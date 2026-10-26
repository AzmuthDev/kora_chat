import { describe, expect, it } from "vitest";
import { createInstagramApi, IgApiError } from "../src/instagram/client.js";

type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("cliente da Graph API do Instagram", () => {
  it("monta a chamada da Send API com resposta privada", async () => {
    const captured: Captured[] = [];
    const api = createInstagramApi({
      baseUrl: "https://graph.instagram.com/",
      version: "v24.0",
      fetchImpl: fakeFetch(200, { recipient_id: "1", message_id: "mid.abc" }, captured),
    });
    const res = await api.sendMessage({
      accessToken: "TOKEN",
      igAccountId: "178",
      recipient: { comment_id: "c1" },
      message: { text: "oi" },
    });
    expect(res).toEqual({ messageId: "mid.abc" });
    expect(captured[0]!.url).toBe("https://graph.instagram.com/v24.0/178/messages");
    expect(captured[0]!.init.method).toBe("POST");
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(captured[0]!.init.body as string)).toEqual({ recipient: { comment_id: "c1" }, message: { text: "oi" } });
  });

  it("resposta pública em /{comment-id}/replies", async () => {
    const captured: Captured[] = [];
    const api = createInstagramApi({ baseUrl: "https://g.test", version: "v24.0", fetchImpl: fakeFetch(200, { id: "r1" }, captured) });
    expect(await api.replyToComment({ accessToken: "T", commentId: "c9", text: "valeu" })).toEqual({ id: "r1" });
    expect(captured[0]!.url).toBe("https://g.test/v24.0/c9/replies");
    expect(JSON.parse(captured[0]!.init.body as string)).toEqual({ message: "valeu" });
  });

  it("converte erro da Graph API e classifica se vale nova tentativa", async () => {
    const api = (status: number, code: number) =>
      createInstagramApi({ baseUrl: "https://g.test", version: "v24.0", fetchImpl: fakeFetch(status, { error: { message: "x", code } }, []) });

    const definitive = await api(400, 100).replyToComment({ accessToken: "T", commentId: "c", text: "t" }).catch((e) => e);
    expect(definitive).toBeInstanceOf(IgApiError);
    expect(definitive.retryable).toBe(false);

    const throttled = await api(400, 4).replyToComment({ accessToken: "T", commentId: "c", text: "t" }).catch((e) => e);
    expect(throttled.retryable).toBe(true);

    const network = await createInstagramApi({
      baseUrl: "https://g.test",
      version: "v24.0",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    })
      .replyToComment({ accessToken: "T", commentId: "c", text: "t" })
      .catch((e) => e);
    expect(network.retryable).toBe(true);
  });

  it("lista os posts recentes da conta", async () => {
    const captured: Captured[] = [];
    const api = createInstagramApi({
      baseUrl: "https://g.test",
      version: "v24.0",
      fetchImpl: fakeFetch(200, { data: [{ id: "m1", timestamp: "2026-10-26T10:00:00+0000" }, { id: "m2" }] }, captured),
    });
    expect(await api.listRecentMedia({ accessToken: "T", igAccountId: "178", limit: 10 })).toEqual([{ id: "m1" }, { id: "m2" }]);
    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/v24.0/178/media");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(captured[0]!.init.method ?? "GET").toBe("GET");
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer T");
  });

  it("lista comentários com autor e quem já respondeu", async () => {
    const captured: Captured[] = [];
    const body = {
      data: [
        {
          id: "c1",
          text: "quero",
          timestamp: "2026-10-26T10:00:00+0000",
          from: { id: "u1", username: "ana" },
          replies: { data: [{ id: "r1", from: { id: "178" } }] },
        },
        { id: "c2", text: "eu também", timestamp: "2026-10-26T11:00:00+0000", from: { id: "u2" } },
        { id: "c3", timestamp: "2026-10-26T12:00:00+0000" },
      ],
    };
    const api = createInstagramApi({ baseUrl: "https://g.test", version: "v24.0", fetchImpl: fakeFetch(200, body, captured) });
    expect(await api.listComments({ accessToken: "T", mediaId: "m1", limit: 50 })).toEqual([
      { id: "c1", text: "quero", timestamp: "2026-10-26T10:00:00.000Z", fromId: "u1", fromUsername: "ana", replyFromIds: ["178"] },
      { id: "c2", text: "eu também", timestamp: "2026-10-26T11:00:00.000Z", fromId: "u2", fromUsername: undefined, replyFromIds: [] },
    ]);
    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/v24.0/m1/comments");
    expect(url.searchParams.get("fields")).toBe("id,text,timestamp,from,replies{from}");
  });

  it("separa recusa certa de entrega incerta (a DM pode ter chegado)", async () => {
    const err = (status: number, code?: number) => new IgApiError("x", status, code);
    // Recusas explícitas: nada foi entregue.
    expect(err(400, 100).deliveryUncertain).toBe(false);
    expect(err(400, 10).deliveryUncertain).toBe(false);
    expect(err(400, 4).deliveryUncertain).toBe(false);
    expect(err(429).deliveryUncertain).toBe(false);
    expect(err(400, 190).deliveryUncertain).toBe(false);
    // 5xx, falha de rede (vira 503) e os códigos 1/2 já foram vistos junto com entrega real.
    expect(err(500).deliveryUncertain).toBe(true);
    expect(err(503).deliveryUncertain).toBe(true);
    expect(err(400, 1).deliveryUncertain).toBe(true);
    expect(err(400, 2).deliveryUncertain).toBe(true);
  });
});
