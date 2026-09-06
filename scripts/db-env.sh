#!/usr/bin/env bash
# Bu checkout icin DATABASE_URL'i belirler (yoksa turetir).
#
# NEDEN: 5432'deki Postgres butun git worktree'leri arasinda paylasilir ve
# db-reset.sh yikicidir (bu kullaniciya ait tum semalari DROP CASCADE eder).
# Iki worktree ayni anda test kosarsa biri, digerinin semalarini kosu ortasinda
# dusurur; 0200_finance_schema.sql "deadlock detected" ile ya da app.createApp
# "Cannot read properties of undefined" ile coker. Cozum: her worktree kendi
# veritabaninda kosar.
#
# ONCELIK:
#   1. Ortamda tanimli DATABASE_URL her zaman kazanir. god birlestirme
#      dogrulamasi icin buna dayanir; test betikleri de satir ici verebilir.
#   2. .env'deki DATABASE_URL -- bunu load-env.sh zaten yuklemis olur, yani
#      bu betik cagrilmadan once source edilmis olmalidir. Ana checkout'un
#      .env'i vardir ve boylece sezra_dev'de kalir.
#   3. Aksi halde: BAGLI bir git worktree'sindeysek veritabani adini worktree
#      dizininden turet (sezra_dev_<worktree>) ve yoksa olustur. Ana (bagli
#      olmayan) checkout icin varsayilan degismez: sezra_dev.
#
# Kullanim:  source scripts/load-env.sh && source scripts/db-env.sh
# Calisma dizininin depo koku olmasi beklenir.

_sezra_pg='postgresql://sezra_owner:sezra_owner@localhost:5432'

if [ -z "${DATABASE_URL:-}" ]; then
  _sezra_db='sezra_dev'

  # Bagli worktree tespiti: worktree'nin git dizini ile ortak git dizini
  # farkliysa burasi bir "linked worktree"dir. Ana checkout'ta ikisi aynidir.
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    _sezra_gd=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd)
    _sezra_gcd=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd)
    if [ -n "$_sezra_gd" ] && [ "$_sezra_gd" != "$_sezra_gcd" ]; then
      _sezra_slug=$(basename "$(git rev-parse --show-toplevel)" \
        | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed 's/^_*//; s/_*$//')
      _sezra_db="sezra_dev_${_sezra_slug}"

      if ! psql -tAqc \
        "select 1 from pg_database where datname = '${_sezra_db}'" \
        "${_sezra_pg}/postgres" 2>/dev/null | grep -q 1
      then
        # Iki es zamanli kosu ayni adi paylasmaz (ad worktree'ye ozel), ama
        # ayni worktree'de iki kosu yarisirsa "already exists" hatasini yut.
        psql -q "${_sezra_pg}/postgres" \
          -c "create database \"${_sezra_db}\" owner sezra_owner" >/dev/null 2>&1 || true
        psql -q "${_sezra_pg}/${_sezra_db}" \
          -c "grant connect on database \"${_sezra_db}\" to sezra_app" >/dev/null 2>&1 || true
      fi
    fi
  fi

  export DATABASE_URL="${_sezra_pg}/${_sezra_db}"
fi

unset _sezra_pg _sezra_db _sezra_gd _sezra_gcd _sezra_slug
