-- =============================================================================
-- 1200 -- CRM "aninda satis" belge tipi (FAZ 3.1 -- T-034)
-- =============================================================================
-- BAGLAM (T-032 bosluk analizi, kritik bulgu 1):
--   Mevcut satis akisi (crm.confirm_sale_order) ATOMIK DEGIL: siparis onayi
--   yalnizca durumu degistirir ve bir olay yayinlar. Stok REZERVE edilir
--   (sevkiyatta duser), fatura TASLAK kalir (manuel finance.post_invoice
--   gerekir). Bu tasarimin kendi ic mantigi var (transactional outbox,
--   idempotent event handler'lar) ve DEGISMIYOR -- testleri gecmeye devam eder.
--
-- BU MIGRATION insanin sectigi HIBRIT cozumu ekler: AYRI bir belge tipi
-- ("aninda satis" / perakende-tezgah satisi). Bu belge ONAYLANDIGINDA, TEK
-- transaction icinde:
--   1. stoklu her satir icin ANINDA stok cikisi (rezervasyon degil),
--   2. satis faturasi olusur ve HEMEN muhasebelesir -> 120 ALICILAR borc
--      (cari alacak yapisal olarak ayni islemde dogar),
--   3. istege bagli PESIN tahsilat ayni transaction'da kapatilir.
-- Herhangi bir adim patlarsa (ornegin yetersiz stok) hicbir sey yazilmaz.
--
-- MIMARI NOT -- BILINCLI KAPSAM DISI SAPMA:
--   CRM normalde Muhasebe'ye yalnizca OLAYLA baglanir (0100 basligi). Olaylar
--   dogasi geregi ASENKRON (core.dispatch_events / pg_notify worker). "Tek
--   transaction'da kesin sonuc" olayla saglanamaz. Bu yuzden crm.confirm_
--   instant_sale, finance.post_invoice ve inventory.deliver_stock'u DOGRUDAN
--   cagirir. Bu kuplaj SADECE bu belge tipine ozgudur ve insan tarafindan
--   acikca istenmistir. Sert FK (crm -> finance) yine de KURULMAZ: invoice_id
--   gevsek referanstir (pos.terminals.warehouse_id ile ayni gerekce), modul
--   bagimsizligi korunur. Ters yon zaten finance.invoices.source_* ile bagli.
--
-- GUVENLIK / KURALLAR:
--   - Tum para kolonlari numeric(18,2); float yok.
--   - Silme YOK: iptal = durum degisikligi. Onaylanmis belge iptal edilemez;
--     duzeltme iade fisiyle yapilir (CRM iade akisi = T-035, ayri kart).
--   - RBAC: yeni izin eylemi crm.instant_sale.confirm. Ayrica cagiranin
--     finance.invoice.post (+ pesin tahsilatta finance.payment.post) izni
--     olmalidir -- alttaki fonksiyonlar kendi kapilarini korur. Bu yuzden
--     confirm izni yalnizca bu finans izinlerini zaten tasiyan rollere
--     verilir (tenant_admin, accounting). Tezgah personeli icin ayri bir
--     rol tasarimi bu kartin disindadir.
--   - Genel core.attach_audit baslik ve satirlarda otomatik; onay ayrica
--     crm.instant_sale.confirmed olayi yayar (raporlama/entegrasyon icin).
-- =============================================================================
set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- Belge basligi
-- -----------------------------------------------------------------------------
create table if not exists crm.instant_sales (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  -- Cari ZORUNLU: alacak kaydi bir cariye yazilir (walk-in senaryosu POS'un
  -- isidir, orada partner_id null olabilir).
  partner_id        uuid not null references core.partners(id),
  sale_date         date not null default current_date,
  status            text not null default 'draft'
                      check (status in ('draft', 'confirmed', 'cancelled')),
  currency          char(3) not null default 'TRY',
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  withholding_total numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  paid_total        numeric(18,2) not null default 0,
  -- 'none' = onay sirasinda pesin tahsilat yapilmadi (vadeli).
  payment_method    text not null default 'none'
                      check (payment_method in ('none', 'cash', 'bank', 'card')),
  notes             text,
  -- finance.invoices(id) -- FK YOK (modul bagimsizligi; bkz. dosya basligi).
  invoice_id        uuid,
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ux_instant_sales_number
  on crm.instant_sales (tenant_id, number) where number is not null;
create index if not exists ix_instant_sales_partner
  on crm.instant_sales (tenant_id, partner_id, sale_date desc);
create index if not exists ix_instant_sales_status
  on crm.instant_sales (tenant_id, status, sale_date desc);

-- -----------------------------------------------------------------------------
-- Belge satirlari
-- -----------------------------------------------------------------------------
create table if not exists crm.instant_sale_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  instant_sale_id  uuid not null references crm.instant_sales(id) on delete cascade,
  sequence         smallint not null default 10,
  product_id       uuid references core.products(id),
  description      text not null,
  quantity         numeric(18,4) not null default 1 check (quantity > 0),
  uom_id           uuid references core.uoms(id),
  unit_price       numeric(18,4) not null default 0,
  discount_pct     numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id           uuid references core.taxes(id),
  line_subtotal    numeric(18,2) not null default 0,
  line_tax         numeric(18,2) not null default 0,
  line_withholding numeric(18,2) not null default 0,
  line_total       numeric(18,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ix_instant_sale_lines_doc
  on crm.instant_sale_lines (tenant_id, instant_sale_id, sequence);

-- Satir matematigi (teklif/siparis/fatura ile birebir ayni motor).
select core.attach_document_line_math('crm', 'instant_sale_lines',
                                      'crm.instant_sales', 'instant_sale_id');

-- Onaylanmis/iptal edilmis belgenin satirlari degismez.
create or replace function crm.fn_lock_instant_sale_lines()
returns trigger
language plpgsql
as $$
declare v_status text;
begin
  select status into v_status from crm.instant_sales
   where id = coalesce(
     (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'instant_sale_id')::uuid);
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Kilitli aninda satis (% durumunda) satirlari degistirilemez', v_status
      using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_instant_sale_lines_lock on crm.instant_sale_lines;
create trigger trg_instant_sale_lines_lock
  before insert or update or delete on crm.instant_sale_lines
  for each row execute function crm.fn_lock_instant_sale_lines();

-- -----------------------------------------------------------------------------
-- RLS -- baslik standart kiraci/sube/sahip; satir yetkiyi basliktan devralir
-- -----------------------------------------------------------------------------
select core.register_tenant_table('crm', 'instant_sales', 'crm.instant_sale', true, true);

do $$
begin
  execute 'alter table crm.instant_sale_lines enable row level security';
  execute 'alter table crm.instant_sale_lines force row level security';
  execute 'drop policy if exists p_instant_sale_lines_all on crm.instant_sale_lines';
  execute $p$create policy p_instant_sale_lines_all on crm.instant_sale_lines for all
      using (exists (select 1 from crm.instant_sales h where h.id = instant_sale_id))
      with check (exists (select 1 from crm.instant_sales h where h.id = instant_sale_id))$p$;
  execute 'create index if not exists ix_instant_sale_lines_tenant on crm.instant_sale_lines (tenant_id)';
  perform core.attach_updated_at('crm', 'instant_sale_lines');
  perform core.attach_row_defaults('crm', 'instant_sale_lines');
  perform core.attach_audit('crm', 'instant_sale_lines');
end $$;

-- -----------------------------------------------------------------------------
-- ATOMIK ONAY -- tek transaction: stok cikisi + fatura + cari alacak (+ tahsilat)
-- -----------------------------------------------------------------------------
create or replace function crm.confirm_instant_sale(
  p_id              uuid,
  p_pay             boolean default false,
  p_payment_method  text    default 'cash',
  p_bank_account_id uuid    default null
)
returns crm.instant_sales
language plpgsql
security invoker
as $$
declare
  v_sale       crm.instant_sales;
  v_invoice    finance.invoices;
  v_invoice_id uuid;
  v_line       record;
  v_seq        smallint := 10;
  v_income     uuid;
begin
  if not core.has_perm('crm.instant_sale.confirm') then
    raise exception 'Aninda satis onaylama yetkiniz yok' using errcode = '42501';
  end if;
  if p_pay and coalesce(p_payment_method, 'none') not in ('cash', 'bank', 'card') then
    raise exception 'Gecersiz odeme yontemi: %', p_payment_method using errcode = '22023';
  end if;

  select * into v_sale from crm.instant_sales where id = p_id for update;
  if not found then raise exception 'Aninda satis bulunamadi' using errcode = 'P0002'; end if;
  if v_sale.status <> 'draft' then
    raise exception 'Yalnizca taslak aninda satis onaylanabilir (mevcut: %)', v_sale.status
      using errcode = '23514';
  end if;
  if not exists (select 1 from crm.instant_sale_lines where instant_sale_id = p_id) then
    raise exception 'Satiri olmayan aninda satis onaylanamaz' using errcode = '23514';
  end if;

  -- (a) Belge numarasi + durum
  update crm.instant_sales
     set status = 'confirmed', confirmed_at = now(),
         number = coalesce(number, core.next_sequence('crm_instant_sale', branch_id))
   where id = p_id
   returning * into v_sale;

  -- (b) Fatura basligi (taslak) -- kaynak belge: aninda satis
  insert into finance.invoices (
    tenant_id, branch_id, kind, partner_id, issue_date, due_date, status, currency,
    payment_term_days, source_module, source_table, source_id, notes, owner_id
  ) values (
    v_sale.tenant_id, v_sale.branch_id, 'sale', v_sale.partner_id, v_sale.sale_date,
    v_sale.sale_date, 'draft', v_sale.currency, 0,
    'crm', 'instant_sales', v_sale.id,
    'Aninda satis ' || coalesce(v_sale.number, '') || ' -- tek islemde stok + cari + fatura',
    v_sale.owner_id
  ) returning id into v_invoice_id;

  v_income := finance.mapped_account('sales_income', v_sale.tenant_id);

  -- (c) Fatura satirlari + stoklu satirlarda ANINDA stok cikisi.
  --     Yetersiz stokta inventory.post_move '23514' ile patlar -> her sey geri alinir.
  for v_line in
    select l.*, p.kind as product_kind
    from crm.instant_sale_lines l
    left join core.products p on p.id = l.product_id
    where l.instant_sale_id = p_id
    order by l.sequence
  loop
    insert into finance.invoice_lines (
      tenant_id, invoice_id, sequence, product_id, account_id, description,
      quantity, uom_id, unit_price, discount_pct, tax_id
    ) values (
      v_sale.tenant_id, v_invoice_id, v_seq, v_line.product_id, v_income, v_line.description,
      v_line.quantity, v_line.uom_id, v_line.unit_price, v_line.discount_pct, v_line.tax_id
    );
    v_seq := v_seq + 10;

    if v_line.product_kind = 'stockable' and v_line.product_id is not null then
      perform inventory.deliver_stock(
        v_sale.tenant_id, v_sale.branch_id, v_line.product_id, v_line.quantity,
        'crm', 'instant_sales', v_sale.id, coalesce(v_sale.number, ''));
    end if;
  end loop;

  -- (d) Faturayi ANINDA muhasebelestir -> 120 ALICILAR borc = cari alacak
  select * into v_invoice from finance.post_invoice(v_invoice_id);

  -- (e) Istege bagli pesin tahsilat (ayni transaction)
  if p_pay then
    perform finance.register_payment(
      v_invoice_id, v_invoice.total, v_sale.sale_date,
      p_payment_method, p_bank_account_id, v_sale.number);
  end if;

  -- (f) Basligi faturaya bagla + odeme durumunu yansit
  update crm.instant_sales
     set invoice_id     = v_invoice_id,
         paid_total     = (select paid_total from finance.invoices where id = v_invoice_id),
         payment_method = case when p_pay then p_payment_method else 'none' end
   where id = p_id
   returning * into v_sale;

  -- (g) Bilgi olayi -- cekirdek akis zaten senkron tamamlandi
  perform core.emit_event('crm.instant_sale.confirmed', jsonb_build_object(
    'instant_sale_id', v_sale.id, 'number', v_sale.number, 'partner_id', v_sale.partner_id,
    'invoice_id', v_invoice_id, 'total', v_sale.total, 'paid', p_pay
  ), v_sale.branch_id, null, v_sale.tenant_id);

  return v_sale;
end;
$$;

comment on function crm.confirm_instant_sale(uuid, boolean, text, uuid) is
  'Aninda satis belgesini TEK transaction icinde onaylar: stok cikisi + satis '
  'faturasi (muhasebelesmis) + cari alacak, istege bagli pesin tahsilat. Herhangi '
  'bir adim patlarsa hicbir sey yazilmaz. Mevcut crm.confirm_sale_order akisina dokunmaz.';

-- -----------------------------------------------------------------------------
-- IPTAL -- silme yok. Taslak iptal edilir; onaylanmis belge iade fisi ister.
-- -----------------------------------------------------------------------------
create or replace function crm.cancel_instant_sale(p_id uuid, p_reason text default null)
returns crm.instant_sales
language plpgsql
security invoker
as $$
declare v_sale crm.instant_sales;
begin
  if not core.has_perm('crm.instant_sale.confirm') then
    raise exception 'Aninda satis iptal yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_sale from crm.instant_sales where id = p_id for update;
  if not found then raise exception 'Aninda satis bulunamadi' using errcode = 'P0002'; end if;
  if v_sale.status = 'confirmed' then
    raise exception 'Onaylanmis aninda satis iptal edilemez; stok ve cari kaydi '
      'geri almak icin iade fisi kesilmelidir'
      using errcode = '23514';
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'Aninda satis zaten iptal edilmis' using errcode = '23514';
  end if;

  update crm.instant_sales
     set status = 'cancelled', cancelled_at = now(),
         notes = coalesce(notes, '')
                 || case when p_reason is null then '' else E'\niptal: ' || p_reason end
   where id = p_id
   returning * into v_sale;
  return v_sale;
end;
$$;

-- -----------------------------------------------------------------------------
-- Liste gorunumu (readFrom)
-- -----------------------------------------------------------------------------
create or replace view crm.v_instant_sale_list
with (security_invoker = on) as
select s.*,
       p.name      as partner_name,
       p.tax_no,
       u.full_name as owner_name,
       b.name      as branch_name,
       (select count(*) from crm.instant_sale_lines sl where sl.instant_sale_id = s.id) as line_count
from crm.instant_sales s
left join core.partners p on p.id = s.partner_id
left join core.users u on u.id = s.owner_id
left join core.branches b on b.id = s.branch_id;

-- -----------------------------------------------------------------------------
-- Olay tipi
-- -----------------------------------------------------------------------------
select core.declare_event('crm.instant_sale.confirmed', 'crm',
  'Aninda satis onaylandi -- stok, cari alacak ve fatura tek islemde islendi',
  '{"instant_sale_id":"uuid","invoice_id":"uuid","partner_id":"uuid","total":"numeric","paid":"boolean"}'::jsonb);

-- -----------------------------------------------------------------------------
-- Izinler ve roller
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('crm', 'instant_sale', 'Aninda satis');
select core.declare_permission('crm.instant_sale.confirm', 'crm', 'crm.instant_sale', 'approve',
  'Aninda satis belgesini onayla / iptal et (stok + cari + fatura tek islem)');

-- tenant_admin: modul geneli -- yeni izinleri de kapsamak icin yeniden cagrilir.
select core.grant_module_to_role('tenant_admin', 'crm');

-- accounting: onaylayabilir (finance.invoice.post / payment.post izinleri zaten var).
select core.grant_to_role('accounting', array[
  'crm.instant_sale.read.all', 'crm.instant_sale.create',
  'crm.instant_sale.write.all', 'crm.instant_sale.confirm'
]);

-- branch_manager / sales: taslak hazirlar (onay finans izni tasiyan role birakildi).
select core.grant_to_role('branch_manager', array[
  'crm.instant_sale.read.all', 'crm.instant_sale.write.all', 'crm.instant_sale.create'
]);
select core.grant_to_role('sales', array[
  'crm.instant_sale.read.own', 'crm.instant_sale.write.own', 'crm.instant_sale.create'
]);
select core.grant_to_role('readonly', array['crm.instant_sale.read.all']);

-- -----------------------------------------------------------------------------
-- Belge numarasi serisi -- ASF- (Aninda Satis Fisi)
-- -----------------------------------------------------------------------------
-- Yeni kiraci: ek kurulum kancasi.
create or replace function crm.provision_crm_instant_sale(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = crm, core, pg_temp
as $$
begin
  insert into core.sequences (tenant_id, code, prefix, padding, period)
  values (p_tenant_id, 'crm_instant_sale', 'ASF-', 5, 'year')
  on conflict do nothing;
end;
$$;
select core.register_provisioner('crm', 'crm.provision_crm_instant_sale', 21::smallint);

-- Mevcut kiracilar icin geri doldur.
insert into core.sequences (tenant_id, code, prefix, padding, period)
select t.id, 'crm_instant_sale', 'ASF-', 5, 'year'
from core.tenants t
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Yetkileri yeniden uygula (yeni tablolar sezra_app'e DML kazanir)
-- -----------------------------------------------------------------------------
select core.apply_grants();
