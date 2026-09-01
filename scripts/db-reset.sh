#!/usr/bin/env bash
# Şemayı sıfırdan kurar ve demo veriyi yükler. Test yürütmez.
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL=(psql -v ON_ERROR_STOP=1 -q)
[ -n "${DATABASE_URL:-}" ] && PSQL+=(-d "$DATABASE_URL")

if [ -n "${DATABASE_URL:-}" ]; then
  "${PSQL[@]}" -c "drop schema if exists purchasing, hr, finance, crm, core cascade" >/dev/null
  # public'i de temizle (test yardımcı fonksiyonları orada yaşıyor).
  # PG15+ yeni oluşturulan public şemasında PUBLIC'e USAGE vermez; geri veriyoruz
  # ki uygulama rolü şemayı görebilsin (CREATE bilinçli olarak verilmiyor).
  "${PSQL[@]}" -c "drop schema if exists public cascade; create schema public;
                   grant usage on schema public to public" >/dev/null
else
  DB="${PGDATABASE:-sezra_dev}"
  PGDATABASE=postgres dropdb --if-exists "$DB" >/dev/null 2>&1
  PGDATABASE=postgres createdb "$DB"
fi

for f in supabase/migrations/*.sql; do
  if ! "${PSQL[@]}" -c "set client_min_messages='warning'" -f "$f" >/dev/null 2>/tmp/sezra-mig.err; then
    echo "MIGRATION HATASI: $f"; grep -iE "ERROR|HATA" /tmp/sezra-mig.err | head -5; exit 1
  fi
done

"${PSQL[@]}" -f supabase/seed/demo_colombia.sql >/dev/null 2>&1 || { echo "SEED HATASI"; exit 1; }
