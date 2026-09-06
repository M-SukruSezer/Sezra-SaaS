#!/usr/bin/env bash
# Veritabanı katmanı testleri: RLS izolasyonu ve iş akışı.
# Testler idempotent DEĞİLDİR — her çalıştırmada şema sıfırlanır.
set -uo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/load-env.sh
source "$(dirname "$0")/load-env.sh"

bash scripts/db-reset.sh || exit 1
echo "✓ $(ls supabase/migrations/*.sql | wc -l) migration + demo veri yüklendi"
echo

PSQL=(psql -v ON_ERROR_STOP=1 -q)
[ -n "${DATABASE_URL:-}" ] && PSQL+=(-d "$DATABASE_URL")

fail=0
for t in supabase/tests/*.sql; do
  out=$("${PSQL[@]}" -f "$t" 2>&1); rc=$?
  echo "$out" | grep -E "PASS|FAIL|UYARI|^===" | sed 's/^psql:[^ ]* //; s/^NOTICE:  //; s/^WARNING:  //'
  [ $rc -ne 0 ] && { echo "$out" | grep -iE "ERROR|HATA" | head -3; fail=1; }
  echo
done

[ $fail -eq 0 ] && echo "TÜM VERİTABANI TESTLERİ GEÇTİ" || echo "VERİTABANI TESTLERİ BAŞARISIZ"
exit $fail
