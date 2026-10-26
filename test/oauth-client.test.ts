import { describe, expect, it } from "vitest";
import { IgApiError } from "../src/instagram/client.js";
import { createInstagramOAuth, refreshLongLivedToken } from "../src/instagram/oauth.js";

type Captured = { url: string; init: RequestInit };

function fakeFetch(responses: { status?: number; body: unknown }[], captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
}

const base = {
  appId: "app-1",
  appSecret: "sec-1",
  redirectUri: "https://x.test/oauth/instagram/callback",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  graphBaseUrl: "https://graph.instagram.com",
  graphVersion: "v24.0",
};

describe("cliente OAuth do Instagram", () => {
  it("troca o code por token curto (formato novo com data[]) e remove o '#_'", async () => {
    const captured: Captured[] = [];
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch(
        [{ body: { data: [{ access_token: "SHORT", user_id: 17841, permissions: "instagram_business_basic,instagram_business_manage_messages" }] } }],
        captured,
      ),
    });
    const res = await oauth.exchangeCode("CODE#_");
    expect(res).toEqual({
      accessToken: "SHORT",
      userId: "17841",
      permissions: ["instagram_business_basic", "instagram_business_manage_messages"],
    });
    expect(captured[0]!.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(captured[0]!.init.method).toBe("POST");
    const form = new URLSearchParams(String(captured[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: "app-1",
      client_secret: "sec-1",
      grant_type: "authorization_code",
      redirect_uri: "https://x.test/oauth/instagram/callback",
      code: "CODE",
    });
  });

  it("aceita o formato antigo da troca do code", async () => {
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch([{ body: { access_token: "S", user_id: "9", permissions: ["a", "b"] } }], []),
    });
    expect(await oauth.exchangeCode("c")).toEqual({ accessToken: "S", userId: "9", permissions: ["a", "b"] });
  });

  it("erro do endpoint de OAuth (error_type/error_message) vira IgApiError", async () => {
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch([{ status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid code" } }], []),
    });
    const err = await oauth.exchangeCode("c").catch((e) => e);
    expect(err).toBeInstanceOf(IgApiError);
    expect(err.message).toBe("Invalid code");
    expect(err.retryable).toBe(false);
  });

  it("token curto → longo, e renovação", async () => {
    const captured: Captured[] = [];
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch(
        [
          { body: { access_token: "LONG", token_type: "bearer", expires_in: 5183944 } },
          { body: { access_token: "LONG2", token_type: "bearer", expires_in: 5183000 } },
        ],
        captured,
      ),
    });
    expect(await oauth.exchangeForLongLived("SHORT")).toEqual({ accessToken: "LONG", expiresInSeconds: 5183944 });
    expect(await oauth.refresh("LONG")).toEqual({ accessToken: "LONG2", expiresInSeconds: 5183000 });

    const exchange = new URL(captured[0]!.url);
    expect(exchange.origin + exchange.pathname).toBe("https://graph.instagram.com/access_token");
    expect(Object.fromEntries(exchange.searchParams)).toEqual({
      grant_type: "ig_exchange_token",
      client_secret: "sec-1",
      access_token: "SHORT",
    });
    const refresh = new URL(captured[1]!.url);
    expect(refresh.origin + refresh.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(Object.fromEntries(refresh.searchParams)).toEqual({ grant_type: "ig_refresh_token", access_token: "LONG" });
  });

  it("renovação avulsa não precisa de app secret", async () => {
    const captured: Captured[] = [];
    const res = await refreshLongLivedToken(
      "https://graph.instagram.com/",
      "TOK",
      fakeFetch([{ body: { access_token: "TOK2", expires_in: 100 } }], captured),
    );
    expect(res).toEqual({ accessToken: "TOK2", expiresInSeconds: 100 });
    expect(captured[0]!.url).not.toContain("client_secret");
  });

  it("perfil usa user_id (ID dos webhooks) e assinatura de webhooks faz POST em me/subscribed_apps", async () => {
    const captured: Captured[] = [];
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch(
        [{ body: { id: "app-scoped-1", user_id: "17841400000000777", username: "novaloja", account_type: "BUSINESS" } }, { body: { success: true } }],
        captured,
      ),
    });
    expect(await oauth.getProfile("TOK")).toEqual({
      userId: "17841400000000777",
      appScopedId: "app-scoped-1",
      username: "novaloja",
      name: undefined,
      accountType: "BUSINESS",
    });
    await oauth.subscribeWebhooks("TOK", ["comments", "messages"]);

    const sub = new URL(captured[1]!.url);
    expect(captured[1]!.init.method).toBe("POST");
    expect(sub.pathname).toBe("/v24.0/me/subscribed_apps");
    expect(sub.searchParams.get("subscribed_fields")).toBe("comments,messages");
  });

  it("token 190 na renovação não é retentável", async () => {
    const oauth = createInstagramOAuth({
      ...base,
      fetchImpl: fakeFetch([{ status: 400, body: { error: { message: "Invalid OAuth access token", code: 190 } } }], []),
    });
    const err = await oauth.refresh("X").catch((e) => e);
    expect(err).toMatchObject({ code: 190, retryable: false });
  });
});
