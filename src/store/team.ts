import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";

/** admin = gerencia equipe e conexões da empresa; member = opera automações, contatos e mensagens. */
export type AccountRole = "admin" | "member";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function accountRoleOf(q: Queryable, accountId: string, userId: string): Promise<AccountRole | null> {
  const { rows } = await q.query<{ role: AccountRole }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [
    accountId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

/** Cria a empresa; quem criou (se for uma pessoa) vira administradora dela. */
export async function createAccount(
  q: Queryable,
  input: { name: string; timezone?: string; adminUserId?: string },
): Promise<{ id: string; name: string; timezone: string; status: "active" }> {
  const id = randomUUID();
  const timezone = input.timezone ?? "UTC";
  await q.query("INSERT INTO accounts (id, name, timezone) VALUES ($1, $2, $3)", [id, input.name, timezone]);
  if (input.adminUserId) await addMember(q, id, input.adminUserId, "admin");
  return { id, name: input.name, timezone, status: "active" };
}

/** Adiciona à empresa. Se a pessoa já é membro, só sobe o papel (um convite de membro não rebaixa um admin). */
export async function addMember(q: Queryable, accountId: string, userId: string, role: AccountRole): Promise<void> {
  await q.query(
    `INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3) AS new
     ON DUPLICATE KEY UPDATE role = IF(new.role = 'admin', 'admin', account_members.role)`,
    [accountId, userId, role],
  );
}

/** Administradores ativos da empresa, tirando `exceptUserId`: a empresa nunca pode ficar sem nenhum. */
export async function otherActiveAdmins(q: Queryable, accountId: string, exceptUserId: string): Promise<number> {
  const { rows } = await q.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM account_members m JOIN users u ON u.id = m.user_id
      WHERE m.account_id = $1 AND m.role = 'admin' AND NOT u.disabled AND m.user_id <> $2`,
    [accountId, exceptUserId],
  );
  return Number(rows[0]!.n);
}

export async function createInvite(
  q: Queryable,
  input: { accountId: string; email: string; role: AccountRole; invitedBy: string | null },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await q.query(
    `INSERT INTO account_invites (id, account_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.accountId, input.email, input.role, hashToken(token), input.invitedBy, expiresAt.toISOString()],
  );
  return { id, token, expiresAt };
}

export type InviteLookup = {
  id: string;
  accountId: string;
  accountName: string;
  email: string;
  role: AccountRole;
  state: "valid" | "used" | "expired";
};

export async function findInvite(q: Queryable, token: string): Promise<InviteLookup | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query<{
    id: string;
    account_id: string;
    account_name: string;
    email: string;
    role: AccountRole;
    accepted_at: unknown;
    expired: number | string;
  }>(
    `SELECT i.id, i.account_id, a.name AS account_name, i.email, i.role, i.accepted_at, i.expires_at <= NOW(3) AS expired
       FROM account_invites i JOIN accounts a ON a.id = i.account_id
      WHERE i.token_hash = $1`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    email: r.email,
    role: r.role,
    state: r.accepted_at ? "used" : Number(r.expired) ? "expired" : "valid",
  };
}

/** Marca o convite como usado. false = outra aba/pessoa usou primeiro. */
export async function consumeInvite(q: Queryable, inviteId: string): Promise<boolean> {
  const { affectedRows } = await q.query(
    "UPDATE account_invites SET accepted_at = NOW(3) WHERE id = $1 AND accepted_at IS NULL AND expires_at > NOW(3)",
    [inviteId],
  );
  return affectedRows === 1;
}
