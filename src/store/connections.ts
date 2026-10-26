import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { encryptToken } from "../crypto/tokens.js";

export type ConnectionSummary = {
  id: string;
  ig_user_id: string;
  username: string | null;
  status: string;
  token_expires_at: string | null;
  scopes: string[];
};

/** Cria ou atualiza a conexão do Instagram (manual ou via OAuth). Reativa conexões expiradas. */
export async function upsertInstagramConnection(
  q: Queryable,
  c: {
    accountId: string;
    igUserId: string;
    username?: string | null;
    /** `id` do /me — o signed_request de desautorização/exclusão pode trazer este em vez do user_id. */
    appScopedUserId?: string | null;
    accessToken: string;
    expiresAt?: Date | null;
    scopes?: string[];
    encryptionKey: string;
  },
): Promise<ConnectionSummary> {
  await q.query(
    `INSERT INTO channel_connections
       (id, account_id, channel, external_account_id, username, access_token_enc, token_expires_at, token_issued_at, scopes,
        app_scoped_user_id)
     VALUES ($1, $2, 'instagram', $3, $4, $5, $6, NOW(3), $7, $8) AS new
     ON DUPLICATE KEY UPDATE
            account_id = new.account_id,
            username = COALESCE(new.username, channel_connections.username),
            app_scoped_user_id = COALESCE(new.app_scoped_user_id, channel_connections.app_scoped_user_id),
            access_token_enc = new.access_token_enc,
            token_expires_at = new.token_expires_at,
            token_issued_at = NOW(3),
            scopes = new.scopes,
            status = 'active',
            last_refresh_error = NULL,
            refresh_locked_until = NULL,
            updated_at = NOW(3)`,
    [
      randomUUID(),
      c.accountId,
      c.igUserId,
      c.username ?? null,
      encryptToken(c.accessToken, c.encryptionKey),
      c.expiresAt?.toISOString() ?? null,
      JSON.stringify(c.scopes ?? []),
      c.appScopedUserId ?? null,
    ],
  );
  const { rows } = await q.query<ConnectionSummary>(
    `SELECT id, external_account_id AS ig_user_id, username, status, token_expires_at, scopes
       FROM channel_connections WHERE channel = 'instagram' AND external_account_id = $1`,
    [c.igUserId],
  );
  return rows[0]!;
}

/**
 * expired = token morreu (precisa reconectar); disconnected = usuário removeu o app.
 * Em ambos os casos os webhooks da conta passam a ser ignorados. Ao desconectar, o token é apagado.
 */
export async function setConnectionStatus(
  q: Queryable,
  connectionId: string,
  status: "expired" | "disconnected",
  reason: string,
): Promise<void> {
  await q.query(
    `UPDATE channel_connections
        SET status = $2, last_refresh_error = $3, refresh_locked_until = NULL, updated_at = NOW(3),
            access_token_enc = CASE WHEN $2 = 'disconnected' THEN '' ELSE access_token_enc END
      WHERE id = $1`,
    [connectionId, status, reason],
  );
}

/** Conexões Instagram de um user_id vindo da Meta (ID da conta profissional ou ID escopado do app). */
export async function findInstagramConnectionsByMetaUserId(q: Queryable, metaUserId: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM channel_connections
      WHERE channel = 'instagram' AND (external_account_id = $1 OR app_scoped_user_id = $1)`,
    [metaUserId],
  );
  return rows.map((r) => r.id);
}
