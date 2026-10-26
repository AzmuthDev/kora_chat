-- Links rastreados: o botão da DM aponta para PUBLIC_BASE_URL/r/<slug>?r=<pessoa>, que conta o clique e redireciona.
-- Um link por (fluxo, destino), então o slug é o mesmo para todo mundo; o ?r= diferencia as pessoas.

CREATE TABLE tracked_links (
  id          CHAR(36)     NOT NULL DEFAULT (UUID()),
  slug        VARCHAR(16)  NOT NULL,
  account_id  CHAR(36)     NOT NULL,
  flow_id     CHAR(36)     NOT NULL,
  url         TEXT         NOT NULL,
  url_hash    CHAR(64)     NOT NULL,                     -- sha256 da url (TEXT não entra em índice único)
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY tracked_links_slug (slug),
  UNIQUE KEY tracked_links_flow_url (flow_id, url_hash),
  KEY tracked_links_account (account_id),
  CONSTRAINT tracked_links_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT tracked_links_flow_fk FOREIGN KEY (flow_id) REFERENCES flows (id) ON DELETE CASCADE
);

-- Quem recebeu o link numa DM enviada com sucesso (base da taxa de clique).
-- recipient = HMAC do contato: identifica a pessoa entre cliques sem expor o IGSID na URL.
CREATE TABLE tracked_link_recipients (
  link_id     CHAR(36)     NOT NULL,
  recipient   CHAR(22)     NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (link_id, recipient),
  CONSTRAINT tracked_link_recipients_link_fk FOREIGN KEY (link_id) REFERENCES tracked_links (id) ON DELETE CASCADE
);

CREATE TABLE link_clicks (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  link_id     CHAR(36)     NOT NULL,
  recipient   CHAR(22),                                  -- NULL quando o link foi aberto sem um ?r= válido
  ip_hash     CHAR(64),                                  -- HMAC do IP: nunca grava o IP em si
  user_agent  VARCHAR(300),
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY link_clicks_link (link_id, recipient),
  CONSTRAINT link_clicks_link_fk FOREIGN KEY (link_id) REFERENCES tracked_links (id) ON DELETE CASCADE
);
