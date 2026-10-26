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

export interface InstagramApi {
  sendMessage(args: {
    accessToken: string;
    igAccountId: string;
    recipient: Recipient;
    message: IgMessage;
  }): Promise<{ messageId?: string }>;
  replyToComment(args: { accessToken: string; commentId: string; text: string }): Promise<{ id?: string }>;
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
}

export function createInstagramApi(opts: { baseUrl: string; version: string; fetchImpl?: typeof fetch }): InstagramApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = (path: string) => `${opts.baseUrl.replace(/\/$/, "")}/${opts.version}/${path}`;

  async function post(path: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(url(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
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

  return {
    async sendMessage({ accessToken, igAccountId, recipient, message }) {
      const json = await post(`${igAccountId}/messages`, accessToken, { recipient, message });
      return { messageId: typeof json.message_id === "string" ? json.message_id : undefined };
    },
    async replyToComment({ accessToken, commentId, text }) {
      const json = await post(`${commentId}/replies`, accessToken, { message: text });
      return { id: typeof json.id === "string" ? json.id : undefined };
    },
  };
}
