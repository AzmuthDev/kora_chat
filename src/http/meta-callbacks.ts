import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "./app.js";
import { page } from "./html.js";
import { parseSignedRequest } from "../instagram/signed-request.js";
import { findInstagramConnectionsByMetaUserId, setConnectionStatus } from "../store/connections.js";
import { enqueue } from "../worker/queue.js";

/**
 * Callbacks que a Meta exige no App Review (painel do app → login comercial do Instagram):
 *   - Desautorização: o usuário removeu o app → paramos de usar a conexão e apagamos o token.
 *   - Exclusão de dados: idem + apagamos os dados obtidos pela conexão (em job) e devolvemos
 *     { url, confirmation_code } para o usuário acompanhar o pedido.
 * Ambos chegam como formulário `signed_request=...`, assinado com o segredo do app.
 */
export function registerMetaCallbackRoutes(app: FastifyInstance, deps: AppDeps): void {
  const secrets = [deps.config.igOAuth?.appSecret, deps.config.metaAppSecret].filter((s): s is string => !!s);

  const readSignedRequest = (req: FastifyRequest) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return parseSignedRequest(typeof body.signed_request === "string" ? body.signed_request : undefined, secrets);
  };

  app.post("/meta/instagram/deauthorize", async (req, reply) => {
    const payload = readSignedRequest(req);
    if (!payload) return reply.code(400).send({ error: "signed_request inválido" });

    const ids = await findInstagramConnectionsByMetaUserId(deps.db, payload.user_id);
    for (const id of ids) await setConnectionStatus(deps.db, id, "disconnected", "usuário removeu o app no Instagram");
    req.log.info({ metaUserId: payload.user_id, connections: ids.length }, "desautorização recebida");
    return reply.send({ success: true });
  });

  app.post("/meta/instagram/data-deletion", async (req, reply) => {
    const payload = readSignedRequest(req);
    if (!payload) return reply.code(400).send({ error: "signed_request inválido" });

    const confirmationCode = randomBytes(10).toString("hex").toUpperCase();
    await deps.db.tx(async (q) => {
      const ids = await findInstagramConnectionsByMetaUserId(q, payload.user_id);
      // Para de usar a conexão já; a exclusão em si roda no worker.
      for (const id of ids) await setConnectionStatus(q, id, "disconnected", "exclusão de dados solicitada");
      await q.query(
        `INSERT INTO data_deletion_requests (confirmation_code, channel, external_user_id, connection_ids)
         VALUES ($1, 'instagram', $2, $3)`,
        [confirmationCode, payload.user_id, JSON.stringify(ids)],
      );
      await enqueue(q, "data_deletion", { confirmationCode });
    });
    req.log.info({ metaUserId: payload.user_id, confirmationCode }, "pedido de exclusão de dados recebido");

    const base = deps.config.publicBaseUrl ?? `${req.protocol}://${req.host}`;
    return reply.send({
      url: `${base}/meta/data-deletion/status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  });

  app.get("/meta/data-deletion/status", async (req, reply) => {
    const code = (req.query as Record<string, string | undefined>).code ?? "";
    const { rows } = await deps.db.query<{ status: string; requested_at: string | Date; completed_at: string | Date | null }>(
      "SELECT status, requested_at, completed_at FROM data_deletion_requests WHERE confirmation_code = $1",
      [code.toUpperCase()],
    );
    const r = rows[0];
    if (!r) return page(reply, 404, "Pedido não encontrado", "Confira o código de confirmação.");
    const fmt = (d: string | Date) => new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    return r.status === "completed" && r.completed_at
      ? page(reply, 200, "Exclusão concluída", `Pedido ${code.toUpperCase()}: seus dados foram apagados em ${fmt(r.completed_at)}.`)
      : page(reply, 200, "Exclusão em andamento", `Pedido ${code.toUpperCase()} recebido em ${fmt(r.requested_at)}. A exclusão está sendo processada.`);
  });
}
