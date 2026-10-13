export function randomHex(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexBytes(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

export function verificationCode(): string {
  const range = 900_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return String(100_000 + sample[0] % range);
}

export async function importHmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || !/^(?:[0-9a-fA-F]{2}){32,128}$/.test(secret)) {
    throw new Error("mfa_configuration_error");
  }
  return await crypto.subtle.importKey(
    "raw", hexBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

export async function codeHash(key: CryptoKey, userId: string, nonce: string, code: string): Promise<string> {
  const input = `partnerdesk-mfa-v1|${userId.toLowerCase()}|${nonce}|${code}`;
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `hmac-sha256-v1:${nonce}:${hex(new Uint8Array(digest))}`;
}

// Hash the random bytes, not the textual hexadecimal encoding.
export async function sessionHash(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", hexBytes(rawToken));
  return hex(new Uint8Array(digest));
}
