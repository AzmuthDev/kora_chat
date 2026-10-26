-- Login do painel com e-mail e senha.
--   owner  = administrador: vê todas as contas e gerencia a equipe
--   member = vê e opera só as contas às quais foi adicionado

CREATE TABLE users (
  id             CHAR(36)     NOT NULL DEFAULT (UUID()),
  email          VARCHAR(255) NOT NULL,                  -- sempre gravado em minúsculas
  name           VARCHAR(255) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(16)  NOT NULL DEFAULT 'member',
  disabled       BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at  DATETIME(3),
  PRIMARY KEY (id),
  UNIQUE KEY users_email (email),
  CONSTRAINT users_role_check CHECK (role IN ('owner', 'member'))
);

CREATE TABLE account_members (
  account_id  CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (account_id, user_id),
  KEY account_members_user (user_id),
  CONSTRAINT account_members_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT account_members_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  token_hash    CHAR(64)     NOT NULL,                   -- sha256 do token do cookie; o token em si nunca é gravado
  user_id       CHAR(36)     NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)  NOT NULL,
  user_agent    VARCHAR(300),
  ip            VARCHAR(64),
  PRIMARY KEY (token_hash),
  KEY sessions_user (user_id),
  KEY sessions_expires (expires_at),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
