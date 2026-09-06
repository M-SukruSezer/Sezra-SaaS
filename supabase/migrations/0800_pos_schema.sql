-- =============================================================================
-- 0800 — Satış Noktası (POS): şema  (Faz 3)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. FİŞİN KİMLİĞİNİ KASA ÜRETİR, SUNUCU DEĞİL.
--    Kasa internetsiz çalışabilmelidir. Bu yüzden fiş id'si (uuid) CİHAZDA
--    üretilir ve senkronizasyon idempotenttir: aynı fiş yüz kez gönderilse de
--    tek satır olur. Sunucunun sıra numarası üretmesini beklemek, offline
--    çalışmayı en baştan imkânsız kılardı.
--
-- 2. POS SATIŞI STOKU HEMEN DÜŞÜRÜR — REZERVE ETMEZ.
--    Satış siparişinde mal sonra sevk edilir, o yüzden rezervasyon yapıyoruz
--    (0503). Kasada müşteri malı alıp çıkar; rezervasyon diye bir aşama yoktur.
--    İki modülün aynı olaya farklı tepki vermesi tutarsızlık değil, iki farklı
--    ticari gerçeğin doğru modellenmesidir.
--
-- 3. FİYAT VE VERGİ SATIŞ ANINDA DONDURULUR.
--    Satır, ürünün o anki fiyatını ve KDV oranını KOPYALAYARAK saklar. Zam
--    yapıldığında dünkü fişler yeniden hesaplanmaz. (Bordroda, kalitede ve
--    stok maliyetinde uyguladığımız aynı ilke.)
--
-- 4. KASA OTURUMU (Z RAPORU) BİR BELGEDİR.
--    Açılış bakiyesi, beklenen nakit ve sayılan nakit ayrı ayrı saklanır; fark
--    hesaplanır ve GİZLENMEZ. Kasa farkını görünür kılmayan bir POS, kasiyer
--    açığını aylar sonra fark ettirir.
-- =============================================================================

create schema if not exists pos;

select core.register_module('pos', 'Satış Noktası', 3::smallint, '{core}', false,
       'Kasa terminalleri, fiş satışı, çoklu ödeme, kasa oturumu ve Z raporu');

insert into core.plan_modules (plan_code, module_code) values
  ('buyume', 'pos'), ('kurumsal', 'pos')
on conflict do nothing;

do $$ begin
  create type pos.session_status as enum ('open', 'closing', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pos.order_status as enum ('draft', 'paid', 'refunded', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pos.payment_method as enum ('cash', 'card', 'meal_card', 'transfer', 'voucher', 'other');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Kasa terminalleri
-- -----------------------------------------------------------------------------
create table if not exists pos.terminals (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenants(id) on delete cascade,
  branch_id       uuid not null references core.branches(id) on delete cascade,
  code            text not null,
  name            text not null,
  -- Hangi depodan düşecek: şubenin stok konumu
  warehouse_id    uuid,                                -- inventory.warehouses; FK YOK
  -- Cihaz eşleştirme anahtarı (kasa uygulaması bunu taşır)
  device_key      text,
  -- TÜRKİYE PERAKENDESİNDE FİYAT KDV DAHİLDİR.
  -- Etikette "95 TL" yazar ve bu tutar KDV'yi içerir; kasada üstüne vergi
  -- eklenmez, içinden ayrıştırılır. Varsayılan bu yüzden `true`. Toptan satış
  -- yapan bir kiracı terminal bazında hariç'e çevirebilir.
  prices_include_tax boolean not null default true,
  is_active       boolean not null default true,
  created_by      uuid references core.users(id),
  updated_by      uuid references core.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists ux_pos_terminals_code on pos.terminals (tenant_id, code);
create index if not exists ix_pos_terminals_branch on pos.terminals (tenant_id, branch_id) where is_active;

-- NOT: warehouse_id'ye FK yok — POS, Envanter modülü kapalıyken de satış
-- yapabilmelidir (0700'deki lot_id ile aynı gerekçe).

-- -----------------------------------------------------------------------------
-- Kasa oturumu (vardiya / Z raporu)
-- -----------------------------------------------------------------------------
create table if not exists pos.sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  terminal_id       uuid not null references pos.terminals(id) on delete cascade,
  number            text,
  status            pos.session_status not null default 'open',
  opened_at         timestamptz not null default now(),
  opened_by         uuid references core.users(id),
  closed_at         timestamptz,
  closed_by         uuid references core.users(id),
  -- Kasadaki açılış parası (bozukluk)
  opening_cash      numeric(18,2) not null default 0,
  -- Kapanışta fiilen sayılan nakit
  counted_cash      numeric(18,2),
  -- Sistemin beklediği nakit: açılış + nakit satış − iade − kasa çıkışı
  expected_cash     numeric(18,2) not null default 0,
  -- Fark GİZLENMEZ (karar 4). Eksi = kasa açığı.
  cash_difference   numeric(18,2) generated always as
                      (coalesce(counted_cash, 0) - expected_cash) stored,
  -- Özet toplamlar (kapanışta dondurulur)
  order_count       integer not null default 0,
  gross_sales       numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  net_sales         numeric(18,2) not null default 0,
  refund_total      numeric(18,2) not null default 0,
  notes             text,
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_pos_sessions_number
  on pos.sessions (tenant_id, number) where number is not null;
-- Bir terminalde aynı anda tek açık oturum olabilir.
create unique index if not exists ux_pos_sessions_open
  on pos.sessions (terminal_id) where status <> 'closed';
create index if not exists ix_pos_sessions_terminal
  on pos.sessions (tenant_id, terminal_id, opened_at desc);

-- Kasa giriş/çıkışları (para yatırma, gider ödemesi, bozukluk takviyesi)
create table if not exists pos.cash_movements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  session_id   uuid not null references pos.sessions(id) on delete cascade,
  direction    text not null check (direction in ('in', 'out')),
  amount       numeric(18,2) not null check (amount > 0),
  reason       text not null,
  created_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ix_pos_cash_movements on pos.cash_movements (tenant_id, session_id);

-- -----------------------------------------------------------------------------
-- Fişler
-- -----------------------------------------------------------------------------
-- id CİHAZDA üretilir (karar 1): default var ama kasa kendi uuid'sini gönderir.
create table if not exists pos.orders (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  session_id        uuid not null references pos.sessions(id) on delete cascade,
  terminal_id       uuid not null references pos.terminals(id),
  -- Cihazın kendi artan sayacı: sıra atlamasını tespit etmeye yarar
  client_seq        bigint,
  receipt_no        text,
  status            pos.order_status not null default 'draft',
  -- Kasada fiş açıldığı an (cihaz saati). Sunucuya geç ulaşabilir.
  ordered_at        timestamptz not null default now(),
  synced_at         timestamptz,
  partner_id        uuid references core.partners(id),   -- kurumsal müşteri/fatura
  cashier_id        uuid references core.users(id),
  subtotal          numeric(18,2) not null default 0,
  discount_total    numeric(18,2) not null default 0,
  tax_total         numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  paid_total        numeric(18,2) not null default 0,
  change_given      numeric(18,2) not null default 0,
  -- İade fişi ise hangi fişin iadesi
  refund_of_id      uuid references pos.orders(id),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_pos_orders_receipt
  on pos.orders (tenant_id, receipt_no) where receipt_no is not null;
create unique index if not exists ux_pos_orders_client_seq
  on pos.orders (terminal_id, client_seq) where client_seq is not null;
create index if not exists ix_pos_orders_session on pos.orders (tenant_id, session_id, ordered_at);
create index if not exists ix_pos_orders_unsynced on pos.orders (tenant_id) where synced_at is null;

create table if not exists pos.order_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  order_id       uuid not null references pos.orders(id) on delete cascade,
  sequence       smallint not null default 10,
  product_id     uuid references core.products(id),
  -- SATIŞ ANI ANLIK GÖRÜNTÜSÜ (karar 3)
  sku            text,
  name           text not null,
  quantity       numeric(18,4) not null default 1 check (quantity <> 0),
  uom_code       text,
  unit_price     numeric(18,4) not null default 0,
  discount_pct   numeric(6,3) not null default 0 check (discount_pct between 0 and 100),
  tax_id         uuid references core.taxes(id),
  tax_rate       numeric(6,3) not null default 0,
  line_subtotal  numeric(18,2) not null default 0,
  line_tax       numeric(18,2) not null default 0,
  line_total     numeric(18,2) not null default 0,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_pos_order_lines on pos.order_lines (tenant_id, order_id, sequence);

-- Çoklu ödeme: bir fiş nakit + kart karışık ödenebilir (yemek kartı yaygın)
create table if not exists pos.payments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenants(id) on delete cascade,
  order_id       uuid not null references pos.orders(id) on delete cascade,
  method         pos.payment_method not null,
  amount         numeric(18,2) not null check (amount <> 0),
  -- Kart ödemesinde POS cihazı referansı / son 4 hane
  reference      text,
  card_last4     char(4),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists ix_pos_payments_order on pos.payments (tenant_id, order_id);
create index if not exists ix_pos_payments_method on pos.payments (tenant_id, method);
