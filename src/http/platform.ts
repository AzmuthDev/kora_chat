import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { parseJson } from "../db/json.js";
import { requireSuperadmin } from "./admin.js";

/** Visão do dono da plataforma: todas as empresas-clientes, com suspensão (ex.: pagamento em aberto). */
export function registerPlatformRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.get("/api/platform/accounts", async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return reply;
    const { rows } = await deps.db.query<Record<string, unknown> & { admins: unknown; members: number | string; connections: number | string }>(
      `SELECT a.id, a.name, a.status, a.plan, a.created_at,
              (SELECT COUNT(*) FROM account_members m WHERE m.account_id = a.id) AS members,
              (SELECT JSON_ARRAYAGG(u.email) FROM account_members m JOIN users u ON u.id = m.user_id
                WHERE m.account_id = a.id AND m.role = 'admin') AS admins,
              (SELECT COUNT(*) FROM channel_connections c
                WHERE c.account_id = a.id AND c.status = 'active' AND NOT c.sandbox) AS connections
         FROM accounts a
        ORDER BY a.created_at DESC`,
    );
    return rows.map((r) => ({
      ...r,
      members: Number(r.members),
      connections: Number(r.connections),
      admins: [...(parseJson<string[]>(r.admins) ?? [])].sort(),
    }));
  });

  api.patch("/api/platform/accounts/:accountId", async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return reply;
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
    const { affectedRows } = await deps.db.query("UPDATE accounts SET status = $2 WHERE id = $1", [accountId, status]);
    if (affectedRows === 0) return reply.code(404).send({ error: "empresa não encontrada" });
    return { id: accountId, status };
  });
}
