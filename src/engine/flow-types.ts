import { z } from "zod";

/**
 * Grafo de fluxo armazenado em flow_versions.graph.
 * O conteúdo de send_message segue o "Dynamic Block v2" do ManyChat (subconjunto que o Instagram suporta).
 */

/** Só http(s): o link vai para o Instagram e é exibido no painel (nada de javascript:, data: etc.). */
export const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "o link precisa começar com http:// ou https://");

const urlButton = z.object({
  type: z.literal("url"),
  caption: z.string().min(1).max(20),
  url: httpUrl,
});

const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1000), buttons: z.array(urlButton).max(3).optional() }),
  z.object({ type: z.literal("image"), url: httpUrl }),
]);

/** Quick reply que, ao ser tocado, continua o fluxo no nó `target` — a DM do usuário abre a janela de 24h. */
const quickReply = z.object({
  type: z.literal("node"),
  caption: z.string().min(1).max(20),
  target: z.string().min(1),
});

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_tag"), tag_name: z.string().min(1) }),
  z.object({ action: z.literal("remove_tag"), tag_name: z.string().min(1) }),
  z.object({
    action: z.literal("set_field_value"),
    field_name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
]);

const next = z.string().nullable().optional();

export const nodeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_message"),
    content: z.object({
      version: z.literal("v2"),
      content: z.object({
        messages: z.array(message).min(1).max(10),
        quick_replies: z.array(quickReply).max(13).optional(),
      }),
    }),
    next,
  }),
  z.object({ type: z.literal("action"), actions: z.array(action).min(1).max(5), next }),
  /** Resposta pública no comentário que disparou o fluxo (uma das frases, sorteada). */
  z.object({ type: z.literal("reply_comment"), texts: z.array(z.string().min(1).max(300)).min(1), next }),
]);

export const graphSchema = z
  .object({ start: z.string(), nodes: z.record(z.string(), nodeSchema) })
  .superRefine((g, ctx) => {
    const ids = new Set(Object.keys(g.nodes));
    if (!ids.has(g.start)) ctx.addIssue({ code: "custom", message: `start "${g.start}" não existe` });
    for (const [id, node] of Object.entries(g.nodes)) {
      if (node.next && !ids.has(node.next)) ctx.addIssue({ code: "custom", message: `${id}.next aponta para nó inexistente` });
      if (node.type === "send_message") {
        for (const qr of node.content.content.quick_replies ?? []) {
          if (!ids.has(qr.target)) ctx.addIssue({ code: "custom", message: `${id}: quick reply aponta para nó inexistente` });
        }
      }
    }
  });

export type FlowGraph = z.infer<typeof graphSchema>;
export type FlowNode = z.infer<typeof nodeSchema>;
export type FlowMessage = z.infer<typeof message>;
export type FlowAction = z.infer<typeof action>;

export const commentTriggerConfigSchema = z.object({
  /** Vazio = qualquer post/reel da conta. */
  media_ids: z.array(z.string()).default([]),
  /** Vazio = qualquer comentário. */
  keywords: z.array(z.string().min(1)).default([]),
  match: z.enum(["contains", "exact"]).default("contains"),
  /** Ignora respostas a outros comentários (só comentários de primeiro nível). */
  top_level_only: z.boolean().default(false),
});
export type CommentTriggerConfig = z.infer<typeof commentTriggerConfigSchema>;
