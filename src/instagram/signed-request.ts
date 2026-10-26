import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `signed_request` dos callbacks de desautorização e exclusão de dados da Meta:
 *   base64url(HMAC-SHA256(payload_b64, app_secret)) + "." + payload_b64
 * onde payload é JSON { algorithm: "HMAC-SHA256", issued_at, user_id }.
 */
export type SignedRequestPayload = { user_id: string; algorithm: string; issued_at?: number } & Record<string, unknown>;

export function parseSignedRequest(signedRequest: string | undefined, secrets: string[]): SignedRequestPayload | null {
  if (!signedRequest) return null;
  const [sigB64, payloadB64, ...rest] = signedRequest.split(".");
  if (!sigB64 || !payloadB64 || rest.length) return null;

  const received = Buffer.from(sigB64, "base64url");
  const valid = secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(payloadB64).digest();
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.algorithm !== "string" || p.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
  if (typeof p.user_id !== "string" && typeof p.user_id !== "number") return null;
  return { ...p, user_id: String(p.user_id), algorithm: p.algorithm } as SignedRequestPayload;
}

export function createSignedRequest(payload: Record<string, unknown>, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${sig}.${payloadB64}`;
}
