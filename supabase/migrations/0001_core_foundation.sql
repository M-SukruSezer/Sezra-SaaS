-- =============================================================================
-- 0001 — Çekirdek temel: şemalar, uzantılar, ortak tipler, yardımcı trigger'lar
-- =============================================================================
-- Tasarım notu: Her modül kendi PostgreSQL şemasında yaşar (core, crm, finance,
-- hr, purchasing). Bu, "modüler monolit" yaklaşımının veritabanı karşılığıdır:
-- modüller fiziksel olarak ayrık ama tek bir veritabanında; ileride bir modülü
-- ayrı servise çıkarmak istediğinizde şema bazlı logical replication yeterlidir.
-- =============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "pg_trgm";       -- isim/arama indeksleri
create extension if not exists "btree_gin";

create schema if not exists core;
create schema if not exists crm;
create schema if not exists finance;
create schema if not exists hr;
create schema if not exists purchasing;

comment on schema core is 'Kiracı bağlamı, kimlik, yetki, olay veri yolu, ortak varlıklar';

-- -----------------------------------------------------------------------------
-- Ortak enum tipleri
-- -----------------------------------------------------------------------------
do $$ begin
  create type core.partner_type as enum ('customer', 'supplier', 'employee', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type core.subscription_status as enum ('trial', 'active', 'past_due', 'suspended', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type core.event_status as enum ('pending', 'processing', 'done', 'failed', 'dead');
exception when duplicate_object then null; end $$;

do $$ begin
  create type core.audit_action as enum ('insert', 'update', 'delete');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- updated_at otomatik güncelleme
-- -----------------------------------------------------------------------------
create or replace function core.fn_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Bir tabloya standart updated_at trigger'ı ekler.
create or replace function core.attach_updated_at(p_schema text, p_table text)
returns void
language plpgsql
as $$
begin
  execute format(
    'drop trigger if exists trg_%1$s_updated_at on %2$I.%1$I;
     create trigger trg_%1$s_updated_at before update on %2$I.%1$I
       for each row execute function core.fn_set_updated_at();',
    p_table, p_schema
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Türkçe uyumlu slug / normalize (arama ve kod üretimi için)
-- -----------------------------------------------------------------------------
create or replace function core.slugify(p_text text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(
    lower(translate(coalesce(p_text, ''),
      'ÇĞİIÖŞÜçğıiöşü',
      'cgiiosucgiiosu')),
    '[^a-z0-9]+', '-', 'g'));
$$;
