import { createHmac, timingSafeEqual } from "node:crypto";

/** Valida o header `X-Hub-Signature-256: sha256=<hex>` contra o corpo bruto (bytes exatos recebidos). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
