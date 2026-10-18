import { AppError } from "../types";

export const json = (value: unknown, status = 200) =>
  Response.json(value, { status });

export async function readJson(r: Request): Promise<unknown> {
  if (!r.headers.get("Content-Type")?.startsWith("application/json"))
    throw new AppError("json_required", 415);
  const reader = r.body?.getReader();
  if (!reader) throw new AppError("missing_body");
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 2048) {
      await reader.cancel();
      throw new AppError("request_too_large", 413);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new AppError("invalid_json");
  }
}
