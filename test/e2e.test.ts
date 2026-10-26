import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgApiError } from "../src/instagram/client.js";
import { drain } from "../src/worker/run.js";
import { auth, commentWebhook, dmWebhook, IG_ACCOUNT_ID, postWebhook, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

async function createAutomation(payload: Record<string, unknown>) {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
    headers: auth(),
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function contacts() {
  return (await env.app.inject({ url: `/api/accounts/${env.accountId}/contacts`, headers: auth() })).json();
}

describe("webhook HTTP", () => {
  it("verificação do GET devolve o challenge só com o token certo", async () => {
    const ok = await env.app.inject({ url: "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");
    const bad = await env.app.inject({ url: "/webhooks/instagram?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("rejeita assinatura inválida e não enfileira nada", async () => {
    const res = await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero" }), "sha256=" + "0".repeat(64));
    expect(res.statusCode).toBe(401);
    expect((await env.db.query("SELECT 1 FROM scheduled_jobs")).rows).toHaveLength(0);
  });

  it("API administrativa exige o token", async () => {
    const res = await env.app.inject({ method: "POST", url: "/api/accounts", payload: { name: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("valida o corpo da automação", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
      headers: auth(),
      payload: { keywords: ["x"], dm: { text: "" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("comentário → DM", () => {
  it("responde em privado ao comment_id, responde em público, cria contato e tag", async () => {
    await createAutomation({
      keywords: ["quero", "link"],
      public_replies: ["Te mandei no direct, @{{username}}!"],
      dm: { text: "Oi {{first_name}}! Aqui está:", buttons: [{ caption: "Abrir loja", url: "https://loja.exemplo/oferta" }] },
      tag: "lead-reels",
    });

    const res = await postWebhook(env, commentWebhook({ commentId: "c100", text: "Quero o LINK!!" }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("EVENT_RECEIVED");

    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "ran" });

    expect(env.ig.calls).toEqual([
      { op: "replyToComment", accessToken: "IGAA-token-de-teste", commentId: "c100", text: "Te mandei no direct, @maria!" },
      {
        op: "sendMessage",
        accessToken: "IGAA-token-de-teste",
        igAccountId: IG_ACCOUNT_ID,
        recipient: { comment_id: "c100" },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: "Oi maria! Aqui está:",
              // O link passa pelo contador de cliques (/r/<slug>?r=<pessoa>), que redireciona para a oferta.
              buttons: [{ type: "web_url", url: expect.stringMatching(/^https:\/\/clone\.exemplo\/r\/[\w-]+\?r=[\w-]{22}$/), title: "Abrir loja" }],
            },
          },
        },
      },
    ]);

    const [contact] = await contacts();
    expect(contact).toMatchObject({ igsid: "990001", username: "maria", tags: ["lead-reels"] });

    const msgs = (await env.app.inject({ url: `/api/accounts/${env.accountId}/messages`, headers: auth() })).json();
    expect(msgs.map((m: { kind: string; status: string }) => `${m.kind}:${m.status}`).sort()).toEqual(
      ["comment:received", "comment_reply:sent", "private_reply:sent"].sort(),
    );
  });

  it("webhook duplicado não envia de novo", async () => {
    await createAutomation({ keywords: [], dm: { text: "Oi" } });
    const body = commentWebhook({ commentId: "c200", text: "qualquer" });
    await postWebhook(env, body);
    await postWebhook(env, body);
    await drain(env.worker);
    expect(env.ig.calls).toHaveLength(1);
  });

  it("ignora comentários da própria conta (evita laço com a resposta pública)", async () => {
    await createAutomation({ keywords: [], public_replies: ["Valeu!"], dm: { text: "Oi" } });
    await postWebhook(env, commentWebhook({ commentId: "c300", text: "Valeu!", fromId: IG_ACCOUNT_ID, username: "lojateste" }));
    const [outcome] = await drain(env.worker);
    expect(outcome).toEqual({ status: "ignored", reason: "comentário da própria conta" });
    expect(env.ig.calls).toHaveLength(0);
  });

  it("não dispara sem palavra-chave nem em outro post", async () => {
    await createAutomation({ keywords: ["quero"], media_ids: ["media-1"], dm: { text: "Oi" } });
    await postWebhook(env, commentWebhook({ commentId: "c400", text: "lindo!" }));
    await postWebhook(env, commentWebhook({ commentId: "c401", text: "quero", mediaId: "media-9" }));
    const outcomes = await drain(env.worker);
    expect(outcomes.every((o) => typeof o === "object" && o.status === "ignored")).toBe(true);
    expect(env.ig.calls).toHaveLength(0);
  });

  it("conta não conectada é ignorada sem erro", async () => {
    const body = commentWebhook({ commentId: "c500", text: "quero" });
    body.entry[0]!.id = "999";
    await postWebhook(env, body);
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "ignored" });
  });

  it("gatilho com maior prioridade vence", async () => {
    const graph = (text: string) => ({
      start: "a",
      nodes: { a: { type: "send_message", content: { version: "v2", content: { messages: [{ type: "text", text }] } } } },
    });
    for (const [text, priority] of [["genérico", 0], ["específico", 10]] as const) {
      const res = await env.app.inject({
        method: "POST",
        url: `/api/accounts/${env.accountId}/flows`,
        headers: auth(),
        payload: { name: text, graph: graph(text), trigger: { type: "comment", config: {}, priority } },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    await postWebhook(env, commentWebhook({ commentId: "c600", text: "oi" }));
    await drain(env.worker);
    expect(env.ig.calls).toMatchObject([{ op: "sendMessage", message: { text: "específico" } }]);
  });
});

describe("fluxo em duas etapas (quick reply abre a janela de 24h)", () => {
  it("resposta privada com botão → toque do usuário → DM com link pelo IGSID", async () => {
    await createAutomation({
      keywords: ["link"],
      opening: { text: "Oi! Quer receber o link?", button_caption: "Quero!" },
      dm: { text: "Aqui está 👉", buttons: [{ caption: "Abrir", url: "https://loja.exemplo" }] },
      tag: "clicou",
    });

    await postWebhook(env, commentWebhook({ commentId: "c700", text: "link" }));
    await drain(env.worker);

    expect(env.ig.calls).toHaveLength(1);
    const first = env.ig.calls[0]!;
    expect(first).toMatchObject({ op: "sendMessage", recipient: { comment_id: "c700" }, message: { text: "Oi! Quer receber o link?" } });
    const payload = (first as { message: { quick_replies: { payload: string; title: string }[] } }).message.quick_replies[0]!;
    expect(payload.title).toBe("Quero!");
    expect((await contacts())[0].tags).toEqual([]);

    // O usuário toca no quick reply: chega uma DM com o payload.
    await postWebhook(env, dmWebhook({ mid: "mid.qr1", text: "Quero!", quickReply: payload.payload }));
    await drain(env.worker);

    expect(env.ig.calls).toHaveLength(2);
    expect(env.ig.calls[1]).toMatchObject({ op: "sendMessage", recipient: { id: "990001" } });
    const [contact] = await contacts();
    expect(contact.tags).toEqual(["clicou"]);
    expect(contact.last_input_text).toBe("Quero!");
    expect(contact.last_inbound_at).not.toBeNull();
  });

  it("payload de quick reply de outra conta é ignorado", async () => {
    await postWebhook(env, dmWebhook({ mid: "mid.x", quickReply: "qr:00000000-0000-0000-0000-000000000000:dm" }));
    const [outcome] = await drain(env.worker);
    expect(outcome).toEqual({ status: "ignored", reason: "quick reply de fluxo desconhecido" });
  });
});

describe("falhas e reprocessamento", () => {
  it("limite de taxa na resposta pública: job reprocessado não reenvia a DM", async () => {
    const graph = {
      start: "dm",
      nodes: {
        dm: { type: "send_message", content: { version: "v2", content: { messages: [{ type: "text", text: "Oi" }] } }, next: "pub" },
        pub: { type: "reply_comment", texts: ["Enviado!"], next: null },
      },
    };
    await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/flows`,
      headers: auth(),
      payload: { name: "f", graph, trigger: { type: "comment", config: {} } },
    });
    // Throttling é recusa explícita: a resposta não foi publicada, então vale tentar de novo.
    env.ig.failReplyNext.push(new IgApiError("(#4) Application request limit reached", 400, 4));

    await postWebhook(env, commentWebhook({ commentId: "c800", text: "oi" }));
    expect(await drain(env.worker)).toEqual(["failed"]);

    // Simula o backoff vencido.
    await env.db.query("UPDATE scheduled_jobs SET run_at = NOW(3) WHERE status = 'pending'");
    const [retry] = await drain(env.worker);
    expect(retry).toMatchObject({ status: "ran" });

    expect(env.ig.calls.map((c) => c.op)).toEqual(["sendMessage", "replyToComment"]);
  });

  it("5xx no envio: marca entrega incerta, não tenta de novo e não duplica a DM", async () => {
    await createAutomation({ keywords: [], dm: { text: "Oi" } });
    env.ig.failNext.push(new IgApiError("An unexpected error has occurred.", 500, 2));
    await postWebhook(env, commentWebhook({ commentId: "c850", text: "oi" }));
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "ran", result: { stoppedBy: "entrega incerta em dm" } });

    const { rows } = await env.db.query<{ status: string }>("SELECT status FROM messages WHERE direction = 'outbound'");
    expect(rows).toEqual([{ status: "unconfirmed" }]);
    const jobs = await env.db.query<{ status: string }>("SELECT status FROM scheduled_jobs");
    expect(jobs.rows).toEqual([{ status: "done" }]);

    // Mesmo que o evento seja processado de novo, a DM incerta não é reenviada.
    await env.db.query("UPDATE scheduled_jobs SET status = 'pending', run_at = NOW(3)");
    await drain(env.worker);
    expect(env.ig.calls).toEqual([]);
  });

  it("envio que ficou pela metade (processo caiu) não é repetido", async () => {
    await createAutomation({ keywords: [], dm: { text: "Oi" } });
    await postWebhook(env, commentWebhook({ commentId: "c860", text: "oi" }));
    // Simula a queda entre gravar a intenção de envio e saber o resultado.
    const job = await env.db.query<{ payload: string | { eventId: string } }>("SELECT payload FROM scheduled_jobs");
    const payload = typeof job.rows[0]!.payload === "string" ? JSON.parse(job.rows[0]!.payload) : job.rows[0]!.payload;
    await env.db.query(
      `INSERT INTO messages (account_id, channel, direction, kind, payload, idempotency_key, status)
       VALUES ($1, 'instagram', 'outbound', 'private_reply', '{}', $2, 'pending')`,
      [env.accountId, `evt:${payload.eventId}:dm:0`],
    );
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "ran", result: { stoppedBy: "entrega incerta em dm" } });
    expect(env.ig.calls).toEqual([]);
  });

  it("erro definitivo do Instagram marca a mensagem como falha e encerra o job", async () => {
    await createAutomation({ keywords: [], dm: { text: "Oi" } });
    env.ig.failNext.push(new IgApiError("(#10) This message is sent outside of allowed window.", 400, 10));
    await postWebhook(env, commentWebhook({ commentId: "c900", text: "oi" }));
    const [outcome] = await drain(env.worker);
    expect(outcome).toMatchObject({ status: "ran", result: { stoppedBy: "envio falhou em dm" } });
    const { rows } = await env.db.query<{ status: string; error: string }>(
      "SELECT status, error FROM messages WHERE direction = 'outbound'",
    );
    expect(rows).toEqual([{ status: "failed", error: "(#10) This message is sent outside of allowed window." }]);
    const jobs = await env.db.query<{ status: string }>("SELECT status FROM scheduled_jobs");
    expect(jobs.rows).toEqual([{ status: "done" }]);
  });

  it("segunda mensagem sem janela aberta fica bloqueada (só 1 resposta privada por comentário)", async () => {
    const graph = {
      start: "a",
      nodes: {
        a: {
          type: "send_message",
          content: { version: "v2", content: { messages: [{ type: "text", text: "1" }, { type: "text", text: "2" }] } },
        },
      },
    };
    await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/flows`,
      headers: auth(),
      payload: { name: "f", graph, trigger: { type: "comment", config: {} } },
    });
    await postWebhook(env, commentWebhook({ commentId: "c1000", text: "oi" }));
    const [outcome] = await drain(env.worker);
    expect(env.ig.calls).toHaveLength(1);
    expect(outcome).toMatchObject({ result: { blocked: [{ nodeId: "a" }] } });
  });

  it("contato que já mandou DM nas últimas 24h recebe DM normal, não resposta privada", async () => {
    await createAutomation({ keywords: [], dm: { text: "Oi" } });
    await postWebhook(env, dmWebhook({ mid: "mid.antes", text: "olá" }));
    await postWebhook(env, commentWebhook({ commentId: "c1100", text: "oi" }));
    await drain(env.worker);
    expect(env.ig.calls).toMatchObject([{ op: "sendMessage", recipient: { id: "990001" } }]);
    expect(await contacts()).toHaveLength(1);
  });
});
