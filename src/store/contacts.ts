import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";

export type InstagramContact = {
  contactId: string;
  firstName: string | null;
  username: string | null;
  lastInboundAt: Date | null;
};

type Row = { contact_id: string; first_name: string | null; username: string | null; last_inbound_at: string | Date | null };

const toContact = (r: Row): InstagramContact => ({
  contactId: r.contact_id,
  firstName: r.first_name,
  username: r.username,
  lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at) : null,
});

const SELECT_BY_IGSID = `
  SELECT ci.contact_id, c.first_name, ci.username, ci.last_inbound_at
    FROM contact_identities ci JOIN contacts c ON c.id = ci.contact_id
   WHERE ci.account_id = $1 AND ci.channel = 'instagram' AND ci.external_user_id = $2`;

/**
 * No MySQL (REPEATABLE READ), uma leitura comum dentro da transação enxerga a "foto" do início dela.
 * Depois de perder a corrida para outro worker, a leitura com trava (FOR SHARE) enxerga o que ele gravou.
 */
const SELECT_BY_IGSID_LATEST = `${SELECT_BY_IGSID} FOR SHARE`;

/** Acha ou cria o contato pelo IGSID. Seguro contra dois eventos simultâneos do mesmo usuário novo. */
export async function upsertInstagramContact(
  q: Queryable,
  accountId: string,
  connectionId: string,
  igsid: string,
  username?: string,
): Promise<InstagramContact> {
  const existing = (await q.query<Row>(SELECT_BY_IGSID_LATEST, [accountId, igsid])).rows[0];
  if (existing) {
    await q.query(
      `UPDATE contact_identities SET username = COALESCE($3, username), connection_id = $4
        WHERE account_id = $1 AND channel = 'instagram' AND external_user_id = $2
          AND (NOT (connection_id <=> $4) OR ($3 IS NOT NULL AND NOT (username <=> $3)))`,
      [accountId, igsid, username ?? null, connectionId],
    );
    return toContact({ ...existing, username: username ?? existing.username });
  }

  const contactId = randomUUID();
  await q.query("INSERT INTO contacts (id, account_id) VALUES ($1, $2)", [contactId, accountId]);
  const inserted = await q.query(
    `INSERT IGNORE INTO contact_identities (contact_id, account_id, channel, external_user_id, username, connection_id)
     VALUES ($1, $2, 'instagram', $3, $4, $5)`,
    [contactId, accountId, igsid, username ?? null, connectionId],
  );
  if (inserted.affectedRows === 0) {
    // Outro worker criou o mesmo contato no meio do caminho: descarta o nosso.
    await q.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    return toContact((await q.query<Row>(SELECT_BY_IGSID_LATEST, [accountId, igsid])).rows[0]!);
  }
  return { contactId, firstName: null, username: username ?? null, lastInboundAt: null };
}

/** DM recebida: abre a janela de 24h e guarda o último texto. */
export async function markInbound(q: Queryable, contactId: string, at: string, text?: string): Promise<void> {
  await q.query(
    `UPDATE contact_identities
        SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, CAST($2 AS DATETIME(3))), CAST($2 AS DATETIME(3)))
      WHERE contact_id = $1 AND channel = 'instagram'`,
    [contactId, at],
  );
  await q.query(
    `UPDATE contacts
        SET last_interaction_at = GREATEST(COALESCE(last_interaction_at, CAST($2 AS DATETIME(3))), CAST($2 AS DATETIME(3))),
            last_input_text = COALESCE($3, last_input_text)
      WHERE id = $1`,
    [contactId, at, text ?? null],
  );
}

/** Cria a linha se não existir e devolve o id dela (tags e campos personalizados). */
async function ensureNamed(q: Queryable, table: "tags" | "custom_fields", accountId: string, name: string, type?: string): Promise<string> {
  if (table === "tags") {
    await q.query("INSERT IGNORE INTO tags (id, account_id, name) VALUES ($1, $2, $3)", [randomUUID(), accountId, name]);
  } else {
    await q.query("INSERT IGNORE INTO custom_fields (id, account_id, name, type) VALUES ($1, $2, $3, $4)", [
      randomUUID(),
      accountId,
      name,
      type ?? "text",
    ]);
  }
  const { rows } = await q.query<{ id: string }>(`SELECT id FROM ${table} WHERE account_id = $1 AND name = $2 FOR SHARE`, [
    accountId,
    name,
  ]);
  return rows[0]!.id;
}

/** No MVP a tag é criada se ainda não existir (o ManyChat exige criar antes). */
export async function addTag(q: Queryable, accountId: string, contactId: string, tagName: string): Promise<void> {
  const tagId = await ensureNamed(q, "tags", accountId, tagName);
  await q.query("INSERT IGNORE INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)", [contactId, tagId]);
}

export async function removeTag(q: Queryable, accountId: string, contactId: string, tagName: string): Promise<void> {
  await q.query(
    `DELETE ct FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = $1 AND t.account_id = $2 AND t.name = $3`,
    [contactId, accountId, tagName],
  );
}

export async function setFieldValue(
  q: Queryable,
  accountId: string,
  contactId: string,
  fieldName: string,
  value: string | number | boolean | null,
): Promise<void> {
  const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text";
  const fieldId = await ensureNamed(q, "custom_fields", accountId, fieldName, type);
  await q.query(
    `INSERT INTO contact_field_values (contact_id, field_id, value) VALUES ($1, $2, $3) AS new
     ON DUPLICATE KEY UPDATE value = new.value`,
    [contactId, fieldId, JSON.stringify(value)],
  );
}
