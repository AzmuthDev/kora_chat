-- Modelo de dados do relatório (seção 6), em MySQL 8.
--   * IDs: CHAR(36) com UUID gerado pelo banco (ou pelo app, quando ele precisa saber o ID antes)
--   * Datas: DATETIME(3) sempre em UTC (a conexão usa time_zone '+00:00')
--   * Collation binária: comparações de texto diferenciam maiúsculas e acentos, como no PostgreSQL
--     (importante para chaves de idempotência e IDs do Instagram). E-mails são gravados em minúsculas.

ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE accounts (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  name        VARCHAR(255) NOT NULL,
  timezone    VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  plan        VARCHAR(32)  NOT NULL DEFAULT 'free',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
);

CREATE TABLE channel_connections (
  id                   CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id           CHAR(36)     NOT NULL,
  channel              VARCHAR(32)  NOT NULL,             -- instagram | messenger | whatsapp | tiktok | sms | email
  external_account_id  VARCHAR(191) NOT NULL,             -- instagram: IG user id (entry[].id do webhook)
  username             VARCHAR(255),
  access_token_enc     TEXT         NOT NULL,
  token_expires_at     DATETIME(3),
  status               VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY channel_connections_external (channel, external_account_id),
  CONSTRAINT channel_connections_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE contacts (
  id                   CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id           CHAR(36)     NOT NULL,
  first_name           VARCHAR(255),
  last_name            VARCHAR(255),
  email                VARCHAR(255),
  phone                VARCHAR(64),
  locale               VARCHAR(32),
  timezone             VARCHAR(64),
  last_interaction_at  DATETIME(3),
  last_input_text      TEXT,
  status               VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY contacts_account (account_id, created_at),
  CONSTRAINT contacts_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE contact_identities (
  contact_id        CHAR(36)     NOT NULL,
  account_id        CHAR(36)     NOT NULL,
  channel           VARCHAR(32)  NOT NULL,
  external_user_id  VARCHAR(191) NOT NULL,               -- instagram: IGSID
  username          VARCHAR(255),
  opted_in          BOOLEAN      NOT NULL DEFAULT TRUE,
  last_inbound_at   DATETIME(3),                         -- última DM recebida: abre a janela de 24h
  PRIMARY KEY (contact_id, channel),
  UNIQUE KEY contact_identities_external (account_id, channel, external_user_id),
  CONSTRAINT contact_identities_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE,
  CONSTRAINT contact_identities_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE tags (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)     NOT NULL,
  name        VARCHAR(191) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY tags_name (account_id, name),
  CONSTRAINT tags_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE contact_tags (
  contact_id  CHAR(36)    NOT NULL,
  tag_id      CHAR(36)    NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (contact_id, tag_id),
  CONSTRAINT contact_tags_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE,
  CONSTRAINT contact_tags_tag_fk FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
);

CREATE TABLE custom_fields (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)     NOT NULL,
  name        VARCHAR(191) NOT NULL,
  type        VARCHAR(32)  NOT NULL,                     -- text | number | date | datetime | boolean | array
  PRIMARY KEY (id),
  UNIQUE KEY custom_fields_name (account_id, name),
  CONSTRAINT custom_fields_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE contact_field_values (
  contact_id  CHAR(36) NOT NULL,
  field_id    CHAR(36) NOT NULL,
  value       JSON,
  PRIMARY KEY (contact_id, field_id),
  CONSTRAINT contact_field_values_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE,
  CONSTRAINT contact_field_values_field_fk FOREIGN KEY (field_id) REFERENCES custom_fields (id) ON DELETE CASCADE
);

CREATE TABLE bot_fields (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)     NOT NULL,
  name        VARCHAR(191) NOT NULL,
  type        VARCHAR(32)  NOT NULL,
  value       JSON,
  PRIMARY KEY (id),
  UNIQUE KEY bot_fields_name (account_id, name),
  CONSTRAINT bot_fields_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE folders (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)     NOT NULL,
  parent_id   CHAR(36),
  name        VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT folders_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT folders_parent_fk FOREIGN KEY (parent_id) REFERENCES folders (id) ON DELETE CASCADE
);

CREATE TABLE flows (
  id                    CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id            CHAR(36)     NOT NULL,
  ns                    VARCHAR(191) NOT NULL,
  folder_id             CHAR(36),
  name                  VARCHAR(255) NOT NULL,
  status                VARCHAR(32)  NOT NULL DEFAULT 'draft',   -- draft | published | archived
  published_version_id  CHAR(36),
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY flows_ns (account_id, ns),
  CONSTRAINT flows_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT flows_folder_fk FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE SET NULL
);

CREATE TABLE flow_versions (
  id          CHAR(36)    NOT NULL DEFAULT (UUID()),
  flow_id     CHAR(36)    NOT NULL,
  graph       JSON        NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT flow_versions_flow_fk FOREIGN KEY (flow_id) REFERENCES flows (id) ON DELETE CASCADE
);

ALTER TABLE flows
  ADD CONSTRAINT flows_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES flow_versions (id) ON DELETE SET NULL;

CREATE TABLE triggers (
  id          CHAR(36)    NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)    NOT NULL,
  flow_id     CHAR(36)    NOT NULL,
  channel     VARCHAR(32) NOT NULL,
  type        VARCHAR(32) NOT NULL,                      -- comment | keyword | story_reply | story_mention | ref_url | default_reply | api
  config      JSON        NOT NULL DEFAULT (JSON_OBJECT()),
  priority    INT         NOT NULL DEFAULT 0,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY triggers_lookup (account_id, channel, type, active),
  CONSTRAINT triggers_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT triggers_flow_fk FOREIGN KEY (flow_id) REFERENCES flows (id) ON DELETE CASCADE
);

CREATE TABLE contact_sessions (
  contact_id       CHAR(36)     NOT NULL,
  flow_version_id  CHAR(36)     NOT NULL,
  node_id          VARCHAR(191) NOT NULL,
  waiting_for      VARCHAR(64),
  context          JSON         NOT NULL DEFAULT (JSON_OBJECT()),
  expires_at       DATETIME(3),
  PRIMARY KEY (contact_id),
  CONSTRAINT contact_sessions_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE,
  CONSTRAINT contact_sessions_version_fk FOREIGN KEY (flow_version_id) REFERENCES flow_versions (id) ON DELETE CASCADE
);

CREATE TABLE events_raw (
  id           CHAR(36)     NOT NULL DEFAULT (UUID()),
  channel      VARCHAR(32)  NOT NULL,
  dedupe_key   VARCHAR(255) NOT NULL,
  received_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  payload      JSON         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY events_raw_dedupe (channel, dedupe_key)
);

CREATE TABLE scheduled_jobs (
  id          CHAR(36)    NOT NULL DEFAULT (UUID()),
  contact_id  CHAR(36),
  run_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  kind        VARCHAR(64) NOT NULL,                       -- process_event | data_deletion | (futuro) smart_delay
  payload     JSON        NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',     -- pending | running | done | failed
  attempts    INT         NOT NULL DEFAULT 0,
  last_error  TEXT,
  locked_at   DATETIME(3),
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY scheduled_jobs_due (status, run_at),
  CONSTRAINT scheduled_jobs_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id                   CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id           CHAR(36)     NOT NULL,
  contact_id           CHAR(36),
  channel              VARCHAR(32)  NOT NULL,
  direction            VARCHAR(16)  NOT NULL,             -- inbound | outbound
  kind                 VARCHAR(32)  NOT NULL DEFAULT 'dm',-- dm | private_reply | comment_reply | comment
  payload              JSON         NOT NULL,
  external_message_id  VARCHAR(255),
  idempotency_key      VARCHAR(255),
  status               VARCHAR(16)  NOT NULL,             -- received | pending | sent | failed | blocked
  error                TEXT,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY messages_idempotency (idempotency_key),
  KEY messages_contact (contact_id, created_at),
  KEY messages_account (account_id, created_at),
  CONSTRAINT messages_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT messages_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL
);

CREATE TABLE broadcasts (
  id            CHAR(36)    NOT NULL DEFAULT (UUID()),
  account_id    CHAR(36)    NOT NULL,
  segment       JSON        NOT NULL DEFAULT (JSON_OBJECT()),
  content       JSON        NOT NULL,
  scheduled_at  DATETIME(3),
  status        VARCHAR(16) NOT NULL DEFAULT 'draft',
  PRIMARY KEY (id),
  CONSTRAINT broadcasts_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE TABLE api_keys (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id  CHAR(36)     NOT NULL,
  hash        VARCHAR(191) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY api_keys_hash (hash),
  CONSTRAINT api_keys_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);
