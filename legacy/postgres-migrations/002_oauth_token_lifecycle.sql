-- Login OAuth do Instagram e ciclo de vida do token longo (60 dias, renovável após 24h).

CREATE TABLE oauth_states (
  state       text PRIMARY KEY,                   -- valor aleatório enviado à Meta e devolvido no callback
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    text NOT NULL,                      -- instagram
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channel_connections
  ADD COLUMN token_issued_at       timestamptz,   -- quando o token atual foi emitido (refresh só após 24h)
  ADD COLUMN token_refreshed_at    timestamptz,
  ADD COLUMN scopes                text[] NOT NULL DEFAULT '{}',
  ADD COLUMN last_refresh_error    text,
  ADD COLUMN refresh_locked_until  timestamptz,   -- trava entre workers e backoff após falha
  ADD COLUMN updated_at            timestamptz NOT NULL DEFAULT now();

UPDATE channel_connections SET token_issued_at = created_at WHERE token_issued_at IS NULL;

-- status de channel_connections: active | expired (precisa reconectar) | disconnected
CREATE INDEX channel_connections_refresh ON channel_connections (token_expires_at) WHERE status = 'active';
