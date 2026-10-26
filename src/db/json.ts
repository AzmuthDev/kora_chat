/**
 * O mysql2 já devolve colunas JSON como objeto, mas resultados de funções (JSON_ARRAYAGG, COALESCE…)
 * podem chegar como texto. Aceita os dois; null/undefined continuam null.
 */
export function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as T;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8")) as T;
  return value as T;
}
