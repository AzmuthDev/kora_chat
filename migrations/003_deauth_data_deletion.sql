-- Desautorização e exclusão de dados (callbacks exigidos pela Meta).
--
-- Para apagar "os dados obtidos por meio de uma conexão", contatos e mensagens precisam saber de qual
-- conexão vieram. O IGSID já é escopado por conta profissional, então a identidade pertence a uma conexão.

ALTER TABLE channel_connections
  ADD COLUMN app_scoped_user_id VARCHAR(191),           -- campo `id` do /me (o signed_request pode trazer este)
  ADD KEY channel_connections_app_scoped (app_scoped_user_id);

ALTER TABLE contact_identities
  ADD COLUMN connection_id CHAR(36),
  ADD KEY contact_identities_connection (connection_id),
  ADD CONSTRAINT contact_identities_connection_fk FOREIGN KEY (connection_id) REFERENCES channel_connections (id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN connection_id CHAR(36),
  ADD KEY messages_connection (connection_id),
  ADD CONSTRAINT messages_connection_fk FOREIGN KEY (connection_id) REFERENCES channel_connections (id) ON DELETE SET NULL;

-- Preenche o histórico quando não há ambiguidade (a conta tem uma única conexão Instagram).
UPDATE contact_identities ci
  JOIN (SELECT account_id, MIN(id) AS connection_id FROM channel_connections
         WHERE channel = 'instagram' GROUP BY account_id HAVING COUNT(*) = 1) s ON s.account_id = ci.account_id
   SET ci.connection_id = s.connection_id
 WHERE ci.channel = 'instagram' AND ci.connection_id IS NULL;

UPDATE messages m
  JOIN (SELECT account_id, MIN(id) AS connection_id FROM channel_connections
         WHERE channel = 'instagram' GROUP BY account_id HAVING COUNT(*) = 1) s ON s.account_id = m.account_id
   SET m.connection_id = s.connection_id
 WHERE m.channel = 'instagram' AND m.connection_id IS NULL;

CREATE TABLE data_deletion_requests (
  confirmation_code  VARCHAR(64)  NOT NULL,
  channel            VARCHAR(32)  NOT NULL,
  external_user_id   VARCHAR(191) NOT NULL,              -- user_id recebido no signed_request
  connection_ids     JSON         NOT NULL DEFAULT (JSON_ARRAY()), -- conexões encontradas no momento do pedido
  status             VARCHAR(16)  NOT NULL DEFAULT 'pending',    -- pending | completed
  summary            JSON,
  requested_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at       DATETIME(3),
  PRIMARY KEY (confirmation_code)
);
