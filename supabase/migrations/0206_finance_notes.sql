-- =============================================================================
-- 0206 — Çek / Senet portföyü
--
-- Türkiye'de vadeli ticaretin taşıyıcısı çek ve senettir; bir ERP'de "tahsilat"
-- tek başına yetmez, çünkü elde duran bir çek henüz PARA DEĞİLDİR ama alacak
-- da sayılmaz — kendi hayatı olan bir kıymetli evraktır.
--
-- TEK TABLO, İKİ TÜR: çek ve senet aynı yaşam döngüsünü yaşar (portföy →
-- tahsile ver → tahsil et / karşılıksız). Ayrı iki tablo, aynı durum
-- makinesini iki kez yazmak ve ikisinin zamanla ayrışması demekti. Türe özel
-- alanlar (banka, şube) senette boş kalır.
--
-- YÖN, TÜRDEN AYRI: alınan çek bir varlık, verilen çek bir borçtur. Aynı
-- tabloda `direction` ile ayrılırlar çünkü evrakın kendisi aynı şeydir; ayrı
-- tablolar, "bu çeki ciro ettim" gibi yön değiştiren işlemleri imkânsız
-- kılardı.
--
-- DURUM GEÇİŞLERİ FONKSİYONLA: statüyü serbest bir UPDATE'e bırakmak,
-- tahsil edilmiş bir çeki portföye geri döndürmeye izin vermek olurdu.
-- =============================================================================
set client_min_messages = warning;

create type finance.note_kind as enum ('cek', 'senet');
create type finance.note_direction as enum ('in', 'out');
create type finance.note_status as enum (
  'portfoy',          -- Elde / kasada
  'tahsile_verildi',  -- Bankaya tahsile gönderildi (yalnızca alınan)
  'ciro_edildi',      -- Üçüncü tarafa ciro edildi (yalnızca alınan)
  'tahsil_edildi',    -- Tahsil edildi / ödendi
  'karsiliksiz',      -- Karşılıksız çıktı
  'iade'              -- Keşideciye iade edildi
);

create table if not exists finance.notes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  branch_id     uuid references core.branches(id),
  kind          finance.note_kind not null,
  direction     finance.note_direction not null,
  status        finance.note_status not null default 'portfoy',
  -- Sistem numarası (SNT-2026-000001). Evrakın kendi seri numarası ayrı.
  number        text,
  -- Evrakın üzerindeki seri/numara. Çekte çek no, senette senet no.
  serial_no     text,
  partner_id    uuid references core.partners(id),
  -- Keşideci: çeki yazan. Genelde cari ile aynıdır ama ciro edilmiş bir
  -- çekte farklıdır ve o zaman asıl borçluyu bilmek gerekir.
  drawer_name   text,
  bank_name     text,
  bank_branch   text,
  bank_account  text,
  issue_place   text,
  issue_date    date not null default current_date,
  due_date      date not null,
  amount        numeric(18,2) not null check (amount > 0),
  currency      char(3) not null default 'TRY',
  -- Tahsile verildiğinde hangi bankaya: tahsil masrafı ve takibi buradan.
  bank_account_id uuid references finance.bank_accounts(id),
  -- Ciro edildiyse kime.
  endorsed_to_id  uuid references core.partners(id),
  -- Tahsil edildiğinde üretilen tahsilat kaydı.
  payment_id      uuid references finance.payments(id),
  status_at     timestamptz,
  notes         text,
  owner_id      uuid references core.users(id),
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ÇEK BANKASIZ OLMAZ: bir çekin bankası yoksa o çek değildir. Senette ise
  -- banka alanı boş kalır. Kontrolü şemaya koymak, arayüzün unutmasını
  -- imkânsız kılar.
  constraint notes_cek_banka check (kind <> 'cek' or bank_name is not null),
  -- Vade düzenleme tarihinden önce olamaz.
  constraint notes_vade check (due_date >= issue_date)
);

create index if not exists ix_notes_tenant   on finance.notes (tenant_id);
create index if not exists ix_notes_partner  on finance.notes (tenant_id, partner_id, due_date);
create index if not exists ix_notes_vade     on finance.notes (tenant_id, status, due_date)
  where status in ('portfoy', 'tahsile_verildi');
create unique index if not exists ux_notes_number
  on finance.notes (tenant_id, number) where number is not null;

select core.attach_updated_at('finance', 'notes');
select core.attach_row_defaults('finance', 'notes');
select core.attach_audit('finance', 'notes');

-- -----------------------------------------------------------------------------
-- Durum makinesi
-- -----------------------------------------------------------------------------
/**
 * İzin verilen geçişler.
 *
 * TEK YERDE TANIMLI: geçiş kuralı hem arayüzde hem uçta hem de burada
 * yazılsaydı üçü ayrışır ve en gevşek olanı geçerli olurdu.
 */
create or replace function finance.note_gecis_gecerli(
  p_direction finance.note_direction,
  p_from finance.note_status,
  p_to finance.note_status
) returns boolean
language sql immutable as $$
  select case
    -- ALINAN evrak: portföyde durur, bankaya verilir, ciro edilir ya da
    -- doğrudan tahsil edilir.
    when p_direction = 'in' then
      (p_from = 'portfoy'         and p_to in ('tahsile_verildi', 'ciro_edildi',
                                               'tahsil_edildi', 'iade'))
      or (p_from = 'tahsile_verildi' and p_to in ('tahsil_edildi', 'karsiliksiz', 'portfoy'))
      -- Karşılıksız çıkan çek portföye geri döner: takibe alınır ya da
      -- iade edilir. Bu, gerçek hayatta en sık yaşanan dönüştür.
      or (p_from = 'karsiliksiz'   and p_to in ('portfoy', 'iade', 'tahsil_edildi'))
    -- VERİLEN evrak: portföyden çıkar, ödenir ya da karşılıksız kalır.
    else
      (p_from = 'portfoy'      and p_to in ('tahsil_edildi', 'karsiliksiz', 'iade'))
      or (p_from = 'karsiliksiz' and p_to in ('portfoy', 'tahsil_edildi'))
  end;
$$;

/**
 * Çek/senedin durumunu değiştirir.
 *
 * `p_bank_account_id` yalnızca tahsile verme, `p_endorsed_to_id` yalnızca
 * ciro için anlamlıdır; ilgisiz alanlar yok sayılmaz, REDDEDİLİR — sessizce
 * yok saymak, kullanıcıya yaptığını sandığı şeyin olmadığını göstermez.
 */
create or replace function finance.note_set_status(
  p_id uuid,
  p_status finance.note_status,
  p_bank_account_id uuid default null,
  p_endorsed_to_id uuid default null,
  p_note text default null
) returns finance.notes
language plpgsql
security invoker
as $$
declare
  v_n finance.notes;
begin
  -- YETKİ ÖNCE, KİLİT SONRA.
  -- `select ... for update` RLS'in UPDATE politikasını da uygular: yazma
  -- yetkisi olmayan kullanıcı satırı KİLİTLEYEMEZ ve sorgu boş döner. Kontrol
  -- kilitten sonra yapılsaydı, evrakı görebilen ama değiştiremeyen bir
  -- kullanıcıya "çek bulunamadı" denirdi -- oysa çek duruyor, eksik olan
  -- yetki. İki durumu ayırmak, kullanıcının ne yapması gerektiğini söyler.
  if not core.has_perm('finance.note.write.all') then
    raise exception 'Çek/senet güncelleme yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_n from finance.notes where id = p_id for update;
  if not found then
    raise exception 'Çek/senet bulunamadı' using errcode = 'P0002';
  end if;

  if not finance.note_gecis_gecerli(v_n.direction, v_n.status, p_status) then
    raise exception '% durumundan % durumuna geçilemez', v_n.status, p_status
      using errcode = '23514';
  end if;

  if p_status = 'tahsile_verildi' and p_bank_account_id is null then
    raise exception 'Tahsile verirken banka hesabı seçilmelidir' using errcode = '23502';
  end if;
  if p_status = 'ciro_edildi' and p_endorsed_to_id is null then
    raise exception 'Ciro ederken devredilen cari seçilmelidir' using errcode = '23502';
  end if;
  if p_endorsed_to_id is not null and p_endorsed_to_id = v_n.partner_id then
    raise exception 'Evrak geldiği cariye ciro edilemez' using errcode = '23514';
  end if;

  update finance.notes set
    status          = p_status,
    status_at       = now(),
    bank_account_id = case when p_status = 'tahsile_verildi'
                           then p_bank_account_id else bank_account_id end,
    endorsed_to_id  = case when p_status = 'ciro_edildi'
                           then p_endorsed_to_id else endorsed_to_id end,
    notes           = case when p_note is null or btrim(p_note) = '' then notes
                           else concat_ws(E'\n', notes, p_note) end
  where id = p_id
  returning * into v_n;

  return v_n;
end;
$$;

/**
 * Numara verir: kayıt oluşturulurken tetiklenir.
 *
 * Çek ve senet AYRI SERİ kullanır; tek seri, "bu numara çek mi senet mi"
 * sorusunu evrakın kendisine bakmadan cevaplanamaz hâle getirirdi.
 */
create or replace function finance.fn_note_number()
returns trigger language plpgsql as $$
begin
  if new.number is null then
    new.number := core.next_sequence(
      case when new.kind = 'cek' then 'finance_cek' else 'finance_senet' end,
      new.branch_id);
  end if;
  return new;
end $$;

drop trigger if exists t_note_number on finance.notes;
create trigger t_note_number before insert on finance.notes
  for each row execute function finance.fn_note_number();

-- -----------------------------------------------------------------------------
-- Liste görünümü
-- -----------------------------------------------------------------------------
create or replace view finance.v_note_list
with (security_invoker = on) as
select n.*,
       p.name  as partner_name,
       e.name  as endorsed_to_name,
       b.name  as bank_account_name,
       br.name as branch_name,
       u.full_name as owner_name,
       -- Vadeye kalan gün: eksiyse vadesi geçmiş demektir. Portföyde duran
       -- ve vadesi geçmiş bir evrak, takibe alınması gereken şeydir.
       (n.due_date - current_date) as kalan_gun,
       (n.status in ('portfoy', 'tahsile_verildi') and n.due_date < current_date)
         as vadesi_gecti
from finance.notes n
left join core.partners p    on p.id = n.partner_id
left join core.partners e    on e.id = n.endorsed_to_id
left join finance.bank_accounts b on b.id = n.bank_account_id
left join core.branches br   on br.id = n.branch_id
left join core.users u       on u.id = n.owner_id;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table finance.notes enable row level security;
alter table finance.notes force row level security;

drop policy if exists p_notes_select on finance.notes;
create policy p_notes_select on finance.notes for select
  using (tenant_id = (select core.support_tenant_id())
         or (tenant_id = (select core.current_tenant_id())
             and (branch_id is null
                  or (select core.accessible_branch_ids()) @> array[branch_id])
             and (select core.has_perm('finance.note.read.all'))));

drop policy if exists p_notes_write on finance.notes;
create policy p_notes_write on finance.notes for all
  using (tenant_id = (select core.current_tenant_id())
         and (select core.has_perm('finance.note.write.all')))
  with check (tenant_id = (select core.current_tenant_id())
              and (select core.has_perm('finance.note.write.all')));

-- -----------------------------------------------------------------------------
-- İzinler ve numaralandırma
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('finance', 'note', 'Çek / senet');

-- MEVCUT kiracılar için tek seferlik dolgu. YENİ kiracılar seriyi
-- `finance.provision_finance` içinden alır (0202): burada `core.tenants`
-- üzerinden yapılan dolgu yalnızca migration anındaki kiracıları kapsar,
-- sonradan açılan kiracı serisiz kalır ve `next_sequence` her iki tür
-- için de 'FIN-' ön ekini türetip numaraları çakıştırırdı.
insert into core.sequences (tenant_id, code, prefix, padding, period)
select t.id, v.code, v.prefix, 6, 'year'
from core.tenants t
cross join (values ('finance_cek', 'CEK-'), ('finance_senet', 'SNT-')) as v(code, prefix)
on conflict do nothing;

comment on table finance.notes is
  'Çek/senet portföyü. Elde duran bir çek henüz para değildir; kendi durum '
  'makinesi olan bir kıymetli evraktır.';

-- -----------------------------------------------------------------------------
-- Rol eşlemesi
-- -----------------------------------------------------------------------------
-- 0202'deki `grant_module_to_role` bu izinler DAHA YOKKEN çalıştı; yeniden
-- çağrılmazsa yönetici kendi eklediği modülün ekranını göremez. Fonksiyon
-- ekleme yaptığı için tekrar çağrılması güvenli.
select core.grant_module_to_role('tenant_admin', 'finance');

-- Muhasebeci çek/senedi görür ve yönetir: portföy takibi muhasebenin işidir.
select core.grant_to_role('accounting', array[
  'finance.note.read.all', 'finance.note.write.all',
  'finance.note.create', 'finance.note.delete.all'
]);

-- Satış çeki GÖRÜR ama değiştiremez: müşterinin verdiği çekin durumu, satışın
-- tahsilat konuşmasında bilmesi gereken bir şey; ama evrakın durumunu
-- değiştirmek muhasebenin yetkisidir.
select core.grant_to_role('sales', array['finance.note.read.all']);
