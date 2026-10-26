import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { dummyPasswordHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/passwords.js";
import { LoginRateLimiter } from "../auth/rate-limit.js";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  type SessionUser,
} from "../auth/sessions.js";

/** Quem está fazendo a chamada: um usuário logado (cookie) ou um script com o ADMIN_TOKEN. */
export type Principal =
  | { kind: "session"; role: "owner" | "member"; user: SessionUser; token: string }
  | { kind: "admin_token"; role: "owner" };

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const email = z.string().trim().toLowerCase().email("e-mail inválido").max(200);
export const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `a senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`)
  .max(200);

export function tokenMatches(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function resolvePrincipal(req: FastifyRequest, deps: AppDeps): Promise<Principal | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return tokenMatches(auth.slice(7).trim(), deps.config.adminToken) ? { kind: "admin_token", role: "owner" } : null;
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = await readSession(deps.db, token);
  return user && token ? { kind: "session", role: user.role, user, token } : null;
}

/**
 * Proteção contra CSRF para quem usa cookie: além do SameSite=Lax, pedidos que alteram dados
 * precisam vir da mesma origem (o navegador sempre manda Origin/Sec-Fetch-Site nesses casos).
 */
export function isSameOrigin(req: FastifyRequest): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.host;
  } catch {
    return false;
  }
}

const isSecure = (req: FastifyRequest) => req.protocol === "https";

function setSessionCookie(reply: FastifyReply, req: FastifyRequest, token: string) {
  reply.header("Set-Cookie", sessionCookie(token, { secure: isSecure(req), maxAgeMs: SESSION_TTL_MS }));
}

function clearSessionCookie(reply: FastifyReply, req: FastifyRequest) {
  reply.header("Set-Cookie", sessionCookie("", { secure: isSecure(req), maxAgeMs: 0 }));
}

const GENERIC_LOGIN_ERROR = "E-mail ou senha incorretos.";

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new LoginRateLimiter();

  app.register(async (auth) => {
    auth.setErrorHandler((err, _req, reply) => {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: err.issues.map((i) => i.message).join("; "), issues: err.issues });
      }
      return reply.send(err);
    });

    auth.addHook("preHandler", async (req, reply) => {
      if (req.method !== "GET" && !isSameOrigin(req)) return reply.code(403).send({ error: "origem não permitida" });
    });

    /** O painel pergunta se precisa criar o primeiro administrador. */
    auth.get("/auth/status", async () => {
      const { rows } = await deps.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM users");
      return { needs_setup: rows[0]!.n === 0 };
    });

    /** Cria o primeiro administrador. Exige o ADMIN_TOKEN para provar acesso ao servidor. */
    auth.post("/auth/setup", async (req, reply) => {
      const body = z
        .object({ admin_token: z.string(), name: z.string().trim().min(1).max(100), email, password })
        .parse(req.body);
      if (!tokenMatches(body.admin_token, deps.config.adminToken)) {
        return reply.code(403).send({ error: "Token de administrador incorreto. Ele está em ADMIN_TOKEN no .env do servidor." });
      }
      const hash = await hashPassword(body.password);
      const id = randomUUID();
      const inserted = await deps.db.query(
        `INSERT INTO users (id, email, name, password_hash, role, last_login_at)
         SELECT $1, $2, $3, $4, 'owner', NOW(3) FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM users)`,
        [id, body.email, body.name, hash],
      );
      if (inserted.affectedRows === 0) return reply.code(409).send({ error: "O administrador já foi criado. Entre com e-mail e senha." });
      const user: SessionUser = { id, email: body.email, name: body.name, role: "owner" };
      const session = await createSession(deps.db, user.id, { userAgent: req.headers["user-agent"], ip: req.ip });
      setSessionCookie(reply, req, session.token);
      return reply.code(201).send({ user });
    });

    auth.post("/auth/login", async (req, reply) => {
      const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
      const keys = [`ip:${req.ip}`, `email:${body.email}`];
      const wait = limiter.retryAfter(keys);
      if (wait > 0) {
        return reply
          .code(429)
          .header("Retry-After", String(wait))
          .send({ error: `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60)} min.` });
      }

      const { rows } = await deps.db.query<SessionUser & { password_hash: string; disabled: boolean }>(
        "SELECT id, email, name, role, password_hash, disabled FROM users WHERE lower(email) = $1",
        [body.email],
      );
      const found = rows[0];
      // Sempre roda o scrypt, exista o e-mail ou não, para o tempo de resposta não revelar quem tem conta.
      const ok = await verifyPassword(body.password, found?.password_hash ?? (await dummyPasswordHash()));
      if (!found || !ok || found.disabled) {
        limiter.fail(keys);
        return reply.code(401).send({ error: GENERIC_LOGIN_ERROR });
      }

      limiter.succeed(keys);
      await deps.db.query("UPDATE users SET last_login_at = NOW(3) WHERE id = $1", [found.id]);
      const session = await createSession(deps.db, found.id, { userAgent: req.headers["user-agent"], ip: req.ip });
      setSessionCookie(reply, req, session.token);
      return { user: { id: found.id, email: found.email, name: found.name, role: found.role } };
    });

    auth.post("/auth/logout", async (req, reply) => {
      await deleteSession(deps.db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      clearSessionCookie(reply, req);
      return { ok: true };
    });

    auth.get("/auth/me", async (req, reply) => {
      const principal = await resolvePrincipal(req, deps);
      if (!principal || principal.kind !== "session") return reply.code(401).send({ error: "não autenticado" });
      return { user: principal.user };
    });

    auth.post("/auth/password", async (req, reply) => {
      const principal = await resolvePrincipal(req, deps);
      if (!principal || principal.kind !== "session") return reply.code(401).send({ error: "não autenticado" });
      const body = z.object({ current_password: z.string().min(1), new_password: password }).parse(req.body);
      const { rows } = await deps.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
        principal.user.id,
      ]);
      if (!rows[0] || !(await verifyPassword(body.current_password, rows[0].password_hash))) {
        return reply.code(400).send({ error: "A senha atual não confere." });
      }
      await deps.db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [principal.user.id, await hashPassword(body.new_password)]);
      // Desconecta os outros aparelhos; esta sessão continua.
      await deleteUserSessions(deps.db, principal.user.id, principal.token);
      return { ok: true };
    });
  });
}
