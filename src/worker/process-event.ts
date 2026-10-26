import type { Db } from "../db/index.js";
import type { InstagramEvent } from "../instagram/normalize.js";
import type { InstagramApi } from "../instagram/client.js";
import { decryptToken } from "../crypto/tokens.js";
import { commentTriggerConfigSchema, graphSchema, type FlowGraph } from "../engine/flow-types.js";
import { commentMatches } from "../engine/triggers.js";
import { parseQuickReplyPayload, runFlow, type RunResult } from "../engine/executor.js";
import { markInbound, upsertInstagramContact } from "../store/contacts.js";
import { recordInbound } from "../store/messages.js";
import { sandboxInstagramApi } from "../instagram/sandbox.js";
import { setConnectionStatus } from "../store/connections.js";

export type WorkerDeps = { db: Db; ig: InstagramApi; tokenEncryptionKey: string };

export type ProcessOutcome =
  | { status: "ignored"; reason: string }
  | { status: "recorded" }
  | { status: "ran"; connectionId: string; flowVersionId: string; result: RunResult };

type Connection = { id: string; account_id: string; access_token_enc: string; sandbox: boolean };

export async function processInstagramEvent(deps: WorkerDeps, eventId: string, event: InstagramEvent): Promise<ProcessOutcome> {
  const outcome = await handleEvent(deps, eventId, event);
  // Erro 190 num envio: o token foi revogado/expirou. Para de usar a conexão até reconectar.
  if (outcome.status === "ran" && outcome.result.tokenInvalid) {
    await setConnectionStatus(deps.db, outcome.connectionId, "expired", outcome.result.tokenInvalid);
  }
  return outcome;
}

async function handleEvent(deps: WorkerDeps, eventId: string, event: InstagramEvent): Promise<ProcessOutcome> {
  const conn = (
    await deps.db.query<Connection>(
      `SELECT id, account_id, access_token_enc, sandbox FROM channel_connections
        WHERE channel = 'instagram' AND external_account_id = $1 AND status = 'active'`,
      [event.igAccountId],
    )
  ).rows[0];
  if (!conn) return { status: "ignored", reason: `conta Instagram ${event.igAccountId} não conectada` };

  const accountId = conn.account_id;
  const connectionId = conn.id;
  // Conexões de teste (simulador) nunca chamam o Instagram de verdade.
  const flowDeps = { db: deps.db, ig: conn.sandbox ? sandboxInstagramApi : deps.ig };
  const base = {
    accountId,
    connectionId,
    igAccountId: event.igAccountId,
    accessToken: decryptToken(conn.access_token_enc, deps.tokenEncryptionKey),
    idempotencyBase: `evt:${eventId}`,
  };

  if (event.type === "comment") {
    // Nossas próprias respostas públicas também geram webhook de comentário — sem isso vira laço infinito.
    if (event.fromId === event.igAccountId) return { status: "ignored", reason: "comentário da própria conta" };

    const contact = await deps.db.tx((q) => upsertInstagramContact(q, accountId, connectionId, event.fromId, event.fromUsername));
    await recordInbound(deps.db, {
      accountId, connectionId, contactId: contact.contactId, kind: "comment", externalId: event.commentId,
      payload: { text: event.text, media_id: event.mediaId, parent_id: event.parentCommentId },
    });

    const triggers = await deps.db.query<{ config: unknown; version_id: string; graph: unknown }>(
      `SELECT t.config, v.id AS version_id, v.graph
         FROM triggers t
         JOIN flows f ON f.id = t.flow_id AND f.status = 'published'
         JOIN flow_versions v ON v.id = f.published_version_id
        WHERE t.account_id = $1 AND t.channel = 'instagram' AND t.type = 'comment' AND t.active
        ORDER BY t.priority DESC, t.created_at`,
      [accountId],
    );
    const hit = triggers.rows.find((t) => commentMatches(commentTriggerConfigSchema.parse(t.config), event));
    if (!hit) return { status: "ignored", reason: "nenhum gatilho de comentário casou" };

    const graph: FlowGraph = graphSchema.parse(hit.graph);
    const result = await runFlow(flowDeps, graph, graph.start, {
      ...base,
      contactId: contact.contactId,
      igsid: event.fromId,
      username: contact.username,
      firstName: contact.firstName,
      lastInboundAt: contact.lastInboundAt,
      commentId: event.commentId,
      flowVersionId: hit.version_id,
    });
    return { status: "ran", connectionId, flowVersionId: hit.version_id, result };
  }

  // DM recebida
  const contact = await deps.db.tx(async (q) => {
    const c = await upsertInstagramContact(q, accountId, connectionId, event.senderId);
    await markInbound(q, c.contactId, event.occurredAt, event.text);
    return { ...c, lastInboundAt: new Date(event.occurredAt) };
  });
  await recordInbound(deps.db, {
    accountId, connectionId, contactId: contact.contactId, kind: "dm", externalId: event.messageId,
    payload: { text: event.text, quick_reply: event.quickReplyPayload },
  });

  const qr = event.quickReplyPayload ? parseQuickReplyPayload(event.quickReplyPayload) : null;
  if (!qr) return { status: "recorded" };

  const version = (
    await deps.db.query<{ graph: unknown }>(
      `SELECT v.graph FROM flow_versions v JOIN flows f ON f.id = v.flow_id
        WHERE v.id = $1 AND f.account_id = $2`,
      [qr.flowVersionId, accountId],
    )
  ).rows[0];
  if (!version) return { status: "ignored", reason: "quick reply de fluxo desconhecido" };

  const graph = graphSchema.parse(version.graph);
  const result = await runFlow(flowDeps, graph, qr.nodeId, {
    ...base,
    contactId: contact.contactId,
    igsid: event.senderId,
    username: contact.username,
    firstName: contact.firstName,
    lastInboundAt: contact.lastInboundAt,
    flowVersionId: qr.flowVersionId,
  });
  return { status: "ran", connectionId, flowVersionId: qr.flowVersionId, result };
}
