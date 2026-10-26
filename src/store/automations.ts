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
  dm: { text: string; buttons?: { caption: string; url: string }[] };
  tag?: string;
};

/** Monta o grafo do "Quick Automation" comentário → DM. */
export function buildCommentToDmGraph(input: CommentToDmInput): FlowGraph {
  const nodes: Record<string, FlowNode> = {};
  const order: string[] = [];

  if (input.publicReplies?.length) {
    nodes.public_reply = { type: "reply_comment", texts: input.publicReplies, next: null };
    order.push("public_reply");
  }
  if (input.opening) {
    nodes.opening = {
      type: "send_message",
      content: {
        version: "v2",
        content: {
          messages: [{ type: "text", text: input.opening.text }],
          quick_replies: [{ type: "node", caption: input.opening.buttonCaption, target: "dm" }],
        },
      },
      next: null,
    };
    order.push("opening");
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
  if (!input.opening) order.push("dm");
  if (input.tag) nodes.tag = { type: "action", actions: [{ action: "add_tag", tag_name: input.tag }], next: null };

  // Encadeia a parte executada logo no comentário. Com abertura, "dm" só roda após o quick reply.
  for (let i = 0; i < order.length - 1; i++) nodes[order[i]!]!.next = order[i + 1]!;
  return { start: order[0]!, nodes };
}
