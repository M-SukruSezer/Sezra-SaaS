-- =============================================================================
-- 1000 — Destek Masası: şema  (Faz 4)
-- =============================================================================
-- TASARIM KARARLARI
--
-- 1. SLA HEDEFİ BİLET AÇILIRKEN DONDURULUR.
--    Politika sonradan sıkılaştırılırsa, açık biletler geçmişe dönük ihlal
--    sayılmamalıdır. Bilet, o günkü hedef süreleri KOPYALAYARAK saklar
--    (bordroda, kalitede, stok maliyetinde ve projede uyguladığımız aynı ilke).
--
-- 2. "MÜŞTERİ BEKLENİYOR" DURUMUNDA SLA SAATİ DURUR.
--    Müşteriye soru sorup yanıt beklerken geçen süre bizim gecikmemiz değildir.
--    Duraklatılan süre ayrı bir alanda birikir ve hedeften düşülür. Bunu
--    yapmayan bir SLA ölçümü, ekibi müşterinin cevap hızıyla cezalandırır.
--
-- 3. İLK YANIT SÜRESİ AYRI ÖLÇÜLÜR.
--    Müşteri memnuniyetini en çok belirleyen metrik çözüm değil, İLK DÖNÜŞTÜR.
--    Bu yüzden ayrı hedefi ve ayrı damgası vardır.
--
-- 4. YAZIŞMA BİLETİN PARÇASIDIR.
--    Mesajlar ayrı bir "iletişim" modülüne değil, biletin altına yazılır; iç
--    not ile müşteriye giden mesaj aynı tabloda `is_internal` ile ayrılır.
--    İkisini ayırmak, "müşteri bunu gördü mü?" sorusunu belirsizleştirirdi.
-- =============================================================================

create schema if not exists helpdesk;

select core.register_module('helpdesk', 'Destek Masası', 4::smallint, '{core}', false,
       'Destek biletleri, SLA takibi, yazışma, memnuniyet ölçümü');

insert into core.plan_modules (plan_code, module_code) values
  ('buyume', 'helpdesk'), ('kurumsal', 'helpdesk')
on conflict do nothing;

do $$ begin
  create type helpdesk.ticket_status as enum
    ('new', 'open', 'pending_customer', 'resolved', 'closed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type helpdesk.ticket_priority as enum ('low', 'normal', 'high', 'urgent');
exception when duplicate_object then null; end $$;

do $$ begin
  create type helpdesk.ticket_channel as enum ('email', 'phone', 'portal', 'walk_in', 'internal');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Destek ekipleri
-- -----------------------------------------------------------------------------
create table if not exists helpdesk.teams (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references core.tenants(id) on delete cascade,
  branch_id    uuid references core.branches(id) on delete set null,
  code         text not null,
  name         text not null,
  description  text,
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  updated_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ux_hd_teams_code on helpdesk.teams (tenant_id, code);

-- -----------------------------------------------------------------------------
-- SLA politikaları
-- -----------------------------------------------------------------------------
create table if not exists helpdesk.sla_policies (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references core.tenants(id) on delete cascade,
  code                  text not null,
  name                  text not null,
  priority              helpdesk.ticket_priority not null,
  team_id               uuid references helpdesk.teams(id) on delete cascade,
  -- Hedefler DAKİKA cinsinden: saat/gün karışıklığı en sık yapılan hata
  first_response_minutes integer not null check (first_response_minutes > 0),
  resolution_minutes     integer not null check (resolution_minutes > 0),
  is_active             boolean not null default true,
  created_by            uuid references core.users(id),
  updated_by            uuid references core.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists ux_hd_sla_code on helpdesk.sla_policies (tenant_id, code);
create index if not exists ix_hd_sla_lookup
  on helpdesk.sla_policies (tenant_id, priority, team_id) where is_active;

-- -----------------------------------------------------------------------------
-- Biletler
-- -----------------------------------------------------------------------------
create table if not exists helpdesk.tickets (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenants(id) on delete cascade,
  branch_id         uuid references core.branches(id) on delete set null,
  number            text,
  subject           text not null,
  description       text,
  partner_id        uuid references core.partners(id),
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  team_id           uuid references helpdesk.teams(id) on delete set null,
  assignee_id       uuid references core.users(id),
  status            helpdesk.ticket_status not null default 'new',
  priority          helpdesk.ticket_priority not null default 'normal',
  channel           helpdesk.ticket_channel not null default 'email',
  -- İlgili proje (varsa). FK YOK: Proje modülü kapalı olabilir.
  project_id        uuid,

  -- KARAR 1: SLA hedefleri açılışta dondurulur
  sla_policy_id     uuid references helpdesk.sla_policies(id),
  first_response_target_minutes integer,
  resolution_target_minutes     integer,
  first_response_due timestamptz,
  resolution_due     timestamptz,

  -- KARAR 3: ilk yanıt ayrı ölçülür
  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,

  -- KARAR 2: müşteri beklenirken geçen süre hedeften düşülür
  paused_at         timestamptz,
  paused_minutes    integer not null default 0,

  -- İhlal bayrakları: hesaplanabilir ama sorgulanabilir olması için saklanır
  first_response_breached boolean not null default false,
  resolution_breached     boolean not null default false,

  satisfaction      smallint check (satisfaction between 1 and 5),
  satisfaction_note text,
  resolution        text,
  tags              text[] not null default '{}',
  owner_id          uuid references core.users(id),
  created_by        uuid references core.users(id),
  updated_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists ux_hd_tickets_number
  on helpdesk.tickets (tenant_id, number) where number is not null;
create index if not exists ix_hd_tickets_open
  on helpdesk.tickets (tenant_id, status)
  where status in ('new', 'open', 'pending_customer');
create index if not exists ix_hd_tickets_assignee
  on helpdesk.tickets (tenant_id, assignee_id) where status <> 'closed';
create index if not exists ix_hd_tickets_partner
  on helpdesk.tickets (tenant_id, partner_id, created_at desc);
-- SLA tarama sorgusu: vadesi geçmiş ve henüz ihlal işaretlenmemiş biletler
create index if not exists ix_hd_tickets_sla
  on helpdesk.tickets (tenant_id, resolution_due)
  where status in ('new', 'open') and not resolution_breached;

-- -----------------------------------------------------------------------------
-- Yazışma
-- -----------------------------------------------------------------------------
create table if not exists helpdesk.messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references core.tenants(id) on delete cascade,
  ticket_id     uuid not null references helpdesk.tickets(id) on delete cascade,
  author_id     uuid references core.users(id),
  -- Müşteriden gelen mesajda author_id null olur; kim yazdığı burada durur
  author_name   text,
  -- KARAR 4: iç not mu, müşteriye giden mesaj mı
  is_internal   boolean not null default false,
  is_from_customer boolean not null default false,
  body          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ix_hd_messages_ticket
  on helpdesk.messages (tenant_id, ticket_id, created_at);
