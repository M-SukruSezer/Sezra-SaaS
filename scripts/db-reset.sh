#!/usr/bin/env bash
# Şemayı sıfırdan kurar ve demo veriyi yükler. Test yürütmez.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/load-env.sh
source "$(dirname "$0")/load-env.sh"
# shellcheck source=scripts/db-env.sh
source "$(dirname "$0")/db-env.sh"

PSQL=(psql -v ON_ERROR_STOP=1 -q)
[ -n "${DATABASE_URL:-}" ] && PSQL+=(-d "$DATABASE_URL")

if [ -n "${DATABASE_URL:-}" ]; then
  # Şema listesi ELLE SAYILMAZ. Sayıldığında, yeni bir modül eklendiğinde onun
  # şeması resetten sağ çıkar; `create table if not exists` de mevcut tabloyu
  # atladığı için yeni kolonlar sessizce uygulanmaz ve migration'lar "geçti"
  # görünürken şema eskide kalır. Bunun yerine bu kullanıcıya ait sistem dışı
  # tüm şemalar düşürülür (sezra_dev bu proje için ayrılmış bir veritabanıdır).
  "${PSQL[@]}" -c "do \$\$
     declare s text;
     begin
       for s in
         select n.nspname from pg_namespace n
         join pg_roles r on r.oid = n.nspowner
         where r.rolname = current_user
           and n.nspname not in ('public', 'information_schema')
           and n.nspname not like 'pg\\_%'
       loop
         execute format('drop schema if exists %I cascade', s);
       end loop;
     end \$\$;" >/dev/null
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

"${PSQL[@]}" -f supabase/seed/demo_tenant.sql >/dev/null 2>&1 || { echo "SEED HATASI"; exit 1; }
