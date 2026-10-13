export class HttpError extends Error {
  constructor(public status: number, public reason: string) { super(reason); }
}

export function allowedOrigins(config: string | undefined, hosted: boolean): Set<string> {
  if (!config?.trim()) {
    return new Set(hosted ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]);
  }
  const origins = config.split(",").map((value) => value.trim());
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new HttpError(503, "cors_configuration_error"); }
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) ||
        (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new HttpError(503, "cors_configuration_error");
    }
  }
  return new Set(origins);
}

export function response(status: number, body: Record<string, unknown>, origin?: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Pragma": "no-cache", "Vary": "Origin", "X-Content-Type-Options": "nosniff",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", [
      "authorization", "apikey", "content-type", "x-client-info", "x-partnerdesk-session",
      "x-supabase-client-platform", "x-supabase-client-platform-version",
      "x-supabase-client-runtime", "x-supabase-client-runtime-version",
    ].join(", "));
    headers.set("Access-Control-Max-Age", "600");
  }
  if (status === 405) headers.set("Allow", "POST, OPTIONS");
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export async function requestBody(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "json_required");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
  return body as Record<string, unknown>;
}
