import type { FastifyInstance } from "fastify";
import { page } from "./html.js";
import type { AppDeps } from "./app.js";
import { IgApiError } from "../instagram/client.js";
import { REQUIRED_SCOPES, WEBHOOK_FIELDS } from "../instagram/oauth.js";
import { InstagramInUseError, upsertInstagramConnection } from "../store/connections.js";

/**
 * Callback público do OAuth. A autenticação é o `state`: aleatório, de uso único, expira em 15 min
 * e foi emitido pela API administrativa para uma conta específica.
 */
export function registerOAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/oauth/instagram/callback", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const oauth = deps.oauth;
    if (!oauth) return page(reply, 503, "OAuth não configurado", "Defina IG_APP_ID, IG_APP_SECRET e PUBLIC_BASE_URL.");

    const state = q.state;
    // Consome o state de forma atômica: dois callbacks com o mesmo link não passam os dois.
    const accountId = state
      ? await deps.db.tx(async (t) => {
          const { rows } = await t.query<{ account_id: string }>(
            `SELECT account_id FROM oauth_states
              WHERE state = $1 AND provider = 'instagram' AND used_at IS NULL AND expires_at > NOW(3)
              FOR UPDATE`,
            [state],
          );
          if (!rows[0]) return undefined;
          await t.query("UPDATE oauth_states SET used_at = NOW(3) WHERE state = $1", [state]);
          return rows[0].account_id;
        })
      : undefined;
    if (!accountId) {
      return page(reply, 400, "Link inválido ou expirado", "Gere um novo link de conexão e tente de novo.", {
        href: "/#/conexoes",
        label: "Voltar ao painel",
      });
    }

    if (q.error || !q.code) {
      req.log.info({ error: q.error, reason: q.error_reason }, "OAuth do Instagram cancelado");
      return page(reply, 400, "Conexão cancelada", q.error_description ?? "A autorização não foi concluída no Instagram.");
    }

    try {
      const short = await oauth.exchangeCode(q.code);
      const missing = short.permissions.length ? REQUIRED_SCOPES.filter((s) => !short.permissions.includes(s)) : [];
      if (missing.length) {
        return page(reply, 400, "Permissões insuficientes", `Reconecte e aceite todas as permissões. Faltou: ${missing.join(", ")}.`);
      }

      const long = await oauth.exchangeForLongLived(short.accessToken);
      const profile = await oauth.getProfile(long.accessToken);
      await oauth.subscribeWebhooks(long.accessToken, WEBHOOK_FIELDS);

      const connection = await upsertInstagramConnection(deps.db, {
        accountId,
        igUserId: profile.userId,
        username: profile.username,
        appScopedUserId: profile.appScopedId,
        accessToken: long.accessToken,
        expiresAt: new Date(Date.now() + long.expiresInSeconds * 1000),
        scopes: short.permissions.length ? short.permissions : [...REQUIRED_SCOPES],
        encryptionKey: deps.config.tokenEncryptionKey,
      });
      req.log.info({ accountId, igUserId: connection.ig_user_id }, "Instagram conectado via OAuth");
      return page(
        reply,
        200,
        "Instagram conectado",
        `A conta @${profile.username ?? profile.userId} está conectada e já pode receber automações.`,
        { href: "/#/conexoes", label: "Voltar ao painel" },
      );
    } catch (err) {
      if (err instanceof InstagramInUseError) return page(reply, 409, "Conta já conectada", err.message, { href: "/#/conexoes", label: "Voltar ao painel" });
      req.log.error({ err }, "falha no OAuth do Instagram");
      const detail = err instanceof IgApiError ? err.message : "erro inesperado";
      return page(reply, 502, "Não foi possível conectar", `O Instagram recusou a conexão: ${detail}`);
    }
  });
}
