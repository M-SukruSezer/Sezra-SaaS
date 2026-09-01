#!/usr/bin/env bash
# Migration'ları sırayla uygular. DATABASE_URL owner (BYPASSRLS) rolü olmalı.
set -euo pipefail
: "${DATABASE_URL:=postgresql://sezra_owner:sezra_owner@localhost:5432/sezra_dev}"
cd "$(dirname "$0")/.."
for f in supabase/migrations/*.sql; do
  echo "→ $f"
  psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" -f "$f"
done
echo "Tüm migration'lar uygulandı."
