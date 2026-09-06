#!/usr/bin/env bash
# Tedarik zinciri geciti: bagimlilik agacinda bilinen guvenlik acigi VARSA
# derlemeyi durdurur. Agac su an 0 acikta; bu betik o temiz durumu kilitler.
# npm audit acik veritabanina eristigi icin ag baglantisi gerektirir; baglanti
# yoksa "audit calistirilamadi" diye sesli duser, sessizce gecmez.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! npm audit --audit-level=low; then
  echo "BASARISIZ: bagimlilik acigi bulundu (ya da audit ag hatasi). Yukariya bakin."
  exit 1
fi

echo "GECTI: npm audit temiz (low ve uzeri acik yok)."
