-- Disposable local/CI fixture credentials, never for a hosted service.
CREATE ROLE app_login LOGIN PASSWORD 'local_app_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
