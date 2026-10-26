// Redefine a senha de quem esqueceu (inclusive o único administrador), direto no banco.
// Uso: npm run reset-password -- email@exemplo.com
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { email as emailSchema, password as passwordSchema } from "../http/auth.js";
import { hashPassword } from "./passwords.js";
import { deleteUserSessions } from "./sessions.js";

/** Lê uma linha do terminal sem mostrar o que é digitado. */
function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  out._writeToOutput = (s) => {
    if (!muted || s.includes("\n")) process.stdout.write(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

const emailArg = emailSchema.safeParse(process.argv[2] ?? "");
if (!emailArg.success) {
  console.error("Uso: npm run reset-password -- email@exemplo.com");
  process.exit(1);
}

const config = loadConfig();
const db = createDb({ databaseUrl: config.databaseUrl, sslCaPath: config.databaseSslCa });
try {
  const { rows } = await db.query<{ id: string; name: string; role: string }>(
    "SELECT id, name, role FROM users WHERE lower(email) = $1",
    [emailArg.data],
  );
  const user = rows[0];
  if (!user) {
    const all = await db.query<{ email: string; role: string }>("SELECT email, role FROM users ORDER BY created_at");
    console.error(`Nenhum usuário com o e-mail ${emailArg.data}. Usuários cadastrados:`);
    for (const u of all.rows) console.error(`  ${u.email} (${u.role})`);
    process.exitCode = 1;
  } else {
    console.log(`Redefinindo a senha de ${user.name} <${emailArg.data}> (${user.role}).`);
    const first = await askHidden("Nova senha: ");
    const parsed = passwordSchema.safeParse(first);
    if (!parsed.success) {
      console.error(parsed.error.issues[0]?.message ?? "senha inválida");
      process.exitCode = 1;
    } else if ((await askHidden("Repita a senha: ")) !== first) {
      console.error("As senhas não conferem. Nada foi alterado.");
      process.exitCode = 1;
    } else {
      await db.query("UPDATE users SET password_hash = $2, disabled = FALSE WHERE id = $1", [user.id, await hashPassword(first)]);
      await deleteUserSessions(db, user.id);
      console.log("Senha redefinida. As sessões abertas dessa pessoa foram encerradas.");
    }
  }
} finally {
  await db.close();
}
