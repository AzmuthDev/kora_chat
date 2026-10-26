import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { hashIp, parseRecipientToken, recordClick } from "../store/links.js";

/** Destino dos botões de link: conta o clique e redireciona. Público (quem toca não está logado). */
export function registerLinkRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { slug: string }; Querystring: { r?: string } }>("/r/:slug", async (req, reply) => {
    const { slug } = req.params;
    if (!/^[\w-]{1,16}$/.test(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Link não encontrado.");
    const secret = deps.config.tokenEncryptionKey;
    const url = await recordClick(deps.db, slug, {
      recipient: parseRecipientToken(req.query.r),
      ipHash: hashIp(secret, req.ip),
      userAgent: req.headers["user-agent"],
    });
    if (!url) return reply.code(404).type("text/plain; charset=utf-8").send("Link não encontrado.");
    // Sem cache: cada toque precisa passar por aqui para ser contado.
    return reply.header("cache-control", "no-store").redirect(url, 302);
  });
}
