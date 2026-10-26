import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drain } from "../src/worker/run.js";
import { refreshDueTokens } from "../src/worker/token-refresh.js";
import { auth, IG_ACCOUNT_ID, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  env.app.inject({ method, url: `/api/accounts/${env.accountId}${url}`, headers: auth(), payload: payload as object });

async function sandbox() {
  const res = await call("POST", "/connections/sandbox", {});
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; ig_user_id: string; username: string; sandbox: boolean };
}

async function automation(extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/automations/comment-to-dm", {
    name: "Promo",
    keywords: ["quero"],
    public_replies: ["Te chamei no direct, @{{username}}!"],
    opening: { text: "Quer o link?", button_caption: "Quero!" },
    dm: { text: "Aqui está", buttons: [{ caption: "Abrir", url: "https://loja.exemplo" }] },
    tag: "lead",
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { flowId: string };
}

describe("painel estático", () => {
  it("serve o HTML do painel com CSP e os arquivos estáticos", async () => {
    const page = await env.app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.body).toContain('src="/panel/app.js"');

    for (const [file, type] of [
      ["app.js", "javascript"],
      ["styles.css", "css"],
      ["favicon.svg", "svg"],
      ["kora-wordmark.svg", "svg"],
      ["kora-wordmark-white.svg", "svg"],
    ]) {
      const res = await env.app.inject({ url: `/panel/${file}` });
      expect(res.statusCode, file).toBe(200);
      expect(res.headers["content-type"]).toContain(type);
    }
    expect((await env.app.inject({ url: "/panel/../package.json" })).statusCode).toBe(404);
  });

  it("publica a Política de Privacidade e os Termos sem login (a Meta exige a URL)", async () => {
    for (const [url, title] of [
      ["/privacidade", "Política de Privacidade"],
      ["/termos", "Termos de Uso"],
    ]) {
      const res = await env.app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.body).toContain(`<h1>${title}</h1>`);
    }
    // As páginas HTML não ficam expostas também em /panel/.
    expect((await env.app.inject({ url: "/panel/legal/termos.html" })).statusCode).toBe(404);
  });
});

describe("contas e automações", () => {
  it("lista contas", async () => {
    const res = await env.app.inject({ url: "/api/accounts", headers: auth() });
    expect(res.json()).toMatchObject([{ id: env.accountId, name: "Loja Teste" }]);
  });

  it("lista automações com gatilho e grafo, e pausa/reativa", async () => {
    const { flowId } = await automation();
    const list = (await call("GET", "/automations")).json();
    expect(list).toMatchObject([
      { id: flowId, name: "Promo", active: true, trigger_type: "comment", config: { keywords: ["quero"] } },
    ]);
    expect(list[0].graph.nodes.dm.content.content.messages[0].text).toBe("Aqui está");

    const paused = await call("PATCH", `/automations/${flowId}`, { active: false });
    expect(paused.json()).toEqual({ id: flowId, active: false });
    expect((await call("GET", "/automations")).json()[0].active).toBe(false);

    expect((await call("PATCH", "/automations/00000000-0000-0000-0000-000000000000", { active: true })).statusCode).toBe(404);
  });

  it("recusa links que não são http(s) nos botões", async () => {
    const res = await call("POST", "/automations/comment-to-dm", {
      keywords: [],
      dm: { text: "Oi", buttons: [{ caption: "x", url: "javascript:alert(1)" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("http");
  });
});

describe("simulador", () => {
  it("cria conta de teste que nunca chama o Instagram nem entra na renovação de token", async () => {
    const c = await sandbox();
    expect(c).toMatchObject({ username: "minha_loja_teste", sandbox: true });
    expect(c.ig_user_id).toMatch(/^sandbox-[0-9a-f]{12}$/);

    const connections = (await call("GET", "/connections")).json();
    expect(connections.find((x: { id: string }) => x.id === c.id).sandbox).toBe(true);

    await env.db.query("UPDATE channel_connections SET token_issued_at = NOW(3) - INTERVAL 3 DAY WHERE sandbox");
    const refreshed = await refreshDueTokens({
      db: env.db, oauth: env.oauth, tokenEncryptionKey: env.config.tokenEncryptionKey, refreshDaysBefore: 15,
    });
    expect(refreshed.map((r) => r.connectionId)).not.toContain(c.id);
  });

  it("comentário simulado roda a automação completa, em duas etapas, sem tocar no Instagram", async () => {
    const c = await sandbox();
    await automation();

    const commented = await call("POST", "/simulate/comment", { connection_id: c.id, username: "Maria.Teste", text: "QUERO!" });
    expect(commented.statusCode).toBe(202);
    expect(commented.json().igsid).toBe("sim-maria.teste");
    await drain(env.worker);

    let thread = (await call("GET", `/messages?connection_id=${c.id}&igsid=sim-maria.teste`)).json();
    expect(thread.map((m: { kind: string; status: string }) => `${m.kind}:${m.status}`).reverse()).toEqual([
      "comment:received",
      "comment_reply:sent",
      "private_reply:sent",
    ]);
    const opening = thread.find((m: { kind: string }) => m.kind === "private_reply");
    expect(opening.payload.recipient).toEqual({ comment_id: expect.stringMatching(/^sim-comment-/) });
    const qr = opening.payload.message.quick_replies[0];
    expect(qr.title).toBe("Quero!");

    // Toque no botão.
    const tapped = await call("POST", "/simulate/message", {
      connection_id: c.id, username: "Maria.Teste", text: qr.title, quick_reply_payload: qr.payload,
    });
    expect(tapped.statusCode).toBe(202);
    await drain(env.worker);

    thread = (await call("GET", `/messages?connection_id=${c.id}&igsid=sim-maria.teste`)).json();
    const last = thread[0];
    expect(last).toMatchObject({ kind: "dm", direction: "outbound", status: "sent", username: "Maria.Teste" });
    expect(last.payload.recipient).toEqual({ id: "sim-maria.teste" });

    // Nada passou pelo cliente "real" do Instagram.
    expect(env.ig.calls).toHaveLength(0);
    const [contact] = (await call("GET", "/contacts")).json();
    expect(contact.tags).toEqual(["lead"]);
  });

  it("automação pausada não responde", async () => {
    const c = await sandbox();
    const { flowId } = await automation();
    await call("PATCH", `/automations/${flowId}`, { active: false });
    await call("POST", "/simulate/comment", { connection_id: c.id, username: "joao", text: "quero" });
    expect(await drain(env.worker)).toMatchObject([{ status: "ignored", reason: "nenhum gatilho de comentário casou" }]);
  });

  it("filtra o post pelo ID informado", async () => {
    const c = await sandbox();
    await automation({ media_ids: ["post-a"] });
    await call("POST", "/simulate/comment", { connection_id: c.id, username: "ana", text: "quero", media_id: "post-b" });
    await call("POST", "/simulate/comment", { connection_id: c.id, username: "ana", text: "quero", media_id: "post-a" });
    const outcomes = await drain(env.worker);
    expect(outcomes.map((o) => (typeof o === "object" ? o.status : o))).toEqual(["ignored", "ran"]);
  });

  it("só aceita conexões de teste da própria conta e valida o usuário", async () => {
    const real = (await call("GET", "/connections")).json().find((x: { ig_user_id: string }) => x.ig_user_id === IG_ACCOUNT_ID);
    const onReal = await call("POST", "/simulate/comment", { connection_id: real.id, username: "ana", text: "oi" });
    expect(onReal.statusCode).toBe(404);

    const c = await sandbox();
    const other = await env.app.inject({ method: "POST", url: "/api/accounts", headers: auth(), payload: { name: "Outra" } });
    const foreign = await env.app.inject({
      method: "POST",
      url: `/api/accounts/${other.json().id}/simulate/comment`,
      headers: auth(),
      payload: { connection_id: c.id, username: "ana", text: "oi" },
    });
    expect(foreign.statusCode).toBe(404);

    expect((await call("POST", "/simulate/comment", { connection_id: c.id, username: "<script>", text: "oi" })).statusCode).toBe(400);
    expect((await call("POST", "/simulate/message", { connection_id: c.id, username: "ana", text: "  " })).statusCode).toBe(400);
    expect((await env.db.query("SELECT 1 FROM scheduled_jobs")).rows).toHaveLength(0);
  });
});
