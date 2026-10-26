import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/index.js";
import { createTestDb } from "./mysql-test-db.js";
import { buildApp } from "../src/http/app.js";
import { IgApiError, type IgMessage, type InstagramApi } from "../src/instagram/client.js";
import type { Recipient } from "../src/engine/policy.js";
import { signMetaPayload } from "../src/instagram/signature.js";
import type { WorkerDeps } from "../src/worker/process-event.js";
import { createInstagramOAuth, REQUIRED_SCOPES, type IgProfile, type InstagramOAuth, type LongLivedToken } from "../src/instagram/oauth.js";

export const IG_ACCOUNT_ID = "17841400000000001";
export const ADMIN = "admin-token-de-teste-123456";

export const IG_APP_SECRET = "ig-app-secret";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    META_APP_SECRET: "app-secret",
    META_VERIFY_TOKEN: "verify-me",
    ADMIN_TOKEN: ADMIN,
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    IG_APP_ID: "123456789",
    IG_APP_SECRET,
    PUBLIC_BASE_URL: "https://clone.exemplo",
    // Só para validar a config: os testes passam o próprio banco para o app.
    DATABASE_URL: "mysql://teste@127.0.0.1/teste",
    ...overrides,
  });
}

export type SentCall =
  | { op: "sendMessage"; accessToken: string; igAccountId: string; recipient: Recipient; message: IgMessage }
  | { op: "replyToComment"; accessToken: string; commentId: string; text: string };

/** Instagram falso: grava as chamadas e permite injetar falhas. */
export class FakeInstagram implements InstagramApi {
  calls: SentCall[] = [];
  failNext: IgApiError[] = [];
  failReplyNext: IgApiError[] = [];
  private seq = 0;

  async sendMessage(args: { accessToken: string; igAccountId: string; recipient: Recipient; message: IgMessage }) {
    const err = this.failNext.shift();
    if (err) throw err;
    this.calls.push({ op: "sendMessage", ...args });
    return { messageId: `mid.${++this.seq}` };
  }

  async replyToComment(args: { accessToken: string; commentId: string; text: string }) {
    const err = this.failReplyNext.shift();
    if (err) throw err;
    this.calls.push({ op: "replyToComment", ...args });
    return { id: `reply.${++this.seq}` };
  }
}

/** OAuth falso: tokens previsíveis ("short:<code>" → "long:short:<code>") e falhas injetáveis. */
export class FakeOAuth implements InstagramOAuth {
  permissions: string[] = [...REQUIRED_SCOPES];
  profile: IgProfile = { userId: "17841400000000777", username: "novaloja" };
  exchangeError?: Error;
  refreshError?: Error;
  refreshed: string[] = [];
  subscribed: { accessToken: string; fields: readonly string[] }[] = [];
  private urls = createInstagramOAuth({
    appId: "123456789", appSecret: IG_APP_SECRET, redirectUri: "https://clone.exemplo/oauth/instagram/callback",
    authorizeUrl: "https://www.instagram.com/oauth/authorize", tokenUrl: "https://api.instagram.com/oauth/access_token",
    graphBaseUrl: "https://graph.instagram.com", graphVersion: "v24.0",
  });

  authorizeUrl(state: string) {
    return this.urls.authorizeUrl(state);
  }
  async exchangeCode(code: string) {
    if (this.exchangeError) throw this.exchangeError;
    return { accessToken: `short:${code}`, userId: this.profile.userId, permissions: this.permissions };
  }
  async exchangeForLongLived(token: string): Promise<LongLivedToken> {
    return { accessToken: `long:${token}`, expiresInSeconds: 60 * 24 * 3600 };
  }
  async refresh(token: string): Promise<LongLivedToken> {
    if (this.refreshError) throw this.refreshError;
    this.refreshed.push(token);
    return { accessToken: `${token}+r`, expiresInSeconds: 60 * 24 * 3600 };
  }
  async getProfile() {
    return this.profile;
  }
  async subscribeWebhooks(accessToken: string, fields: readonly string[]) {
    this.subscribed.push({ accessToken, fields });
  }
}

export type TestEnv = {
  db: Db;
  app: FastifyInstance;
  ig: FakeInstagram;
  oauth: FakeOAuth;
  config: Config;
  worker: WorkerDeps;
  accountId: string;
  close: () => Promise<void>;
};

export async function setup(opts: { oauth?: boolean } = {}): Promise<TestEnv> {
  const config = testConfig();
  const testDb = await createTestDb();
  const db = testDb.db;
  const oauth = new FakeOAuth();
  const app = buildApp({ config, db, oauth: opts.oauth === false ? undefined : oauth });
  const ig = new FakeInstagram();

  const account = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(), payload: { name: "Loja Teste" } });
  const accountId = account.json().id as string;
  const conn = await app.inject({
    method: "POST",
    url: `/api/accounts/${accountId}/connections/instagram`,
    headers: auth(),
    payload: { ig_user_id: IG_ACCOUNT_ID, username: "lojateste", access_token: "IGAA-token-de-teste" },
  });
  if (conn.statusCode !== 201) throw new Error(conn.body);

  return {
    db, app, ig, oauth, config, accountId,
    worker: { db, ig, tokenEncryptionKey: config.tokenEncryptionKey },
    close: async () => {
      await app.close();
      await testDb.drop();
    },
  };
}

export const auth = () => ({ authorization: `Bearer ${ADMIN}` });

export function commentWebhook(c: {
  commentId: string;
  text: string;
  fromId?: string;
  username?: string;
  mediaId?: string;
  parentId?: string;
}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: 1_792_800_000,
        changes: [
          {
            field: "comments",
            value: {
              from: { id: c.fromId ?? "990001", username: c.username ?? "maria" },
              media: { id: c.mediaId ?? "media-1", media_product_type: "REELS" },
              id: c.commentId,
              ...(c.parentId ? { parent_id: c.parentId } : {}),
              text: c.text,
            },
          },
        ],
      },
    ],
  };
}

export function dmWebhook(m: { mid: string; senderId?: string; text?: string; quickReply?: string; timestamp?: number }) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: m.senderId ?? "990001" },
            recipient: { id: IG_ACCOUNT_ID },
            timestamp: m.timestamp ?? Date.now(),
            message: {
              mid: m.mid,
              text: m.text ?? "",
              ...(m.quickReply ? { quick_reply: { payload: m.quickReply } } : {}),
            },
          },
        ],
      },
    ],
  };
}

export async function postWebhook(env: TestEnv, body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return env.app.inject({
    method: "POST",
    url: "/webhooks/instagram",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature ?? signMetaPayload(raw, env.config.metaAppSecret),
    },
    payload: raw,
  });
}
