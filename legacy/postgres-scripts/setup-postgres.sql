-- Cria (ou atualiza a senha de) um usuário próprio do app e o banco dele.
-- Uso: psql -U postgres -h localhost -v app_user=manychat -v app_db=manychat -v app_password='...' -f scripts/setup-postgres.sql
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', :'app_db', :'app_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_db') \gexec
SELECT format('GRANT ALL ON DATABASE %I TO %I', :'app_db', :'app_user') \gexec

\echo
\echo 'Banco e usuario prontos.'
