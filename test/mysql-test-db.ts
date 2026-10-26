import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { createDb, poolOptions, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

/** Servidor MySQL dos testes (sem banco no caminho). Configurado por scripts/setup-mysql.mjs no .env. */
export function testServerUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL não definido. Instale o MySQL local e rode: node scripts/setup-mysql.mjs (grava a variável no .env).",
    );
  }
  return url;
}

export type TestDb = { db: Db; url: string; drop: () => Promise<void> };

/** Cria um banco novo e vazio (manychat_test_xxxx), aplica as migrações e devolve uma função que apaga tudo. */
export async function createTestDb(): Promise<TestDb> {
  const server = testServerUrl();
  const name = `manychat_test_${randomBytes(6).toString("hex")}`;
  const admin = await mysql.createConnection(poolOptions({ databaseUrl: server }) as mysql.ConnectionOptions);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);

  const url = new URL(server);
  url.pathname = `/${name}`;
  const db = createDb({ databaseUrl: url.toString() });
  await migrate(db);

  return {
    db,
    url: url.toString(),
    async drop() {
      await db.close();
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.end();
    },
  };
}
