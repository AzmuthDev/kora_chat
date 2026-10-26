import { randomUUID } from "node:crypto";
import type { InstagramApi } from "./client.js";

/**
 * "Instagram" das conexões de teste: aceita tudo e devolve IDs falsos.
 * O que seria enviado fica registrado na tabela messages pelo executor, como num envio real.
 */
export const sandboxInstagramApi: InstagramApi = {
  async sendMessage() {
    return { messageId: `sandbox.mid.${randomUUID()}` };
  },
  async replyToComment() {
    return { id: `sandbox.reply.${randomUUID()}` };
  },
};
