import { randomInt, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { graphSchema, type CommentTriggerConfig, type FlowGraph, type FlowNode } from "../engine/flow-types.js";

/** Mesmo estilo do `flow_ns` do ManyChat: content<timestamp>_<aleatório>. */
export function newFlowNs(now = new Date()): string {
  const ts = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `content${ts}_${randomInt(100000, 999999)}`;
}

export async function createPublishedFlow(
  db: Db,
  input: { accountId: string; name: string; graph: FlowGraph; trigger: { type: "comment"; config: CommentTriggerConfig; priority?: number } },
): Promise<{ flowId: string; ns: string; versionId: string; triggerId: string }> {
  const graph = graphSchema.parse(input.graph);
  return db.tx(async (q) => {
    const ns = newFlowNs();
    const flowId = randomUUID();
    const versionId = randomUUID();
    const triggerId = randomUUID();
    await q.query("INSERT INTO flows (id, account_id, ns, name, status) VALUES ($1, $2, $3, $4, 'published')", [
      flowId,
      input.accountId,
      ns,
      input.name,
    ]);
    await q.query("INSERT INTO flow_versions (id, flow_id, graph) VALUES ($1, $2, $3)", [versionId, flowId, JSON.stringify(graph)]);
    await q.query("UPDATE flows SET published_version_id = $2 WHERE id = $1", [flowId, versionId]);
    await q.query(
      `INSERT INTO triggers (id, account_id, flow_id, channel, type, config, priority)
       VALUES ($1, $2, $3, 'instagram', $4, $5, $6)`,
      [triggerId, input.accountId, flowId, input.trigger.type, JSON.stringify(input.trigger.config), input.trigger.priority ?? 0],
    );
    return { flowId, ns, versionId, triggerId };
  });
}

export type CommentToDmInput = {
  publicReplies?: string[];
  /** Mensagem de abertura com um botão de resposta rápida; o link só vai depois do toque (abre a janela de 24h). */
  opening?: { text: string; buttonCaption: string };
  /** Só entrega o link para quem segue a conta; quem não segue recebe este pedido com o botão "Já sigo". */
  requireFollow?: { text: string; buttonCaption: string };
  dm: { text: string; buttons?: { caption: string; url: string }[] };
  tag?: string;
};

/** A checagem de follow só funciona depois de um toque, então "pedir para seguir" exige uma abertura. */
export const DEFAULT_OPENING = { text: "Oi! Quer que eu te mande o link?", buttonCaption: "Quero!" };

const quickReplyMessage = (text: string, caption: string, target: string): FlowNode => ({
  type: "send_message",
  content: {
    version: "v2",
    content: { messages: [{ type: "text", text }], quick_replies: [{ type: "node", caption, target }] },
  },
  next: null,
});

/** Monta o grafo do "Quick Automation" comentário → DM. */
export function buildCommentToDmGraph(input: CommentToDmInput): FlowGraph {
  type Chainable = Exclude<FlowNode, { type: "check_follow" }>;
  const nodes: Record<string, FlowNode> = {};
  const order: string[] = [];
  const opening = input.opening ?? (input.requireFollow ? DEFAULT_OPENING : undefined);

  if (input.publicReplies?.length) {
    nodes.public_reply = { type: "reply_comment", texts: input.publicReplies, next: null };
    order.push("public_reply");
  }
  if (opening) {
    nodes.opening = quickReplyMessage(opening.text, opening.buttonCaption, input.requireFollow ? "follow_gate" : "dm");
    order.push("opening");
  }
  if (input.requireFollow) {
    // Toque na abertura → confere na hora. Toque em "Já sigo" → confere com paciência (a Meta demora a ver o follow).
    nodes.follow_gate = { type: "check_follow", following: "dm", not_following: "follow_prompt" };
    nodes.follow_prompt = quickReplyMessage(input.requireFollow.text, input.requireFollow.buttonCaption, "follow_recheck");
    nodes.follow_recheck = { type: "check_follow", following: "dm", not_following: "follow_prompt", wait_for_follow: true };
  }
  nodes.dm = {
    type: "send_message",
    content: {
      version: "v2",
      content: {
        messages: [
          {
            type: "text",
            text: input.dm.text,
            ...(input.dm.buttons?.length ? { buttons: input.dm.buttons.map((b) => ({ type: "url" as const, ...b })) } : {}),
          },
        ],
      },
    },
    next: input.tag ? "tag" : null,
  };
  if (!opening) order.push("dm");
  if (input.tag) nodes.tag = { type: "action", actions: [{ action: "add_tag", tag_name: input.tag }], next: null };

  // Encadeia a parte executada logo no comentário. Com abertura, "dm" só roda após o quick reply.
  for (let i = 0; i < order.length - 1; i++) (nodes[order[i]!] as Chainable).next = order[i + 1]!;
  return { start: order[0]!, nodes };
}
