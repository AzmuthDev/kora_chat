import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { hashPassword } from "../auth/passwords.js";
import { createSession } from "../auth/sessions.js";
import { addMember, consumeInvite, createInvite, findInvite, otherActiveAdmins } from "../store/team.js";
import { email, password, resolvePrincipal, setSessionCookie } from "./auth.js";

const accountRole = z.enum(["admin", "member"]);
const params = z.object({ accountId: z.string().uuid() });

/** Para rotas que só o admin da empresa (ou o super-admin) pode usar. Responde 403 e devolve false para membros. */
export function requireAccountAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.accountRole === "admin") return true;
  void reply.code(403).send({ error: "Só administradores da empresa podem fazer isso." });
  return false;
}

/** Link que a pessoa convidada abre. Sem PUBLIC_BASE_URL, usa o endereço de quem convidou. */
function inviteUrl(req: FastifyRequest, deps: AppDeps, token: string): string {
  const base = deps.config.publicBaseUrl ?? `${req.protocol}://${req.host}`;
  return `${base.replace(/\/$/, "")}/#/convite/${token}`;
}

/** Equipe de uma empresa. Registrado dentro de /api, que já checou o acesso à empresa. */
export function registerTeamRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.get("/api/accounts/:accountId/members", async (req) => {
    const { accountId } = params.parse(req.params);
    const { rows } = await deps.db.query(
      `SELECT u.id AS user_id, u.name, u.email, m.role, u.disabled, u.last_login_at, m.created_at
         FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1
        ORDER BY m.role = 'admin' DESC, u.name`,
      [accountId],
    );
    return rows;
  });

  api.patch("/api/accounts/:accountId/members/:userId", async (req, reply) => {
    if (!requireAccountAdmin(req, reply)) return reply;
    const { accountId, userId } = params.extend({ userId: z.string().uuid() }).parse(req.params);
    const { role } = z.object({ role: accountRole }).parse(req.body);
    const result = await deps.db.tx(async (q) => {
      const current = await q.query<{ role: string }>(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2 FOR UPDATE",
        [accountId, userId],
      );
      if (!current.rows[0]) return 404;
      if (current.rows[0].role === "admin" && role === "member" && (await otherActiveAdmins(q, accountId, userId)) === 0) return 400;
      await q.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [accountId, userId, role]);
      return 200;
    });
    if (result === 404) return reply.code(404).send({ error: "essa pessoa não é da empresa" });
    if (result === 400) return reply.code(400).send({ error: "A empresa precisa de pelo menos um administrador. Promova outra pessoa antes." });
    return { user_id: userId, role };
  });

  /** Admin remove alguém; qualquer pessoa pode sair da empresa (menos o último admin). */
  api.delete("/api/accounts/:accountId/members/:userId", async (req, reply) => {
    const { accountId, userId } = params.extend({ userId: z.string().uuid() }).parse(req.params);
    const self = req.principal?.kind === "session" && req.principal.user.id === userId;
    if (!self && !requireAccountAdmin(req, reply)) return reply;
    const result = await deps.db.tx(async (q) => {
      const current = await q.query<{ role: string }>(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2 FOR UPDATE",
        [accountId, userId],
      );
      if (!current.rows[0]) return 404;
      if (current.rows[0].role === "admin" && (await otherActiveAdmins(q, accountId, userId)) === 0) return 400;
      await q.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
      return 200;
    });
    if (result === 404) return reply.code(404).send({ error: "essa pessoa não é da empresa" });
    if (result === 400) return reply.code(400).send({ error: "A empresa precisa de pelo menos um administrador. Promova outra pessoa antes." });
    return { ok: true };
  });

  api.get("/api/accounts/:accountId/invites", async (req, reply) => {
    if (!requireAccountAdmin(req, reply)) return reply;
    const { accountId } = params.parse(req.params);
    const { rows } = await deps.db.query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.created_at, u.name AS invited_by
         FROM account_invites i LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.account_id = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW(3)
        ORDER BY i.created_at DESC`,
      [accountId],
    );
    return rows;
  });

  /** Gera o link de convite. O token só aparece nesta resposta: o admin copia e manda para a pessoa. */
  api.post("/api/accounts/:accountId/invites", async (req, reply) => {
    if (!requireAccountAdmin(req, reply)) return reply;
    const { accountId } = params.parse(req.params);
    const body = z.object({ email, role: accountRole.default("member") }).parse(req.body);
    const already = await deps.db.query(
      `SELECT 1 FROM account_members m JOIN users u ON u.id = m.user_id
        WHERE m.account_id = $1 AND lower(u.email) = $2`,
      [accountId, body.email],
    );
    if (already.rows.length) return reply.code(409).send({ error: "Essa pessoa já faz parte da empresa." });

    const invitedBy = req.principal?.kind === "session" ? req.principal.user.id : null;
    const invite = await createInvite(deps.db, { accountId, email: body.email, role: body.role, invitedBy });
    return reply.code(201).send({
      id: invite.id,
      email: body.email,
      role: body.role,
      expires_at: invite.expiresAt.toISOString(),
      url: inviteUrl(req, deps, invite.token),
    });
  });

  api.delete("/api/accounts/:accountId/invites/:inviteId", async (req, reply) => {
    if (!requireAccountAdmin(req, reply)) return reply;
    const { accountId, inviteId } = params.extend({ inviteId: z.string().uuid() }).parse(req.params);
    const { affectedRows } = await deps.db.query("DELETE FROM account_invites WHERE id = $1 AND account_id = $2 AND accepted_at IS NULL", [
      inviteId,
      accountId,
    ]);
    if (affectedRows === 0) return reply.code(404).send({ error: "convite não encontrado" });
    return { ok: true };
  });
}

const GONE = { used: "Este convite já foi usado.", expired: "Este convite venceu. Peça um novo a quem te convidou." } as const;

/** Rotas públicas do convite (quem abre o link ainda pode não ter login). Registrado dentro de /auth. */
export function registerInviteRoutes(auth: FastifyInstance, deps: AppDeps): void {
  auth.get<{ Params: { token: string } }>("/auth/invites/:token", async (req, reply) => {
    const invite = await findInvite(deps.db, req.params.token);
    if (!invite) return reply.code(404).send({ error: "Convite não encontrado. Confira o link ou peça um novo." });
    if (invite.state !== "valid") return reply.code(410).send({ error: GONE[invite.state] });
    const user = await deps.db.query("SELECT 1 FROM users WHERE lower(email) = $1", [invite.email]);
    return { account_name: invite.accountName, email: invite.email, role: invite.role, has_user: user.rows.length > 0 };
  });

  /**
   * Aceita o convite. Logado: precisa ser o e-mail convidado. Sem login: cria a conta da pessoa com
   * aquele e-mail (se ela já tiver conta, precisa entrar primeiro, para ninguém aceitar no lugar dela).
   */
  auth.post<{ Params: { token: string } }>("/auth/invites/:token/accept", async (req, reply) => {
    const invite = await findInvite(deps.db, req.params.token);
    if (!invite) return reply.code(404).send({ error: "Convite não encontrado. Confira o link ou peça um novo." });
    if (invite.state !== "valid") return reply.code(410).send({ error: GONE[invite.state] });

    const principal = await resolvePrincipal(req, deps);
    if (principal?.kind === "session") {
      if (principal.user.email.toLowerCase() !== invite.email) {
        return reply.code(403).send({ error: `Este convite é para ${invite.email}. Saia e entre com esse e-mail para aceitar.` });
      }
      const ok = await deps.db.tx(async (q) => {
        if (!(await consumeInvite(q, invite.id))) return false;
        await addMember(q, invite.accountId, principal.user.id, invite.role);
        return true;
      });
      if (!ok) return reply.code(410).send({ error: GONE.used });
      return { user: principal.user, account_id: invite.accountId };
    }

    const existing = await deps.db.query("SELECT 1 FROM users WHERE lower(email) = $1", [invite.email]);
    if (existing.rows.length) {
      return reply.code(401).send({ error: "Já existe uma conta com esse e-mail. Entre com ela para aceitar o convite." });
    }
    const body = z.object({ name: z.string().trim().min(1).max(100), password }).parse(req.body);
    const hash = await hashPassword(body.password);
    const user = { id: randomUUID(), email: invite.email, name: body.name, role: "user" as const };
    const ok = await deps.db.tx(async (q) => {
      if (!(await consumeInvite(q, invite.id))) return false;
      await q.query("INSERT INTO users (id, email, name, password_hash, role, last_login_at) VALUES ($1, $2, $3, $4, 'user', NOW(3))", [
        user.id,
        user.email,
        user.name,
        hash,
      ]);
      await addMember(q, invite.accountId, user.id, invite.role);
      return true;
    });
    if (!ok) return reply.code(410).send({ error: GONE.used });
    const session = await createSession(deps.db, user.id, { userAgent: req.headers["user-agent"], ip: req.ip });
    setSessionCookie(reply, req, session.token);
    return { user, account_id: invite.accountId };
  });
}
