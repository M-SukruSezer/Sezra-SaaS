#!/usr/bin/env bash
# Kok dizindeki .env dosyasini ortama yukler.
#
# `source scripts/load-env.sh` ile cagrilir; calisma dizininin kok olmasi
# beklenir.
#
# PRECEDENCE: kabukte tanimli gercek degiskenler .env'i EZER. Test betikleri
# DATABASE_URL'i satir ici verdigi icin bu sart -- aksi halde testler
# gelistirme veritabanina baglanirdi. Ayni kural apps/api/src/env.ts'te de
# gecerlidir; ikisi ayni sozlesmeyi uygular.
[ -f .env ] || return 0
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key=${line%%=*}; val=${line#*=}
  key=$(printf '%s' "$key" | tr -d '[:space:]')
  [ -z "$key" ] && continue
  if [ -z "$(eval "printf '%s' \"\${$key:-}\"")" ]; then
    val=$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    export "$key=$val"
  fi
done < .env
