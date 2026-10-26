import type { Db } from "../db/index.js";
import type { FlowGraph, FlowNode } from "./flow-types.js";
import { decideRecipient } from "./policy.js";
import { IgApiError, type InstagramApi, type IgQuickReply } from "../instagram/client.js";
import { renderTemplate, toInstagramMessage } from "../instagram/translate.js";
import { addTag, removeTag, setFieldValue } from "../store/contacts.js";
import { beginOutbound, finishOutbound, getOutbound, type MessageKind } from "../store/messages.js";

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
};

export type RunResult = {
  visited: string[];
  sent: { nodeId: string; kind: MessageKind }[];
  blocked: { nodeId: string; reason: string }[];
  stoppedBy?: string;
  /** Preenchido quando a API respondeu erro 190: o token da conexão não vale mais. */
  tokenInvalid?: string;
};

export type ExecutorDeps = { db: Db; ig: InstagramApi };

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
   * Envia uma vez por chave. Retorna false se o fluxo deve parar (erro definitivo).
   * Erros temporários da API sobem como exceção para o job ser reprocessado.
   */
  async function sendOnce(key: string, kind: MessageKind, payload: unknown, send: () => Promise<string | undefined>) {
    const previous = await getOutbound(deps.db, key);
    if (previous?.status === "sent" || previous?.status === "blocked") return previous.status === "sent";
    await beginOutbound(deps.db, {
      key, accountId: input.accountId, connectionId: input.connectionId, contactId: input.contactId, kind, payload,
    });
    try {
      const externalId = await send();
      await finishOutbound(deps.db, key, { status: "sent", externalId });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishOutbound(deps.db, key, { status: "failed", error: message });
      if (err instanceof IgApiError && err.code === 190) result.tokenInvalid = message;
      if (err instanceof IgApiError && !err.retryable) return false;
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
        const rendered = msg.type === "text" ? { ...msg, text: renderTemplate(msg.text, vars) } : msg;
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
        const ok = await sendOnce(key, decision.kind, { recipient: decision.recipient, message: igMessage }, async () =>
          (await deps.ig.sendMessage({
            accessToken: input.accessToken,
            igAccountId: input.igAccountId,
            recipient: decision.recipient,
            message: igMessage,
          })).messageId,
        );
        if (!ok) {
          result.stoppedBy = `envio falhou em ${nodeId}`;
          stop = true;
          break;
        }
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
        const ok = await sendOnce(`${keyBase}:0`, "comment_reply", { comment_id: commentId, text }, async () =>
          (await deps.ig.replyToComment({ accessToken: input.accessToken, commentId, text })).id,
        );
        if (ok) result.sent.push({ nodeId, kind: "comment_reply" });
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
