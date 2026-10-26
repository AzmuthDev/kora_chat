-- Desautorização e exclusão de dados (callbacks exigidos pela Meta).
--
-- Para apagar "os dados obtidos por meio de uma conexão", contatos e mensagens precisam saber de qual
-- conexão vieram. O IGSID já é escopado por conta profissional, então a identidade pertence a uma conexão.

ALTER TABLE channel_connections ADD COLUMN app_scoped_user_id text;   -- campo `id` do /me (o signed_request pode trazer este)
CREATE INDEX channel_connections_app_scoped ON channel_connections (app_scoped_user_id);

ALTER TABLE contact_identities ADD COLUMN connection_id uuid REFERENCES channel_connections(id) ON DELETE SET NULL;
ALTER TABLE messages           ADD COLUMN connection_id uuid REFERENCES channel_connections(id) ON DELETE SET NULL;
CREATE INDEX contact_identities_connection ON contact_identities (connection_id);
CREATE INDEX messages_connection ON messages (connection_id);

-- Preenche o histórico quando não há ambiguidade (a conta tem uma única conexão Instagram).
WITH single AS (
  SELECT account_id, min(id::text)::uuid AS connection_id
    FROM channel_connections WHERE channel = 'instagram'
   GROUP BY account_id HAVING count(*) = 1
)
UPDATE contact_identities ci SET connection_id = s.connection_id
  FROM single s WHERE ci.account_id = s.account_id AND ci.channel = 'instagram' AND ci.connection_id IS NULL;

WITH single AS (
  SELECT account_id, min(id::text)::uuid AS connection_id
    FROM channel_connections WHERE channel = 'instagram'
   GROUP BY account_id HAVING count(*) = 1
)
UPDATE messages m SET connection_id = s.connection_id
  FROM single s WHERE m.account_id = s.account_id AND m.channel = 'instagram' AND m.connection_id IS NULL;

CREATE TABLE data_deletion_requests (
  confirmation_code  text PRIMARY KEY,
  channel            text NOT NULL,
  external_user_id   text NOT NULL,                -- user_id recebido no signed_request
  connection_ids     uuid[] NOT NULL DEFAULT '{}', -- conexões encontradas no momento do pedido
  status             text NOT NULL DEFAULT 'pending',   -- pending | completed
  summary            jsonb,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
