/**
 * Varredura de comentários: rede de segurança para o webhook.
 *
 * Sem Advanced Access, a Meta não entrega o webhook de comentários em tempo real (e mesmo com ele
 * alguns comentários nunca chegam: "ver mais", contas filtradas). A cada poucos minutos o worker lê os
 * comentários recentes dos posts que têm automação e põe na fila os que casam e ainda não foram vistos.
 *
 * Não manda nada duas vezes: o evento é gravado com a mesma chave do webhook (`comment:<id>`), então
 * se o webhook chegar depois (ou já tiver chegado) o INSERT IGNORE de events_raw descarta a cópia.
 * Ideia adaptada do OpenReply (github.com/diwenne/openreply, licença MIT).
 */
import type { Queryable } from "../db/index.js";
import { decryptToken } from "../crypto/tokens.js";
import { commentTriggerConfigSchema, type CommentTriggerConfig } from "../engine/flow-types.js";
import { commentMatches } from "../engine/triggers.js";
import { IgApiError, type IgComment } from "../instagram/client.js";
import type { InstagramEvent } from "../instagram/normalize.js";
import { setConnectionStatus } from "../store/connections.js";
import { ingestInstagramEvents } from "./ingest.js";
import type { WorkerDeps } from "./process-event.js";

export type SweepOptions = {
  /** Comentários mais velhos que isso ficam de fora (a resposta privada só vale por 7 dias). */
  lookbackHours?: number;
  /** Teto de comentários novos por conta e por rodada: um post viral escoa aos poucos, sem estourar a API. */
  maxPerConnection?: number;
  /** Para automações de "qualquer post": quantos posts recentes olhar. */
  recentMediaLimit?: number;
  commentsPerMedia?: number;
};

export type SweepSummary = {
  connectionId: string;
  mediaScanned: number;
  matched: number;
  queued: number;
  errors: string[];
};

type Trigger = { config: CommentTriggerConfig; createdAt: number };

export async function sweepComments(deps: WorkerDeps, opts: SweepOptions = {}): Promise<SweepSummary[]> {
  const conns = await deps.db.query<{ id: string; account_id: string; external_account_id: string; access_token_enc: string }>(
    `SELECT id, account_id, external_account_id, access_token_enc FROM channel_connections
      WHERE channel = 'instagram' AND status = 'active' AND NOT sandbox
      ORDER BY created_at`,
  );
  const summaries: SweepSummary[] = [];
  for (const conn of conns.rows) {
    const triggers = await activeCommentTriggers(deps.db, conn.account_id);
    if (triggers.length === 0) continue;
    try {
      summaries.push(
        await sweepConnection(deps, opts, {
          id: conn.id,
          igAccountId: conn.external_account_id,
          accessToken: decryptToken(conn.access_token_enc, deps.tokenEncryptionKey),
          triggers,
        }),
      );
    } catch (err) {
      // Uma conexão com problema não pode impedir a varredura das outras.
      summaries.push({ connectionId: conn.id, mediaScanned: 0, matched: 0, queued: 0, errors: [String(err)] });
    }
  }
  return summaries;
}

async function activeCommentTriggers(q: Queryable, accountId: string): Promise<Trigger[]> {
  const { rows } = await q.query<{ config: unknown; created_at: string | Date }>(
    `SELECT t.config, t.created_at FROM triggers t
       JOIN flows f ON f.id = t.flow_id AND f.status = 'published'
      WHERE t.account_id = $1 AND t.channel = 'instagram' AND t.type = 'comment' AND t.active`,
    [accountId],
  );
  return rows.map((r) => ({
    config: commentTriggerConfigSchema.parse(r.config),
    createdAt: new Date(r.created_at).getTime(),
  }));
}

async function sweepConnection(
  deps: WorkerDeps,
  opts: SweepOptions,
  conn: { id: string; igAccountId: string; accessToken: string; triggers: Trigger[] },
): Promise<SweepSummary> {
  const summary: SweepSummary = { connectionId: conn.id, mediaScanned: 0, matched: 0, queued: 0, errors: [] };
  const since = Date.now() - (opts.lookbackHours ?? 72) * 60 * 60 * 1000;

  // Posts fixados nas automações + os mais recentes, se alguma automação vale para qualquer post.
  const mediaIds = new Set(conn.triggers.flatMap((t) => t.config.media_ids));
  try {
    if (conn.triggers.some((t) => t.config.media_ids.length === 0)) {
      const recent = await deps.ig.listRecentMedia({
        accessToken: conn.accessToken,
        igAccountId: conn.igAccountId,
        limit: opts.recentMediaLimit ?? 10,
      });
      for (const m of recent) mediaIds.add(m.id);
    }
  } catch (err) {
    if (await handleError(deps, conn.id, err, "posts recentes", summary)) return summary;
  }

  const found: { comment: IgComment; mediaId: string }[] = [];
  for (const mediaId of mediaIds) {
    summary.mediaScanned++;
    let comments: IgComment[];
    try {
      comments = await deps.ig.listComments({ accessToken: conn.accessToken, mediaId, limit: opts.commentsPerMedia ?? 50 });
    } catch (err) {
      if (await handleError(deps, conn.id, err, mediaId, summary)) return summary;
      continue;
    }
    for (const c of comments) {
      const at = Date.parse(c.timestamp);
      if (at < since) continue;
      // Comentário da própria conta (nossas respostas públicas) ou que a conta já respondeu.
      if (c.fromId === conn.igAccountId || c.replyFromIds.includes(conn.igAccountId)) continue;
      // Só o que veio depois da automação: ligar uma automação não dispara DM para comentários antigos.
      const hit = conn.triggers.some((t) => t.createdAt <= at && commentMatches(t.config, { text: c.text, mediaId }));
      if (!hit) continue;
      summary.matched++;
      found.push({ comment: c, mediaId });
    }
  }
  if (found.length === 0) return summary;

  // Tira o que já está em events_raw antes de aplicar o teto, senão o já visto ocupa a vaga dos novos.
  const known = new Set(
    (
      await deps.db.query<{ dedupe_key: string }>("SELECT dedupe_key FROM events_raw WHERE channel = 'instagram' AND dedupe_key IN ($1)", [
        found.map((f) => `comment:${f.comment.id}`),
      ])
    ).rows.map((r) => r.dedupe_key),
  );
  const events: InstagramEvent[] = found
    .filter((f) => !known.has(`comment:${f.comment.id}`))
    // Quem comentou primeiro é atendido primeiro.
    .sort((a, b) => Date.parse(a.comment.timestamp) - Date.parse(b.comment.timestamp))
    .slice(0, opts.maxPerConnection ?? 30)
    .map(({ comment: c, mediaId }) => ({
      type: "comment",
      dedupeKey: `comment:${c.id}`,
      igAccountId: conn.igAccountId,
      commentId: c.id,
      mediaId,
      fromId: c.fromId,
      fromUsername: c.fromUsername,
      text: c.text,
      occurredAt: c.timestamp,
    }));
  summary.queued = await ingestInstagramEvents(deps.db, events);
  return summary;
}

/** Registra o erro no resumo. Retorna true se a conexão inteira deve parar (token inválido). */
async function handleError(deps: WorkerDeps, connectionId: string, err: unknown, where: string, summary: SweepSummary): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  summary.errors.push(`${where}: ${message}`);
  if (err instanceof IgApiError && err.code === 190) {
    await setConnectionStatus(deps.db, connectionId, "expired", message);
    return true;
  }
  return false;
}
