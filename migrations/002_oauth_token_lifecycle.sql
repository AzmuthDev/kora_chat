-- Login OAuth do Instagram e ciclo de vida do token longo (60 dias, renovável após 24h).

CREATE TABLE oauth_states (
  state       VARCHAR(191) NOT NULL,                  -- valor aleatório enviado à Meta e devolvido no callback
  account_id  CHAR(36)     NOT NULL,
  provider    VARCHAR(32)  NOT NULL,                  -- instagram
  expires_at  DATETIME(3)  NOT NULL,
  used_at     DATETIME(3),
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (state),
  CONSTRAINT oauth_states_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

ALTER TABLE channel_connections
  ADD COLUMN token_issued_at       DATETIME(3),       -- quando o token atual foi emitido (refresh só após 24h)
  ADD COLUMN token_refreshed_at    DATETIME(3),
  ADD COLUMN scopes                JSON        NOT NULL DEFAULT (JSON_ARRAY()),
  ADD COLUMN last_refresh_error    TEXT,
  ADD COLUMN refresh_locked_until  DATETIME(3),       -- trava entre workers e backoff após falha
  ADD COLUMN updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

UPDATE channel_connections SET token_issued_at = created_at WHERE token_issued_at IS NULL;

-- status de channel_connections: active | expired (precisa reconectar) | disconnected
CREATE INDEX channel_connections_refresh ON channel_connections (status, token_expires_at);
