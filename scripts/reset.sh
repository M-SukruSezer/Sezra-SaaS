#!/usr/bin/env bash
# Şemayı sıfırlar ve migration'ları baştan uygular (yalnızca geliştirme!).
set -euo pipefail
: "${DATABASE_URL:=postgresql://sezra_owner:sezra_owner@localhost:5432/sezra_dev}"
cd "$(dirname "$0")/.."
psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" <<'SQL'
drop schema if exists purchasing cascade;
drop schema if exists hr cascade;
drop schema if exists finance cascade;
drop schema if exists crm cascade;
drop schema if exists core cascade;
SQL
exec bash scripts/migrate.sh
