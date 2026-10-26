import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerAdminRoutes } from "./admin.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerMetaCallbackRoutes } from "./meta-callbacks.js";
import { registerPanelRoutes } from "./panel.js";
import { registerLinkRoutes } from "./links.js";
import { registerAuthRoutes } from "./auth.js";
import type { InstagramOAuth } from "../instagram/oauth.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Bytes exatos do corpo — necessários para validar a assinatura da Meta. */
    rawBody?: Buffer;
  }
}

export type AppDeps = { config: Config; db: Db; oauth?: InstagramOAuth };

export function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ bodyLimit: 1024 * 1024, trustProxy: deps.config.trustProxy, ...opts });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch {
      const err = new Error("JSON inválido") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Os callbacks de desautorização/exclusão da Meta chegam como formulário (signed_request=...).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/health", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true };
  });

  registerWebhookRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerOAuthRoutes(app, deps);
  registerMetaCallbackRoutes(app, deps);
  registerLinkRoutes(app, deps);
  registerPanelRoutes(app);
  return app;
}
