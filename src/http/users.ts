import type { FastifyInstance } from "fastify";
import { parseJson } from "../db/json.js";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { hashPassword } from "../auth/passwords.js";
import { deleteUserSessions } from "../auth/sessions.js";
import { password } from "./auth.js";
import { requireSuperadmin } from "./admin.js";

const role = z.enum(["superadmin", "user"]);

const USER_COLUMNS = `u.id, u.email, u.name, u.role, u.disabled, u.created_at, u.last_login_at,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('account_id', a.id, 'name', a.name, 'role', m.role))
     FROM account_members m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = u.id) AS accounts`;

type UserRow = Record<string, unknown> & { accounts: unknown };
const withAccounts = (r: UserRow | undefined) => r && { ...r, accounts: parseJson<unknown[]>(r.accounts) ?? [] };

/**
 * Pessoas da plataforma inteira: só o super-admin vê, desativa, redefine senha e promove.
 * Entrar numa empresa é por convite (rotas de equipe); não há mais criação direta de usuário.
 */
export function registerUserRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.get("/api/users", async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return reply;
    const { rows } = await deps.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.created_at`);
    return rows.map(withAccounts);
  });

  api.patch("/api/users/:userId", async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        role: role.optional(),
        disabled: z.boolean().optional(),
        password: password.optional(),
      })
      .parse(req.body);

    const me = req.principal?.kind === "session" ? req.principal.user.id : null;
    if (userId === me && (body.disabled === true || body.role === "user")) {
      return reply.code(400).send({ error: "Você não pode desativar nem rebaixar a própria conta." });
    }

    const result = await deps.db.tx(async (q) => {
      const current = (await q.query<{ role: string; disabled: boolean }>("SELECT role, disabled FROM users WHERE id = $1 FOR UPDATE", [userId]))
        .rows[0];
      if (!current) return { status: 404 as const };

      // Sempre precisa sobrar pelo menos um super-admin ativo.
      const losing = current.role === "superadmin" && !current.disabled && (body.role === "user" || body.disabled === true);
      if (losing) {
        const { rows } = await q.query<{ n: number | string }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND NOT disabled AND id <> $1",
          [userId],
        );
        if (Number(rows[0]!.n) === 0) return { status: 400 as const, error: "É preciso manter pelo menos um super-admin ativo." };
      }

      await q.query(
        `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), disabled = COALESCE($4, disabled),
                          password_hash = COALESCE($5, password_hash)
          WHERE id = $1`,
        [userId, body.name ?? null, body.role ?? null, body.disabled ?? null, body.password ? await hashPassword(body.password) : null],
      );
      // Senha redefinida ou acesso cortado: derruba as sessões abertas dessa pessoa.
      if (body.password || body.disabled === true) await deleteUserSessions(q, userId);
      return {
        status: 200 as const,
        user: withAccounts((await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId])).rows[0]),
      };
    });

    if (result.status === 404) return reply.code(404).send({ error: "usuário não encontrado" });
    if (result.status === 400) return reply.code(400).send({ error: result.error });
    return result.user;
  });
}
