#!/usr/bin/env bash
# API uçtan uca testleri. Veritabanı testlerini de çalıştırır, ardından
# şemayı TEMİZ duruma döndürür — API testleri bilinen bir başlangıç bekler.
set -euo pipefail
cd "$(dirname "$0")/.."

# DATABASE_URL: ortamda verilmişse ona dokunulmaz (god birleştirme doğrulaması
# ve bu betiğin çağıranı buna dayanır); yoksa .env'den, o da yoksa worktree'ye
# özel bir veritabanından türetilir (bkz. scripts/db-env.sh — paylaşımlı
# Postgres'te iki worktree'nin aynı anda db-reset'i birbirini çökertmesin diye).
# shellcheck source=scripts/load-env.sh
source "$(dirname "$0")/load-env.sh"
# shellcheck source=scripts/db-env.sh
source "$(dirname "$0")/db-env.sh"

# API testleri RLS'e TABİ rolle koşmalıdır. DB_APP_ROLE ayarlanmazsa bağlantı
# owner (BYPASSRLS) olarak kalır ve izolasyon testleri anlamsızlaşır — üstelik
# sessizce değil, "başka kiracının verisi görünüyor" diye gürültüyle düşerler.
# Yine de burada açıkça sabitliyoruz: testin neyi sınadığı ortam değişkenine
# bağlı olmamalı.
: "${DB_APP_ROLE:=sezra_app}"
export DATABASE_URL DB_APP_ROLE

bash scripts/audit.sh
echo

bash scripts/test.sh | tail -3
npx tsc --build
echo "✓ TypeScript derlendi"

bash scripts/db-reset.sh
echo "✓ veritabanı temiz duruma döndürüldü"
echo

AUTH_MODE=dev NODE_ENV=test node --import tsx --test --test-concurrency=1 apps/api/test/*.test.ts
