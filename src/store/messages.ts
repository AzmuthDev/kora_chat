import type { Queryable } from "../db/index.js";

export type MessageKind = "dm" | "private_reply" | "comment_reply" | "comment";

export async function recordInbound(
  q: Queryable,
  m: { accountId: string; connectionId: string; contactId: string; kind: MessageKind; payload: unknown; externalId: string },
): Promise<void> {
  await q.query(
    `INSERT IGNORE INTO messages (account_id, connection_id, contact_id, channel, direction, kind, payload, external_message_id, idempotency_key, status)
     VALUES ($1, $2, $3, 'instagram', 'inbound', $4, $5, $6, $7, 'received')`,
    [m.accountId, m.connectionId, m.contactId, m.kind, JSON.stringify(m.payload), m.externalId, `in:${m.kind}:${m.externalId}`],
  );
}

export type OutboundState = { status: string; kind: MessageKind } | null;

export async function getOutbound(q: Queryable, key: string): Promise<OutboundState> {
  const { rows } = await q.query<{ status: string; kind: MessageKind }>(
    "SELECT status, kind FROM messages WHERE idempotency_key = $1",
    [key],
  );
  return rows[0] ?? null;
}

export async function beginOutbound(
  q: Queryable,
  m: {
    key: string;
    accountId: string;
    connectionId: string;
    contactId: string;
    kind: MessageKind;
    payload: unknown;
    status?: "pending" | "blocked";
    error?: string;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO messages (account_id, contact_id, channel, direction, kind, payload, idempotency_key, status, error, connection_id)
     VALUES ($1, $2, 'instagram', 'outbound', $3, $4, $5, $6, $7, $8) AS new
     ON DUPLICATE KEY UPDATE kind = new.kind, payload = new.payload, status = new.status, error = new.error`,
    [m.accountId, m.contactId, m.kind, JSON.stringify(m.payload), m.key, m.status ?? "pending", m.error ?? null, m.connectionId],
  );
}

export async function finishOutbound(
  q: Queryable,
  key: string,
  result: { status: "sent"; externalId?: string } | { status: "failed"; error: string },
): Promise<void> {
  await q.query("UPDATE messages SET status = $2, external_message_id = $3, error = $4 WHERE idempotency_key = $1", [
    key,
    result.status,
    result.status === "sent" ? (result.externalId ?? null) : null,
    result.status === "failed" ? result.error : null,
  ]);
}
