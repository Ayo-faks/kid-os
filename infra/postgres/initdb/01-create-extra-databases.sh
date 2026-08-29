#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${POSTGRES_EXTRA_DBS:-}" ]]; then
  POSTGRES_EXTRA_DBS=""
fi

if [[ -n "${POSTGRES_APP_USER:-}" && -n "${POSTGRES_APP_PASSWORD:-}" ]]; then
  psql --username "${POSTGRES_USER}" --dbname postgres \
    --set app_user="${POSTGRES_APP_USER}" \
    --set app_password="${POSTGRES_APP_PASSWORD}" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
  :'app_user',
  :'app_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'app_user'
)\gexec
SQL
fi

IFS=',' read -ra databases <<< "${POSTGRES_EXTRA_DBS}"

for raw_database in "${databases[@]}"; do
  database="${raw_database//[[:space:]]/}"
  if [[ -z "${database}" ]]; then
    continue
  fi

  psql --username "${POSTGRES_USER}" --dbname postgres --set database="${database}" <<'SQL'
SELECT format('CREATE DATABASE %I', :'database')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'database'
)\gexec
SQL
done