import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { drain } from "../src/worker/run.js";
import { ADMIN, commentWebhook, postWebhook, setup, testConfig, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const HOST = "painel.test";
type Inject = { method?: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown; cookie?: string; headers?: Record<string, string> };
const req = ({ method = "GET", url, payload, cookie, headers }: Inject, app = env.app) =>
  app.inject({
    method,
    url,
    payload: payload as object,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { origin: `http://${HOST}` } : {}), ...headers },
  });

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const m = /sid=([^;]*)/.exec(String(res.headers["set-cookie"] ?? ""));
  if (!m) throw new Error("sem cookie de sessão");
  return `sid=${m[1]}`;
}

async function signup(company: string, email: string, password = "senha-forte-1") {
  const res = await req({ method: "POST", url: "/auth/signup", payload: { name: `Admin ${company}`, email, password, company_name: company } });
  expect(res.statusCode, res.body).toBe(201);
  return { cookie: cookieOf(res), accountId: res.json().account.id as string, userId: res.json().user.id as string };
}

async function superadmin() {
  const res = await req({ method: "POST", url: "/auth/setup", payload: { admin_token: ADMIN, name: "Dono", email: "dono@kora.test", password: "senha-do-dono" } });
  expect(res.statusCode, res.body).toBe(201);
  return cookieOf(res);
}

async function invite(cookie: string, accountId: string, email: string, role = "member") {
  const res = await req({ method: "POST", url: `/api/accounts/${accountId}/invites`, cookie, payload: { email, role } });
  expect(res.statusCode, res.body).toBe(201);
  const { url } = res.json() as { url: string };
  return new URL(url).hash.replace("#/convite/", "");
}

describe("cadastro", () => {
  it("cria a pessoa e a empresa dela, já logada como administradora", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const accounts = (await req({ url: "/api/accounts", cookie: a.cookie })).json();
    expect(accounts).toEqual([expect.objectContaining({ id: a.accountId, name: "Loja A", my_role: "admin", status: "active" })]);
    const me = (await req({ url: "/auth/me", cookie: a.cookie })).json();
    expect(me.user).toMatchObject({ email: "ana@lojaa.com", role: "user" });
  });

  it("e-mail repetido é recusado sem revelar a senha de ninguém", async () => {
    await signup("Loja A", "ana@lojaa.com");
    const dup = await req({ method: "POST", url: "/auth/signup", payload: { name: "X", email: "ANA@lojaa.com", password: "outra-senha-1", company_name: "Y" } });
    expect(dup.statusCode).toBe(409);
  });

  it("pode ser desligado com SIGNUP_ENABLED=false", async () => {
    const closed = buildApp({ config: testConfig({ SIGNUP_ENABLED: "false" }), db: env.db });
    try {
      expect((await req({ url: "/auth/status" }, closed)).json()).toMatchObject({ signup_enabled: false });
      const res = await req({ method: "POST", url: "/auth/signup", payload: { name: "X", email: "x@x.com", password: "12345678", company_name: "Y" } }, closed);
      expect(res.statusCode).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe("isolamento entre empresas", () => {
  it("cada empresa só enxerga o que é dela", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const b = await signup("Loja B", "bia@lojab.com");

    expect((await req({ url: "/api/accounts", cookie: a.cookie })).json().map((x: { id: string }) => x.id)).toEqual([a.accountId]);
    for (const path of ["/contacts", "/automations", "/messages", "/connections", "/members", "/invites"]) {
      expect((await req({ url: `/api/accounts/${b.accountId}${path}`, cookie: a.cookie })).statusCode, path).toBe(404);
      expect((await req({ url: `/api/accounts/${env.accountId}${path}`, cookie: b.cookie })).statusCode, path).toBe(404);
    }
    const write = await req({ method: "POST", url: `/api/accounts/${b.accountId}/automations/comment-to-dm`, cookie: a.cookie, payload: { dm: { text: "x" } } });
    expect(write.statusCode).toBe(404);
  });

  it("qualquer pessoa logada pode abrir outra empresa e vira administradora dela", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const created = await req({ method: "POST", url: "/api/accounts", cookie: a.cookie, payload: { name: "Loja A2" } });
    expect(created.statusCode).toBe(201);
    const accounts = (await req({ url: "/api/accounts", cookie: a.cookie })).json();
    expect(accounts.map((x: { name: string; my_role: string }) => `${x.name}:${x.my_role}`).sort()).toEqual(["Loja A2:admin", "Loja A:admin"]);
  });

  it("a mesma conta do Instagram não pode ficar em duas empresas", async () => {
    const b = await signup("Loja B", "bia@lojab.com");
    // env.accountId já tem a conta IG_ACCOUNT_ID conectada (setup dos testes).
    const res = await req({
      method: "POST",
      url: `/api/accounts/${b.accountId}/connections/instagram`,
      cookie: b.cookie,
      payload: { ig_user_id: "17841400000000001", access_token: "IGAA-outro-token" },
    });
    expect(res.statusCode).toBe(409);
    const { rows } = await env.db.query<{ account_id: string }>("SELECT account_id FROM channel_connections WHERE external_account_id = '17841400000000001'");
    expect(rows).toEqual([{ account_id: env.accountId }]);
  });
});

describe("convites e papéis", () => {
  it("convite cria a conta da pessoa convidada e dá acesso só àquela empresa", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const token = await invite(a.cookie, a.accountId, "Bruno@LojaA.com");

    const info = (await req({ url: `/auth/invites/${token}` })).json();
    expect(info).toMatchObject({ account_name: "Loja A", email: "bruno@lojaa.com", role: "member", has_user: false });

    const accepted = await req({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { name: "Bruno", password: "senha-do-bruno" } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const bruno = cookieOf(accepted);
    expect((await req({ url: "/api/accounts", cookie: bruno })).json()).toEqual([expect.objectContaining({ id: a.accountId, my_role: "member" })]);

    // O link é de uso único.
    expect((await req({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { name: "X", password: "12345678" } })).statusCode).toBe(410);
  });

  it("quem já tem conta precisa entrar com o e-mail convidado para aceitar", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const b = await signup("Loja B", "bia@lojab.com");
    const token = await invite(a.cookie, a.accountId, "bia@lojab.com", "admin");

    expect((await req({ url: `/auth/invites/${token}` })).json()).toMatchObject({ has_user: true });
    expect((await req({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { name: "Bia", password: "qualquer-1" } })).statusCode).toBe(401);

    // Logado com outro e-mail: recusado.
    expect((await req({ method: "POST", url: `/auth/invites/${token}/accept`, cookie: a.cookie, payload: {} })).statusCode).toBe(403);

    const ok = await req({ method: "POST", url: `/auth/invites/${token}/accept`, cookie: b.cookie, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    const accounts = (await req({ url: "/api/accounts", cookie: b.cookie })).json();
    expect(accounts.map((x: { name: string; my_role: string }) => `${x.name}:${x.my_role}`).sort()).toEqual(["Loja A:admin", "Loja B:admin"]);
  });

  it("convite vencido ou revogado não vale", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const vencido = await invite(a.cookie, a.accountId, "c@c.com");
    await env.db.query("UPDATE account_invites SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE email = 'c@c.com'");
    expect((await req({ url: `/auth/invites/${vencido}` })).statusCode).toBe(410);

    const revogado = await invite(a.cookie, a.accountId, "d@d.com");
    const pending = (await req({ url: `/api/accounts/${a.accountId}/invites`, cookie: a.cookie })).json();
    const id = pending.find((i: { email: string }) => i.email === "d@d.com").id;
    expect((await req({ method: "DELETE", url: `/api/accounts/${a.accountId}/invites/${id}`, cookie: a.cookie })).statusCode).toBe(200);
    expect((await req({ url: `/auth/invites/${revogado}` })).statusCode).toBe(404);
    expect((await req({ url: "/auth/invites/token-inventado" })).statusCode).toBe(404);
  });

  it("membro opera, mas não convida, não conecta Instagram e não mexe na equipe", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const token = await invite(a.cookie, a.accountId, "bruno@lojaa.com");
    const bruno = cookieOf(await req({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { name: "Bruno", password: "senha-do-bruno" } }));
    const base = `/api/accounts/${a.accountId}`;

    const auto = await req({ method: "POST", url: `${base}/automations/comment-to-dm`, cookie: bruno, payload: { dm: { text: "Oi" } } });
    expect(auto.statusCode).toBe(201);
    expect((await req({ method: "POST", url: `${base}/connections/sandbox`, cookie: bruno, payload: {} })).statusCode).toBe(201);
    expect((await req({ url: `${base}/members`, cookie: bruno })).statusCode).toBe(200);

    expect((await req({ method: "POST", url: `${base}/invites`, cookie: bruno, payload: { email: "x@x.com" } })).statusCode).toBe(403);
    expect((await req({ url: `${base}/invites`, cookie: bruno })).statusCode).toBe(403);
    const ig = await req({ method: "POST", url: `${base}/connections/instagram`, cookie: bruno, payload: { ig_user_id: "123", access_token: "IGAA-token-x" } });
    expect(ig.statusCode).toBe(403);
    expect((await req({ method: "PATCH", url: base, cookie: bruno, payload: { name: "Outro nome" } })).statusCode).toBe(403);
    expect((await req({ url: "/api/platform/accounts", cookie: bruno })).statusCode).toBe(403);
  });

  it("administrador promove, rebaixa e remove; a empresa nunca fica sem administrador", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const token = await invite(a.cookie, a.accountId, "bruno@lojaa.com");
    const bruno = cookieOf(await req({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { name: "Bruno", password: "senha-do-bruno" } }));
    const base = `/api/accounts/${a.accountId}`;
    const members = (await req({ url: `${base}/members`, cookie: a.cookie })).json();
    const brunoId = members.find((m: { email: string }) => m.email === "bruno@lojaa.com").user_id;

    // Única administradora não pode se rebaixar nem sair.
    expect((await req({ method: "PATCH", url: `${base}/members/${a.userId}`, cookie: a.cookie, payload: { role: "member" } })).statusCode).toBe(400);
    expect((await req({ method: "DELETE", url: `${base}/members/${a.userId}`, cookie: a.cookie })).statusCode).toBe(400);

    expect((await req({ method: "PATCH", url: `${base}/members/${brunoId}`, cookie: a.cookie, payload: { role: "admin" } })).statusCode).toBe(200);
    expect((await req({ url: `${base}/invites`, cookie: bruno })).statusCode).toBe(200);

    expect((await req({ method: "DELETE", url: `${base}/members/${brunoId}`, cookie: a.cookie })).statusCode).toBe(200);
    expect((await req({ url: `${base}/contacts`, cookie: bruno })).statusCode).toBe(404);
    expect((await req({ url: "/api/accounts", cookie: bruno })).json()).toEqual([]);
  });

  it("não convida quem já é da empresa", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    const res = await req({ method: "POST", url: `/api/accounts/${a.accountId}/invites`, cookie: a.cookie, payload: { email: "ana@lojaa.com" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("super-admin da plataforma", () => {
  it("vê todas as empresas e pode suspender uma (painel só leitura, worker ignora os eventos)", async () => {
    const dono = await superadmin();
    const a = await signup("Loja A", "ana@lojaa.com");

    const list = (await req({ url: "/api/platform/accounts", cookie: dono })).json();
    expect(list.map((x: { name: string }) => x.name).sort()).toEqual(["Loja A", "Loja Teste"]);
    expect(list.find((x: { name: string }) => x.name === "Loja A")).toMatchObject({ status: "active", members: 1, admins: ["ana@lojaa.com"] });

    // O super-admin também vê e entra em qualquer empresa.
    expect((await req({ url: `/api/accounts/${a.accountId}/contacts`, cookie: dono })).statusCode).toBe(200);

    const susp = await req({ method: "PATCH", url: `/api/platform/accounts/${a.accountId}`, cookie: dono, payload: { status: "suspended" } });
    expect(susp.statusCode).toBe(200);
    expect((await req({ url: `/api/accounts/${a.accountId}/automations`, cookie: a.cookie })).statusCode).toBe(200);
    const blocked = await req({ method: "POST", url: `/api/accounts/${a.accountId}/automations/comment-to-dm`, cookie: a.cookie, payload: { dm: { text: "x" } } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toContain("suspensa");

    // Empresa suspensa: o webhook é recebido, mas nada é enviado.
    await req({ method: "PATCH", url: `/api/platform/accounts/${env.accountId}`, cookie: dono, payload: { status: "suspended" } });
    await env.app.inject({
      method: "POST", url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
      headers: { authorization: `Bearer ${ADMIN}` }, payload: { dm: { text: "Oi" } },
    });
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "oi" }));
    expect(await drain(env.worker)).toEqual([{ status: "ignored", reason: "empresa suspensa" }]);
    expect(env.ig.calls).toEqual([]);
  });

  it("gerencia as pessoas da plataforma, mas nunca fica sem super-admin", async () => {
    const dono = await superadmin();
    const a = await signup("Loja A", "ana@lojaa.com");
    const users = (await req({ url: "/api/users", cookie: dono })).json();
    expect(users.map((u: { email: string; role: string }) => `${u.email}:${u.role}`).sort()).toEqual(["ana@lojaa.com:user", "dono@kora.test:superadmin"]);

    expect((await req({ method: "PATCH", url: `/api/users/${a.userId}`, cookie: dono, payload: { disabled: true } })).statusCode).toBe(200);
    expect((await req({ url: "/auth/me", cookie: a.cookie })).statusCode).toBe(401);

    const meId = (await req({ url: "/auth/me", cookie: dono })).json().user.id;
    expect((await req({ method: "PATCH", url: `/api/users/${meId}`, cookie: dono, payload: { role: "user" } })).statusCode).toBe(400);
    const viaToken = await req({ method: "PATCH", url: `/api/users/${meId}`, payload: { disabled: true }, headers: { authorization: `Bearer ${ADMIN}` } });
    expect(viaToken.statusCode).toBe(400);
    expect(viaToken.json().error).toContain("super-admin");
  });

  it("rotas da plataforma são só do super-admin", async () => {
    const a = await signup("Loja A", "ana@lojaa.com");
    expect((await req({ url: "/api/platform/accounts", cookie: a.cookie })).statusCode).toBe(403);
    expect((await req({ url: "/api/users", cookie: a.cookie })).statusCode).toBe(403);
    expect((await req({ method: "PATCH", url: `/api/platform/accounts/${a.accountId}`, cookie: a.cookie, payload: { status: "suspended" } })).statusCode).toBe(403);
  });
});
