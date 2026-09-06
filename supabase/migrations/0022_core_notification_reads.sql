-- =============================================================================
-- 0022 — Bildirim okundu işaretleri
--
-- BİLDİRİMLER SAKLANMIYOR, TÜRETİLİYOR. Vadesi geçen fatura, kritik seviyeye
-- düşen stok, onay bekleyen izin: hepsi zaten veritabanında duran gerçeklerdir.
-- Bunları ayrıca bir "notifications" tablosuna kopyalamak iki doğruluk kaynağı
-- yaratır ve ikisi kaçınılmaz olarak ayrışır — fatura tahsil edilir ama
-- bildirim orada durur.
--
-- Saklanması gereken TEK şey, kullanıcının neyi GÖRDÜĞÜdür. Bu tablo yalnızca
-- onu tutar: (kullanıcı, bildirim anahtarı) çifti.
--
-- ANAHTAR KAYNAK TARAFINDAN ÜRETİLİR ve kaydın kimliğini içerir
-- ("finance.invoice.overdue:<id>"). Böylece bir fatura okundu işaretlendikten
-- sonra ödenip yeniden gecikirse anahtar aynı kalır ve kullanıcı onu tekrar
-- görmez. Bu bilinçli: aynı kayıt için ikinci kez uyarmak, kullanıcının
-- bildirim listesine olan güvenini bitiriyor.
-- =============================================================================
set client_min_messages = warning;

create table if not exists core.notification_reads (
  tenant_id  uuid not null references core.tenants(id) on delete cascade,
  user_id    uuid not null references core.users(id) on delete cascade,
  -- Kaynak + kayıt kimliğinden oluşan kararlı anahtar.
  key        text not null,
  read_at    timestamptz not null default now(),
  primary key (tenant_id, user_id, key)
);

create index if not exists ix_notification_reads_user
  on core.notification_reads (tenant_id, user_id);

alter table core.notification_reads enable row level security;
alter table core.notification_reads force row level security;

-- KULLANICI YALNIZCA KENDİ İŞARETİNİ GÖRÜR VE YAZAR.
-- Şirket yöneticisi bile başkasının okundu bilgisini değiştirememeli:
-- bu, iş verisi değil o kişinin kendi arayüz durumudur.
drop policy if exists p_notification_reads_own on core.notification_reads;
create policy p_notification_reads_own on core.notification_reads for all
  using (
    tenant_id = (select core.current_tenant_id())
    and user_id = (select core.current_user_id())
  )
  with check (
    tenant_id = (select core.current_tenant_id())
    and user_id = (select core.current_user_id())
  );

/**
 * Bildirimi okundu işaretler.
 *
 * `on conflict do nothing`: aynı bildirimi iki kez okundu işaretlemek hata
 * değil, sıradan bir tekrar. Kullanıcı iki sekmede aynı anda okuyabilir.
 */
create or replace function core.notification_mark_read(p_keys text[])
returns integer
language plpgsql
security invoker
as $$
declare
  v_tenant uuid := core.current_tenant_id();
  v_user   uuid := core.current_user_id();
  v_sayi   integer;
begin
  if v_tenant is null or v_user is null then
    raise exception 'Kiracı bağlamı yok' using errcode = '42501';
  end if;

  insert into core.notification_reads (tenant_id, user_id, key)
  select v_tenant, v_user, k
  from unnest(coalesce(p_keys, '{}'::text[])) as k
  where k is not null and btrim(k) <> ''
  on conflict do nothing;

  get diagnostics v_sayi = row_count;
  return v_sayi;
end;
$$;

comment on table core.notification_reads is
  'Türetilmiş bildirimlerin kullanıcı bazında okundu işaretleri. Bildirimin '
  'kendisi saklanmaz; kaynak veriden hesaplanır.';
