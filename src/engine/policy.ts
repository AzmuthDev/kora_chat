/**
 * Regras de envio do Instagram que o motor esconde do usuário:
 *  - Dentro de 24h desde a última DM do contato → DM normal pelo IGSID.
 *  - Fora disso, se o fluxo nasceu de um comentário → UMA resposta privada endereçada ao comment_id.
 *  - Caso contrário → bloqueado (não há janela aberta).
 */

export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Recipient = { id: string } | { comment_id: string };

export type SendContext = {
  igsid: string;
  lastInboundAt: Date | null;
  commentId?: string;
  privateReplyUsed: boolean;
};

export type SendDecision =
  | { ok: true; recipient: Recipient; kind: "dm" | "private_reply" }
  | { ok: false; reason: string };

export function decideRecipient(ctx: SendContext, now = new Date()): SendDecision {
  if (ctx.lastInboundAt && now.getTime() - ctx.lastInboundAt.getTime() < MESSAGING_WINDOW_MS) {
    return { ok: true, recipient: { id: ctx.igsid }, kind: "dm" };
  }
  if (ctx.commentId && !ctx.privateReplyUsed) {
    return { ok: true, recipient: { comment_id: ctx.commentId }, kind: "private_reply" };
  }
  return {
    ok: false,
    reason: ctx.commentId
      ? "resposta privada ao comentário já usada e o contato não abriu a janela de 24h"
      : "fora da janela de 24h",
  };
}
