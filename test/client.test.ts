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
});
