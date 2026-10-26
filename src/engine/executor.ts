import type { Db } from "../db/index.js";
import type { FlowGraph, FlowNode } from "./flow-types.js";
import { decideRecipient } from "./policy.js";
import { IgApiError, type InstagramApi, type IgQuickReply } from "../instagram/client.js";
import { renderTemplate, toInstagramMessage } from "../instagram/translate.js";
import { addTag, removeTag, setFieldValue } from "../store/contacts.js";
import { beginOutbound, finishOutbound, getOutbound, type MessageKind } from "../store/messages.js";
import { ensureTrackedLink, recipientToken, recordRecipients, trackedUrl } from "../store/links.js";

const MAX_STEPS = 50;

export type RunInput = {
  accountId: string;
  connectionId: string;
  contactId: string;
  igAccountId: string;
  accessToken: string;
  igsid: string;
  username: string | null;
  firstName: string | null;
  lastInboundAt: Date | null;
  /** Presente quando o fluxo foi disparado por comentário. */
  commentId?: string;
  flowVersionId: string;
  /** Prefixo das chaves de idempotência — o mesmo evento reprocessado não reenvia nada. */
  idempotencyBase: string;
  /** Quantas vezes o follow já foi reconferido nesta execução (ver check_follow.wait_for_follow). */
  followRechecks?: number;
};

/** Espera antes de cada nova checagem de follow. Medido no OpenReply: ainda `false` aos 17 s, `true` por volta de 68 s. */
export const FOLLOW_RECHECK_DELAYS_MS = [20_000, 40_000];

export type RunResult = {
  visited: string[];
  sent: { nodeId: string; kind: MessageKind }[];
  blocked: { nodeId: string; reason: string }[];
  stoppedBy?: string;
  /** Preenchido quando a API respondeu erro 190: o token da conexão não vale mais. */
  tokenInvalid?: string;
  /** O fluxo pediu para ser retomado depois deste tempo (nova checagem de follow). */
  followRecheckAfterMs?: number;
};

export type ExecutorDeps = {
  db: Db;
  ig: InstagramApi;
  /** Com a URL pública do servidor, os botões de link passam pelo contador de cliques (/r/<slug>). */
  links?: { baseUrl: string; secret: string };
};

export function quickReplyPayload(flowVersionId: string, nodeId: string): string {
  return `qr:${flowVersionId}:${nodeId}`;
}

export function parseQuickReplyPayload(payload: string): { flowVersionId: string; nodeId: string } | null {
  const m = /^qr:([0-9a-f-]{36}):(.+)$/i.exec(payload);
  return m ? { flowVersionId: m[1]!, nodeId: m[2]! } : null;
}

export async function runFlow(deps: ExecutorDeps, graph: FlowGraph, startNodeId: string, input: RunInput): Promise<RunResult> {
  const result: RunResult = { visited: [], sent: [], blocked: [] };
  const vars = { username: input.username, first_name: input.firstName ?? input.username };
  let privateReplyUsed = false;
  let nodeId: string | null | undefined = startNodeId;

  /**
   * Envia uma vez por chave. "failed" = erro definitivo; "unconfirmed" = não dá para saber se chegou
   * (5xx, rede, erro 1/2, ou um envio anterior que ficou pela metade) e por isso não se repete.
   * Recusas temporárias da API (limite de taxa) sobem como exceção para o job ser reprocessado.
   */
  async function sendOnce(
    key: string,
    kind: MessageKind,
    payload: unknown,
    send: () => Promise<string | undefined>,
  ): Promise<"sent" | "failed" | "unconfirmed"> {
    const previous = await getOutbound(deps.db, key);
    if (previous?.status === "sent") return "sent";
    if (previous?.status === "blocked") return "failed";
    // `pending` que sobrou de uma execução anterior = o processo caiu no meio do envio. Na dúvida, não repete.
    if (previous?.status === "pending" || previous?.status === "unconfirmed") return "unconfirmed";
    await beginOutbound(deps.db, {
      key, accountId: input.accountId, connectionId: input.connectionId, contactId: input.contactId, kind, payload,
    });
    try {
      const externalId = await send();
      await finishOutbound(deps.db, key, { status: "sent", externalId });
      return "sent";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof IgApiError && err.deliveryUncertain) {
        await finishOutbound(deps.db, key, { status: "unconfirmed", error: message });
        return "unconfirmed";
      }
      await finishOutbound(deps.db, key, { status: "failed", error: message });
      if (err instanceof IgApiError && err.code === 190) result.tokenInvalid = message;
      if (err instanceof IgApiError && !err.retryable) return "failed";
      throw err;
    }
  }

  for (let step = 0; nodeId && step < MAX_STEPS; step++) {
    const node: FlowNode | undefined = graph.nodes[nodeId];
    if (!node) {
      result.stoppedBy = `nó inexistente: ${nodeId}`;
      break;
    }
    result.visited.push(nodeId);
    const keyBase = `${input.idempotencyBase}:${nodeId}`;

    if (node.type === "check_follow") {
      const follows = await deps.ig.getFollowStatus({ accessToken: input.accessToken, igsid: input.igsid });
      if (follows === false && node.wait_for_follow) {
        // A pessoa disse que já segue: dá tempo para a Meta reconhecer o follow antes de recusar.
        const done = input.followRechecks ?? 0;
        if (done < FOLLOW_RECHECK_DELAYS_MS.length) {
          result.followRecheckAfterMs = FOLLOW_RECHECK_DELAYS_MS[done];
          result.stoppedBy = "aguardando o Instagram confirmar o follow";
          break;
        }
      }
      // null (a Meta não informou) conta como seguidor: nunca prender quem segue de verdade.
      nodeId = follows === false ? node.not_following : node.following;
      continue;
    }

    if (node.type === "send_message") {
      const { messages, quick_replies } = node.content.content;
      const qrs: IgQuickReply[] | undefined = quick_replies?.map((qr) => ({
        content_type: "text",
        title: qr.caption,
        payload: quickReplyPayload(input.flowVersionId, qr.target),
      }));

      let stop = false;
      for (const [i, msg] of messages.entries()) {
        const key = `${keyBase}:${i}`;
        const previous = await getOutbound(deps.db, key);
        if (previous?.status === "sent") {
          if (previous.kind === "private_reply") privateReplyUsed = true;
          continue;
        }

        const decision = decideRecipient({
          igsid: input.igsid,
          lastInboundAt: input.lastInboundAt,
          commentId: input.commentId,
          privateReplyUsed,
        });
        const tracked: { linkId: string; recipient: string }[] = [];
        let rendered = msg.type === "text" ? { ...msg, text: renderTemplate(msg.text, vars) } : msg;
        if (rendered.type === "text" && rendered.buttons?.length && deps.links) {
          const { baseUrl, secret } = deps.links;
          const recipient = recipientToken(secret, input.contactId);
          const buttons = [];
          for (const b of rendered.buttons) {
            const link = await ensureTrackedLink(deps.db, { accountId: input.accountId, flowVersionId: input.flowVersionId, url: b.url });
            if (link) tracked.push({ linkId: link.id, recipient });
            buttons.push(link ? { ...b, url: trackedUrl(baseUrl, link.slug, recipient) } : b);
          }
          rendered = { ...rendered, buttons };
        }
        // Quick replies vão na última mensagem do bloco.
        const igMessage = toInstagramMessage(rendered, i === messages.length - 1 ? qrs : undefined);

        if (!decision.ok) {
          await beginOutbound(deps.db, {
            key, accountId: input.accountId, connectionId: input.connectionId, contactId: input.contactId, kind: "dm",
            payload: igMessage, status: "blocked", error: decision.reason,
          });
          result.blocked.push({ nodeId, reason: decision.reason });
          stop = true;
          break;
        }

        if (decision.kind === "private_reply") privateReplyUsed = true;
        const outcome = await sendOnce(key, decision.kind, { recipient: decision.recipient, message: igMessage }, async () =>
          (await deps.ig.sendMessage({
            accessToken: input.accessToken,
            igAccountId: input.igAccountId,
            recipient: decision.recipient,
            message: igMessage,
          })).messageId,
        );
        if (outcome !== "sent") {
          result.stoppedBy = outcome === "unconfirmed" ? `entrega incerta em ${nodeId}` : `envio falhou em ${nodeId}`;
          stop = true;
          break;
        }
        await recordRecipients(deps.db, tracked);
        result.sent.push({ nodeId, kind: decision.kind });
      }
      if (stop) break;
      // Com quick replies o fluxo pausa: continua quando o contato tocar em uma delas.
      if (quick_replies?.length) {
        result.stoppedBy = "aguardando quick reply";
        break;
      }
    } else if (node.type === "reply_comment") {
      if (input.commentId) {
        const text = renderTemplate(node.texts[Math.floor(Math.random() * node.texts.length)]!, vars);
        const commentId = input.commentId;
        const outcome = await sendOnce(`${keyBase}:0`, "comment_reply", { comment_id: commentId, text }, async () =>
          (await deps.ig.replyToComment({ accessToken: input.accessToken, commentId, text })).id,
        );
        // Resposta pública incerta ou recusada não impede a DM: o fluxo segue.
        if (outcome === "sent") result.sent.push({ nodeId, kind: "comment_reply" });
        else if (result.tokenInvalid) {
          result.stoppedBy = `token inválido em ${nodeId}`;
          break;
        }
      }
    } else if (node.type === "action") {
      for (const a of node.actions) {
        if (a.action === "add_tag") await addTag(deps.db, input.accountId, input.contactId, a.tag_name);
        else if (a.action === "remove_tag") await removeTag(deps.db, input.accountId, input.contactId, a.tag_name);
        else await setFieldValue(deps.db, input.accountId, input.contactId, a.field_name, a.value);
      }
    }

    nodeId = node.next;
  }

  if (nodeId && result.visited.length >= MAX_STEPS) result.stoppedBy = "limite de passos (laço no fluxo?)";
  return result;
}
