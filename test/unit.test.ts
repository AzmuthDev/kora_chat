import { describe, expect, it } from "vitest";
import { signMetaPayload, verifyMetaSignature } from "../src/instagram/signature.js";
import { matchesKeywords, commentMatches } from "../src/engine/triggers.js";
import { decideRecipient } from "../src/engine/policy.js";
import { normalizeInstagramWebhook } from "../src/instagram/normalize.js";
import { encryptToken, decryptToken } from "../src/crypto/tokens.js";
import { buildCommentToDmGraph } from "../src/store/automations.js";
import { graphSchema } from "../src/engine/flow-types.js";
import { toInstagramMessage, renderTemplate } from "../src/instagram/translate.js";
import { commentWebhook, dmWebhook, IG_ACCOUNT_ID, testConfig } from "./helpers.js";
import { poolOptions, toMysql } from "../src/db/index.js";

describe("assinatura da Meta", () => {
  it("aceita a assinatura correta e rejeita corpo alterado ou header ausente", () => {
    const body = Buffer.from('{"object":"instagram"}');
    const sig = signMetaPayload(body, "segredo");
    expect(verifyMetaSignature(body, sig, "segredo")).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"object":"instagraM"}'), sig, "segredo")).toBe(false);
    expect(verifyMetaSignature(body, sig, "outro-segredo")).toBe(false);
    expect(verifyMetaSignature(body, undefined, "segredo")).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", "segredo")).toBe(false);
  });
});

describe("palavras-chave", () => {
  it("ignora caixa, acento e pontuação, e casa palavra inteira", () => {
    expect(matchesKeywords("QUERO o link!!!", ["quero"], "contains")).toBe(true);
    expect(matchesKeywords("Preço?", ["preco"], "contains")).toBe(true);
    expect(matchesKeywords("queroooo", ["quero"], "contains")).toBe(false);
    expect(matchesKeywords("me manda o link", ["link", "eu quero"], "contains")).toBe(true);
    expect(matchesKeywords("eu quero sim", ["eu quero"], "contains")).toBe(true);
  });

  it("modo exact exige o comentário inteiro", () => {
    expect(matchesKeywords("Link", ["link"], "exact")).toBe(true);
    expect(matchesKeywords("o link", ["link"], "exact")).toBe(false);
  });

  it("lista vazia casa qualquer comentário; emoji compara texto cru", () => {
    expect(matchesKeywords("qualquer coisa", [], "contains")).toBe(true);
    expect(matchesKeywords("🔥🔥", ["🔥"], "contains")).toBe(true);
    expect(matchesKeywords("legal", ["🔥"], "contains")).toBe(false);
  });

  it("filtra por post e por respostas", () => {
    const base = { media_ids: ["m1"], keywords: [], match: "contains" as const, top_level_only: true };
    expect(commentMatches(base, { text: "oi", mediaId: "m1" })).toBe(true);
    expect(commentMatches(base, { text: "oi", mediaId: "m2" })).toBe(false);
    expect(commentMatches(base, { text: "oi", mediaId: "m1", parentCommentId: "c0" })).toBe(false);
  });
});

describe("política de envio", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  it("DM normal dentro de 24h", () => {
    const d = decideRecipient({ igsid: "u1", lastInboundAt: new Date("2026-10-24T00:00:00Z"), privateReplyUsed: false }, now);
    expect(d).toEqual({ ok: true, recipient: { id: "u1" }, kind: "dm" });
  });
  it("fora de 24h: uma única resposta privada ao comentário", () => {
    const ctx = { igsid: "u1", lastInboundAt: null, commentId: "c1", privateReplyUsed: false };
    expect(decideRecipient(ctx, now)).toEqual({ ok: true, recipient: { comment_id: "c1" }, kind: "private_reply" });
    expect(decideRecipient({ ...ctx, privateReplyUsed: true }, now).ok).toBe(false);
  });
  it("sem comentário e sem janela: bloqueado", () => {
    const d = decideRecipient({ igsid: "u1", lastInboundAt: new Date("2026-10-20T00:00:00Z"), privateReplyUsed: false }, now);
    expect(d.ok).toBe(false);
  });
});

describe("normalização do webhook", () => {
  it("extrai comentário e DM; ignora eco e outros campos", () => {
    const comment = normalizeInstagramWebhook(commentWebhook({ commentId: "c1", text: "quero" }));
    expect(comment.events).toMatchObject([
      { type: "comment", commentId: "c1", fromId: "990001", fromUsername: "maria", mediaId: "media-1", igAccountId: IG_ACCOUNT_ID },
    ]);

    const dm = dmWebhook({ mid: "m1", text: "oi" });
    expect(normalizeInstagramWebhook(dm).events).toMatchObject([{ type: "message", messageId: "m1", senderId: "990001" }]);

    const echo = dmWebhook({ mid: "m2" });
    (echo.entry[0]!.messaging[0]!.message as Record<string, unknown>).is_echo = true;
    expect(normalizeInstagramWebhook(echo).events).toHaveLength(0);

    const other = { object: "instagram", entry: [{ id: "1", changes: [{ field: "mentions", value: {} }] }] };
    expect(normalizeInstagramWebhook(other).ignored).toContain("change:mentions");
    expect(normalizeInstagramWebhook({ object: "page" }).events).toHaveLength(0);
  });
});

describe("configuração", () => {
  it("variáveis vazias do .env.example contam como não definidas", () => {
    const config = testConfig({ PUBLIC_BASE_URL: "", IG_APP_ID: "", DATABASE_SSL_CA: "", IG_TOKEN_REFRESH_DAYS_BEFORE: "" });
    expect(config.igOAuth).toBeUndefined();
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.databaseSslCa).toBeUndefined();
    expect(config.tokenRefreshDaysBefore).toBe(15);
  });

  it("variável obrigatória vazia continua sendo erro", () => {
    expect(() => testConfig({ ADMIN_TOKEN: "" })).toThrow(/ADMIN_TOKEN/);
    expect(() => testConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("DATABASE_URL precisa ser MySQL", () => {
    expect(() => testConfig({ DATABASE_URL: "postgres://u:p@localhost/db" })).toThrow(/mysql:\/\//);
  });
});

describe("adaptador MySQL", () => {
  it("troca $n por ?, repete valores, converte datas ISO e listas vazias", () => {
    const { text, values } = toMysql("SELECT $1, $2, $1 WHERE id IN ($3) AND d > $4", ["a", 2, [], "2026-10-24T12:00:00.000Z"]);
    expect(text).toBe("SELECT ?, ?, ? WHERE id IN (?) AND d > ?");
    expect(values.slice(0, 4)).toEqual(["a", 2, "a", [null]]);
    expect(values[4]).toEqual(new Date("2026-10-24T12:00:00.000Z"));
    // Caminhos JSON ('$.campo') não são parâmetros.
    expect(toMysql("SELECT payload->>'$.igAccountId' FROM t WHERE x = $1", [1]).text).toBe(
      "SELECT payload->>'$.igAccountId' FROM t WHERE x = ?",
    );
    expect(() => toMysql("SELECT $2", [1])).toThrow(/\$2/);
  });

  it("lê ssl-mode e host da URL", () => {
    const opts = poolOptions({ databaseUrl: "mysql://avnadmin:s%40nha@db.exemplo.com:24764/defaultdb?ssl-mode=REQUIRED" });
    expect(opts).toMatchObject({ host: "db.exemplo.com", port: 24764, user: "avnadmin", password: "s@nha", database: "defaultdb" });
    expect(opts.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(poolOptions({ databaseUrl: "mysql://u:p@127.0.0.1/db" }).ssl).toBeUndefined();
  });
});

describe("tokens cifrados", () => {
  it("ida e volta, e o texto cifrado muda a cada chamada", () => {
    const key = "ab".repeat(32);
    const a = encryptToken("IGAA-secret", key);
    expect(a).not.toContain("IGAA");
    expect(encryptToken("IGAA-secret", key)).not.toBe(a);
    expect(decryptToken(a, key)).toBe("IGAA-secret");
    expect(() => decryptToken(a, "cd".repeat(32))).toThrow();
  });
});

describe("grafo da Quick Automation", () => {
  it("sem abertura: resposta pública → DM → tag", () => {
    const g = buildCommentToDmGraph({ publicReplies: ["Te chamei no direct!"], dm: { text: "Aqui está" }, tag: "lead" });
    expect(graphSchema.parse(g)).toBeTruthy();
    expect(g.start).toBe("public_reply");
    expect(g.nodes.public_reply!.next).toBe("dm");
    expect(g.nodes.dm!.next).toBe("tag");
  });

  it("com abertura: o fluxo pausa no quick reply e a DM com link vem depois", () => {
    const g = buildCommentToDmGraph({ opening: { text: "Quer o link?", buttonCaption: "Quero!" }, dm: { text: "Link" } });
    expect(graphSchema.parse(g)).toBeTruthy();
    expect(g.start).toBe("opening");
    expect(g.nodes.opening!.next).toBeNull();
  });

  it("valida referências quebradas", () => {
    const bad = { start: "a", nodes: { a: { type: "action", actions: [{ action: "add_tag", tag_name: "x" }], next: "zz" } } };
    expect(graphSchema.safeParse(bad).success).toBe(false);
  });
});

describe("tradução para a Send API", () => {
  it("texto com botões vira button template; quick replies anexadas", () => {
    const qr = [{ content_type: "text" as const, title: "Sim", payload: "p" }];
    expect(toInstagramMessage({ type: "text", text: "oi" }, qr)).toEqual({ text: "oi", quick_replies: qr });
    expect(toInstagramMessage({ type: "text", text: "oi", buttons: [{ type: "url", caption: "Abrir", url: "https://x.y" }] })).toEqual({
      attachment: {
        type: "template",
        payload: { template_type: "button", text: "oi", buttons: [{ type: "web_url", url: "https://x.y", title: "Abrir" }] },
      },
    });
    expect(toInstagramMessage({ type: "image", url: "https://x.y/a.png" })).toEqual({
      attachment: { type: "image", payload: { url: "https://x.y/a.png" } },
    });
  });

  it("variáveis", () => {
    expect(renderTemplate("Oi {{ first_name }}, @{{username}}{{x}}", { first_name: "Ana", username: "ana" })).toBe("Oi Ana, @ana");
  });
});
