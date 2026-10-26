import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  /** MySQL 8: mysql://usuario:senha@host:porta/banco (acrescente ?ssl-mode=REQUIRED em bancos na nuvem). */
  DATABASE_URL: z
    .string({ error: "defina DATABASE_URL (mysql://usuario:senha@host:porta/banco)" })
    .regex(/^mysql:\/\//, "precisa começar com mysql://"),
  /** Caminho do certificado CA do provedor (a Aiven exige: baixe o ca.pem no painel do serviço). */
  DATABASE_SSL_CA: z.string().optional(),
  /** App Secret do app na Meta — valida X-Hub-Signature-256 dos webhooks. */
  META_APP_SECRET: z.string().min(1),
  /** Token que você escolhe e cola no painel da Meta ao assinar o webhook. */
  META_VERIFY_TOKEN: z.string().min(1),
  /** Protege a API administrativa (/api/*). */
  ADMIN_TOKEN: z.string().min(16),
  /** 32 bytes em hex (64 caracteres) — cifra os access tokens do Instagram no banco. */
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "precisa ter 64 caracteres hex"),
  IG_GRAPH_BASE_URL: z.string().url().default("https://graph.instagram.com"),
  IG_GRAPH_VERSION: z.string().default("v24.0"),
  /** Login OAuth do Instagram (painel do app → Instagram → "Instagram app ID/secret"). Opcional: sem eles, só conexão manual. */
  IG_APP_ID: z.string().optional(),
  IG_APP_SECRET: z.string().optional(),
  /** URL pública HTTPS deste servidor; o redirect do OAuth é PUBLIC_BASE_URL/oauth/instagram/callback. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  IG_OAUTH_AUTHORIZE_URL: z.string().url().default("https://www.instagram.com/oauth/authorize"),
  IG_OAUTH_TOKEN_URL: z.string().url().default("https://api.instagram.com/oauth/access_token"),
  /** Renova o token longo quando faltarem menos que estes dias para expirar. */
  IG_TOKEN_REFRESH_DAYS_BEFORE: z.coerce.number().int().min(1).max(59).default(15),
  /** true quando há um proxy HTTPS na frente (nginx, Caddy, Cloudflare): o cookie de sessão passa a ser Secure. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  /** inline = worker roda no mesmo processo do servidor HTTP. */
  WORKER_MODE: z.enum(["inline", "off"]).default("inline"),
  /** De quantos em quantos minutos o worker procura comentários que o webhook não entregou. 0 desliga. */
  COMMENT_SWEEP_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
});

export type Config = {
  port: number;
  host: string;
  databaseUrl: string;
  databaseSslCa?: string;
  metaAppSecret: string;
  metaVerifyToken: string;
  adminToken: string;
  tokenEncryptionKey: string;
  igGraphBaseUrl: string;
  igGraphVersion: string;
  publicBaseUrl?: string;
  /** Presente só quando IG_APP_ID, IG_APP_SECRET e PUBLIC_BASE_URL estão configurados. */
  igOAuth?: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    authorizeUrl: string;
    tokenUrl: string;
  };
  tokenRefreshDaysBefore: number;
  trustProxy: boolean;
  workerMode: "inline" | "off";
  commentSweepMinutes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `CHAVE=` vazio no .env (como vem do .env.example) conta como não definido.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(defined);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida (veja .env.example):\n${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    databaseSslCa: e.DATABASE_SSL_CA,
    metaAppSecret: e.META_APP_SECRET,
    metaVerifyToken: e.META_VERIFY_TOKEN,
    adminToken: e.ADMIN_TOKEN,
    tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY,
    igGraphBaseUrl: e.IG_GRAPH_BASE_URL,
    igGraphVersion: e.IG_GRAPH_VERSION,
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/$/, ""),
    igOAuth:
      e.IG_APP_ID && e.IG_APP_SECRET && e.PUBLIC_BASE_URL
        ? {
            appId: e.IG_APP_ID,
            appSecret: e.IG_APP_SECRET,
            redirectUri: `${e.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/instagram/callback`,
            authorizeUrl: e.IG_OAUTH_AUTHORIZE_URL,
            tokenUrl: e.IG_OAUTH_TOKEN_URL,
          }
        : undefined,
    tokenRefreshDaysBefore: e.IG_TOKEN_REFRESH_DAYS_BEFORE,
    trustProxy: e.TRUST_PROXY === "true",
    workerMode: e.WORKER_MODE,
    commentSweepMinutes: e.COMMENT_SWEEP_MINUTES,
  };
}
