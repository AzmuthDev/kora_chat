import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { encryptToken } from "../crypto/tokens.js";
import type { InstagramEvent } from "../instagram/normalize.js";
import { ingestInstagramEvents } from "../worker/ingest.js";

const params = z.object({ accountId: z.string().uuid() });
const username = z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "use só letras, números, ponto e sublinhado (até 30)");

/** IGSID falso e estável para um usuário simulado. */
export const simulatedIgsid = (name: string) => `sim-${name.toLowerCase()}`;

/**
 * Rotas do simulador (dentro do escopo autenticado da API administrativa).
 * Elas produzem exatamente o mesmo evento que o webhook da Meta produziria, mas só para conexões de teste,
 * cujo "Instagram" é falso — nada sai para usuários reais.
 */
export function registerSimulatorRoutes(api: FastifyInstance, deps: AppDeps): void {
  async function sandboxConnection(accountId: string, connectionId: string) {
    const { rows } = await deps.db.query<{ external_account_id: string; status: string }>(
      `SELECT external_account_id, status FROM channel_connections
        WHERE id = $1 AND account_id = $2 AND sandbox AND channel = 'instagram'`,
      [connectionId, accountId],
    );
    return rows[0];
  }

  api.post("/api/accounts/:accountId/connections/sandbox", async (req, reply) => {
    const { accountId } = params.parse(req.params);
    const body = z.object({ username: username.default("minha_loja_teste") }).parse(req.body ?? {});
    const exists = await deps.db.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
    if (exists.rows.length === 0) return reply.code(404).send({ error: "conta não encontrada" });

    const id = randomUUID();
    await deps.db.query(
      `INSERT INTO channel_connections
         (id, account_id, channel, external_account_id, username, access_token_enc, sandbox, token_issued_at)
       VALUES ($1, $2, 'instagram', $3, $4, $5, TRUE, NOW(3))`,
      [id, accountId, `sandbox-${randomBytes(6).toString("hex")}`, body.username, encryptToken("sandbox", deps.config.tokenEncryptionKey)],
    );
    const { rows } = await deps.db.query(
      `SELECT id, channel, external_account_id AS ig_user_id, username, status, sandbox
         FROM channel_connections WHERE id = $1`,
      [id],
    );
    return reply.code(201).send(rows[0]);
  });

  api.post("/api/accounts/:accountId/simulate/comment", async (req, reply) => {
    const { accountId } = params.parse(req.params);
    const body = z
      .object({
        connection_id: z.string().uuid(),
        username,
        text: z.string().min(1).max(2200),
        media_id: z.string().min(1).max(100).default("post-de-teste"),
      })
      .parse(req.body);
    const conn = await sandboxConnection(accountId, body.connection_id);
    if (!conn) return reply.code(404).send({ error: "conta de teste não encontrada" });

    const commentId = `sim-comment-${randomUUID()}`;
    const igsid = simulatedIgsid(body.username);
    const event: InstagramEvent = {
      type: "comment",
      dedupeKey: `comment:${commentId}`,
      igAccountId: conn.external_account_id,
      commentId,
      mediaId: body.media_id,
      mediaProductType: "FEED",
      fromId: igsid,
      fromUsername: body.username,
      text: body.text,
      occurredAt: new Date().toISOString(),
    };
    await deps.db.tx((q) => ingestInstagramEvents(q, [event]));
    return reply.code(202).send({ igsid, comment_id: commentId });
  });

  /** O usuário simulado manda uma DM ou toca num botão de resposta rápida. */
  api.post("/api/accounts/:accountId/simulate/message", async (req, reply) => {
    const { accountId } = params.parse(req.params);
    const body = z
      .object({
        connection_id: z.string().uuid(),
        username,
        text: z.string().max(1000).default(""),
        quick_reply_payload: z.string().max(1000).optional(),
      })
      .refine((b) => b.text.trim() !== "" || b.quick_reply_payload, "mande um texto ou toque num botão")
      .parse(req.body);
    const conn = await sandboxConnection(accountId, body.connection_id);
    if (!conn) return reply.code(404).send({ error: "conta de teste não encontrada" });

    const messageId = `sim-mid-${randomUUID()}`;
    const igsid = simulatedIgsid(body.username);
    const event: InstagramEvent = {
      type: "message",
      dedupeKey: `message:${messageId}`,
      igAccountId: conn.external_account_id,
      messageId,
      senderId: igsid,
      text: body.text,
      quickReplyPayload: body.quick_reply_payload,
      occurredAt: new Date().toISOString(),
    };
    await deps.db.tx((q) => ingestInstagramEvents(q, [event]));
    return reply.code(202).send({ igsid, message_id: messageId });
  });
}
