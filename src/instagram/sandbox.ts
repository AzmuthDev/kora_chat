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
  // Conexões de teste não têm posts de verdade: a varredura não acha nada.
  async listRecentMedia() {
    return [];
  },
  async listComments() {
    return [];
  },
  // No simulador não há como saber: trata como seguidor e entrega o link.
  async getFollowStatus() {
    return null;
  },
};
