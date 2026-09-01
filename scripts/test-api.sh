#!/usr/bin/env bash
# API uçtan uca testleri. Veritabanı testlerini de çalıştırır, ardından
# şemayı TEMİZ duruma döndürür — API testleri bilinen bir başlangıç bekler.
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/test.sh | tail -3
npx tsc --build
echo "✓ TypeScript derlendi"

bash scripts/db-reset.sh
echo "✓ veritabanı temiz duruma döndürüldü"
echo

AUTH_MODE=dev NODE_ENV=test node --import tsx --test apps/api/test/*.test.ts
