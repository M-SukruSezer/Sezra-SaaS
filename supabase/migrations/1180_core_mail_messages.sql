-- =============================================================================
-- 1180 -- Mail mesaj saklama + hesap basina senkron durumu (T-029 -- adim 1)
-- =============================================================================
-- BAGLAM: 1160 (T-025) bagli mail hesabini (core.mail_accounts) kurdu; IMAP ve
-- POP3 baglanti dogrulamasi calisiyor. Bu migration KALAN parcanin veri
-- katmanidir: cekilen mesajlarin saklandigi tablo ve her hesap icin senkron
-- ilerlemesi (en son UID, son senkron zamani, son hata).
--
-- GUVENLIK -- PAZARLIK KONUSU DEGIL:
--   1. Mesaj basligi VE govdesi KISISEL VERIDIR. RLS yalnizca sahip:
--      owner_id = core.current_user_id(). Kiraci yoneticisi, destek modu ve
--      mali musavir DAHIL kimse baskasinin postasini goremez. Politikada
--      bunlar icin OR dali YOKTUR ve OLMAYACAKTIR (bkz. 1160 ayni desen).
--   2. core.attach_audit BILEREK CAGRILMAZ: to_jsonb(new) ile mesaj govdesini
--      audit_log'a yazardi. Bu tablolar hic denetlenmez.
--   3. Gizli kimlik bilgisi bu tablolarda YOK; parola/token yalnizca
--      core.mail_accounts.secret_cipher'da, cekme/gonderme aninda cozulur.
--   4. body_html HAM olarak saklanir ama arayuz onu ASLA ham render etmez
--      (XSS yolu); istemci duz metne duser ya da temizler. Saklama guvenli,
--      render degil -- bu ayrim uygulama katmaninda korunur.
--
-- KVKK -- SAKLAMA SINIRI: hesap basina en fazla core.MAIL_MESSAGE_KEEP (500)
-- gelen mesaj saklanir. Senkron sonrasi core.mail_messages_trim() en eskileri
-- siler. Gerekce: gelen kutusu bir arsiv degil calisma penceresidir; sinirsiz
-- saklama, silinme hakkini (KVKK m।7) ve veri minimizasyonu ilkesini (m।4)
-- zedeler. Giden mesajlar (gonderilmis ileti kaydi) bu limitten muaftir:
-- sayilari kullanici denetimindedir ve gonderim kaniti niteligindedir.
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Sabit: hesap basina saklanan gelen mesaj ust siniri
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_keep()
returns int language sql immutable as $$ select 500 $$;

comment on function core.mail_message_keep() is
  'KVKK saklama siniri: hesap basina saklanan gelen mesaj ust siniri.';

-- -----------------------------------------------------------------------------
-- Tablo: mail_messages
-- -----------------------------------------------------------------------------
create table if not exists core.mail_messages (
  id            uuid primary key default gen_random_uuid(),
  -- Hangi bagli hesaba ait. Hesap silinince mesajlar da gider.
  account_id    uuid not null references core.mail_accounts(id) on delete cascade,
  -- SAHIP: RLS'in tek dayanagi. Hesabin sahibiyle ayni; sorgu kolayligi ve
  -- politika sadeligi icin denormalize edildi.
  owner_id      uuid not null references core.users(id) on delete cascade,
  -- Yon: cekilen gelen posta ya da panelden gonderilen.
  direction     text not null default 'incoming'
    check (direction in ('incoming', 'outgoing')),
  -- Sunucu klasoru (IMAP). POP3'te daima 'INBOX'. Giden mesajda 'SENT'.
  folder        text not null default 'INBOX',
  -- Sunucu kimligi: IMAP UID (metin) ya da POP3 UIDL. Giden mesajda uygulama
  -- 'out:<uuid>' uretir. (account_id, uid) essiz -> ayni mesaj iki kez yazilmaz.
  uid           text not null,
  -- IMAP UIDVALIDITY: degisirse sunucudaki UID'ler gecersizdir (bkz. sync_state).
  uid_validity  text,
  -- RFC 5322 basliklari (govde disinda kalan ust veri de kisisel veridir).
  message_id    text,
  in_reply_to   text,
  subject       text,
  from_addr     text,
  from_name     text,
  to_addrs      text[] not null default '{}',
  cc_addrs      text[] not null default '{}',
  -- Date basligi (gonderenin bildirdigi zaman).
  sent_at       timestamptz,
  -- Sunucudaki alinma zamani / bizim cektigimiz an.
  received_at   timestamptz not null default now(),
  -- Liste gorunumu icin kisa duz-metin onizleme (govdeden turetilir, ~200 char).
  snippet       text,
  -- Govde. body_text her zaman doldurulur (gerekirse HTML'den soyutlanarak).
  -- body_html HAM saklanir; render katmani temizler.
  body_text     text,
  body_html     text,
  -- Bu kartta ek indirme YOK; yalnizca "eki var mi" bilgisi tasinir.
  has_attachments boolean not null default false,
  size_bytes    int,
  -- Okundu isareti (yerel; sunucuya geri yazilmaz).
  seen          boolean not null default false,
  -- Giden mesaj sonucu. incoming'de daima null.
  send_status   text check (send_status in ('sent', 'failed')),
  send_error    text,
  sent_by       uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Ayni hesapta ayni sunucu kimligi bir kez.
  constraint ux_mail_messages_account_uid unique (account_id, uid),
  -- Giden mesajda send_status zorunlu, gelen mesajda yasak.
  constraint ck_mail_messages_send_status check (
    (direction = 'outgoing' and send_status is not null)
    or (direction = 'incoming' and send_status is null)
  )
);

create index if not exists ix_mail_messages_account
  on core.mail_messages (account_id, direction, received_at desc);
create index if not exists ix_mail_messages_owner
  on core.mail_messages (owner_id, received_at desc);

select core.attach_updated_at('core', 'mail_messages');
-- owner_id'yi otomatik doldurur (current_user_id). Fonksiyonlar da acikca set
-- eder; tetikleyici ikinci savunma.
select core.attach_row_defaults('core', 'mail_messages');
-- DIKKAT: core.attach_audit BILEREK CAGRILMIYOR -- govdeyi audit_log'a yazardi.

-- -----------------------------------------------------------------------------
-- Tablo: mail_sync_state -- hesap basina senkron ilerlemesi
-- -----------------------------------------------------------------------------
create table if not exists core.mail_sync_state (
  account_id     uuid primary key references core.mail_accounts(id) on delete cascade,
  owner_id       uuid not null references core.users(id) on delete cascade,
  -- IMAP UIDVALIDITY (metin). Sunucuda degisirse yerel mesajlar bosaltilip
  -- bastan cekilir.
  uid_validity   text,
  -- Cekilmis en yuksek IMAP UID. Artimli cekme buradan devam eder.
  last_uid       bigint not null default 0,
  -- POP3: cekilmis UIDL'lerin sayisi degil, en son gorulme; POP3'te last_uid
  -- kullanilmaz, uid essizligi yeterlidir.
  last_synced_at timestamptz,
  last_error     text,
  last_error_at  timestamptz,
  message_count  int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

select core.attach_updated_at('core', 'mail_sync_state');
select core.attach_row_defaults('core', 'mail_sync_state');

-- -----------------------------------------------------------------------------
-- RLS -- yalnizca sahip (1160 mail_accounts ile ayni desen)
-- -----------------------------------------------------------------------------
alter table core.mail_messages enable row level security;
alter table core.mail_messages force row level security;
drop policy if exists p_mail_messages_own on core.mail_messages;
create policy p_mail_messages_own on core.mail_messages for all
  using (owner_id = (select core.current_user_id()))
  with check (owner_id = (select core.current_user_id()));

alter table core.mail_sync_state enable row level security;
alter table core.mail_sync_state force row level security;
drop policy if exists p_mail_sync_state_own on core.mail_sync_state;
create policy p_mail_sync_state_own on core.mail_sync_state for all
  using (owner_id = (select core.current_user_id()))
  with check (owner_id = (select core.current_user_id()));

-- -----------------------------------------------------------------------------
-- Yardimci: caller bu hesabin sahibi mi (security definer fonksiyonlar icin)
-- -----------------------------------------------------------------------------
create or replace function core.mail_account_owned(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select exists (
    select 1 from core.mail_accounts
    where id = p_account_id and owner_id = core.current_user_id()
  );
$$;

-- -----------------------------------------------------------------------------
-- Okuma: liste -- govde DONMEZ, yalnizca snippet + ust veri
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_list(
  p_account_id uuid,
  p_direction  text default 'incoming',
  p_limit      int  default 50,
  p_offset     int  default 0
)
returns table (
  id              uuid,
  account_id      uuid,
  direction       text,
  folder          text,
  subject         text,
  from_addr       text,
  from_name       text,
  to_addrs        text[],
  snippet         text,
  has_attachments boolean,
  seen            boolean,
  send_status     text,
  sent_at         timestamptz,
  received_at     timestamptz,
  total_count     bigint
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  with lim as (select least(greatest(coalesce(p_limit, 50), 1), 100) as n,
                      greatest(coalesce(p_offset, 0), 0) as off)
  select
    m.id, m.account_id, m.direction, m.folder, m.subject, m.from_addr, m.from_name,
    m.to_addrs, m.snippet, m.has_attachments, m.seen, m.send_status,
    m.sent_at, m.received_at,
    count(*) over () as total_count
  from core.mail_messages m, lim
  where m.owner_id = core.current_user_id()
    and m.account_id = p_account_id
    and (p_direction is null or m.direction = p_direction)
  order by m.received_at desc, m.id
  limit (select n from lim) offset (select off from lim);
$$;

comment on function core.mail_message_list(uuid, text, int, int) is
  'Oturumdaki kullanicinin bir hesabindaki mesaj listesi (ust veri + snippet). '
  'Govde (body_text/body_html) DONMEZ. Yalnizca sahip.';

-- -----------------------------------------------------------------------------
-- Okuma: tek mesaj -- govde DAHIL (yalnizca sahibe)
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_get(p_id uuid)
returns table (
  id              uuid,
  account_id      uuid,
  direction       text,
  folder          text,
  message_id      text,
  in_reply_to     text,
  subject         text,
  from_addr       text,
  from_name       text,
  to_addrs        text[],
  cc_addrs        text[],
  snippet         text,
  body_text       text,
  body_html       text,
  has_attachments boolean,
  size_bytes      int,
  seen            boolean,
  send_status     text,
  send_error      text,
  sent_at         timestamptz,
  received_at     timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    m.id, m.account_id, m.direction, m.folder, m.message_id, m.in_reply_to,
    m.subject, m.from_addr, m.from_name, m.to_addrs, m.cc_addrs, m.snippet,
    m.body_text, m.body_html, m.has_attachments, m.size_bytes, m.seen,
    m.send_status, m.send_error, m.sent_at, m.received_at
  from core.mail_messages m
  where m.id = p_id and m.owner_id = core.current_user_id();
$$;

comment on function core.mail_message_get(uuid) is
  'Tek mesaj, govde dahil. Yalnizca mesajin sahibi. body_html HAM doner; '
  'render katmani temizler (arayuz ham HTML basmaz).';

-- -----------------------------------------------------------------------------
-- Yazma: okundu isareti
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_mark_seen(p_id uuid, p_seen boolean default true)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_user uuid := core.current_user_id();
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  update core.mail_messages m set seen = coalesce(p_seen, true)
  where m.id = p_id and m.owner_id = v_user;
  if not found then
    raise exception 'Mesaj bulunamadi' using errcode = 'P0002';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Yazma: cekilen mesaji tabloya yaz (artimli senkron kullanir)
--
-- security definer + acik sahiplik kontrolu: hesap caller'a ait degilse reddet.
-- (account_id, uid) cakisirsa mevcut satir KORUNUR (mesaj degismez) ama seen
-- disi ust veri tazelenir degil -- idempotent: hicbir sey yapma.
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_ingest(
  p_account_id uuid,
  p_uid        text,
  p_uid_validity text,
  p_folder     text,
  p_message_id text,
  p_in_reply_to text,
  p_subject    text,
  p_from_addr  text,
  p_from_name  text,
  p_to_addrs   text[],
  p_cc_addrs   text[],
  p_sent_at    timestamptz,
  p_received_at timestamptz,
  p_snippet    text,
  p_body_text  text,
  p_body_html  text,
  p_has_attachments boolean,
  p_size_bytes int
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if not core.mail_account_owned(p_account_id) then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_uid), '') = '' then
    raise exception 'uid bos olamaz' using errcode = '23514';
  end if;

  insert into core.mail_messages (
    account_id, owner_id, direction, folder, uid, uid_validity,
    message_id, in_reply_to, subject, from_addr, from_name,
    to_addrs, cc_addrs, sent_at, received_at, snippet, body_text, body_html,
    has_attachments, size_bytes)
  values (
    p_account_id, v_user, 'incoming', coalesce(nullif(btrim(p_folder), ''), 'INBOX'),
    btrim(p_uid), p_uid_validity,
    p_message_id, p_in_reply_to, p_subject, p_from_addr, p_from_name,
    coalesce(p_to_addrs, '{}'), coalesce(p_cc_addrs, '{}'),
    p_sent_at, coalesce(p_received_at, now()), p_snippet, p_body_text, p_body_html,
    coalesce(p_has_attachments, false), p_size_bytes)
  on conflict (account_id, uid) do nothing
  returning id into v_id;

  return v_id;  -- NULL => zaten vardi (idempotent)
end;
$$;

comment on function core.mail_message_ingest is
  'Cekilen gelen mesaji yazar. (account_id, uid) varsa hicbir sey yapmaz. '
  'Hesap oturumdaki kullaniciya ait degilse reddeder.';

-- -----------------------------------------------------------------------------
-- Yazma: giden mesaj kaydi (SMTP gonderiminden sonra)
-- -----------------------------------------------------------------------------
create or replace function core.mail_message_record_sent(
  p_account_id uuid,
  p_to_addrs   text[],
  p_cc_addrs   text[],
  p_subject    text,
  p_body_text  text,
  p_in_reply_to text,
  p_status     text,
  p_error      text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if not core.mail_account_owned(p_account_id) then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;
  if p_status not in ('sent', 'failed') then
    raise exception 'Gecersiz gonderim durumu: %', p_status using errcode = '23514';
  end if;

  insert into core.mail_messages (
    account_id, owner_id, direction, folder, uid,
    in_reply_to, subject, from_addr, to_addrs, cc_addrs,
    sent_at, received_at, snippet, body_text,
    send_status, send_error, sent_by)
  values (
    p_account_id, v_user, 'outgoing', 'SENT', 'out:' || gen_random_uuid()::text,
    p_in_reply_to, p_subject,
    (select email_address from core.mail_accounts where id = p_account_id),
    coalesce(p_to_addrs, '{}'), coalesce(p_cc_addrs, '{}'),
    now(), now(), left(coalesce(p_body_text, ''), 200), p_body_text,
    p_status, p_error, v_user)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function core.mail_message_record_sent is
  'Panelden gonderilen mesajin kaydi. Basarisiz gonderim de kaydedilir '
  '(send_status=failed) -- denetimde "neden gitmedi" cevabi kalsin.';

-- -----------------------------------------------------------------------------
-- Yazma: senkron durumu upsert + KVKK trim
-- -----------------------------------------------------------------------------
create or replace function core.mail_sync_state_set(
  p_account_id  uuid,
  p_uid_validity text,
  p_last_uid    bigint,
  p_error       text default null
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_user uuid := core.current_user_id();
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if not core.mail_account_owned(p_account_id) then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;

  insert into core.mail_sync_state (
    account_id, owner_id, uid_validity, last_uid,
    last_synced_at, last_error, last_error_at, message_count)
  values (
    p_account_id, v_user, p_uid_validity, coalesce(p_last_uid, 0),
    case when p_error is null then now() end,
    p_error,
    case when p_error is not null then now() end,
    (select count(*) from core.mail_messages
       where account_id = p_account_id and owner_id = v_user))
  on conflict (account_id) do update set
    uid_validity   = coalesce(excluded.uid_validity, core.mail_sync_state.uid_validity),
    last_uid       = greatest(core.mail_sync_state.last_uid, excluded.last_uid),
    last_synced_at = coalesce(excluded.last_synced_at, core.mail_sync_state.last_synced_at),
    last_error     = excluded.last_error,
    last_error_at  = excluded.last_error_at,
    message_count  = excluded.message_count;
end;
$$;

comment on function core.mail_sync_state_set(uuid, text, bigint, text) is
  'Hesap senkron ilerlemesini yazar. p_error verilirse last_error''a gecer, '
  'last_synced_at dokunulmaz. last_uid monoton artar.';

-- UIDVALIDITY degisince yerel mesajlari bosalt (sunucu UID''leri gecersiz).
create or replace function core.mail_sync_reset(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare v_user uuid := core.current_user_id();
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if not core.mail_account_owned(p_account_id) then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;
  delete from core.mail_messages
   where account_id = p_account_id and owner_id = v_user and direction = 'incoming';
  update core.mail_sync_state set last_uid = 0, message_count = (
    select count(*) from core.mail_messages
     where account_id = p_account_id and owner_id = v_user)
   where account_id = p_account_id and owner_id = v_user;
end;
$$;

-- KVKK saklama siniri: hesap basina en fazla mail_message_keep() gelen mesaj.
create or replace function core.mail_messages_trim(p_account_id uuid)
returns int
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_user uuid := core.current_user_id();
  v_deleted int;
begin
  if v_user is null then
    raise exception 'Oturum yok' using errcode = '42501';
  end if;
  if not core.mail_account_owned(p_account_id) then
    raise exception 'Mail hesabi bulunamadi' using errcode = 'P0002';
  end if;

  with keep as (
    select id from core.mail_messages
    where account_id = p_account_id and owner_id = v_user and direction = 'incoming'
    order by received_at desc, id
    limit core.mail_message_keep()
  ), gone as (
    delete from core.mail_messages m
    where m.account_id = p_account_id and m.owner_id = v_user
      and m.direction = 'incoming'
      and m.id not in (select id from keep)
    returning 1
  )
  select count(*)::int into v_deleted from gone;
  return coalesce(v_deleted, 0);
end;
$$;

comment on function core.mail_messages_trim(uuid) is
  'KVKK saklama siniri: hesap basina en eski gelen mesajlari mail_message_keep() '
  'adedin ustunde siler. Senkron sonrasi cagrilir. Giden mesaja dokunmaz.';

-- -----------------------------------------------------------------------------
-- Okuma: senkron durumu
-- -----------------------------------------------------------------------------
create or replace function core.mail_sync_state_get(p_account_id uuid)
returns table (
  account_id     uuid,
  uid_validity   text,
  last_uid       bigint,
  last_synced_at timestamptz,
  last_error     text,
  last_error_at  timestamptz,
  message_count  int
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select s.account_id, s.uid_validity, s.last_uid, s.last_synced_at,
         s.last_error, s.last_error_at, s.message_count
  from core.mail_sync_state s
  where s.account_id = p_account_id and s.owner_id = core.current_user_id();
$$;

-- 9999_apply_grants.sql en sonda calisir ve sezra_app'e core tablolarinda DML +
-- fonksiyonlarda EXECUTE verir; bu tablo/fonksiyonlar da kapsanir.
