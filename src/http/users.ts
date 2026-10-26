import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseJson } from "../db/json.js";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import type { Queryable } from "../db/index.js";
import { hashPassword } from "../auth/passwords.js";
import { deleteUserSessions } from "../auth/sessions.js";
import { email, password } from "./auth.js";
import { requireOwner } from "./admin.js";

const role = z.enum(["owner", "member"]);
const accountIds = z.array(z.string().uuid()).max(500);

const USER_COLUMNS = `u.id, u.email, u.name, u.role, u.disabled, u.created_at, u.last_login_at,
  (SELECT JSON_ARRAYAGG(m.account_id) FROM account_members m WHERE m.user_id = u.id) AS account_ids`;

type UserRow = Record<string, unknown> & { account_ids: unknown };
const withAccounts = (r: UserRow | undefined) => r && { ...r, account_ids: parseJson<string[]>(r.account_ids) ?? [] };

async function setMemberships(q: Queryable, userId: string, ids: string[]): Promise<void> {
  await q.query("DELETE FROM account_members WHERE user_id = $1", [userId]);
  if (ids.length) {
    await q.query(
      `INSERT INTO account_members (account_id, user_id)
       SELECT a.id, $1 FROM accounts a WHERE a.id IN ($2)`,
      [userId, ids],
    );
  }
}

/** Equipe: só administradores criam, editam, desativam e redefinem senhas. */
export function registerUserRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.get("/api/users", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const { rows } = await deps.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u ORDER BY u.created_at`);
    return rows.map(withAccounts);
  });

  api.post("/api/users", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        email,
        password,
        role: role.default("member"),
        account_ids: accountIds.default([]),
      })
      .parse(req.body);

    const hash = await hashPassword(body.password);
    try {
      const user = await deps.db.tx(async (q) => {
        const id = randomUUID();
        await q.query("INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)", [
          id,
          body.email,
          body.name,
          hash,
          body.role,
        ]);
        await setMemberships(q, id, body.account_ids);
        return withAccounts((await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [id])).rows[0]);
      });
      return reply.code(201).send(user);
    } catch (err) {
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
        return reply.code(409).send({ error: "Já existe alguém com esse e-mail." });
      }
      throw err;
    }
  });

  api.patch("/api/users/:userId", async (req, reply) => {
    if (!requireOwner(req, reply)) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        role: role.optional(),
        disabled: z.boolean().optional(),
        password: password.optional(),
        account_ids: accountIds.optional(),
      })
      .parse(req.body);

    const me = req.principal?.kind === "session" ? req.principal.user.id : null;
    if (userId === me && (body.disabled === true || body.role === "member")) {
      return reply.code(400).send({ error: "Você não pode desativar nem rebaixar a própria conta." });
    }

    const result = await deps.db.tx(async (q) => {
      const current = (await q.query<{ role: string; disabled: boolean }>("SELECT role, disabled FROM users WHERE id = $1 FOR UPDATE", [userId]))
        .rows[0];
      if (!current) return { status: 404 as const };

      // Sempre precisa sobrar pelo menos um administrador ativo.
      const losingOwner = current.role === "owner" && !current.disabled && (body.role === "member" || body.disabled === true);
      if (losingOwner) {
        const { rows } = await q.query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND NOT disabled AND id <> $1",
          [userId],
        );
        if (rows[0]!.n === 0) return { status: 400 as const, error: "É preciso manter pelo menos um administrador ativo." };
      }

      await q.query(
        `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), disabled = COALESCE($4, disabled),
                          password_hash = COALESCE($5, password_hash)
          WHERE id = $1`,
        [userId, body.name ?? null, body.role ?? null, body.disabled ?? null, body.password ? await hashPassword(body.password) : null],
      );
      if (body.account_ids) await setMemberships(q, userId, body.account_ids);
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
