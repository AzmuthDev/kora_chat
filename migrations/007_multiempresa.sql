-- Multiempresa: cada `account` é uma empresa-cliente, com administradores e membros próprios.
--   users.role            superadmin = dono da plataforma (vê e administra todas as empresas)
--                         user       = cliente; o acesso vem de account_members
--   account_members.role  admin  = gerencia a equipe e as conexões do Instagram da empresa
--                         member = opera automações, contatos e mensagens

ALTER TABLE users DROP CHECK users_role_check;
UPDATE users SET role = CASE role WHEN 'owner' THEN 'superadmin' ELSE 'user' END;
ALTER TABLE users ALTER role SET DEFAULT 'user';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin', 'user'));

ALTER TABLE account_members
  ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'member',
  ADD CONSTRAINT account_members_role_check CHECK (role IN ('admin', 'member'));

-- suspended: o painel fica só leitura e o worker ignora os eventos da empresa (ex.: falta de pagamento).
ALTER TABLE accounts
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD CONSTRAINT accounts_status_check CHECK (status IN ('active', 'suspended'));

-- Convite por link: só o hash do token fica gravado; o link vale para o e-mail convidado.
CREATE TABLE account_invites (
  id           CHAR(36)     NOT NULL DEFAULT (UUID()),
  account_id   CHAR(36)     NOT NULL,
  email        VARCHAR(255) NOT NULL,                  -- sempre em minúsculas
  role         VARCHAR(16)  NOT NULL DEFAULT 'member',
  token_hash   CHAR(64)     NOT NULL,
  invited_by   CHAR(36),
  expires_at   DATETIME(3)  NOT NULL,
  accepted_at  DATETIME(3),
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY account_invites_token (token_hash),
  KEY account_invites_account (account_id, accepted_at),
  CONSTRAINT account_invites_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT account_invites_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT account_invites_invited_by_fk FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE SET NULL
);
