import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { Pool, PoolConnection, PoolOptions } from "mysql2/promise";

export type QueryResult<T> = { rows: T[]; affectedRows: number };

/** O mínimo de que o resto do código precisa. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Vários comandos de uma vez (migrações). Usa uma conexão separada com multipleStatements. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeParam(value: unknown): unknown {
  // O código gera datas com toISOString(); o MySQL não aceita o "Z" num DATETIME, então vira Date (gravado em UTC).
  if (typeof value === "string" && ISO_DATETIME.test(value)) return new Date(value);
  // `IN (?)` com lista vazia seria erro de sintaxe; `IN (NULL)` não encontra nada, que é o resultado certo.
  if (Array.isArray(value) && value.length === 0) return [null];
  return value;
}

/**
 * As consultas do app usam $1, $2… (mais legível quando um valor se repete).
 * Aqui viram `?` na ordem em que aparecem, repetindo o valor quando um $n aparece mais de uma vez.
 * Listas (arrays) são expandidas pelo mysql2 em `IN (?)`.
 */
export function toMysql(sql: string, params: unknown[] = []): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_, n: string) => {
    const index = Number(n) - 1;
    if (index < 0 || index >= params.length) throw new Error(`parâmetro $${n} não informado`);
    values.push(normalizeParam(params[index]));
    return "?";
  });
  return { text, values };
}

async function run<T>(conn: Pool | PoolConnection, sql: string, params?: unknown[]): Promise<QueryResult<T>> {
  const { text, values } = toMysql(sql, params);
  // query (e não execute): formatação no cliente, que expande listas em IN (?).
  const [result] = await conn.query(text, values);
  if (Array.isArray(result)) return { rows: result as T[], affectedRows: 0 };
  return { rows: [], affectedRows: (result as { affectedRows?: number }).affectedRows ?? 0 };
}

export type DbOptions = {
  databaseUrl: string;
  /** Certificado da autoridade do provedor (a Aiven exige SSL com o CA dela). */
  sslCaPath?: string;
  onIdleError?: (err: Error) => void;
};

export function poolOptions(opts: DbOptions): PoolOptions {
  const url = new URL(opts.databaseUrl);
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL precisa começar com mysql://");
  const sslMode = (url.searchParams.get("ssl-mode") ?? url.searchParams.get("sslmode") ?? "").toUpperCase();
  const wantsSsl = Boolean(opts.sslCaPath) || ["REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY", "REQUIRE"].includes(sslMode);

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    ssl: wantsSsl ? { rejectUnauthorized: true, ...(opts.sslCaPath ? { ca: readFileSync(opts.sslCaPath, "utf8") } : {}) } : undefined,
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: 10,
    enableKeepAlive: true,
    // TINYINT(1) é o booleano do MySQL: devolve true/false em vez de 1/0.
    typeCast(field, next) {
      if (field.type === "TINY" && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === "1";
      }
      return next();
    },
  };
}

export function createDb(opts: DbOptions): Db {
  const options = poolOptions(opts);
  const pool = mysql.createPool(options);
  const onError = opts.onIdleError ?? ((e: Error) => console.warn(`[db] conexão perdida: ${e.message}`));

  // Todas as datas em UTC, inclusive NOW(). Conexões que morrem (reinício do MySQL, rede) só são
  // descartadas pelo pool; sem este handler o evento 'error' derrubaria o processo.
  pool.pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
    conn.on("error", onError);
  });

  return {
    query: (sql, params) => run(pool, sql, params),
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn({ query: (sql, params) => run(conn, sql, params) });
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    async exec(sql) {
      const conn = await mysql.createConnection({ ...options, multipleStatements: true } as Parameters<typeof mysql.createConnection>[0]);
      try {
        await conn.query("SET time_zone = '+00:00'");
        await conn.query(sql);
      } finally {
        await conn.end();
      }
    },
    close: () => pool.end(),
  };
}
