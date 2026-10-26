// Configura o PostgreSQL local para o app:
//   1. gera uma senha nova para o usuário do app
//   2. roda scripts/setup-postgres.sql como "postgres" (o psql pede a senha do postgres no terminal)
//   3. grava DATABASE_URL no .env e aplica as migrações
//
// Uso: npm run db:setup            (usuário/banco "manychat")
//      npm run db:setup -- loja    (usuário/banco "loja")
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = (process.argv[2] ?? "manychat").toLowerCase();
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(name)) {
  console.error("Nome inválido: use letras minúsculas, números e _.");
  process.exit(1);
}
const host = process.env.PGHOST ?? "localhost";
const port = process.env.PGPORT ?? "5432";

const psqlCandidates = [
  "psql",
  ...["18", "17", "16", "15"].map((v) => `C:\\Program Files\\PostgreSQL\\${v}\\bin\\psql.exe`),
];
const psql = psqlCandidates.find((p) => p === "psql" ? spawnSync(p, ["--version"]).status === 0 : existsSync(p));
if (!psql) {
  console.error("Não encontrei o psql. Instale o PostgreSQL ou coloque a pasta bin dele no PATH.");
  process.exit(1);
}

const password = randomBytes(24).toString("base64url");
console.log(`\nVou criar o usuário e o banco "${name}" no PostgreSQL em ${host}:${port}.`);
console.log('Digite a senha do usuário "postgres" (a definida na instalação) quando o psql pedir.\n');

const run = spawnSync(
  psql,
  [
    "-U", "postgres", "-h", host, "-p", port, "-d", "postgres",
    "-v", `app_user=${name}`, "-v", `app_db=${name}`, "-v", `app_password=${password}`,
    "-f", path.join(root, "scripts", "setup-postgres.sql"),
  ],
  { stdio: "inherit" },
);
if (run.status !== 0) {
  console.error("\nO psql falhou. Confira a senha do postgres e se o serviço do PostgreSQL está rodando.");
  process.exit(run.status ?? 1);
}

const envPath = path.join(root, ".env");
const url = `postgres://${name}:${password}@${host}:${port}/${name}`;
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(path.join(root, ".env.example"), "utf8");
env = /^#?\s*DATABASE_URL=.*$/m.test(env)
  ? env.replace(/^#?\s*DATABASE_URL=.*$/m, `DATABASE_URL=${url}`)
  : `${env.trimEnd()}\nDATABASE_URL=${url}\n`;
writeFileSync(envPath, env);
console.log("\nDATABASE_URL gravado no .env.");

const migrate = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "migrate"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(migrate.status ?? 0);
