import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgApiError, type IgComment } from "../src/instagram/client.js";
import { sweepComments } from "../src/worker/comment-sweep.js";
import { drain } from "../src/worker/run.js";
import { auth, commentWebhook, IG_ACCOUNT_ID, postWebhook, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function comment(id: string, text: string, opts: Partial<IgComment> & { minutesAgo?: number } = {}): IgComment {
  return {
    id,
    text,
    timestamp: minutesAgo(opts.minutesAgo ?? 5),
    fromId: opts.fromId ?? `u-${id}`,
    fromUsername: opts.fromUsername ?? `pessoa_${id}`,
    replyFromIds: opts.replyFromIds ?? [],
  };
}

/** Cria a automação e a "envelhece" um dia, para os comentários de teste serem posteriores a ela. */
async function createAutomation(payload: Record<string, unknown>) {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/accounts/${env.accountId}/automations/comment-to-dm`,
    headers: auth(),
    payload: { dm: { text: "Aqui está o link" }, ...payload },
  });
  expect(res.statusCode, res.body).toBe(201);
  await env.db.query("UPDATE triggers SET created_at = NOW(3) - INTERVAL 1 DAY");
  return res.json() as { flowId: string };
}

const sentTo = () => env.ig.calls.flatMap((c) => (c.op === "sendMessage" ? [c.recipient] : []));

describe("varredura de comentários", () => {
  it("acha o comentário que o webhook não entregou e manda a DM", async () => {
    await createAutomation({ keywords: ["quero"], media_ids: ["m1"] });
    env.ig.comments.set("m1", [comment("c1", "Quero o link!")]);

    const [summary] = await sweepComments(env.worker);
    expect(summary).toMatchObject({ mediaScanned: 1, matched: 1, queued: 1, errors: [] });

    expect(await drain(env.worker)).toMatchObject([{ status: "ran" }]);
    expect(sentTo()).toEqual([{ comment_id: "c1" }]);
  });

  it("não repete o que o webhook já entregou, nem o que uma varredura anterior já pegou", async () => {
    await createAutomation({ keywords: ["quero"], media_ids: ["m1"] });
    await postWebhook(env, commentWebhook({ commentId: "c1", text: "quero", mediaId: "m1" }));
    await drain(env.worker);

    env.ig.comments.set("m1", [comment("c1", "quero"), comment("c2", "quero também")]);
    const [first] = await sweepComments(env.worker);
    expect(first).toMatchObject({ matched: 2, queued: 1 });
    await drain(env.worker);

    const [second] = await sweepComments(env.worker);
    expect(second).toMatchObject({ matched: 2, queued: 0 });
    expect(await drain(env.worker)).toEqual([]);
    expect(sentTo()).toEqual([{ comment_id: "c1" }, { comment_id: "c2" }]);
  });

  it("pula o que não casa, a própria conta, o que a conta já respondeu e o que é anterior à automação", async () => {
    await createAutomation({ keywords: ["quero"], media_ids: ["m1"] });
    env.ig.comments.set("m1", [
      comment("c-outro", "lindo post"),
      comment("c-conta", "quero", { fromId: IG_ACCOUNT_ID }),
      comment("c-respondido", "quero", { replyFromIds: ["alguem", IG_ACCOUNT_ID] }),
      comment("c-antigo", "quero", { minutesAgo: 2 * 24 * 60 }),
      comment("c-vale", "quero"),
    ]);

    const [summary] = await sweepComments(env.worker);
    expect(summary).toMatchObject({ matched: 1, queued: 1 });
    await drain(env.worker);
    expect(sentTo()).toEqual([{ comment_id: "c-vale" }]);
  });

  it("ignora comentários mais velhos que a janela de busca", async () => {
    await createAutomation({ keywords: [], media_ids: ["m1"] });
    await env.db.query("UPDATE triggers SET created_at = NOW(3) - INTERVAL 30 DAY");
    env.ig.comments.set("m1", [comment("c-velho", "oi", { minutesAgo: 5 * 24 * 60 }), comment("c-novo", "oi")]);

    const [summary] = await sweepComments(env.worker, { lookbackHours: 72 });
    expect(summary).toMatchObject({ matched: 1, queued: 1 });
  });

  it("automação sem post definido varre os posts recentes da conta", async () => {
    await createAutomation({ keywords: ["link"] });
    env.ig.media = ["m-novo", "m-velho"];
    env.ig.comments.set("m-velho", [comment("c9", "manda o link")]);

    const [summary] = await sweepComments(env.worker, { recentMediaLimit: 2 });
    expect(summary).toMatchObject({ mediaScanned: 2, queued: 1 });
    expect(env.ig.reads).toEqual(["media", "comments:m-novo", "comments:m-velho"]);
  });

  it("limita quantos comentários entram por rodada, começando pelos mais antigos", async () => {
    await createAutomation({ keywords: [], media_ids: ["m1"] });
    env.ig.comments.set("m1", [comment("c-3", "a", { minutesAgo: 1 }), comment("c-1", "b", { minutesAgo: 30 }), comment("c-2", "c", { minutesAgo: 10 })]);

    const [first] = await sweepComments(env.worker, { maxPerConnection: 2 });
    expect(first).toMatchObject({ matched: 3, queued: 2 });
    await drain(env.worker);
    expect(sentTo()).toEqual([{ comment_id: "c-1" }, { comment_id: "c-2" }]);

    // O que sobrou entra na rodada seguinte.
    const [second] = await sweepComments(env.worker, { maxPerConnection: 2 });
    expect(second).toMatchObject({ queued: 1 });
  });

  it("não varre automação pausada nem conta sem automação", async () => {
    const { flowId } = await createAutomation({ keywords: [], media_ids: ["m1"] });
    await env.app.inject({
      method: "PATCH",
      url: `/api/accounts/${env.accountId}/automations/${flowId}`,
      headers: auth(),
      payload: { active: false },
    });
    env.ig.comments.set("m1", [comment("c1", "oi")]);

    expect(await sweepComments(env.worker)).toEqual([]);
    expect(env.ig.reads).toEqual([]);
  });

  it("erro ao ler um post fica no resumo e não impede os outros", async () => {
    await createAutomation({ keywords: [], media_ids: ["m1", "m2"] });
    env.ig.failListNext.push(new IgApiError("(#368) Temporarily blocked", 400, 368));
    env.ig.comments.set("m2", [comment("c2", "oi")]);

    const [summary] = await sweepComments(env.worker);
    expect(summary).toMatchObject({ mediaScanned: 2, queued: 1, errors: ["m1: (#368) Temporarily blocked"] });
  });

  it("token inválido (190) marca a conexão como expirada", async () => {
    await createAutomation({ keywords: [], media_ids: ["m1"] });
    env.ig.failListNext.push(new IgApiError("Error validating access token", 400, 190));

    await sweepComments(env.worker);
    const { rows } = await env.db.query<{ status: string }>("SELECT status FROM channel_connections");
    expect(rows).toEqual([{ status: "expired" }]);
  });
});
