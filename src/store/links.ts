/**
 * Links rastreados: contam quantas pessoas tocaram no botão da DM.
 * Ideia adaptada do OpenReply (github.com/diwenne/openreply, licença MIT).
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";

const RECIPIENT_RE = /^[\w-]{22}$/;

/** Token da pessoa no link (?r=). HMAC: dá para contar pessoas distintas sem expor quem é. */
export function recipientToken(secret: string, contactId: string): string {
  return createHmac("sha256", secret).update(`link-recipient:${contactId}`).digest("base64url").slice(0, 22);
}

export function parseRecipientToken(value: unknown): string | null {
  return typeof value === "string" && RECIPIENT_RE.test(value) ? value : null;
}

export function hashIp(secret: string, ip: string | undefined): string | null {
  return ip ? createHmac("sha256", secret).update(`link-ip:${ip}`).digest("hex") : null;
}

/** Link do fluxo para o destino (cria na primeira vez; o mesmo destino reaproveita o slug). */
export async function ensureTrackedLink(
  q: Queryable,
  input: { accountId: string; flowVersionId: string; url: string },
): Promise<{ id: string; slug: string } | null> {
  const urlHash = createHash("sha256").update(input.url).digest("hex");
  const flow = await q.query<{ flow_id: string }>("SELECT flow_id FROM flow_versions WHERE id = $1", [input.flowVersionId]);
  const flowId = flow.rows[0]?.flow_id;
  if (!flowId) return null;
  await q.query(
    `INSERT IGNORE INTO tracked_links (id, slug, account_id, flow_id, url, url_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), randomBytes(7).toString("base64url"), input.accountId, flowId, input.url, urlHash],
  );
  const { rows } = await q.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM tracked_links WHERE flow_id = $1 AND url_hash = $2",
    [flowId, urlHash],
  );
  return rows[0] ?? null;
}

export function trackedUrl(baseUrl: string, slug: string, recipient: string): string {
  return `${baseUrl.replace(/\/$/, "")}/r/${slug}?r=${recipient}`;
}

/** Chamado depois do envio confirmado: só conta quem de fato recebeu o link. */
export async function recordRecipients(q: Queryable, items: { linkId: string; recipient: string }[]): Promise<void> {
  for (const i of items) {
    await q.query("INSERT IGNORE INTO tracked_link_recipients (link_id, recipient) VALUES ($1, $2)", [i.linkId, i.recipient]);
  }
}

export async function recordClick(
  q: Queryable,
  slug: string,
  click: { recipient: string | null; ipHash: string | null; userAgent?: string },
): Promise<string | null> {
  const { rows } = await q.query<{ id: string; url: string }>("SELECT id, url FROM tracked_links WHERE slug = $1", [slug]);
  const link = rows[0];
  // O destino foi validado como http(s) ao criar a automação; confere de novo antes de redirecionar.
  if (!link || !/^https?:\/\//i.test(link.url)) return null;
  await q.query("INSERT INTO link_clicks (link_id, recipient, ip_hash, user_agent) VALUES ($1, $2, $3, $4)", [
    link.id,
    click.recipient,
    click.ipHash,
    click.userAgent?.slice(0, 300) ?? null,
  ]);
  return link.url;
}

export type LinkStats = { recipients: number; clicks: number; people_clicked: number };

/** Totais por fluxo. people_clicked conta só quem recebeu o link e tocou nele (base da taxa de clique). */
export async function linkStatsByFlow(q: Queryable, accountId: string): Promise<Map<string, LinkStats>> {
  const { rows } = await q.query<{ flow_id: string; recipients: number | string; clicks: number | string; people_clicked: number | string }>(
    `SELECT l.flow_id,
            (SELECT COUNT(*) FROM tracked_link_recipients r JOIN tracked_links l2 ON l2.id = r.link_id
              WHERE l2.flow_id = l.flow_id) AS recipients,
            (SELECT COUNT(*) FROM link_clicks c JOIN tracked_links l2 ON l2.id = c.link_id
              WHERE l2.flow_id = l.flow_id) AS clicks,
            (SELECT COUNT(DISTINCT c.recipient) FROM link_clicks c
               JOIN tracked_link_recipients r ON r.link_id = c.link_id AND r.recipient = c.recipient
               JOIN tracked_links l2 ON l2.id = c.link_id
              WHERE l2.flow_id = l.flow_id) AS people_clicked
       FROM tracked_links l
      WHERE l.account_id = $1
      GROUP BY l.flow_id`,
    [accountId],
  );
  return new Map(
    rows.map((r) => [r.flow_id, { recipients: Number(r.recipients), clicks: Number(r.clicks), people_clicked: Number(r.people_clicked) }]),
  );
}
