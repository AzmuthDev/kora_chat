import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./mysql-test-db.js";
import { buildApp } from "../src/http/app.js";
import { ADMIN, setup, testConfig, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const HOST = "painel.test";
const OWNER = { name: "Ana Admin", email: "Ana@Loja.com", password: "senha-forte-1" };

type Inject = { method?: "GET" | "POST" | "PATCH"; url: string; payload?: unknown; cookie?: string; headers?: Record<string, string> };
const req = ({ method = "GET", url, payload, cookie, headers }: Inject) =>
  env.app.inject({
    method,
    url,
    payload: payload as object,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: `http://${HOST}` } : {}), ...headers },
  });

function sessionCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers["set-cookie"] ?? "");
  const m = /sid=([^;]*)/.exec(raw);
  if (!m) throw new Error(`sem cookie: ${raw}`);
  return `sid=${m[1]}`;
}

async function createOwner() {
  const res = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: ADMIN, ...OWNER } });
  expect(res.statusCode, res.body).toBe(201);
  return sessionCookieOf(res);
}

async function login(emailAddr: string, password: string) {
  return req({ method: "POST", url: "/auth/login", payload: { email: emailAddr, password } });
}

describe("primeiro acesso", () => {
  it("exige o ADMIN_TOKEN, cria o administrador uma única vez e já deixa logado", async () => {
    expect((await req({ url: "/auth/status" })).json()).toMatchObject({ needs_setup: true });

    const wrong = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: "errado", ...OWNER } });
    expect(wrong.statusCode).toBe(403);

    const res = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: ADMIN, ...OWNER } });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: "ana@loja.com", name: "Ana Admin", role: "superadmin" });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure"); // HTTP local; com proxy HTTPS vira Secure

    const again = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: ADMIN, ...OWNER, email: "b@b.com" } });
    expect(again.statusCode).toBe(409);
    expect((await req({ url: "/auth/status" })).json()).toMatchObject({ needs_setup: false });

    const me = await req({ url: "/auth/me", cookie: sessionCookieOf(res) });
    expect(me.json().user.email).toBe("ana@loja.com");
  });

  it("valida e-mail e tamanho da senha", async () => {
    const res = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: ADMIN, name: "A", email: "x", password: "123" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("e-mail inválido");
    expect(res.json().error).toContain("8 caracteres");
  });

  it("guarda só o hash da senha", async () => {
    await createOwner();
    const { rows } = await env.db.query<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(rows[0]!.password_hash).not.toContain(OWNER.password);
  });
});

describe("login e sessão", () => {
  beforeEach(async () => {
    await createOwner();
  });

  it("entra com e-mail (sem diferenciar maiúsculas) e senha; erro genérico quando falha", async () => {
    const ok = await login("ANA@loja.com", OWNER.password);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe("superadmin");

    const badPass = await login(OWNER.email, "senha-errada");
    const noUser = await login("ninguem@loja.com", "qualquer-coisa");
    expect(badPass.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(badPass.json().error).toBe(noUser.json().error);

    const { rows } = await env.db.query<{ last_login_at: string | null }>("SELECT last_login_at FROM users");
    expect(rows[0]!.last_login_at).not.toBeNull();
  });

  it("bloqueia depois de 10 tentativas erradas", async () => {
    for (let i = 0; i < 10; i++) expect((await login(OWNER.email, `errada-${i}`)).statusCode).toBe(401);
    const blocked = await login(OWNER.email, OWNER.password);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("sair invalida a sessão", async () => {
    const cookie = sessionCookieOf(await login(OWNER.email, OWNER.password));
    expect((await req({ url: "/api/accounts", cookie })).statusCode).toBe(200);
    const out = await req({ method: "POST", url: "/auth/logout", cookie });
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await req({ url: "/api/accounts", cookie })).statusCode).toBe(401);
    expect((await req({ url: "/auth/me", cookie })).statusCode).toBe(401);
  });

  it("cookie inventado não entra", async () => {
    expect((await req({ url: "/api/accounts", cookie: "sid=inventado" })).statusCode).toBe(401);
    expect((await req({ url: "/api/accounts" })).statusCode).toBe(401);
  });

  it("bloqueia pedidos de outra origem (CSRF)", async () => {
    const cookie = sessionCookieOf(await login(OWNER.email, OWNER.password));
    const evil = await req({ method: "POST", url: "/api/accounts", cookie, payload: { name: "x" }, headers: { origin: "https://site-malicioso.com" } });
    expect(evil.statusCode).toBe(403);
    const crossSite = await req({ method: "POST", url: "/api/accounts", cookie, payload: { name: "x" }, headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.statusCode).toBe(403);
    const same = await req({ method: "POST", url: "/api/accounts", cookie, payload: { name: "Minha loja" } });
    expect(same.statusCode).toBe(201);
  });

  it("trocar a senha exige a atual e derruba as outras sessões", async () => {
    const phone = sessionCookieOf(await login(OWNER.email, OWNER.password));
    const laptop = sessionCookieOf(await login(OWNER.email, OWNER.password));

    const wrong = await req({ method: "POST", url: "/auth/password", cookie: laptop, payload: { current_password: "x", new_password: "nova-senha-123" } });
    expect(wrong.statusCode).toBe(400);

    const ok = await req({
      method: "POST", url: "/auth/password", cookie: laptop,
      payload: { current_password: OWNER.password, new_password: "nova-senha-123" },
    });
    expect(ok.statusCode).toBe(200);
    expect((await req({ url: "/auth/me", cookie: laptop })).statusCode).toBe(200);
    expect((await req({ url: "/auth/me", cookie: phone })).statusCode).toBe(401);
    expect((await login(OWNER.email, OWNER.password)).statusCode).toBe(401);
    expect((await login(OWNER.email, "nova-senha-123")).statusCode).toBe(200);
  });
});

describe("atrás de proxy HTTPS", () => {
  it("cookie fica Secure quando TRUST_PROXY=true e o proxy informa https", async () => {
    const testDb = await createTestDb();
    const app = buildApp({ config: testConfig({ TRUST_PROXY: "true" }), db: testDb.db });
    const res = await app.inject({
      method: "POST",
      url: "/auth/setup",
      headers: { host: HOST, origin: `https://${HOST}`, "x-forwarded-proto": "https" },
      payload: { admin_token: ADMIN, ...OWNER },
    });
    expect(res.statusCode).toBe(201);
    expect(String(res.headers["set-cookie"])).toContain("Secure");
    await app.close();
    await testDb.drop();
  });
});
