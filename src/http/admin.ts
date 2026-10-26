import { randomBytes } from "node:crypto";
import { parseJson } from "../db/json.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { commentTriggerConfigSchema, graphSchema, httpUrl } from "../engine/flow-types.js";
import { buildCommentToDmGraph, createPublishedFlow } from "../store/automations.js";
import { InstagramInUseError, upsertInstagramConnection } from "../store/connections.js";
import { linkStatsByFlow } from "../store/links.js";
import { accountRoleOf, createAccount } from "../store/team.js";
import { registerTeamRoutes, requireAccountAdmin } from "./team.js";
import { registerPlatformRoutes } from "./platform.js";
import { registerSimulatorRoutes } from "./simulator.js";
import { registerUserRoutes } from "./users.js";
import { isSameOrigin, resolvePrincipal } from "./auth.js";

export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const uuid = z.object({ accountId: z.string().uuid() });

const commentToDmBody = commentTriggerConfigSchema.extend({
  name: z.string().min(1).default("Comentário → DM"),
  public_replies: z.array(z.string().min(1).max(300)).optional(),
  opening: z.object({ text: z.string().min(1).max(1000), button_caption: z.string().min(1).max(20) }).optional(),
  require_follow: z.object({ text: z.string().min(1).max(1000), button_caption: z.string().min(1).max(20) }).optional(),
  dm: z.object({
    text: z.string().min(1).max(1000),
    buttons: z.array(z.object({ caption: z.string().min(1).max(20), url: httpUrl })).max(3).optional(),
  }),
  tag: z.string().min(1).optional(),
});

const isUuid = (v: unknown): v is string => typeof v === "string" && z.string().uuid().safeParse(v).success;

/** Para rotas só do dono da plataforma. Responde 403 e devolve false para os demais. */
export function requireSuperadmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.principal?.role === "superadmin") return true;
  void reply.code(403).send({ error: "Só o administrador da plataforma pode fazer isso." });
  return false;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.register(async (api) => {
    // Autenticação (cookie de sessão ou ADMIN_TOKEN), proteção CSRF e acesso por empresa.
    api.addHook("preHandler", async (req, reply) => {
      const principal = await resolvePrincipal(req, deps);
      if (!principal) return reply.code(401).send({ error: "não autenticado" });
      if (principal.kind === "session" && req.method !== "GET" && !isSameOrigin(req)) {
        return reply.code(403).send({ error: "origem não permitida" });
      }
      req.principal = principal;

      const accountId = (req.params as Record<string, unknown> | undefined)?.accountId;
      if (!isUuid(accountId) || !req.url.startsWith("/api/accounts/")) return;
      const account = (await deps.db.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [accountId])).rows[0];
      if (principal.role === "superadmin") {
        if (!account) return reply.code(404).send({ error: "empresa não encontrada" });
        req.accountRole = "admin";
        return;
      }
      const role = account && principal.kind === "session" ? await accountRoleOf(deps.db, accountId, principal.user.id) : null;
      // 404 em vez de 403: não revela que a empresa existe.
      if (!role) return reply.code(404).send({ error: "empresa não encontrada" });
      req.accountRole = role;
      // Empresa suspensa (ex.: pagamento em aberto): dá para consultar, não para mudar nada.
      if (account!.status === "suspended" && req.method !== "GET") {
        return reply.code(403).send({ error: "Esta empresa está suspensa. Fale com o suporte do Kora para reativar." });
      }
    });

    api.setErrorHandler((err, _req, reply) => {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: "validation", issues: err.issues });
      return reply.send(err);
    });

    /** Empresas de quem chama, com o papel dela em cada uma. O super-admin vê todas. */
    api.get("/api/accounts", async (req) => {
      const p = req.principal!;
      const { rows } =
        p.role === "superadmin"
          ? await deps.db.query(
              `SELECT id, name, timezone, status, plan, created_at, 'admin' AS my_role FROM accounts ORDER BY created_at`,
            )
          : await deps.db.query(
              `SELECT a.id, a.name, a.timezone, a.status, a.plan, a.created_at, m.role AS my_role FROM accounts a
                 JOIN account_members m ON m.account_id = a.id AND m.user_id = $1
                ORDER BY a.created_at`,
              [p.kind === "session" ? p.user.id : null],
            );
      return rows;
    });

    /** Qualquer pessoa logada pode abrir uma empresa (ex.: agência com vários clientes) e vira admin dela. */
    api.post("/api/accounts", async (req, reply) => {
      const body = z.object({ name: z.string().trim().min(1).max(120), timezone: z.string().default("UTC") }).parse(req.body);
      const p = req.principal!;
      const created = await deps.db.tx((q) =>
        createAccount(q, { name: body.name, timezone: body.timezone, adminUserId: p.kind === "session" ? p.user.id : undefined }),
      );
      return reply.code(201).send({ ...created, my_role: "admin" });
    });

    api.patch("/api/accounts/:accountId", async (req, reply) => {
      if (!requireAccountAdmin(req, reply)) return reply;
      const { accountId } = uuid.parse(req.params);
      const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
      await deps.db.query("UPDATE accounts SET name = $2 WHERE id = $1", [accountId, name]);
      return { id: accountId, name };
    });

    /** Conexão manual: token gerado no painel do app da Meta. */
    api.post("/api/accounts/:accountId/connections/instagram", async (req, reply) => {
      if (!requireAccountAdmin(req, reply)) return reply;
      const { accountId } = uuid.parse(req.params);
      const body = z
        .object({
          ig_user_id: z.string().regex(/^\d+$/),
          username: z.string().optional(),
          access_token: z.string().min(10),
          expires_at: z.string().datetime().optional(),
        })
        .parse(req.body);
      try {
        const connection = await upsertInstagramConnection(deps.db, {
          accountId,
          igUserId: body.ig_user_id,
          username: body.username,
          accessToken: body.access_token,
          // Validade desconhecida: o worker tenta renovar depois de 24h e descobre a expiração real.
          expiresAt: body.expires_at ? new Date(body.expires_at) : null,
          encryptionKey: deps.config.tokenEncryptionKey,
        });
        return reply.code(201).send(connection);
      } catch (err) {
        if (err instanceof InstagramInUseError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    });

    /** Gera o link de autorização do Instagram. Abra no navegador; o callback grava a conexão. */
    api.post("/api/accounts/:accountId/connections/instagram/oauth", async (req, reply) => {
      if (!requireAccountAdmin(req, reply)) return reply;
      const { accountId } = uuid.parse(req.params);
      if (!deps.oauth) {
        return reply.code(503).send({ error: "OAuth não configurado: defina IG_APP_ID, IG_APP_SECRET e PUBLIC_BASE_URL" });
      }
      const exists = await deps.db.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
      if (exists.rows.length === 0) return reply.code(404).send({ error: "conta não encontrada" });

      const state = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
      await deps.db.query("INSERT INTO oauth_states (state, account_id, provider, expires_at) VALUES ($1, $2, 'instagram', $3)", [
        state,
        accountId,
        expiresAt.toISOString(),
      ]);
      return reply.code(201).send({ authorize_url: deps.oauth.authorizeUrl(state), expires_at: expiresAt.toISOString() });
    });

    api.get("/api/accounts/:accountId/connections", async (req) => {
      const { accountId } = uuid.parse(req.params);
      const { rows } = await deps.db.query(
        `SELECT id, channel, external_account_id AS ig_user_id, username, status, scopes, sandbox,
                token_expires_at, token_issued_at, token_refreshed_at, last_refresh_error
           FROM channel_connections WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      return rows;
    });

    api.post("/api/accounts/:accountId/automations/comment-to-dm", async (req, reply) => {
      const { accountId } = uuid.parse(req.params);
      const b = commentToDmBody.parse(req.body);
      const graph = buildCommentToDmGraph({
        publicReplies: b.public_replies,
        opening: b.opening && { text: b.opening.text, buttonCaption: b.opening.button_caption },
        requireFollow: b.require_follow && { text: b.require_follow.text, buttonCaption: b.require_follow.button_caption },
        dm: b.dm,
        tag: b.tag,
      });
      const created = await createPublishedFlow(deps.db, {
        accountId,
        name: b.name,
        graph,
        trigger: {
          type: "comment",
          config: { media_ids: b.media_ids, keywords: b.keywords, match: b.match, top_level_only: b.top_level_only },
        },
      });
      return reply.code(201).send({ ...created, graph });
    });

    /** Fluxo com grafo livre (o que o editor visual vai salvar). */
    api.post("/api/accounts/:accountId/flows", async (req, reply) => {
      const { accountId } = uuid.parse(req.params);
      const body = z
        .object({
          name: z.string().min(1),
          graph: graphSchema,
          trigger: z.object({ type: z.literal("comment"), config: commentTriggerConfigSchema, priority: z.number().int().optional() }),
        })
        .parse(req.body);
      return reply.code(201).send(await createPublishedFlow(deps.db, { accountId, ...body }));
    });

    api.get("/api/accounts/:accountId/automations", async (req) => {
      const { accountId } = uuid.parse(req.params);
      const { rows } = await deps.db.query(
        `SELECT f.id, f.ns, f.name, f.status, f.created_at, t.id AS trigger_id, t.type AS trigger_type,
                t.active, t.config, t.priority, v.graph
           FROM flows f
           JOIN triggers t ON t.flow_id = f.id
           LEFT JOIN flow_versions v ON v.id = f.published_version_id
          WHERE f.account_id = $1
          ORDER BY f.created_at DESC`,
        [accountId],
      );
      const stats = await linkStatsByFlow(deps.db, accountId);
      // null = a automação ainda não mandou nenhum link rastreado.
      return rows.map((r) => ({ ...r, link_stats: stats.get(r.id as string) ?? null }));
    });

    /** Pausa ou reativa a automação (os gatilhos do fluxo). */
    api.patch("/api/accounts/:accountId/automations/:flowId", async (req, reply) => {
      const { accountId, flowId } = uuid.extend({ flowId: z.string().uuid() }).parse(req.params);
      const { active } = z.object({ active: z.boolean() }).parse(req.body);
      const { rows } = await deps.db.query("SELECT 1 FROM triggers WHERE account_id = $1 AND flow_id = $2", [accountId, flowId]);
      if (rows.length === 0) return reply.code(404).send({ error: "automação não encontrada" });
      await deps.db.query("UPDATE triggers SET active = $3 WHERE account_id = $1 AND flow_id = $2", [accountId, flowId, active]);
      return { id: flowId, active };
    });

    api.get("/api/accounts/:accountId/contacts", async (req) => {
      const { accountId } = uuid.parse(req.params);
      const { rows } = await deps.db.query(
        `SELECT c.id, ci.external_user_id AS igsid, ci.username, ci.last_inbound_at, c.last_input_text, c.created_at,
                (SELECT JSON_ARRAYAGG(t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                  WHERE ct.contact_id = c.id) AS tags,
                (SELECT JSON_OBJECTAGG(f.name, v.value) FROM contact_field_values v JOIN custom_fields f ON f.id = v.field_id
                  WHERE v.contact_id = c.id) AS fields
           FROM contacts c LEFT JOIN contact_identities ci ON ci.contact_id = c.id AND ci.channel = 'instagram'
          WHERE c.account_id = $1
          ORDER BY c.created_at DESC LIMIT 200`,
        [accountId],
      );
      // JSON_ARRAYAGG não ordena e devolve NULL quando não há linhas.
      return rows.map((r) => ({
        ...r,
        tags: [...(parseJson<string[]>(r.tags) ?? [])].sort(),
        fields: parseJson<Record<string, unknown>>(r.fields) ?? {},
      }));
    });

    api.get("/api/accounts/:accountId/messages", async (req) => {
      const { accountId } = uuid.parse(req.params);
      const filters = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          connection_id: z.string().uuid().optional(),
          contact_id: z.string().uuid().optional(),
          igsid: z.string().optional(),
        })
        .parse(req.query);
      const { rows } = await deps.db.query(
        `SELECT m.id, m.contact_id, m.connection_id, m.direction, m.kind, m.status, m.error, m.payload,
                m.external_message_id, m.created_at, ci.external_user_id AS igsid, ci.username
           FROM messages m
           LEFT JOIN contact_identities ci ON ci.contact_id = m.contact_id AND ci.channel = 'instagram'
          WHERE m.account_id = $1
            AND ($3 IS NULL OR m.connection_id = $3)
            AND ($4 IS NULL OR m.contact_id = $4)
            AND ($5 IS NULL OR ci.external_user_id = $5)
          ORDER BY m.created_at DESC, m.id
          LIMIT $2`,
        [accountId, filters.limit, filters.connection_id ?? null, filters.contact_id ?? null, filters.igsid ?? null],
      );
      return rows;
    });

    registerSimulatorRoutes(api, deps);
    registerUserRoutes(api, deps);
    registerTeamRoutes(api, deps);
    registerPlatformRoutes(api, deps);
  });
}
