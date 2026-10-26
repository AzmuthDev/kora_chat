import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Aplica, em ordem, os arquivos .sql ainda não registrados em schema_migrations.
 * No MySQL, comandos de estrutura (CREATE/ALTER) não entram em transação: se uma migração falhar
 * no meio, corrija o arquivo e rode de novo num banco limpo (ou desfaça à mão o que já foi criado).
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name VARCHAR(191) NOT NULL PRIMARY KEY,
       applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     )`,
  );
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    await db.exec(await readFile(path.join(dir, file), "utf8"));
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    applied.push(file);
  }
  return applied;
}
