-- Conexões de teste: o simulador do painel gera eventos para elas e nada é enviado ao Instagram de verdade.
ALTER TABLE channel_connections ADD COLUMN sandbox boolean NOT NULL DEFAULT false;
