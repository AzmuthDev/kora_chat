import type { Db } from "../db/index.js";
import { decryptToken, encryptToken } from "../crypto/tokens.js";
import { IgApiError } from "../instagram/client.js";
import type { InstagramOAuth } from "../instagram/oauth.js";
import { setConnectionStatus } from "../store/connections.js";

export type TokenRefreshDeps = {
  db: Db;
  oauth: Pick<InstagramOAuth, "refresh">;
  tokenEncryptionKey: string;
  refreshDaysBefore: number;
};

export type RefreshOutcome = { connectionId: string; result: "refreshed" | "expired" | "error"; error?: string };

/** Erro 190 = token inválido/expirado/revogado: renovar não adianta, só reconectando. */
const isDeadToken = (err: unknown) => err instanceof IgApiError && err.code === 190;

/**
 * Renova tokens longos perto de expirar. Regras da Meta: o token precisa ter pelo menos 24h
 * e ainda estar válido. Conexões sem validade conhecida (token colado à mão) também entram,
 * e a primeira renovação descobre a expiração real.
 */
export async function refreshDueTokens(deps: TokenRefreshDeps, batchSize = 20): Promise<RefreshOutcome[]> {
  type Row = { id: string; access_token_enc: string; token_expires_at: string | Date | null };
  // Reserva um lote por 10 min (SKIP LOCKED: dois workers nunca pegam a mesma conexão).
  const rows = await deps.db.tx(async (q) => {
    const due = await q.query<Row>(
      `SELECT id, access_token_enc, token_expires_at FROM channel_connections
        WHERE channel = 'instagram' AND status = 'active' AND NOT sandbox
          AND (refresh_locked_until IS NULL OR refresh_locked_until < NOW(3))
          AND COALESCE(token_issued_at, created_at) < NOW(3) - INTERVAL 24 HOUR
          AND (token_expires_at IS NULL OR token_expires_at < NOW(3) + INTERVAL $1 DAY)
        ORDER BY token_expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [deps.refreshDaysBefore, batchSize],
    );
    if (due.rows.length) {
      await q.query("UPDATE channel_connections SET refresh_locked_until = NOW(3) + INTERVAL 10 MINUTE WHERE id IN ($1)", [
        due.rows.map((r) => r.id),
      ]);
    }
    return due.rows;
  });

  const outcomes: RefreshOutcome[] = [];
  for (const row of rows) {
    const expired = row.token_expires_at !== null && new Date(row.token_expires_at).getTime() <= Date.now();
    if (expired) {
      await setConnectionStatus(deps.db, row.id, "expired", "token expirou antes de ser renovado");
      outcomes.push({ connectionId: row.id, result: "expired" });
      continue;
    }

    try {
      const fresh = await deps.oauth.refresh(decryptToken(row.access_token_enc, deps.tokenEncryptionKey));
      await deps.db.query(
        `UPDATE channel_connections
            SET access_token_enc = $2,
                token_expires_at = NOW(3) + INTERVAL $3 SECOND,
                token_issued_at = NOW(3), token_refreshed_at = NOW(3),
                last_refresh_error = NULL, refresh_locked_until = NULL, updated_at = NOW(3)
          WHERE id = $1`,
        [row.id, encryptToken(fresh.accessToken, deps.tokenEncryptionKey), fresh.expiresInSeconds],
      );
      outcomes.push({ connectionId: row.id, result: "refreshed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isDeadToken(err)) {
        await setConnectionStatus(deps.db, row.id, "expired", message);
        outcomes.push({ connectionId: row.id, result: "expired", error: message });
      } else {
        // Falha temporária: tenta de novo em 1h.
        await deps.db.query(
          `UPDATE channel_connections
              SET last_refresh_error = $2, refresh_locked_until = NOW(3) + INTERVAL 1 HOUR, updated_at = NOW(3)
            WHERE id = $1`,
          [row.id, message],
        );
        outcomes.push({ connectionId: row.id, result: "error", error: message });
      }
    }
  }
  return outcomes;
}
