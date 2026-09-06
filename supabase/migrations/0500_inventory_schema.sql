-- =============================================================================
-- 0500 — Envanter & Stok: şema  (Faz 2)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. STOK BİR BAKİYE DEĞİL, BİR DEFTERDİR.
--    inventory.moves tek gerçek kaynaktır; inventory.quants ondan TÜRETİLİR ve
--    tetikleyiciyle güncellenir. "Stok neden 7 değil de 5?" sorusu ancak
--    hareket defteri varsa yanıtlanabilir — muhasebedeki yevmiye mantığının
--    aynısı. Quants'ı doğrudan güncellemek yasaktır (RLS + tetikleyici engeli).
--
-- 2. DIŞ DÜNYA = NULL KONUM.
--    Tedarikçiden giriş: from_location_id null. Müşteriye çıkış:
--    to_location_id null. Böylece giriş, çıkış ve transfer TEK tablo ve TEK
--    mantıkla ifade edilir; üç ayrı hareket tipi ve üç ayrı kod yolu olmaz.
--
-- 3. MALİYET HAREKETİN ÜZERİNDE TAŞINIR.
--    Hareketli ortalama maliyet, giriş anında hesaplanıp harekete YAZILIR.
--    Sonradan yeniden hesaplanmaz: geçmiş bir çıkışın maliyeti, o an geçerli
--    olan ortalamadır. Aksi hâlde yeni bir alış, kapanmış ayın kâr/zararını
--    geriye dönük değiştirirdi.
--
-- 4. LOT/SKT, raf ömrü olan her sektörde zorunlu.
--    Üretim tarihi ve son kullanma tarihi takip edilmezse
--    FEFO (önce son kullanma tarihi gelen çıkar) uygulanamaz.
-- =============================================================================

-- Modül kendi şemasını kendi migration'ında açar (Faz 2 modülü; 0001 yalnızca
-- Faz 1 şemalarını kurar). Yetkiler 9999'da core.apply_grants() ile veriliyor;
-- o fonksiyon şema listesini core.modules'tan türettiği için ek iş gerekmiyor.
create schema if not exists inventory;

select core.register_module('inventory', 'Envanter & Stok', 2::smallint, '{core}', false,
       'Depo, stok hareketleri, lot/SKT takibi, sayım, yeniden sipariş uyarıları');

-- Faz 2 modülü: Büyüme ve Kurumsal paketlere dahil
insert into core.plan_modules (plan_code, module_code) values
  ('buyume', 'inventory'), ('kurumsal', 'inventory')
on conflict do nothing;

do $$ begin
  create type inventory.move_state as enum ('draft', 'done', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type inventory.location_kind as enum ('stock', 'production', 'scrap', 'transit');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Depolar ve konumlar
-- -----------------------------------------------------------------------------
create table if not exists inventory.warehouses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references core.tenants(id) on delete cascade,
  branch_id   uuid references core.branches(id) on delete set null,
  code        text not null,
  name        text not null,
  address     text,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_by  uuid references core.users(id),
  updated_by  uuid references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_warehouses_code on inventory.warehouses (tenant_id, code);
-- Şube başına tek varsayılan depo
create unique index if not exists ux_warehouses_default
  on inventory.warehouses (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default;

create table if not exists inventory.locations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  warehouse_id  uuid not null references inventory.warehouses(id) on delete cascade,
  parent_id     uuid references inventory.locations(id) on delete set null,
  code          text not null,
  name          text not null,
  kind          inventory.location_kind not null default 'stock',
  is_active     boolean not null default true,
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_locations_code on inventory.locations (tenant_id, code);
create index if not exists ix_locations_warehouse on inventory.locations (tenant_id, warehouse_id);

-- -----------------------------------------------------------------------------
-- Lot / parti ve son kullanma tarihi
-- -----------------------------------------------------------------------------
create table if not exists inventory.lots (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  product_id      uuid not null references core.products(id) on delete cascade,
  code            text not null,                     -- parti/lot numarası
  production_date date,                              -- kavurma/üretim tarihi
  expiry_date     date,                              -- SKT
  supplier_lot    text,
  notes           text,
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists ux_lots_code on inventory.lots (tenant_id, product_id, code);
create index if not exists ix_lots_expiry
  on inventory.lots (tenant_id, expiry_date) where expiry_date is not null;

-- -----------------------------------------------------------------------------
-- Stok hareketleri — tek gerçek kaynak
-- -----------------------------------------------------------------------------
create table if not exists inventory.moves (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  branch_id        uuid references core.branches(id) on delete set null,
  number           text,
  product_id       uuid not null references core.products(id),
  lot_id           uuid references inventory.lots(id) on delete set null,
  -- NULL = dış dünya (tedarikçi girişi / müşteri çıkışı)
  from_location_id uuid references inventory.locations(id),
  to_location_id   uuid references inventory.locations(id),
  quantity         numeric(18,4) not null check (quantity > 0),
  uom_id           uuid references core.uoms(id),
  -- Birim maliyet: girişte fiili alış fiyatı, çıkışta o anki hareketli ortalama
  unit_cost        numeric(18,4) not null default 0,
  total_cost       numeric(18,2) not null default 0,
  move_date        timestamptz not null default now(),
  state            inventory.move_state not null default 'draft',
  reference        text,
  -- Hareketi doğuran belge — modüller arası bağ (modül, tablo, id) üçlüsüyle
  source_module    text,
  source_table     text,
  source_id        uuid,
  notes            text,
  -- TASLAK çıkış hareketi = REZERVASYON.
  -- Satış siparişi onaylandığında mal henüz çıkmaz; söz verilir. Bu bayrak,
  -- hareketin quants.reserved'ı da tuttuğunu ve sevkiyatta (post_move) onu
  -- serbest bırakması gerektiğini işaretler.
  reserves_stock   boolean not null default false,
  owner_id         uuid references core.users(id),
  created_by       uuid references core.users(id),
  updated_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Bir hareket ya girer, ya çıkar, ya transfer eder; ikisi birden null olamaz
  constraint ck_moves_has_side check (from_location_id is not null or to_location_id is not null),
  constraint ck_moves_not_same check (from_location_id is distinct from to_location_id)
);

create index if not exists ix_moves_product
  on inventory.moves (tenant_id, product_id, move_date desc);
create index if not exists ix_moves_source
  on inventory.moves (tenant_id, source_module, source_table, source_id);
create index if not exists ix_moves_state on inventory.moves (tenant_id, state) where state = 'draft';

-- -----------------------------------------------------------------------------
-- Anlık bakiyeler (türetilmiş)
-- -----------------------------------------------------------------------------
-- moves'tan tetikleyiciyle üretilir. Her sorguda hareketleri toplamak, ürün
-- sayısı büyüdükçe stok ekranını kullanılamaz hâle getirirdi.
create table if not exists inventory.quants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  location_id   uuid not null references inventory.locations(id) on delete cascade,
  product_id    uuid not null references core.products(id) on delete cascade,
  lot_id        uuid references inventory.lots(id) on delete cascade,
  quantity      numeric(18,4) not null default 0,
  -- Onaylanmış ama henüz sevk edilmemiş siparişler için ayrılan miktar
  reserved      numeric(18,4) not null default 0,
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_quants_slot
  on inventory.quants (tenant_id, location_id, product_id,
                       coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists ix_quants_product on inventory.quants (tenant_id, product_id);

-- -----------------------------------------------------------------------------
-- Ürün maliyeti (hareketli ortalama)
-- -----------------------------------------------------------------------------
create table if not exists inventory.product_costs (
  tenant_id        uuid not null references core.tenants(id) on delete cascade,
  product_id       uuid not null references core.products(id) on delete cascade,
  average_cost     numeric(18,4) not null default 0,
  quantity_on_hand numeric(18,4) not null default 0,
  total_value      numeric(18,2) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, product_id)
);

-- -----------------------------------------------------------------------------
-- Yeniden sipariş kuralları (minimum stok uyarısı — Bölüm 3.2)
-- -----------------------------------------------------------------------------
create table if not exists inventory.reorder_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  branch_id     uuid references core.branches(id) on delete set null,
  product_id    uuid not null references core.products(id) on delete cascade,
  warehouse_id  uuid references inventory.warehouses(id) on delete cascade,
  min_quantity  numeric(18,4) not null default 0,
  max_quantity  numeric(18,4),
  is_active     boolean not null default true,
  last_alert_at timestamptz,                        -- aynı uyarıyı her dakika yollamamak için
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_reorder_rules
  on inventory.reorder_rules (tenant_id, product_id,
                              coalesce(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- -----------------------------------------------------------------------------
-- Sayım (envanter düzeltmesi)
-- -----------------------------------------------------------------------------
create table if not exists inventory.counts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  branch_id     uuid references core.branches(id) on delete set null,
  number        text,
  warehouse_id  uuid not null references inventory.warehouses(id),
  count_date    date not null default current_date,
  status        text not null default 'draft' check (status in ('draft', 'applied', 'cancelled')),
  notes         text,
  applied_at    timestamptz,
  owner_id      uuid references core.users(id),
  created_by    uuid references core.users(id),
  updated_by    uuid references core.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_counts_number
  on inventory.counts (tenant_id, number) where number is not null;

create table if not exists inventory.count_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  count_id       uuid not null references inventory.counts(id) on delete cascade,
  location_id    uuid not null references inventory.locations(id),
  product_id     uuid not null references core.products(id),
  lot_id         uuid references inventory.lots(id),
  -- Sistemdeki miktar, sayım anında dondurulur: sayım sürerken stok hareket
  -- ederse fark yanlış hesaplanmasın.
  system_quantity numeric(18,4) not null default 0,
  counted_quantity numeric(18,4) not null default 0,
  difference     numeric(18,4) generated always as (counted_quantity - system_quantity) stored,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_count_lines_doc on inventory.count_lines (tenant_id, count_id);
