#!/usr/bin/env bash
# Yerel geliştirme veritabanını kurar.
#
# ÖNEMLİ: Migration'lar RLS'i FORCE ettiği için, şemayı kuran rolün BYPASSRLS
# yetkisi olmalıdır (Supabase'de `postgres` rolü zaten böyledir). Uygulamanın
# bağlandığı rol (sezra_app) ise BYPASSRLS almaz — izolasyonu o rol yaşar.
#
# Kullanım:  sudo -u postgres bash scripts/dev-db-setup.sh
set -euo pipefail

DB_NAME="${DB_NAME:-sezra_dev}"
OWNER="${OWNER:-sezra_owner}"
APP_ROLE="${APP_ROLE:-sezra_app}"
OWNER_PW="${OWNER_PW:-sezra_owner}"
APP_PW="${APP_PW:-sezra_app}"

psql -v ON_ERROR_STOP=1 -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '${OWNER}') then
    create role ${OWNER} login password '${OWNER_PW}' createdb bypassrls;
  else
    -- Betik tekrar tekrar çalıştırılabilir olmalı: rol zaten varsa parolası ve
    -- öznitelikleri .env'in beklediği değerlere geri çekilir. Aksi halde eski,
    -- kimsenin bilmediği bir parola kurulumu kilitler.
    alter role ${OWNER} login password '${OWNER_PW}' createdb bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
    create role ${APP_ROLE} login password '${APP_PW}';
  else
    alter role ${APP_ROLE} login password '${APP_PW}' nobypassrls;
  end if;
end \$\$;

-- Owner bağlantısının `set role ${APP_ROLE}` yapabilmesi için üyelik şart.
-- Hem DB_APP_ROLE ile çalışan API (yetki daraltma) hem de RLS testleri buna
-- dayanır; üyelik olmadan ikisi de "permission denied to set role" ile düşer.
-- ADMIN OPTION gerektirdiği için yalnızca rolü oluşturan süper kullanıcı verebilir.
grant ${APP_ROLE} to ${OWNER};
SQL

if ! psql -tAc "select 1 from pg_database where datname='${DB_NAME}'" -d postgres | grep -q 1; then
  createdb -O "${OWNER}" "${DB_NAME}"
fi

psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
grant connect on database ${DB_NAME} to ${APP_ROLE};
SQL

echo "Hazır."
echo "  Migration için : postgresql://${OWNER}:${OWNER_PW}@localhost:5432/${DB_NAME}"
echo "  Uygulama için  : postgresql://${APP_ROLE}:${APP_PW}@localhost:5432/${DB_NAME}"
