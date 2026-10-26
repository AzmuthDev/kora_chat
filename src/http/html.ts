import type { FastifyReply } from "fastify";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(
  reply: FastifyReply,
  status: number,
  title: string,
  body: string,
  link?: { href: string; label: string },
) {
  const linkHtml = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : "";
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1b2430}` +
        `h1{font-size:1.4rem}a{color:#2848c8}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${linkHtml}</body></html>`,
    );
}
