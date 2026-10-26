import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCommentToDmGraph } from "../src/store/automations.js";
import { graphSchema } from "../src/engine/flow-types.js";
import { drain } from "../src/worker/run.js";
import { auth, commentWebhook, dmWebhook, postWebhook, setup, type SentCall, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

type Sent = Extract<SentCall, { op: "sendMessage" }>;
const sent = () => env.ig.calls.filter((c): c is Sent => c.op === "sendMessage");
const textOf = (c: Sent) => ("text" in c.message ? c.message.text : c.message.attachment.type === "template" ? c.message.attachment.payload.text : "");
const quickReplyOf = (c: Sent, title: string) => c.message.quick_replies?.find((q) => q.title === title)?.payload;

async function createAutomation(extra: Record<string, unknown> = {}) {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
    headers: auth(),
    payload: {
      keywords: ["link"],
      opening: { text: "Quer o link?", button_caption: "Quero!" },
      require_follow: { text: "Siga a gente e toque em Já sigo", button_caption: "Já sigo" },
      dm: { text: "Aqui está o link" },
      ...extra,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
}

let mid = 0;
/** Comenta e toca em "Quero!" na abertura. */
async function commentAndTapOpening() {
  await postWebhook(env, commentWebhook({ commentId: "c1", text: "link" }));
  await drain(env.worker);
  const opening = sent()[0]!;
  expect(textOf(opening)).toBe("Quer o link?");
  await postWebhook(env, dmWebhook({ mid: `mid.${++mid}`, text: "Quero!", quickReply: quickReplyOf(opening, "Quero!") }));
  return drain(env.worker);
}

async function tapAlreadyFollow() {
  const prompt = sent().findLast((c) => textOf(c).startsWith("Siga"))!;
  await postWebhook(env, dmWebhook({ mid: `mid.${++mid}`, text: "Já sigo", quickReply: quickReplyOf(prompt, "Já sigo") }));
  return drain(env.worker);
}

/** Faz o job agendado (rechecagem) vencer agora. */
async function runScheduled() {
  await env.db.query("UPDATE scheduled_jobs SET run_at = NOW(3) WHERE status = 'pending'");
  return drain(env.worker);
}

describe("pedir para seguir antes do link", () => {
  it("quem já segue recebe o link logo depois de tocar na abertura", async () => {
    await createAutomation();
    env.ig.follows.push(true);
    await commentAndTapOpening();
    expect(sent().map(textOf)).toEqual(["Quer o link?", "Aqui está o link"]);
  });

  it("quem não segue recebe o pedido; depois de seguir e tocar em Já sigo, recebe o link", async () => {
    await createAutomation();
    env.ig.follows.push(false);
    await commentAndTapOpening();
    expect(sent().map(textOf)).toEqual(["Quer o link?", "Siga a gente e toque em Já sigo"]);

    env.ig.follows.push(true);
    await tapAlreadyFollow();
    expect(sent().map(textOf)).toEqual(["Quer o link?", "Siga a gente e toque em Já sigo", "Aqui está o link"]);
  });

  it("Já sigo com o Instagram ainda dizendo que não: confere de novo antes de recusar", async () => {
    await createAutomation();
    env.ig.follows.push(false);
    await commentAndTapOpening();

    // O Instagram leva até ~1 min para reconhecer um follow novo.
    env.ig.follows.push(false);
    const [first] = await tapAlreadyFollow();
    expect(first).toMatchObject({ status: "ran", result: { stoppedBy: "aguardando o Instagram confirmar o follow" } });
    expect(sent()).toHaveLength(2);
    const { rows } = await env.db.query<{ secs: number }>(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(3), run_at) AS secs FROM scheduled_jobs WHERE status = 'pending'",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.secs)).toBeGreaterThanOrEqual(15);

    env.ig.follows.push(true);
    await runScheduled();
    expect(sent().map(textOf).at(-1)).toBe("Aqui está o link");
  });

  it("depois das rechecagens, quem continua sem seguir recebe o pedido de novo", async () => {
    await createAutomation();
    env.ig.follows.push(false);
    await commentAndTapOpening();

    env.ig.follows.push(false, false, false);
    await tapAlreadyFollow();
    await runScheduled();
    await runScheduled();
    expect(sent().map(textOf)).toEqual(["Quer o link?", "Siga a gente e toque em Já sigo", "Siga a gente e toque em Já sigo"]);
    expect((await env.db.query("SELECT 1 FROM scheduled_jobs WHERE status = 'pending'")).rows).toHaveLength(0);
  });

  it("se o Instagram não informar, entrega o link (não prende quem segue de verdade)", async () => {
    await createAutomation();
    env.ig.follows.push(null);
    await commentAndTapOpening();
    expect(sent().map(textOf)).toEqual(["Quer o link?", "Aqui está o link"]);
  });

  it("pedir para seguir sem abertura cria uma abertura padrão (a checagem só funciona depois de um toque)", () => {
    const graph = buildCommentToDmGraph({
      requireFollow: { text: "Siga e toque em Já sigo", buttonCaption: "Já sigo" },
      dm: { text: "Link" },
    });
    expect(graphSchema.safeParse(graph).success).toBe(true);
    expect(graph.start).toBe("opening");
    const opening = graph.nodes.opening;
    expect(opening).toMatchObject({ type: "send_message", content: { content: { quick_replies: [{ target: "follow_gate" }] } } });
    expect(graph.nodes.follow_gate).toEqual({ type: "check_follow", following: "dm", not_following: "follow_prompt" });
    expect(graph.nodes.follow_recheck).toEqual({ type: "check_follow", following: "dm", not_following: "follow_prompt", wait_for_follow: true });
  });

  it("valida que os destinos da checagem existem", () => {
    const bad = graphSchema.safeParse({ start: "x", nodes: { x: { type: "check_follow", following: "nada", not_following: "x" } } });
    expect(bad.success).toBe(false);
  });
});
