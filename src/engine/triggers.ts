import type { CommentTriggerConfig } from "./flow-types.js";

/** "Quero o LINK!!" → " quero o link " (minúsculas, sem acento, pontuação vira espaço). */
export function normalizeText(text: string): string {
  const cleaned = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return ` ${cleaned} `;
}

export function matchesKeywords(text: string, keywords: string[], mode: "contains" | "exact"): boolean {
  if (keywords.length === 0) return true;
  const haystack = normalizeText(text);
  return keywords.some((kw) => {
    const needle = normalizeText(kw);
    // Palavra-chave só com emoji/pontuação: compara o texto cru.
    if (needle.trim() === "") return mode === "exact" ? text.trim() === kw.trim() : text.includes(kw.trim());
    return mode === "exact" ? haystack === needle : haystack.includes(needle);
  });
}

export function commentMatches(
  config: CommentTriggerConfig,
  comment: { text: string; mediaId?: string; parentCommentId?: string },
): boolean {
  if (config.top_level_only && comment.parentCommentId) return false;
  if (config.media_ids.length > 0 && (!comment.mediaId || !config.media_ids.includes(comment.mediaId))) return false;
  return matchesKeywords(comment.text, config.keywords, config.match);
}
