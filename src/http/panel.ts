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
  "legal/privacidade.html": "text/html; charset=utf-8",
  "legal/termos.html": "text/html; charset=utf-8",
};

/** Páginas públicas (sem login): a Meta exige a URL da política de privacidade no app. */
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/privacidade": "legal/privacidade.html",
  "/termos": "legal/termos.html",
};

/** O painel só fala com a própria API; fontes vêm do Google Fonts. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  // Miniaturas dos posts no seletor vêm do CDN do Instagram/Facebook.
  "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net",
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

  for (const [route, file] of Object.entries(PAGES)) app.get(route, send(file));
  for (const file of Object.keys(FILES)) {
    if (!file.endsWith(".html")) app.get(`/panel/${file}`, send(file));
  }
}
