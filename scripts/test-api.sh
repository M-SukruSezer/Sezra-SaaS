#!/usr/bin/env bash
# API uçtan uca testleri. Veritabanı testlerini de çalıştırır, ardından
# şemayı TEMİZ duruma döndürür — API testleri bilinen bir başlangıç bekler.
set -euo pipefail
cd "$(dirname "$0")/.."

# API testleri RLS'e TABİ rolle koşmalıdır. DB_APP_ROLE ayarlanmazsa bağlantı
# owner (BYPASSRLS) olarak kalır ve izolasyon testleri anlamsızlaşır — üstelik
# sessizce değil, "başka kiracının verisi görünüyor" diye gürültüyle düşerler.
# Yine de burada açıkça sabitliyoruz: testin neyi sınadığı ortam değişkenine
# bağlı olmamalı.
: "${DATABASE_URL:=postgresql://sezra_owner:sezra_owner@localhost:5432/sezra_dev}"
: "${DB_APP_ROLE:=sezra_app}"
export DATABASE_URL DB_APP_ROLE

bash scripts/test.sh | tail -3
npx tsc --build
echo "✓ TypeScript derlendi"

bash scripts/db-reset.sh
echo "✓ veritabanı temiz duruma döndürüldü"
echo

AUTH_MODE=dev NODE_ENV=test node --import tsx --test --test-concurrency=1 apps/api/test/*.test.ts
