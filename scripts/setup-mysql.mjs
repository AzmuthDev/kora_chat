// Configura o MySQL LOCAL para desenvolvimento e testes (depois do install-mysql-windows.ps1):
//   - define uma senha forte para o root local (se ele ainda estiver sem senha)
//   - cria o banco "manychat" e o usuário "manychat" (desenvolvimento local)
//   - cria o usuário "manychat_test", que só pode criar/apagar bancos "manychat_test_*" (testes automáticos)
//   - grava LOCAL_MYSQL_ROOT_URL, LOCAL_DATABASE_URL e TEST_DATABASE_URL no .env
// O banco de produção (nuvem) continua em DATABASE_URL.
//
// Uso: node scripts/setup-mysql.mjs
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(path.join(root, ".env.example"), "utf8");

const getEnv = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(env)?.[1]?.trim() || undefined;
const setEnv = (key, value) => {
  const line = `${key}=${value}`;
  env = new RegExp(`^#?\\s*${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^#?\\s*${key}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
};
const secret = () => randomBytes(18).toString("base64url");

const host = "127.0.0.1";
const port = 3306;

// 1. Conecta como root: com a senha já salva ou, logo após a instalação, sem senha.
const savedRoot = getEnv("LOCAL_MYSQL_ROOT_URL");
let conn;
let rootPassword;
try {
  if (savedRoot) {
    const u = new URL(savedRoot);
    rootPassword = decodeURIComponent(u.password);
  }
  conn = await mysql.createConnection({ host, port, user: "root", password: rootPassword ?? "", multipleStatements: true });
} catch (err) {
  console.error(`Não consegui entrar no MySQL local como root: ${err.message}`);
  console.error("O serviço está rodando? Rode antes (como administrador): powershell -ExecutionPolicy Bypass -File scripts\\install-mysql-windows.ps1");
  process.exit(1);
}

if (!rootPassword) {
  rootPassword = secret();
  await conn.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [rootPassword]);
  setEnv("LOCAL_MYSQL_ROOT_URL", `mysql://root:${rootPassword}@${host}:${port}`);
  writeFileSync(envPath, env); // grava já: se algo abaixo falhar, a senha do root não se perde
  console.log("Senha do root local definida e guardada no .env (LOCAL_MYSQL_ROOT_URL).");
}

// 2. Usuário e banco de desenvolvimento local.
const appPassword = secret();
await conn.query("CREATE DATABASE IF NOT EXISTS manychat CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
await conn.query("CREATE USER IF NOT EXISTS 'manychat'@'localhost' IDENTIFIED BY ?", [appPassword]);
await conn.query("ALTER USER 'manychat'@'localhost' IDENTIFIED BY ?", [appPassword]);
await conn.query("GRANT ALL PRIVILEGES ON manychat.* TO 'manychat'@'localhost'");
setEnv("LOCAL_DATABASE_URL", `mysql://manychat:${appPassword}@${host}:${port}/manychat`);

// 3. Usuário dos testes: só mexe em bancos manychat_test_*.
const testPassword = secret();
await conn.query("CREATE USER IF NOT EXISTS 'manychat_test'@'localhost' IDENTIFIED BY ?", [testPassword]);
await conn.query("ALTER USER 'manychat_test'@'localhost' IDENTIFIED BY ?", [testPassword]);
await conn.query("GRANT ALL PRIVILEGES ON `manychat\\_test\\_%`.* TO 'manychat_test'@'localhost'");
setEnv("TEST_DATABASE_URL", `mysql://manychat_test:${testPassword}@${host}:${port}`);

await conn.end();
writeFileSync(envPath, env);
console.log("Pronto: banco local 'manychat', usuário dos testes e URLs gravados no .env.");
console.log("Para usar o banco local no app, copie LOCAL_DATABASE_URL para DATABASE_URL.");
