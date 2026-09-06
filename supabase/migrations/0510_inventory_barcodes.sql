-- =============================================================================
-- 0510 — Barkod desteği  (Faz 2)
-- =============================================================================
-- Barkod AYRI BİR MODÜL DEĞİL, envanterin bir yeteneğidir. Kendi şeması, kendi
-- izin ağacı ve kendi kurulum kancası olan bir "modül" yapmak, tek bir tablo ve
-- üç fonksiyon için modül kayıt defterini şişirmek olurdu. Kiracı "barkod satın
-- almaz"; envanteri varsa barkodu da vardır.
--
-- NEDEN core.products.barcode YETMİYOR:
-- Bir ürünün birden fazla barkodu olur — tekli paket, koli, palet. Koli barkodu
-- okutulduğunda stok 1 değil 12 adet artmalıdır. Tek kolon bu çarpanı taşıyamaz.
-- core.products.barcode birincil (tekli) barkod olarak KALIYOR; buradaki tablo
-- onu genişletiyor.
-- =============================================================================

create table if not exists inventory.barcodes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  product_id   uuid not null references core.products(id) on delete cascade,
  code         text not null,
  -- Bu barkodun temsil ettiği miktar: tekli=1, koli=12, palet=480 gibi
  quantity     numeric(18,4) not null default 1 check (quantity > 0),
  uom_id       uuid references core.uoms(id),
  kind         text not null default 'unit' check (kind in ('unit', 'case', 'pallet', 'internal')),
  -- GTIN (EAN-13/EAN-8/UPC-A) ise kontrol hanesi doğrulanır. İşletmenin kendi
  -- iç kodları GTIN olmadığı için bu bir bayrak, zorunluluk değil.
  is_gtin      boolean not null default false,
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Bir barkod kiracı içinde TEK bir şeyi göstermelidir; aksi hâlde okutma
-- belirsizleşir ve depoda yanlış ürün sayılır.
create unique index if not exists ux_barcodes_code on inventory.barcodes (tenant_id, code);
create index if not exists ix_barcodes_product on inventory.barcodes (tenant_id, product_id);

-- -----------------------------------------------------------------------------
-- GTIN kontrol hanesi
-- -----------------------------------------------------------------------------
-- EAN-13/EAN-8/UPC-A'da son hane, önceki hanelerden hesaplanan kontrol hanesidir.
-- Elle giriş yapılan barkodlarda tek haneli yazım hatasını yakalamanın standart
-- yolu budur — okutucudan gelen kod zaten doğrudur, asıl fayda manuel girişte.
create or replace function inventory.is_valid_gtin(p_code text)
returns boolean
language plpgsql
immutable
as $$
declare
  v    text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  v_len integer;
  v_sum integer := 0;
  i     integer;
  v_dig integer;
  v_mul integer;
begin
  v_len := length(v);
  if v_len not in (8, 12, 13, 14) then
    return false;
  end if;

  -- Sağdan sola: kontrol hanesi hariç haneler dönüşümlü 3 ve 1 ile çarpılır
  for i in 1 .. v_len - 1 loop
    v_dig := substr(v, v_len - i, 1)::integer;
    v_mul := case when i % 2 = 1 then 3 else 1 end;
    v_sum := v_sum + v_dig * v_mul;
  end loop;

  return (10 - (v_sum % 10)) % 10 = substr(v, v_len, 1)::integer;
end;
$$;

create or replace function inventory.fn_validate_barcode()
returns trigger
language plpgsql
as $$
begin
  new.code := regexp_replace(coalesce(new.code, ''), '\s', '', 'g');
  if new.code = '' then
    raise exception 'Barkod boş olamaz' using errcode = '23514';
  end if;
  if new.is_gtin and not inventory.is_valid_gtin(new.code) then
    raise exception 'Geçersiz GTIN kontrol hanesi: %', new.code
      using errcode = '23514',
            hint = 'GTIN değilse is_gtin = false bırakın (iç kod olarak kaydedilir).';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_barcodes_validate on inventory.barcodes;
create trigger trg_barcodes_validate before insert or update on inventory.barcodes
  for each row execute function inventory.fn_validate_barcode();

-- -----------------------------------------------------------------------------
-- Barkod çözümleme
-- -----------------------------------------------------------------------------
-- Önce inventory.barcodes'a, bulunamazsa core.products.barcode'a bakar.
-- İkinci adım şart: mevcut ürün kataloğunda barkodlar zaten orada ve kullanıcı
-- onları buraya kopyalamak zorunda kalmamalı.
create or replace function inventory.resolve_barcode(p_code text)
returns table (
  product_id uuid, sku text, product_name text,
  multiplier numeric, uom_id uuid, barcode_kind text
)
language sql
stable
security definer
set search_path = inventory, core, pg_temp
as $$
  with normalized as (
    select regexp_replace(coalesce(p_code, ''), '\s', '', 'g') as code
  )
  select b.product_id, p.sku, p.name, b.quantity, coalesce(b.uom_id, p.uom_id), b.kind
  from inventory.barcodes b
  join core.products p on p.id = b.product_id
  cross join normalized n
  where b.tenant_id = core.current_tenant_id() and b.code = n.code and b.is_active

  union all

  select p.id, p.sku, p.name, 1::numeric, p.uom_id, 'unit'
  from core.products p
  cross join normalized n
  where p.tenant_id = core.current_tenant_id()
    and p.barcode = n.code
    and not exists (
      select 1 from inventory.barcodes b2
      where b2.tenant_id = p.tenant_id and b2.code = n.code and b2.is_active)

  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Okutarak sayım
-- -----------------------------------------------------------------------------
-- Depoda tablet/okutucuyla sayım: her okutma sayım satırını ARTIRIR.
-- Aynı ürün rafın iki farklı yerinde bulunabilir; ikinci okutma satırı sıfırlamaz,
-- üstüne ekler. Sistem miktarı satır İLK açıldığında dondurulur (0500'deki kural).
create or replace function inventory.scan_to_count(
  p_count_id uuid, p_barcode text, p_quantity numeric default 1, p_location_id uuid default null
)
returns inventory.count_lines
language plpgsql
security invoker
as $$
declare
  v_count inventory.counts;
  v_res   record;
  v_loc   uuid;
  v_line  inventory.count_lines;
  v_qty   numeric;
begin
  select * into v_count from inventory.counts where id = p_count_id;
  if not found then raise exception 'Sayım bulunamadı' using errcode = 'P0002'; end if;
  if v_count.status <> 'draft' then
    raise exception 'Uygulanmış sayıma okutma yapılamaz (%)', v_count.status using errcode = '23514';
  end if;

  select * into v_res from inventory.resolve_barcode(p_barcode);
  if v_res.product_id is null then
    raise exception 'Barkod tanınmadı: %', p_barcode
      using errcode = 'P0002',
            hint = 'Ürünü barkodla eşleştirmek için inventory.barcodes''a kaydedin.';
  end if;

  -- Konum verilmediyse deponun stok konumu
  v_loc := coalesce(p_location_id, (
    select l.id from inventory.locations l
     where l.warehouse_id = v_count.warehouse_id and l.kind = 'stock'
     order by l.code limit 1));
  if v_loc is null then
    raise exception 'Deponun stok konumu yok' using errcode = '22023';
  end if;

  v_qty := coalesce(p_quantity, 1) * v_res.multiplier;

  select * into v_line from inventory.count_lines
   where count_id = p_count_id and location_id = v_loc and product_id = v_res.product_id
     and lot_id is null
   for update;

  if found then
    update inventory.count_lines
       set counted_quantity = counted_quantity + v_qty
     where id = v_line.id returning * into v_line;
  else
    insert into inventory.count_lines (count_id, location_id, product_id,
                                       system_quantity, counted_quantity)
    values (p_count_id, v_loc, v_res.product_id,
            coalesce((select sum(q.quantity) from inventory.quants q
                       where q.location_id = v_loc and q.product_id = v_res.product_id), 0),
            v_qty)
    returning * into v_line;
  end if;

  return v_line;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS ve izinler
-- -----------------------------------------------------------------------------
select core.register_tenant_table('inventory', 'barcodes', 'inventory.barcode', false, false);
select core.declare_entity_permissions('inventory', 'barcode', 'Barkod', false);

select core.grant_module_to_role('tenant_admin', 'inventory');
select core.grant_to_role('warehouse', array[
  'inventory.barcode.read.all','inventory.barcode.write.all','inventory.barcode.create'
]);
select core.grant_to_role('branch_manager', array['inventory.barcode.read.all']);
select core.grant_to_role('sales',          array['inventory.barcode.read.all']);
select core.grant_to_role('readonly',       array['inventory.barcode.read.all']);
