import type { Recipient } from "../engine/policy.js";

export type IgMessage =
  | { text: string; quick_replies?: IgQuickReply[] }
  | { attachment: IgAttachment; quick_replies?: IgQuickReply[] };

export type IgQuickReply = { content_type: "text"; title: string; payload: string };

export type IgAttachment =
  | { type: "image"; payload: { url: string } }
  | {
      type: "template";
      payload: { template_type: "button"; text: string; buttons: { type: "web_url"; url: string; title: string }[] };
    };

/** Comentário lido pela API (a varredura usa para achar o que o webhook não entregou). */
export type IgComment = {
  id: string;
  text: string;
  timestamp: string;
  fromId: string;
  fromUsername?: string;
  /** Autores das respostas ao comentário: se a própria conta está aqui, ele já foi atendido. */
  replyFromIds: string[];
};

export interface InstagramApi {
  sendMessage(args: {
    accessToken: string;
    igAccountId: string;
    recipient: Recipient;
    message: IgMessage;
  }): Promise<{ messageId?: string }>;
  replyToComment(args: { accessToken: string; commentId: string; text: string }): Promise<{ id?: string }>;
  listRecentMedia(args: { accessToken: string; igAccountId: string; limit: number }): Promise<{ id: string }[]>;
  listComments(args: { accessToken: string; mediaId: string; limit: number }): Promise<IgComment[]>;
  /** Se o contato segue a conta. null = a Meta não informou (antes de um toque em botão ela não informa). */
  getFollowStatus(args: { accessToken: string; igsid: string }): Promise<boolean | null>;
}

export class IgApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "IgApiError";
  }

  /** 5xx, 429 e os códigos de throttling da Graph API (4, 17, 32, 613) valem nova tentativa. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 613].includes(this.code ?? -1);
  }

  /**
   * Num envio, só uma recusa explícita prova que nada chegou. 5xx, falha de rede (vira 503) e os
   * códigos 1/2 já foram vistos junto com a DM entregue: repetir pode mandar a mensagem duas vezes.
   */
  get deliveryUncertain(): boolean {
    return this.status >= 500 || [1, 2].includes(this.code ?? -1);
  }
}

export function createInstagramApi(opts: { baseUrl: string; version: string; fetchImpl?: typeof fetch }): InstagramApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (path: string) => `${opts.baseUrl.replace(/\/$/, "")}/${opts.version}/${path}`;

  async function request(path: string, accessToken: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(url(path), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Rede/timeout: tratar como 503 para o job tentar de novo.
      throw new IgApiError(`falha de rede: ${(err as Error).message}`, 503);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = (json.error ?? {}) as { message?: string; code?: number; error_subcode?: number };
      throw new IgApiError(e.message ?? `HTTP ${res.status}`, res.status, e.code, e.error_subcode);
    }
    return json;
  }

  type Row = Record<string, unknown>;
  const rows = (json: Row): Row[] => (Array.isArray(json.data) ? json.data.filter((r): r is Row => typeof r === "object" && r !== null) : []);
  const idOf = (v: unknown): string | undefined => {
    const id = (v as Row | undefined)?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  };

  return {
    async sendMessage({ accessToken, igAccountId, recipient, message }) {
      const json = await request(`${igAccountId}/messages`, accessToken, { recipient, message });
      return { messageId: typeof json.message_id === "string" ? json.message_id : undefined };
    },
    async replyToComment({ accessToken, commentId, text }) {
      const json = await request(`${commentId}/replies`, accessToken, { message: text });
      return { id: typeof json.id === "string" ? json.id : undefined };
    },
    async getFollowStatus({ accessToken, igsid }) {
      try {
        const json = await request(`${igsid}?${new URLSearchParams({ fields: "is_user_follow_business" })}`, accessToken);
        return typeof json.is_user_follow_business === "boolean" ? json.is_user_follow_business : null;
      } catch (err) {
        // Token inválido precisa aparecer; o resto ("User consent is required", rede) vira "não sei".
        if (err instanceof IgApiError && err.code === 190) throw err;
        return null;
      }
    },
    async listRecentMedia({ accessToken, igAccountId, limit }) {
      const json = await request(`${igAccountId}/media?${new URLSearchParams({ fields: "id", limit: String(limit) })}`, accessToken);
      return rows(json).flatMap((r) => (idOf(r) ? [{ id: idOf(r)! }] : []));
    },
    async listComments({ accessToken, mediaId, limit }) {
      const params = new URLSearchParams({ fields: "id,text,timestamp,from,replies{from}", limit: String(limit) });
      const json = await request(`${mediaId}/comments?${params}`, accessToken);
      return rows(json).flatMap((r): IgComment[] => {
        const id = idOf(r);
        const fromId = idOf(r.from);
        const time = Date.parse(String(r.timestamp));
        // Sem autor não há a quem mandar DM.
        if (!id || !fromId || Number.isNaN(time)) return [];
        const username = (r.from as Row).username;
        return [
          {
            id,
            text: typeof r.text === "string" ? r.text : "",
            timestamp: new Date(time).toISOString(),
            fromId,
            fromUsername: typeof username === "string" ? username : undefined,
            replyFromIds: rows((r.replies as Row | undefined) ?? {}).flatMap((reply) => idOf(reply.from) ?? []),
          },
        ];
      });
    },
  };
}
