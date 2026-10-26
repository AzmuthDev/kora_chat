import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgApiError } from "../src/instagram/client.js";
import { createSignedRequest, parseSignedRequest } from "../src/instagram/signed-request.js";
import { drain } from "../src/worker/run.js";
import { auth, commentWebhook, dmWebhook, IG_ACCOUNT_ID, IG_APP_SECRET, postWebhook, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const signed = (userId: string, secret = IG_APP_SECRET) =>
  createSignedRequest({ algorithm: "HMAC-SHA256", issued_at: 1_792_800_000, user_id: userId }, secret);

const postForm = (url: string, signedRequest: string) =>
  env.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ signed_request: signedRequest }).toString(),
  });

async function connectionRow(igUserId = IG_ACCOUNT_ID) {
  return (
    await env.db.query<{ status: string; access_token_enc: string; last_refresh_error: string | null }>(
      "SELECT status, access_token_enc, last_refresh_error FROM channel_connections WHERE external_account_id = $1",
      [igUserId],
    )
  ).rows[0];
}

async function automation() {
  await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
    headers: auth(),
    payload: { keywords: [], public_replies: ["Enviado!"], dm: { text: "Oi" }, tag: "lead" },
  });
}

describe("signed_request", () => {
  it("valida assinatura, algoritmo e formato", () => {
    const ok = signed("123");
    expect(parseSignedRequest(ok, ["outro", IG_APP_SECRET])).toMatchObject({ user_id: "123", algorithm: "HMAC-SHA256" });
    expect(parseSignedRequest(ok, ["outro"])).toBeNull();
    expect(parseSignedRequest(undefined, [IG_APP_SECRET])).toBeNull();
    expect(parseSignedRequest("abc", [IG_APP_SECRET])).toBeNull();
    const [sig, payload] = ok.split(".");
    const tampered = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" })).toString("base64url");
    expect(parseSignedRequest(`${sig}.${tampered}`, [IG_APP_SECRET])).toBeNull();
    expect(parseSignedRequest(`${sig}.${payload}.x`, [IG_APP_SECRET])).toBeNull();
    const wrongAlgo = createSignedRequest({ algorithm: "none", user_id: "1" }, IG_APP_SECRET);
    expect(parseSignedRequest(wrongAlgo, [IG_APP_SECRET])).toBeNull();
    const numericId = createSignedRequest({ algorithm: "hmac-sha256", user_id: 42 }, IG_APP_SECRET);
    expect(parseSignedRequest(numericId, [IG_APP_SECRET])?.user_id).toBe("42");
  });
});

describe("erro 190 durante um envio", () => {
  it("marca a conexão como expired e os próximos webhooks da conta são ignorados", async () => {
    await automation();
    env.ig.failNext.push(new IgApiError("Error validating access token: Session has expired.", 400, 190, 463));
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "oi" }));
    await postWebhook(env, commentWebhook({ commentId: "c2", text: "oi", fromId: "990002" }));
    const [first, second] = await drain(env.worker);

    // A resposta pública saiu; a DM falhou com 190 e o fluxo parou antes da tag.
    expect(first).toMatchObject({ status: "ran", result: { tokenInvalid: expect.stringContaining("Session has expired") } });
    expect(env.ig.calls.map((c) => c.op)).toEqual(["replyToComment"]);
    expect(await connectionRow()).toMatchObject({ status: "expired", last_refresh_error: expect.stringContaining("Session") });
    expect(second).toEqual({ status: "ignored", reason: `conta Instagram ${IG_ACCOUNT_ID} não conectada` });

    const tags = (await env.app.inject({ url: `/api/accounts/${env.accountId}/contacts`, headers: auth() })).json()[0].tags;
    expect(tags).toEqual([]);
  });

  it("190 na resposta pública também encerra o fluxo", async () => {
    await automation();
    env.ig.failReplyNext.push(new IgApiError("Invalid OAuth access token", 400, 190));
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "oi" }));
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ result: { stoppedBy: "token inválido em public_reply" } });
    expect(env.ig.calls).toHaveLength(0);
    expect((await connectionRow())!.status).toBe("expired");
  });

  it("outros erros definitivos não derrubam a conexão", async () => {
    await automation();
    env.ig.failNext.push(new IgApiError("(#10) outside of allowed window", 400, 10));
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "oi" }));
    await drain(env.worker);
    expect((await connectionRow())!.status).toBe("active");
  });
});

describe("callback de desautorização", () => {
  it("desconecta, apaga o token e para de processar webhooks", async () => {
    const res = await postForm("/meta/instagram/deauthorize", signed(IG_ACCOUNT_ID));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(await connectionRow()).toMatchObject({ status: "disconnected", access_token_enc: "" });

    await automation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "oi" }));
    expect(await drain(env.worker)).toMatchObject([{ status: "ignored" }]);
    expect(env.ig.calls).toHaveLength(0);
  });

  it("aceita o ID escopado do app guardado no OAuth", async () => {
    await env.db.query("UPDATE channel_connections SET app_scoped_user_id = 'asid-1'");
    await postForm("/meta/instagram/deauthorize", signed("asid-1"));
    expect((await connectionRow())!.status).toBe("disconnected");
  });

  it("aceita assinatura com o segredo do app da Meta e recusa assinatura inválida", async () => {
    expect((await postForm("/meta/instagram/deauthorize", signed("x", "app-secret"))).statusCode).toBe(200);
    expect((await postForm("/meta/instagram/deauthorize", signed(IG_ACCOUNT_ID, "errado"))).statusCode).toBe(400);
    expect((await connectionRow())!.status).toBe("active");
  });

  it("reconectar pelo OAuth reativa a conta", async () => {
    await postForm("/meta/instagram/deauthorize", signed(IG_ACCOUNT_ID));
    env.oauth.profile = { userId: IG_ACCOUNT_ID, username: "lojateste" };
    const start = await env.app.inject({ method: "POST", url: `/api/accounts/${env.accountId}/connections/instagram/oauth`, headers: auth() });
    const state = new URL(start.json().authorize_url).searchParams.get("state");
    expect((await env.app.inject({ url: `/oauth/instagram/callback?code=Z&state=${state}` })).statusCode).toBe(200);
    expect((await connectionRow())!.status).toBe("active");
  });
});

describe("callback de exclusão de dados", () => {
  async function seedData() {
    await automation();
    await postWebhook(env, dmWebhook({ mid: "m1", text: "oi" }));
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero" }));
    await drain(env.worker);
  }

  it("responde url + confirmation_code e o worker apaga os dados da conexão", async () => {
    await seedData();
    const before = await env.db.query("SELECT 1 FROM messages");
    expect(before.rows.length).toBeGreaterThan(0);

    // Outra conta do mesmo cliente, que não pode ser afetada.
    await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/connections/instagram`,
      headers: auth(),
      payload: { ig_user_id: "17841400000000002", access_token: "IGAA-outra-conta" },
    });
    const other = commentWebhook({ commentId: "c-outra", text: "oi", fromId: "880001" });
    other.entry[0]!.id = "17841400000000002";
    await postWebhook(env, other);
    await drain(env.worker);

    const res = await postForm("/meta/instagram/data-deletion", signed(IG_ACCOUNT_ID));
    expect(res.statusCode).toBe(200);
    const { url, confirmation_code } = res.json();
    expect(confirmation_code).toMatch(/^[0-9A-F]{20}$/);
    expect(url).toBe(`https://clone.exemplo/meta/data-deletion/status?code=${confirmation_code}`);

    // Antes do worker: conexão já desconectada, pedido em andamento.
    expect((await connectionRow())!.status).toBe("disconnected");
    const pending = await env.app.inject({ url: `/meta/data-deletion/status?code=${confirmation_code}` });
    expect(pending.body).toContain("Exclusão em andamento");

    const [outcome] = await drain(env.worker);
    expect(outcome).toEqual({
      status: "data_deleted",
      // DM recebida + comentário recebido + resposta pública + DM enviada (janela aberta pela DM).
      summary: { connections: 1, messages: 4, identities: 1, contacts: 1, raw_events: 2, pending_jobs: 0 },
    });

    expect(await connectionRow()).toBeUndefined();
    const left = await env.db.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM contact_identities)
            + (SELECT COUNT(*) FROM contacts) AS n`,
    );
    // Sobra só o que veio da outra conta: 3 mensagens (comentário, resposta pública, resposta privada) + identidade + contato.
    const otherRows = await env.db.query<{ external_user_id: string }>("SELECT external_user_id FROM contact_identities");
    expect(otherRows.rows).toEqual([{ external_user_id: "880001" }]);
    const otherMessages = await env.db.query<{ kind: string }>("SELECT kind FROM messages ORDER BY kind");
    expect(otherMessages.rows.map((r) => r.kind)).toEqual(["comment", "comment_reply", "private_reply"]);
    expect(left.rows[0]!.n).toBe(3 + 1 + 1);
    expect((await env.db.query("SELECT 1 FROM events_raw WHERE payload->>'$.igAccountId' = $1", [IG_ACCOUNT_ID])).rows).toHaveLength(0);
    // Fluxos e gatilhos do cliente continuam.
    expect((await env.db.query("SELECT 1 FROM flows")).rows).toHaveLength(1);

    const done = await env.app.inject({ url: `/meta/data-deletion/status?code=${confirmation_code.toLowerCase()}` });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("Exclusão concluída");
  });

  it("apaga jobs pendentes da conta e um job repetido não faz nada", async () => {
    await automation();
    await postWebhook(env, commentWebhook({ commentId: "c-pend", text: "oi" })); // fica na fila
    const { confirmation_code } = (await postForm("/meta/instagram/data-deletion", signed(IG_ACCOUNT_ID))).json();
    await env.db.query("UPDATE scheduled_jobs SET run_at = NOW(3) + INTERVAL 1 DAY WHERE kind = 'process_event'");
    const outcomes = await drain(env.worker);
    expect(outcomes).toMatchObject([{ status: "data_deleted", summary: { pending_jobs: 1 } }]);
    expect(env.ig.calls).toHaveLength(0);

    const { processDataDeletion } = await import("../src/worker/data-deletion.js");
    expect(await processDataDeletion(env.db, confirmation_code)).toBeNull();
  });

  it("usuário sem conexão ainda recebe confirmação e o pedido conclui vazio", async () => {
    const res = await postForm("/meta/instagram/data-deletion", signed("desconhecido"));
    expect(res.statusCode).toBe(200);
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "data_deleted", summary: { connections: 0, messages: 0, contacts: 0 } });
    expect((await connectionRow())!.status).toBe("active");
  });

  it("recusa signed_request inválido e código de status desconhecido", async () => {
    expect((await postForm("/meta/instagram/data-deletion", "lixo.lixo")).statusCode).toBe(400);
    expect((await env.app.inject({ url: "/meta/data-deletion/status?code=NAOEXISTE" })).statusCode).toBe(404);
    expect((await env.db.query("SELECT 1 FROM data_deletion_requests")).rows).toHaveLength(0);
  });
});
