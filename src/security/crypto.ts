const enc = new TextEncoder();
export const random = () => crypto.randomUUID() + crypto.randomUUID();
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function equal(a: string, b: string) {
  return (await hash(a)) === (await hash(b));
}
async function key(secret: string) {
  const bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("invalid_encryption_key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(value: unknown, secret: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) },
    await key(secret),
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    v: 1,
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(data))),
  });
}
export async function unseal<T>(
  value: string,
  secret: string,
  context: string,
): Promise<T> {
  const v = JSON.parse(value);
  if (v.v !== 1) throw new Error("invalid_cipher_version");
  const decode = (s: string) =>
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(v.iv),
          additionalData: enc.encode(context),
        },
        await key(secret),
        decode(v.data),
      ),
    ),
  );
}
