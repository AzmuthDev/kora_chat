import { IgApiError } from "./client.js";

/**
 * Instagram API with Instagram Login ("Business Login"):
 *   1. usuário autoriza em instagram.com/oauth/authorize → volta com ?code
 *   2. code → token curto (1h)              POST api.instagram.com/oauth/access_token
 *   3. token curto → token longo (60 dias)  GET  graph.instagram.com/access_token?grant_type=ig_exchange_token
 *   4. renovação (token com ≥24h e válido)  GET  graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 */

export const REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export const WEBHOOK_FIELDS = ["comments", "messages"] as const;

export type LongLivedToken = { accessToken: string; expiresInSeconds: number };
export type IgProfile = { userId: string; appScopedId?: string; username?: string; name?: string; accountType?: string };

export interface InstagramOAuth {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<{ accessToken: string; userId: string; permissions: string[] }>;
  exchangeForLongLived(shortLivedToken: string): Promise<LongLivedToken>;
  refresh(longLivedToken: string): Promise<LongLivedToken>;
  getProfile(accessToken: string): Promise<IgProfile>;
  /** Sem isso a Meta não entrega webhooks desta conta para o app. */
  subscribeWebhooks(accessToken: string, fields: readonly string[]): Promise<void>;
}

type OAuthOptions = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  graphBaseUrl: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
};

type Json = Record<string, unknown>;

/** A Graph API responde `{error:{message,code}}`; o endpoint de OAuth responde `{error_type, code, error_message}`. */
async function readJson(res: Response): Promise<Json> {
  const json = (await res.json().catch(() => ({}))) as Json;
  if (res.ok && !json.error && !json.error_type) return json;
  const graph = (json.error ?? {}) as { message?: string; code?: number; error_subcode?: number };
  const message = graph.message ?? (json.error_message as string | undefined) ?? `HTTP ${res.status}`;
  const code = graph.code ?? (typeof json.code === "number" ? json.code : undefined);
  throw new IgApiError(message, res.ok ? 400 : res.status, code, graph.error_subcode);
}

const expiresIn = (json: Json): number => {
  const n = Number(json.expires_in);
  return Number.isFinite(n) && n > 0 ? n : 60 * 24 * 3600;
};

async function call(doFetch: typeof fetch, url: string, init?: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new IgApiError(`falha de rede: ${(err as Error).message}`, 503);
  }
  return readJson(res);
}

/** A renovação não usa app ID/secret — funciona mesmo sem o OAuth configurado (tokens colados à mão). */
export async function refreshLongLivedToken(
  graphBaseUrl: string,
  longLivedToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LongLivedToken> {
  const params = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: longLivedToken });
  const json = await call(fetchImpl, `${graphBaseUrl.replace(/\/$/, "")}/refresh_access_token?${params}`);
  if (typeof json.access_token !== "string") throw new IgApiError("resposta sem access_token", 502);
  return { accessToken: json.access_token, expiresInSeconds: expiresIn(json) };
}

export function createInstagramOAuth(opts: OAuthOptions): InstagramOAuth {
  const doFetch = opts.fetchImpl ?? fetch;
  const graph = opts.graphBaseUrl.replace(/\/$/, "");
  const request = (url: string, init?: RequestInit) => call(doFetch, url, init);

  return {
    authorizeUrl(state) {
      const url = new URL(opts.authorizeUrl);
      url.search = new URLSearchParams({
        client_id: opts.appId,
        redirect_uri: opts.redirectUri,
        response_type: "code",
        scope: REQUIRED_SCOPES.join(","),
        state,
        enable_fb_login: "0",
      }).toString();
      return url.toString();
    },

    async exchangeCode(code) {
      const json = await request(opts.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: opts.appId,
          client_secret: opts.appSecret,
          grant_type: "authorization_code",
          redirect_uri: opts.redirectUri,
          // O Instagram às vezes acrescenta "#_" ao code no redirect.
          code: code.replace(/#_$/, ""),
        }),
      });
      // Formato novo: { data: [ {...} ] }; formato antigo: { access_token, user_id, permissions }.
      const row = (Array.isArray(json.data) ? (json.data[0] as Json | undefined) : json) ?? {};
      const accessToken = row.access_token;
      if (typeof accessToken !== "string") throw new IgApiError("resposta sem access_token", 502);
      const perms = row.permissions;
      return {
        accessToken,
        userId: String(row.user_id ?? ""),
        permissions: Array.isArray(perms) ? perms.map(String) : typeof perms === "string" ? perms.split(",").map((p) => p.trim()) : [],
      };
    },

    async exchangeForLongLived(shortLivedToken) {
      const params = new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: opts.appSecret,
        access_token: shortLivedToken,
      });
      const json = await request(`${graph}/access_token?${params}`);
      if (typeof json.access_token !== "string") throw new IgApiError("resposta sem access_token", 502);
      return { accessToken: json.access_token, expiresInSeconds: expiresIn(json) };
    },

    refresh: (longLivedToken) => refreshLongLivedToken(graph, longLivedToken, doFetch),

    async getProfile(accessToken) {
      const params = new URLSearchParams({ fields: "user_id,username,name,account_type", access_token: accessToken });
      const json = await request(`${graph}/${opts.graphVersion}/me?${params}`);
      // `user_id` é o ID da conta profissional — o mesmo que chega em entry[].id nos webhooks.
      const userId = json.user_id ?? json.id;
      if (userId === undefined) throw new IgApiError("perfil sem user_id", 502);
      return {
        userId: String(userId),
        appScopedId: json.id !== undefined && json.id !== userId ? String(json.id) : undefined,
        username: typeof json.username === "string" ? json.username : undefined,
        name: typeof json.name === "string" ? json.name : undefined,
        accountType: typeof json.account_type === "string" ? json.account_type : undefined,
      };
    },

    async subscribeWebhooks(accessToken, fields) {
      const params = new URLSearchParams({ subscribed_fields: fields.join(","), access_token: accessToken });
      const json = await request(`${graph}/${opts.graphVersion}/me/subscribed_apps?${params}`, { method: "POST" });
      if (json.success === false) throw new IgApiError("subscribed_apps retornou success=false", 400);
    },
  };
}
