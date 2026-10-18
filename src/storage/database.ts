import type { Env } from "../types";
import { AppError } from "../types";
import { seal, unseal, random } from "../security/crypto";
export class Store {
  constructor(public env: Env) {}
  async get<T>(key: string): Promise<T | null> {
    const row = await this.env.DB.prepare(
      "SELECT value FROM records WHERE key=?",
    )
      .bind(key)
      .first<{ value: string }>();
    if (!row) return null;
    return unseal<T>(row.value, this.env.TOKEN_ENCRYPTION_KEY!, key);
  }
  async put(key: string, value: unknown) {
    await this.putMany({ [key]: value });
  }
  async putMany(values: Record<string, unknown>) {
    const statements = await Promise.all(
      Object.entries(values).map(async ([key, value]) =>
        this.env.DB.prepare(
          "INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(key, await seal(value, this.env.TOKEN_ENCRYPTION_KEY!, key)),
      ),
    );
    if (statements.length) await this.env.DB.batch(statements);
  }
  async delete(key: string) {
    await this.env.DB.prepare("DELETE FROM records WHERE key=?")
      .bind(key)
      .run();
  }
  async audit(event: string) {
    await this.env.DB.prepare("INSERT INTO audit(event,created) VALUES(?,?)")
      .bind(event, Date.now())
      .run();
  }
  async locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const owner = random();
    const now = Date.now();
    const row = await this.env.DB.prepare(
      "INSERT INTO locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires < ? RETURNING owner",
    )
      .bind(name, owner, now + 120000, now)
      .first();
    if (!row) throw new AppError("operation_in_progress", 409);
    try {
      return await fn();
    } finally {
      await this.env.DB.prepare("DELETE FROM locks WHERE name=? AND owner=?")
        .bind(name, owner)
        .run();
    }
  }
}
