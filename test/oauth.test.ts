import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../src/crypto/tokens.js";
import { IgApiError } from "../src/instagram/client.js";
import { signMetaPayload } from "../src/instagram/signature.js";
import { upsertInstagramConnection } from "../src/store/connections.js";
import { drain } from "../src/worker/run.js";
import { refreshDueTokens, type TokenRefreshDeps } from "../src/worker/token-refresh.js";
import { auth, commentWebhook, IG_APP_SECRET, postWebhook, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(async () => {
  await env?.close();
});

async function startOAuth(): Promise<string> {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/connections/instagram/oauth`,
    headers: auth(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return new URL(res.json().authorize_url).searchParams.get("state")!;
}

const callback = (query: string) => env.app.inject({ url: `/oauth/instagram/callback?${query}` });

async function connection(igUserId: string) {
  const { rows } = await env.db.query<{
    account_id: string; status: string; username: string; access_token_enc: string;
    token_expires_at: Date; scopes: string[]; last_refresh_error: string | null;
    token_refreshed_at: Date | null; refresh_locked_until: Date | null;
  }>("SELECT * FROM channel_connections WHERE external_account_id = $1", [igUserId]);
  return rows[0];
}

describe("login OAuth do Instagram", () => {
  beforeEach(async () => {
    env = await setup();
  });

  it("gera link de autorização com state de uso único", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/connections/instagram/oauth`,
      headers: auth(),
    });
    const { authorize_url, expires_at } = res.json();
    const url = new URL(authorize_url);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123456789");
    expect(url.searchParams.get("redirect_uri")).toBe("https://clone.exemplo/oauth/instagram/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
    );
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(new Date(expires_at).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    const { rows } = await env.db.query("SELECT account_id FROM oauth_states WHERE state = $1", [state]);
    expect(rows).toEqual([{ account_id: env.accountId }]);
  });

  it("exige token admin e conta existente", async () => {
    const noAuth = await env.app.inject({ method: "POST", url: `/api/accounts/${env.accountId}/connections/instagram/oauth` });
    expect(noAuth.statusCode).toBe(401);
    const missing = await env.app.inject({
      method: "POST",
      url: "/api/accounts/00000000-0000-0000-0000-000000000000/connections/instagram/oauth",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("callback troca o code, pega token longo, assina webhooks e grava a conexão", async () => {
    const state = await startOAuth();
    const res = await callback(`code=ABC123%23_&state=${state}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("@novaloja");

    const c = (await connection("17841400000000777"))!;
    expect(c).toMatchObject({ account_id: env.accountId, status: "active", username: "novaloja" });
    expect(c.scopes).toEqual(env.oauth.permissions);
    expect(decryptToken(c.access_token_enc, env.config.tokenEncryptionKey)).toBe("long:short:ABC123#_");
    const days = (new Date(c.token_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    expect(env.oauth.subscribed).toEqual([{ accessToken: "long:short:ABC123#_", fields: ["comments", "messages"] }]);

    // A conta conectada já recebe automações com o token novo.
    await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
      headers: auth(),
      payload: { keywords: [], dm: { text: "Oi" } },
    });
    const body = commentWebhook({ commentId: "c-oauth", text: "oi" });
    body.entry[0]!.id = "17841400000000777";
    await postWebhook(env, body);
    await drain(env.worker);
    expect(env.ig.calls).toMatchObject([{ op: "sendMessage", accessToken: "long:short:ABC123#_", igAccountId: "17841400000000777" }]);

    const list = (await env.app.inject({ url: `/api/accounts/${env.accountId}/connections`, headers: auth() })).json();
    expect(list.map((x: { username: string }) => x.username)).toEqual(["lojateste", "novaloja"]);
    expect(JSON.stringify(list)).not.toContain("long:short");
  });

  it("state não pode ser reutilizado, inventado ou vencido", async () => {
    const state = await startOAuth();
    expect((await callback(`code=A&state=${state}`)).statusCode).toBe(200);
    expect((await callback(`code=B&state=${state}`)).statusCode).toBe(400);
    expect((await callback("code=C&state=inventado")).statusCode).toBe(400);
    expect((await callback("code=D")).statusCode).toBe(400);

    const old = await startOAuth();
    await env.db.query("UPDATE oauth_states SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE state = $1", [old]);
    const res = await callback(`code=E&state=${old}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("expirado");
  });

  it("usuário cancelou no Instagram", async () => {
    const state = await startOAuth();
    const res = await callback(`error=access_denied&error_reason=user_denied&error_description=Permissions+error&state=${state}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Conexão cancelada");
    expect(await connection("17841400000000777")).toBeUndefined();
  });

  it("recusa quando o usuário desmarcou permissões necessárias", async () => {
    env.oauth.permissions = ["instagram_business_basic", "instagram_business_manage_comments"];
    const state = await startOAuth();
    const res = await callback(`code=X&state=${state}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("instagram_business_manage_messages");
    expect(await connection("17841400000000777")).toBeUndefined();
    expect(env.oauth.subscribed).toHaveLength(0);
  });

  it("erro do Instagram na troca do code vira página 502 e não grava nada", async () => {
    env.oauth.exchangeError = new IgApiError("Error validating verification code", 400, 100);
    const state = await startOAuth();
    const res = await callback(`code=X&state=${state}`);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("Error validating verification code");
    expect(await connection("17841400000000777")).toBeUndefined();
  });

  it("reconectar reativa uma conexão expirada", async () => {
    await callback(`code=1&state=${await startOAuth()}`);
    await env.db.query("UPDATE channel_connections SET status = 'expired', last_refresh_error = 'x' WHERE username = 'novaloja'");
    await callback(`code=2&state=${await startOAuth()}`);
    const c = (await connection("17841400000000777"))!;
    expect(c.status).toBe("active");
    expect(c.last_refresh_error).toBeNull();
    expect(decryptToken(c.access_token_enc, env.config.tokenEncryptionKey)).toBe("long:short:2");
  });

  it("aceita webhook assinado com o segredo do app do Instagram", async () => {
    const raw = JSON.stringify(commentWebhook({ commentId: "c-ig", text: "oi" }));
    const res = await env.app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(raw, IG_APP_SECRET) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("OAuth sem configuração", () => {
  it("responde 503 em vez de gerar link quebrado", async () => {
    env = await setup({ oauth: false });
    const res = await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/connections/instagram/oauth`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(503);
    expect((await callback("code=1&state=x")).statusCode).toBe(503);
  });
});

describe("renovação automática do token longo", () => {
  let deps: TokenRefreshDeps;
  beforeEach(async () => {
    env = await setup();
    deps = { db: env.db, oauth: env.oauth, tokenEncryptionKey: env.config.tokenEncryptionKey, refreshDaysBefore: 15 };
  });

  /** Cria conexão com idade e validade controladas. */
  async function seed(igUserId: string, token: string, issuedHoursAgo: number, expiresInDays: number | null) {
    const c = await upsertInstagramConnection(env.db, {
      accountId: env.accountId, igUserId, accessToken: token, encryptionKey: deps.tokenEncryptionKey,
    });
    await env.db.query(
      `UPDATE channel_connections
          SET token_issued_at = NOW(3) - INTERVAL $2 HOUR,
              token_expires_at = CASE WHEN $3 IS NULL THEN NULL ELSE NOW(3) + INTERVAL $3 DAY END
        WHERE id = $1`,
      [c.id, issuedHoursAgo, expiresInDays],
    );
    return c.id;
  }

  it("renova só o que está perto de vencer e já tem mais de 24h", async () => {
    const due = await seed("1001", "tok-due", 48, 5);
    const unknownExpiry = await seed("1002", "tok-unknown", 48, null);
    await seed("1003", "tok-young", 2, 5);
    await seed("1004", "tok-far", 48, 40);

    const outcomes = await refreshDueTokens(deps);
    expect(outcomes.map((o) => o.connectionId).sort()).toEqual([due, unknownExpiry].sort());
    expect(outcomes.every((o) => o.result === "refreshed")).toBe(true);
    expect(env.oauth.refreshed.sort()).toEqual(["tok-due", "tok-unknown"]);

    const c = (await connection("1001"))!;
    expect(decryptToken(c.access_token_enc, deps.tokenEncryptionKey)).toBe("tok-due+r");
    expect((new Date(c.token_expires_at).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(59.9);
    expect(c.token_refreshed_at).not.toBeNull();
    expect(c.refresh_locked_until).toBeNull();

    // Recém-renovado: não entra de novo.
    expect(await refreshDueTokens(deps)).toEqual([]);
  });

  it("token que já venceu vira 'expired' sem chamar a API", async () => {
    const id = await seed("2001", "tok-old", 24 * 70, -1);
    expect(await refreshDueTokens(deps)).toEqual([{ connectionId: id, result: "expired" }]);
    expect(env.oauth.refreshed).toEqual([]);
    expect((await connection("2001"))!.status).toBe("expired");
  });

  it("erro 190 (token revogado) marca 'expired' e o webhook dessa conta passa a ser ignorado", async () => {
    await seed("3001", "tok-revoked", 48, 5);
    env.oauth.refreshError = new IgApiError("Error validating access token: The user has not authorized application.", 400, 190);
    const [outcome] = await refreshDueTokens(deps);
    expect(outcome).toMatchObject({ result: "expired" });
    expect((await connection("3001"))!).toMatchObject({ status: "expired", last_refresh_error: expect.stringContaining("not authorized") });

    const body = commentWebhook({ commentId: "c-exp", text: "oi" });
    body.entry[0]!.id = "3001";
    await postWebhook(env, body);
    const [processed] = await drain(env.worker);
    expect(processed).toMatchObject({ status: "ignored", reason: "conta Instagram 3001 não conectada" });
  });

  it("falha temporária guarda o erro e espera 1h antes de tentar de novo", async () => {
    await seed("4001", "tok-flaky", 48, 5);
    env.oauth.refreshError = new IgApiError("Service temporarily unavailable", 503);
    expect(await refreshDueTokens(deps)).toMatchObject([{ result: "error" }]);
    const c = (await connection("4001"))!;
    expect(c.status).toBe("active");
    expect(c.last_refresh_error).toBe("Service temporarily unavailable");
    expect(new Date(c.refresh_locked_until!).getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);

    env.oauth.refreshError = undefined;
    expect(await refreshDueTokens(deps)).toEqual([]);
    await env.db.query("UPDATE channel_connections SET refresh_locked_until = NOW(3) - INTERVAL 1 SECOND");
    expect(await refreshDueTokens(deps)).toMatchObject([{ result: "refreshed" }]);
    expect((await connection("4001"))!.last_refresh_error).toBeNull();
  });

  it("a conexão recém-criada pelo setup não é tocada", async () => {
    expect(await refreshDueTokens(deps)).toEqual([]);
  });
});
