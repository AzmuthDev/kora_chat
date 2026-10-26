/**
 * Converte o payload de webhook do Instagram (object: "instagram") em eventos internos.
 *
 * Formatos tratados (Instagram API with Instagram Login / Graph webhooks):
 *   entry[].changes[] com field "comments"  → comentário em post/reel
 *   entry[].messaging[] com message          → DM recebida (ou eco de DM enviada por nós)
 * Qualquer outro campo é ignorado (devolvido em `ignored` para log).
 */

export type InstagramEvent =
  | {
      type: "comment";
      dedupeKey: string;
      igAccountId: string;
      commentId: string;
      parentCommentId?: string;
      mediaId?: string;
      mediaProductType?: string;
      fromId: string;
      fromUsername?: string;
      text: string;
      occurredAt: string;
    }
  | {
      type: "message";
      dedupeKey: string;
      igAccountId: string;
      messageId: string;
      senderId: string;
      text?: string;
      quickReplyPayload?: string;
      occurredAt: string;
    };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
const toIso = (t: unknown): string => {
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  // A Meta manda segundos em `entry.time` dos changes e milissegundos em `messaging.timestamp`.
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

export function normalizeInstagramWebhook(body: unknown): { events: InstagramEvent[]; ignored: string[] } {
  const events: InstagramEvent[] = [];
  const ignored: string[] = [];
  if (!isObj(body) || body.object !== "instagram" || !Array.isArray(body.entry)) {
    return { events, ignored: ["payload não é object=instagram"] };
  }

  for (const entry of body.entry) {
    if (!isObj(entry)) continue;
    const igAccountId = str(entry.id);
    if (!igAccountId) continue;

    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!isObj(change) || !isObj(change.value)) continue;
      if (change.field !== "comments") {
        ignored.push(`change:${String(change.field)}`);
        continue;
      }
      const v = change.value;
      const from = isObj(v.from) ? v.from : {};
      const media = isObj(v.media) ? v.media : {};
      const commentId = str(v.id);
      const fromId = str(from.id);
      if (!commentId || !fromId) {
        ignored.push("comment sem id/from");
        continue;
      }
      events.push({
        type: "comment",
        dedupeKey: `comment:${commentId}`,
        igAccountId,
        commentId,
        parentCommentId: str(v.parent_id),
        mediaId: str(media.id),
        mediaProductType: str(media.media_product_type),
        fromId,
        fromUsername: str(from.username),
        text: str(v.text) ?? "",
        occurredAt: toIso(entry.time),
      });
    }

    for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
      if (!isObj(m) || !isObj(m.message)) {
        ignored.push("messaging sem message (read/reaction/postback)");
        continue;
      }
      const msg = m.message;
      if (msg.is_echo === true) {
        ignored.push("echo");
        continue;
      }
      const senderId = isObj(m.sender) ? str(m.sender.id) : undefined;
      const messageId = str(msg.mid);
      if (!senderId || !messageId || senderId === igAccountId) {
        ignored.push("message sem sender/mid ou enviada pela própria conta");
        continue;
      }
      events.push({
        type: "message",
        dedupeKey: `message:${messageId}`,
        igAccountId,
        messageId,
        senderId,
        text: str(msg.text),
        quickReplyPayload: isObj(msg.quick_reply) ? str(msg.quick_reply.payload) : undefined,
        occurredAt: toIso(m.timestamp),
      });
    }
  }
  return { events, ignored };
}
