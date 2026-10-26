import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IgApiError } from "../src/instagram/client.js";
import { auth, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env?.close();
});

const media = (query = "") => env.app.inject({ url: `/api/accounts/${env.accountId}/instagram/media${query}`, headers: auth() });

describe("posts do Instagram para escolher na automação", () => {
  it("lista os posts recentes da conta conectada, com miniatura e legenda", async () => {
    env.ig.mediaDetails = [
      { id: "m1", caption: "Promo de sexta", mediaType: "VIDEO", productType: "REELS", thumbnailUrl: "https://scontent.cdninstagram.com/t1.jpg", permalink: "https://www.instagram.com/reel/abc/", timestamp: "2026-10-25T10:00:00.000Z" },
      { id: "m2", caption: null, mediaType: "IMAGE", productType: "FEED", thumbnailUrl: "https://scontent.cdninstagram.com/t2.jpg", permalink: null, timestamp: null },
    ];
    const res = await media();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      connection: { username: "lojateste", sandbox: false },
      items: [
        { id: "m1", caption: "Promo de sexta", media_type: "VIDEO", product_type: "REELS", thumbnail_url: "https://scontent.cdninstagram.com/t1.jpg" },
        { id: "m2", caption: null, media_type: "IMAGE" },
      ],
      next: null,
    });
  });

  it("pagina com o cursor da Meta", async () => {
    env.ig.mediaDetails = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, caption: null, mediaType: "IMAGE", productType: "FEED", thumbnailUrl: null, permalink: null, timestamp: null }));
    const first = (await media()).json();
    expect(first.items).toHaveLength(24);
    expect(first.next).toBe("cursor-24");
    const second = (await media(`?after=${first.next}`)).json();
    expect(second.items.map((m: { id: string }) => m.id)).toEqual(["m24", "m25", "m26", "m27", "m28", "m29"]);
    expect(second.next).toBeNull();
  });

  it("conta de teste (simulador) mostra posts de exemplo, sem chamar o Instagram", async () => {
    await env.db.query("UPDATE channel_connections SET status = 'disconnected'");
    const sandbox = await env.app.inject({ method: "POST", url: `/api/accounts/${env.accountId}/connections/sandbox`, headers: auth(), payload: {} });
    expect(sandbox.statusCode).toBe(201);
    const res = (await media()).json();
    expect(res.connection.sandbox).toBe(true);
    expect(res.items.map((m: { id: string }) => m.id)).toContain("post-de-teste");
    expect(env.ig.reads).toEqual([]);
  });

  it("sem conta conectada, explica o que fazer", async () => {
    await env.db.query("UPDATE channel_connections SET status = 'disconnected'");
    const res = await media();
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Conecte");
  });

  it("token vencido marca a conexão como expirada e pede para reconectar", async () => {
    env.ig.failListNext.push(new IgApiError("Error validating access token", 400, 190));
    const res = await media();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("reconecte");
    const { rows } = await env.db.query<{ status: string }>("SELECT status FROM channel_connections");
    expect(rows).toEqual([{ status: "expired" }]);
  });

  it("outra empresa não lista os posts desta", async () => {
    const other = await env.app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: { host: "painel.test", origin: "http://painel.test" },
      payload: { name: "B", email: "b@b.com", password: "senha-forte-1", company_name: "Loja B" },
    });
    const cookie = /sid=[^;]*/.exec(String(other.headers["set-cookie"]))![0];
    const res = await env.app.inject({ url: `/api/accounts/${env.accountId}/instagram/media`, headers: { host: "painel.test", cookie } });
    expect(res.statusCode).toBe(404);
  });
});
