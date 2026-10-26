import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Só o TEST_DATABASE_URL do .env vai para os testes (o resto da config de produção fica de fora). */
function testDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!existsSync(".env")) return undefined;
  return /^TEST_DATABASE_URL=(.*)$/m.exec(readFileSync(".env", "utf8"))?.[1]?.trim() || undefined;
}

const url = testDatabaseUrl();

export default defineConfig({
  test: {
    env: url ? { TEST_DATABASE_URL: url } : {},
    // Cada arquivo cria um banco MySQL próprio e roda as migrações; numa máquina ocupada isso passa dos 10 s padrão.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
