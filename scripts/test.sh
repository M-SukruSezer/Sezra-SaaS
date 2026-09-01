#!/usr/bin/env bash
# Sıfırdan kurar, demo kiracıyı yükler ve tüm testleri çalıştırır.
# Testler idempotent DEĞİLDİR — bilinen bir başlangıç durumu varsayarlar.
#
#   DATABASE_URL=postgres://... bash scripts/test.sh
# ya da PGHOST/PGPORT/PGUSER ortam değişkenleriyle.
set -uo pipefail
cd "$(dirname "$0")/.."

PSQL=(psql -v ON_ERROR_STOP=1 -q)
if [ -n "${DATABASE_URL:-}" ]; then PSQL+=(-d "$DATABASE_URL"); fi
ADMIN=(psql -q); [ -n "${DATABASE_URL:-}" ] && ADMIN+=(-d "$DATABASE_URL")

DB="${PGDATABASE:-sezra_dev}"
if [ -z "${DATABASE_URL:-}" ]; then
  PGDATABASE=postgres dropdb --if-exists "$DB" >/dev/null 2>&1
  PGDATABASE=postgres createdb "$DB" || exit 1
else
  "${PSQL[@]}" -c "drop schema if exists purchasing, hr, finance, crm, core cascade" >/dev/null
fi

for f in supabase/migrations/*.sql; do
  if ! "${PSQL[@]}" -c "set client_min_messages='warning'" -f "$f" >/dev/null 2>/tmp/mig.err; then
    echo "MIGRATION HATASI: $f"; grep -iE "ERROR|HATA" /tmp/mig.err | head -5; exit 1
  fi
done
echo "✓ $(ls supabase/migrations/*.sql | wc -l) migration uygulandı"

"${PSQL[@]}" -f supabase/seed/demo_colombia.sql >/dev/null 2>&1 || { echo "SEED HATASI"; exit 1; }
echo "✓ demo veri yüklendi"
echo

fail=0
for t in supabase/tests/*.sql; do
  out=$("${PSQL[@]}" -f "$t" 2>&1)
  rc=$?
  echo "$out" | grep -E "PASS|FAIL|UYARI|^===" | sed 's/^psql:[^ ]* //; s/^NOTICE:  //; s/^WARNING:  //'
  if [ $rc -ne 0 ]; then
    echo "$out" | grep -iE "ERROR|HATA" | head -3
    fail=1
  fi
  echo
done

pass=$(echo "" | true)
if [ $fail -eq 0 ]; then echo "TÜM TESTLER GEÇTİ"; else echo "TEST BAŞARISIZ"; fi
exit $fail
