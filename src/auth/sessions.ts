import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/index.js";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** superadmin = dono da plataforma; user = cliente (o acesso a cada empresa vem de account_members). */
export type PlatformRole = "superadmin" | "user";
export type SessionUser = { id: string; email: string; name: string; role: PlatformRole };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(
  q: Queryable,
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await q.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5)",
    [hashToken(token), userId, expiresAt.toISOString(), meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  return { token, expiresAt };
}

/** Sessão válida → usuário. Renova a validade (sessão deslizante) no máximo uma vez por hora. */
export async function readSession(q: Queryable, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query<SessionUser & { last_seen_at: string | Date }>(
    `SELECT u.id, u.email, u.name, u.role, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW(3) AND NOT u.disabled`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 60 * 1000) {
    await q.query("UPDATE sessions SET last_seen_at = NOW(3), expires_at = $2 WHERE token_hash = $1", [
      hashToken(token),
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    ]);
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function deleteSession(q: Queryable, token: string | undefined): Promise<void> {
  if (token) await q.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

/** Ao trocar a senha ou desativar alguém: derruba as outras sessões. */
export async function deleteUserSessions(q: Queryable, userId: string, exceptToken?: string): Promise<void> {
  await q.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, exceptToken ? hashToken(exceptToken) : ""]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformado: ignora */
    }
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeMs: number }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
    opts.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
