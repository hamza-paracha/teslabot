import type { Env } from "../types";
import { AppError } from "../types";
import { seal, unseal, random } from "../security/crypto";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Records are namespaced per account. The original single-owner account is ""
// and keeps its unprefixed keys, so existing deployments keep their data. The
// full key is also the encryption context, so a record cannot be replayed into
// another account.
export const accountPrefix = (account: string) =>
  account ? `acct:${account}:` : "";
export class Store {
  readonly prefix: string;
  constructor(
    public env: Env,
    public ctx?: Pick<ExecutionContext, "waitUntil">,
    public account = "",
  ) {
    this.prefix = accountPrefix(account);
  }
  key(name: string) {
    return this.prefix + name;
  }
  forAccount(account: string) {
    return new Store(this.env, this.ctx, account);
  }
  async get<T>(key: string): Promise<T | null> {
    return ((await this.getMany([key])) as Record<string, T | null>)[key];
  }
  // One D1 round trip for several records; absent keys are null.
  async getMany<K extends string>(keys: readonly K[]): Promise<Record<K, any>> {
    const full = keys.map((key) => this.key(key));
    const { results } = await this.env.DB.prepare(
      `SELECT key,value FROM records WHERE key IN (${keys.map(() => "?").join(",")})`,
    )
      .bind(...full)
      .all<{ key: string; value: string }>();
    const found = new Map(results.map((row) => [row.key, row.value]));
    const values = await Promise.all(
      full.map((key) =>
        found.has(key)
          ? unseal(found.get(key)!, this.env.TOKEN_ENCRYPTION_KEY!, key)
          : null,
      ),
    );
    return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as Record<
      K,
      any
    >;
  }
  async put(key: string, value: unknown) {
    await this.putMany({ [key]: value });
  }
  async putMany(
    values: Record<string, unknown>,
    extraStatements: D1PreparedStatement[] = [],
  ) {
    const statements = await Promise.all(
      Object.entries(values).map(async ([key, value]) =>
        this.env.DB.prepare(
          "INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(
          this.key(key),
          await seal(value, this.env.TOKEN_ENCRYPTION_KEY!, this.key(key)),
        ),
      ),
    );
    if (statements.length || extraStatements.length)
      await this.env.DB.batch([...statements, ...extraStatements]);
  }
  async delete(key: string) {
    await this.deleteKeys([key]).run();
  }
  // A statement for use in a batch, so deletions commit with related writes.
  deleteKeys(keys: string[]) {
    return this.env.DB.prepare(
      `DELETE FROM records WHERE key IN (${keys.map(() => "?").join(",")})`,
    ).bind(...keys.map((key) => this.key(key)));
  }
  // Every record of an invited account. The owner account shares unprefixed
  // keys with installation records (partner status), so it is never bulk-deleted.
  deleteAll() {
    if (!this.account) throw new AppError("owner_account_protected", 403);
    return this.env.DB.prepare(
      "DELETE FROM records WHERE substr(key,1,?)=?",
    ).bind(this.prefix.length, this.prefix);
  }
  // Audit rows are not needed to build the response; finish them after it is sent.
  async audit(event: string) {
    const write = this.env.DB.prepare(
      "INSERT INTO audit(event,created,account) VALUES(?,?,?)",
    )
      .bind(event, Date.now(), this.account)
      .run();
    if (this.ctx) this.ctx.waitUntil(write);
    else await write;
  }
  // While waiting, `settled` may return a result the current holder already
  // produced (for example a refreshed cache entry), ending the wait lock-free.
  async locked<T>(
    name: string,
    fn: () => Promise<T>,
    waitMs = 0,
    settled?: () => Promise<T | null>,
  ): Promise<T> {
    const owner = random();
    const deadline = Date.now() + waitMs;
    for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
      const now = Date.now();
      const row = await this.env.DB.prepare(
        "INSERT INTO locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires < ? RETURNING owner",
      )
        .bind(this.key(name), owner, now + 120000, now)
        .first();
      if (row) break;
      if (now + delay > deadline)
        throw new AppError("operation_in_progress", 409);
      await sleep(delay);
      const result = settled && (await settled());
      if (result) return result;
    }
    try {
      return await fn();
    } finally {
      await this.env.DB.prepare("DELETE FROM locks WHERE name=? AND owner=?")
        .bind(this.key(name), owner)
        .run();
    }
  }
}
