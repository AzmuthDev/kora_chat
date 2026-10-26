import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drain } from "../src/worker/run.js";
import { auth, commentWebhook, postWebhook, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const TRACKED = /^https:\/\/clone\.exemplo\/r\/([\w-]+)\?r=([\w-]{22})$/;

async function createAutomation(url = "https://loja.exemplo/oferta?cupom=10") {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
    headers: auth(),
    payload: { keywords: [], dm: { text: "Aqui está", buttons: [{ caption: "Abrir", url }] } },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { flowId: string };
}

/** URL do botão de cada DM enviada. */
function sentUrls(): string[] {
  return env.ig.calls.flatMap((c) =>
    c.op === "sendMessage" && "attachment" in c.message && c.message.attachment.type === "template"
      ? c.message.attachment.payload.buttons.map((b) => b.url)
      : [],
  );
}

async function linkStats(flowId: string) {
  const list = (await env.app.inject({ url: `/api/accounts/${env.accountId}/automations`, headers: auth() })).json();
  return list.find((a: { id: string }) => a.id === flowId).link_stats;
}

describe("links rastreados", () => {
  it("o botão da DM passa por /r/<slug>, que conta o clique e redireciona", async () => {
    const { flowId } = await createAutomation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero", fromId: "u1" }));
    await drain(env.worker);

    const [url] = sentUrls();
    expect(url).toMatch(TRACKED);
    const path = new URL(url!).pathname + new URL(url!).search;

    const click = await env.app.inject({ url: path });
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toBe("https://loja.exemplo/oferta?cupom=10");

    expect(await linkStats(flowId)).toEqual({ recipients: 1, clicks: 1, people_clicked: 1 });
  });

  it("vários toques da mesma pessoa contam como uma pessoa; cada pessoa tem o próprio token", async () => {
    const { flowId } = await createAutomation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero", fromId: "u1" }));
    await postWebhook(env, commentWebhook({ commentId: "c2", text: "quero", fromId: "u2" }));
    await postWebhook(env, commentWebhook({ commentId: "c3", text: "quero", fromId: "u3" }));
    await drain(env.worker);

    const urls = sentUrls();
    expect(urls).toHaveLength(3);
    const [slugs, tokens] = [new Set(urls.map((u) => TRACKED.exec(u)![1])), new Set(urls.map((u) => TRACKED.exec(u)![2]))];
    expect(slugs.size).toBe(1);
    expect(tokens.size).toBe(3);

    const open = (u: string) => env.app.inject({ url: new URL(u).pathname + new URL(u).search });
    await open(urls[0]!);
    await open(urls[0]!);
    await open(urls[1]!);
    expect(await linkStats(flowId)).toEqual({ recipients: 3, clicks: 3, people_clicked: 2 });
  });

  it("reprocessar o mesmo evento reaproveita o link e não conta a pessoa duas vezes", async () => {
    const { flowId } = await createAutomation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero", fromId: "u1" }));
    await drain(env.worker);
    await env.db.query("UPDATE scheduled_jobs SET status = 'pending', run_at = NOW(3)");
    await drain(env.worker);

    expect((await env.db.query("SELECT 1 FROM tracked_links")).rows).toHaveLength(1);
    expect(await linkStats(flowId)).toEqual({ recipients: 1, clicks: 0, people_clicked: 0 });
  });

  it("token adulterado ou ausente conta o clique sem atribuir a ninguém", async () => {
    const { flowId } = await createAutomation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero", fromId: "u1" }));
    await drain(env.worker);
    const slug = TRACKED.exec(sentUrls()[0]!)![1];

    expect((await env.app.inject({ url: `/r/${slug}` })).statusCode).toBe(302);
    expect((await env.app.inject({ url: `/r/${slug}?r=<script>` })).statusCode).toBe(302);
    expect(await linkStats(flowId)).toEqual({ recipients: 1, clicks: 2, people_clicked: 0 });
  });

  it("slug desconhecido responde 404", async () => {
    const res = await env.app.inject({ url: "/r/naoexiste" });
    expect(res.statusCode).toBe(404);
  });

  it("sem PUBLIC_BASE_URL o link vai direto, sem rastreio", async () => {
    await createAutomation();
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero" }));
    await drain({ ...env.worker, publicBaseUrl: undefined });
    expect(sentUrls()).toEqual(["https://loja.exemplo/oferta?cupom=10"]);
  });

  it("automação sem botão de link não mostra estatística", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
      headers: auth(),
      payload: { keywords: [], dm: { text: "Só texto" } },
    });
    expect(await linkStats(res.json().flowId)).toBeNull();
  });
});
