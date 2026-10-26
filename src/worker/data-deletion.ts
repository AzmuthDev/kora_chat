import type { Db } from "../db/index.js";
import { parseJson } from "../db/json.js";

export type DeletionSummary = {
  connections: number;
  messages: number;
  identities: number;
  contacts: number;
  raw_events: number;
  pending_jobs: number;
};

/**
 * Apaga o que foi obtido por meio das conexões do pedido: mensagens, identidades e contatos que
 * ficarem sem nenhuma identidade, webhooks brutos e jobs pendentes da conta, e a própria conexão.
 * Configuração do cliente (fluxos, gatilhos, tags) não é dado do usuário da Meta e fica.
 */
export async function processDataDeletion(db: Db, confirmationCode: string): Promise<DeletionSummary | null> {
  return db.tx(async (q) => {
    const req = (
      await q.query<{ connection_ids: unknown; status: string }>(
        "SELECT connection_ids, status FROM data_deletion_requests WHERE confirmation_code = $1 FOR UPDATE",
        [confirmationCode],
      )
    ).rows[0];
    if (!req || req.status === "completed") return null;

    const ids = parseJson<string[]>(req.connection_ids) ?? [];
    const igIds = (
      await q.query<{ external_account_id: string }>("SELECT external_account_id FROM channel_connections WHERE id IN ($1)", [ids])
    ).rows.map((r) => r.external_account_id);

    const deleted = async (sql: string, params: unknown[]) => (await q.query(sql, params)).affectedRows;

    const messages = await deleted("DELETE FROM messages WHERE connection_id IN ($1)", [ids]);
    const touched = (
      await q.query<{ contact_id: string }>("SELECT contact_id FROM contact_identities WHERE connection_id IN ($1) FOR UPDATE", [ids])
    ).rows.map((r) => r.contact_id);
    const identities = await deleted("DELETE FROM contact_identities WHERE connection_id IN ($1)", [ids]);
    const contacts = await deleted(
      `DELETE FROM contacts
        WHERE id IN ($1)
          AND NOT EXISTS (SELECT 1 FROM contact_identities ci WHERE ci.contact_id = contacts.id)`,
      [touched],
    );
    const rawEvents = await deleted("DELETE FROM events_raw WHERE channel = 'instagram' AND payload->>'$.igAccountId' IN ($1)", [igIds]);
    const pendingJobs = await deleted(
      `DELETE FROM scheduled_jobs
        WHERE kind = 'process_event' AND status IN ('pending', 'failed')
          AND payload->>'$.event.igAccountId' IN ($1)`,
      [igIds],
    );
    const connections = await deleted("DELETE FROM channel_connections WHERE id IN ($1)", [ids]);

    const summary: DeletionSummary = {
      connections,
      messages,
      identities,
      contacts,
      raw_events: rawEvents,
      pending_jobs: pendingJobs,
    };
    await q.query(
      "UPDATE data_deletion_requests SET status = 'completed', completed_at = NOW(3), summary = $2 WHERE confirmation_code = $1",
      [confirmationCode, JSON.stringify(summary)],
    );
    return summary;
  });
}
