import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { buildApp } from "./http/app.js";
import { createInstagramApi } from "./instagram/client.js";
import { createInstagramOAuth, refreshLongLivedToken } from "./instagram/oauth.js";
import { startWorker } from "./worker/run.js";

const config = loadConfig();
const db = createDb({ databaseUrl: config.databaseUrl, sslCaPath: config.databaseSslCa });
const applied = await migrate(db);

const oauth = config.igOAuth
  ? createInstagramOAuth({ ...config.igOAuth, graphBaseUrl: config.igGraphBaseUrl, graphVersion: config.igGraphVersion })
  : undefined;

const ig = createInstagramApi({ baseUrl: config.igGraphBaseUrl, version: config.igGraphVersion });

const app = buildApp(
  { config, db, oauth, ig },
  {
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Sem query string no log: ela carrega o `code` do OAuth e o hub.verify_token.
      serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] }) },
    },
  },
);
if (applied.length) app.log.info({ applied }, "migrações aplicadas");
app.log.info(`usando MySQL em ${new URL(config.databaseUrl).host}`);
app.log.info(oauth ? `OAuth do Instagram ativo (redirect: ${config.igOAuth!.redirectUri})` : "OAuth do Instagram desativado");

const worker =
  config.workerMode === "inline"
    ? startWorker({ db, ig, tokenEncryptionKey: config.tokenEncryptionKey, publicBaseUrl: config.publicBaseUrl }, app.log, {
        tokenRefresh: {
          db,
          oauth: { refresh: (token) => refreshLongLivedToken(config.igGraphBaseUrl, token) },
          tokenEncryptionKey: config.tokenEncryptionKey,
          refreshDaysBefore: config.tokenRefreshDaysBefore,
        },
        commentSweepMs: config.commentSweepMinutes * 60 * 1000,
      })
    : null;

await app.listen({ port: config.port, host: config.host });

async function shutdown(signal: string) {
  app.log.info(`${signal}: encerrando`);
  await app.close();
  await worker?.stop();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
