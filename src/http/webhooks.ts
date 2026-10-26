import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { verifyMetaSignature } from "../instagram/signature.js";
import { normalizeInstagramWebhook } from "../instagram/normalize.js";
import { ingestInstagramEvents } from "../worker/ingest.js";

/**
 * O webhook só valida, grava e enfileira — nunca chama a API do Instagram aqui.
 * A Meta exige resposta rápida e reenvia em caso de erro/timeout; o trabalho pesado fica no worker.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/webhooks/instagram", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === deps.config.metaVerifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("verify token inválido");
  });

  app.post("/webhooks/instagram", async (req, reply) => {
    const raw = req.rawBody;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    // Com Instagram Login o app tem dois segredos (Meta e Instagram); aceita a assinatura de qualquer um deles.
    const secrets = [deps.config.metaAppSecret, deps.config.igOAuth?.appSecret].filter((s): s is string => !!s);
    if (!raw || !secrets.some((secret) => verifyMetaSignature(raw, signature, secret))) {
      req.log.warn("webhook com assinatura inválida");
      return reply.code(401).send("assinatura inválida");
    }

    const { events, ignored } = normalizeInstagramWebhook(req.body);
    if (ignored.length) req.log.debug({ ignored }, "itens de webhook ignorados");

    await deps.db.tx((q) => ingestInstagramEvents(q, events));

    return reply.code(200).send("EVENT_RECEIVED");
  });
}
