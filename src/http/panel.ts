import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

const FILES: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "favicon.svg": "image/svg+xml",
  "kora-wordmark.svg": "image/svg+xml",
  "kora-wordmark-white.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
};

/** O painel só fala com a própria API; fontes vêm do Google Fonts. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** Painel web estático: HTML + JS sem etapa de build, servido pelo mesmo servidor da API. */
export function registerPanelRoutes(app: FastifyInstance): void {
  const cache = new Map<string, Buffer>();
  const load = async (file: string) => {
    // Em desenvolvimento relê a cada pedido para refletir edições; em produção guarda em memória.
    if (process.env.NODE_ENV === "production" && cache.has(file)) return cache.get(file)!;
    const buf = await readFile(path.join(PUBLIC_DIR, file));
    cache.set(file, buf);
    return buf;
  };

  const send = (file: string) => async (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply
      .header("Content-Security-Policy", CSP)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-cache")
      .type(FILES[file]!)
      .send(await load(file));

  app.get("/", send("index.html"));
  for (const file of Object.keys(FILES)) {
    if (file !== "index.html") app.get(`/panel/${file}`, send(file));
  }
}
