import type { FlowMessage } from "../engine/flow-types.js";
import type { IgMessage, IgQuickReply } from "./client.js";

/** Dynamic Block v2 (subconjunto) → formato da Send API do Instagram. */
export function toInstagramMessage(msg: FlowMessage, quickReplies?: IgQuickReply[]): IgMessage {
  const qr = quickReplies?.length ? { quick_replies: quickReplies } : {};
  if (msg.type === "image") {
    return { attachment: { type: "image", payload: { url: msg.url } }, ...qr };
  }
  if (msg.buttons?.length) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: msg.text,
          buttons: msg.buttons.map((b) => ({ type: "web_url", url: b.url, title: b.caption })),
        },
      },
      ...qr,
    };
  }
  return { text: msg.text, ...qr };
}

/** Substitui {{first_name}}, {{username}} etc. Variável desconhecida vira string vazia. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}
