-- Modelo de dados do relatório (seção 6), com os ajustes que o MVP precisou:
--   * contact_identities guarda username e last_inbound_at (a janela de 24h é por canal)
--   * events_raw tem dedupe_key para idempotência de webhooks
--   * scheduled_jobs é a fila genérica (contact_id opcional)
--   * messages.idempotency_key evita reenvio quando um job é reprocessado

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel              text NOT NULL,             -- instagram | messenger | whatsapp | tiktok | sms | email
  external_account_id  text NOT NULL,             -- instagram: IG user id (entry[].id do webhook)
  username             text,
  access_token_enc     text NOT NULL,
  token_expires_at     timestamptz,
  status               text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_account_id)
);

CREATE TABLE contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  first_name           text,
  last_name            text,
  email                text,
  phone                text,
  locale               text,
  timezone             text,
  last_interaction_at  timestamptz,
  last_input_text      text,
  status               text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_identities (
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel           text NOT NULL,
  external_user_id  text NOT NULL,                -- instagram: IGSID
  username          text,
  opted_in          boolean NOT NULL DEFAULT true,
  last_inbound_at   timestamptz,                  -- última DM recebida: abre a janela de 24h
  PRIMARY KEY (contact_id, channel),
  UNIQUE (account_id, channel, external_user_id)
);

CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE contact_tags (
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE custom_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type        text NOT NULL,                      -- text | number | date | datetime | boolean | array
  UNIQUE (account_id, name)
);

CREATE TABLE contact_field_values (
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_id    uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value       jsonb,
  PRIMARY KEY (contact_id, field_id)
);

CREATE TABLE bot_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type        text NOT NULL,
  value       jsonb,
  UNIQUE (account_id, name)
);

CREATE TABLE folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES folders(id) ON DELETE CASCADE,
  name        text NOT NULL
);

CREATE TABLE flows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ns                    text NOT NULL,
  folder_id             uuid REFERENCES folders(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',   -- draft | published | archived
  published_version_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ns)
);

CREATE TABLE flow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id     uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  graph       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE flows
  ADD CONSTRAINT flows_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES flow_versions(id) ON DELETE SET NULL;

CREATE TABLE triggers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id     uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  channel     text NOT NULL,
  type        text NOT NULL,                      -- comment | keyword | story_reply | story_mention | ref_url | default_reply | api
  config      jsonb NOT NULL DEFAULT '{}',
  priority    integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX triggers_lookup ON triggers (account_id, channel, type) WHERE active;

CREATE TABLE contact_sessions (
  contact_id       uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  flow_version_id  uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  node_id          text NOT NULL,
  waiting_for      text,
  context          jsonb NOT NULL DEFAULT '{}',
  expires_at       timestamptz
);

CREATE TABLE events_raw (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      text NOT NULL,
  dedupe_key   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL,
  UNIQUE (channel, dedupe_key)
);

CREATE TABLE scheduled_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  run_at      timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,                      -- process_event | (futuro) smart_delay | sequence_step
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending',    -- pending | running | done | failed
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs (run_at) WHERE status = 'pending';

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id           uuid REFERENCES contacts(id) ON DELETE SET NULL,
  channel              text NOT NULL,
  direction            text NOT NULL,             -- inbound | outbound
  kind                 text NOT NULL DEFAULT 'dm',-- dm | private_reply | comment_reply
  payload              jsonb NOT NULL,
  external_message_id  text,
  idempotency_key      text UNIQUE,
  status               text NOT NULL,             -- received | sent | failed | blocked
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_contact ON messages (contact_id, created_at);

CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  segment       jsonb NOT NULL DEFAULT '{}',
  content       jsonb NOT NULL,
  scheduled_at  timestamptz,
  status        text NOT NULL DEFAULT 'draft'
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hash        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
