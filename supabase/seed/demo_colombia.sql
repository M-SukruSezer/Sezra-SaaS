-- =============================================================================
-- Demo kiracı: Colombia Coffee (Bölüm 10, madde 7)
-- Düzce Merkez + Zonguldak şubeleri, 4 kullanıcı, gerçekçi CRM verisi.
-- Ayrıca izolasyonun sınandığı ikinci bir kiracı: "Rakip Kafe".
-- Owner (BYPASSRLS) rolüyle çalıştırılmalıdır.
-- =============================================================================
set client_min_messages = warning;

-- --- Kullanıcılar -------------------------------------------------------------
insert into core.users (id, email, full_name, is_platform_admin) values
  ('11111111-1111-1111-1111-111111111111', 'sezra@sezra.dev',        'Sezra (Platform)',  true),
  ('22222222-2222-2222-2222-222222222222', 'admin@colombia.test',    'Merve Yıldız',      false),
  ('33333333-3333-3333-3333-333333333333', 'duzce.satis@colombia.test','Ali Kaya',        false),
  ('44444444-4444-4444-4444-444444444444', 'zonguldak.mudur@colombia.test','Deniz Aras',  false),
  ('55555555-5555-5555-5555-555555555555', 'admin@rakipkafe.test',   'Rakip Yönetici',    false)
on conflict (id) do nothing;

-- --- Kiracılar ---------------------------------------------------------------
do $$
declare
  v_colombia uuid;
  v_rakip    uuid;
  v_zonguldak uuid;
  v_duzce    uuid;
  v_ms_ali   uuid;
  v_ms_deniz uuid;
  v_role_sales uuid;
  v_role_bm  uuid;
begin
  if exists (select 1 from core.tenants where slug = 'colombia-coffee') then
    return;
  end if;

  v_colombia := core.provision_tenant(
    'Colombia Coffee', 'colombia-coffee', 'buyume',
    '22222222-2222-2222-2222-222222222222', 'F&B / Kahve Zinciri', 'Düzce Merkez');

  v_rakip := core.provision_tenant(
    'Rakip Kafe', 'rakip-kafe', 'baslangic',
    '55555555-5555-5555-5555-555555555555', 'F&B', 'Merkez');

  select id into v_duzce from core.branches where tenant_id = v_colombia and code = 'MERKEZ';

  insert into core.branches (tenant_id, code, name, city)
  values (v_colombia, 'ZONGULDAK', 'Zonguldak', 'Zonguldak')
  returning id into v_zonguldak;

  select id into v_role_sales from core.roles where tenant_id is null and code = 'sales';
  select id into v_role_bm    from core.roles where tenant_id is null and code = 'branch_manager';

  -- Ali: Düzce'ye kilitli satış temsilcisi (yalnızca KENDİ fırsatlarını görür)
  insert into core.memberships (user_id, tenant_id, is_default)
  values ('33333333-3333-3333-3333-333333333333', v_colombia, true)
  returning id into v_ms_ali;
  insert into core.membership_roles (membership_id, role_id) values (v_ms_ali, v_role_sales);
  insert into core.membership_branches (membership_id, branch_id) values (v_ms_ali, v_duzce);

  -- Deniz: Zonguldak şube müdürü (şubesinin TÜM verisini görür)
  insert into core.memberships (user_id, tenant_id, is_default)
  values ('44444444-4444-4444-4444-444444444444', v_colombia, true)
  returning id into v_ms_deniz;
  insert into core.membership_roles (membership_id, role_id) values (v_ms_deniz, v_role_bm);
  insert into core.membership_branches (membership_id, branch_id) values (v_ms_deniz, v_zonguldak);

  -- --- Ürünler ---------------------------------------------------------------
  insert into core.products (tenant_id, sku, name, kind, uom_id, sale_price, sale_tax_id)
  select v_colombia, x.sku, x.name, 'stockable',
         (select id from core.uoms where tenant_id = v_colombia and code = x.uom),
         x.price,
         (select id from core.taxes where tenant_id = v_colombia and code = x.tax)
  from (values
    ('KHV-ESP',  'Espresso',                'ADET',  75.00,  'KDV10'),
    ('KHV-LAT',  'Latte',                   'ADET',  115.00, 'KDV10'),
    ('KHV-FLT',  'Filtre Kahve',            'ADET',  95.00,  'KDV10'),
    ('KHV-CKR1', 'Colombia Çekirdek 1 kg',  'KG',    780.00, 'KDV1'),
    ('TTL-CHS',  'Cheesecake Dilim',        'ADET',  145.00, 'KDV10')
  ) as x(sku, name, uom, price, tax);

  -- --- Cariler ---------------------------------------------------------------
  insert into core.partners (tenant_id, branch_id, name, is_customer, tax_office, tax_no, city, owner_id) values
    (v_colombia, v_duzce,     'Düzce Üniversitesi Kantin İşl.', true, 'Düzce',     '1234567890', 'Düzce',     '33333333-3333-3333-3333-333333333333'),
    (v_colombia, v_duzce,     'Akçakoca Otel A.Ş.',             true, 'Düzce',     '2234567890', 'Düzce',     '33333333-3333-3333-3333-333333333333'),
    (v_colombia, v_zonguldak, 'Zonguldak Teknopark',            true, 'Zonguldak', '3234567890', 'Zonguldak', '44444444-4444-4444-4444-444444444444'),
    (v_colombia, v_zonguldak, 'Kdz. Ereğli Marina Cafe',        true, 'Zonguldak', '4234567890', 'Zonguldak', '44444444-4444-4444-4444-444444444444');

  insert into core.partners (tenant_id, name, is_supplier, tax_office, tax_no, city)
  values (v_colombia, 'Yeşil Çekirdek İthalat Ltd.', true, 'İstanbul', '5234567890', 'İstanbul');

  -- --- Fırsatlar -------------------------------------------------------------
  insert into crm.leads (tenant_id, branch_id, pipeline_id, stage_id, name, partner_id,
                         source, expected_revenue, owner_id, expected_close_date)
  select v_colombia, x.branch, p.id, s.id, x.title,
         (select id from core.partners where tenant_id = v_colombia and name = x.partner),
         x.source, x.revenue, x.owner, current_date + x.days
  from (values
    (null::uuid, 'Düzce Üniversitesi Kantin İşl.', 'Kampüs toplu kahve tedariki', 'referans',   145000.00, '33333333-3333-3333-3333-333333333333'::uuid, 'Teklif',     21),
    (null,       'Akçakoca Otel A.Ş.',             'Otel kahvaltı kahve anlaşması','instagram',   82000.00, '33333333-3333-3333-3333-333333333333', 'İletişimde', 30),
    (null,       'Zonguldak Teknopark',            'Ofis kahve makinesi + tedarik', 'walk-in',   210000.00, '44444444-4444-4444-4444-444444444444', 'Yeni',       45),
    (null,       'Kdz. Ereğli Marina Cafe',        'Toptan çekirdek satışı',        'referans',   64000.00, '44444444-4444-4444-4444-444444444444', 'Teklif',     14)
  ) as x(branch, partner, title, source, revenue, owner, stage_name, days)
  cross join lateral (select id from crm.pipelines where tenant_id = v_colombia and is_default) p
  cross join lateral (select id from crm.stages where tenant_id = v_colombia and name = x.stage_name) s;

  -- Şube ataması: cariye göre
  update crm.leads l set branch_id = pa.branch_id
  from core.partners pa where pa.id = l.partner_id and l.tenant_id = v_colombia;

  -- Kaybedilmiş bir fırsat (kayıp sebebi analizi raporu için)
  insert into crm.leads (tenant_id, branch_id, pipeline_id, stage_id, name, source,
                         expected_revenue, owner_id, lost_reason_id)
  select v_colombia, v_duzce,
         (select id from crm.pipelines where tenant_id = v_colombia and is_default),
         (select id from crm.stages where tenant_id = v_colombia and is_lost),
         'Düzce AVM kiosk', 'walk-in', 55000.00,
         '33333333-3333-3333-3333-333333333333',
         (select id from crm.lost_reasons where tenant_id = v_colombia and name = 'Fiyat yüksek');

  -- --- Aktiviteler -----------------------------------------------------------
  insert into crm.activities (tenant_id, branch_id, lead_id, kind, subject, due_at, assigned_to, owner_id)
  select l.tenant_id, l.branch_id, l.id, 'call', 'Teklif takip araması',
         now() - interval '2 days', l.owner_id, l.owner_id
  from crm.leads l where l.tenant_id = v_colombia and l.status = 'open'
  limit 3;

  -- --- Teklif ----------------------------------------------------------------
  declare
    v_q uuid;
    v_lead uuid;
  begin
    select id into v_lead from crm.leads
     where tenant_id = v_colombia and name = 'Kampüs toplu kahve tedariki';

    insert into crm.quotations (tenant_id, branch_id, partner_id, lead_id, valid_until, owner_id, payment_term_days)
    select v_colombia, l.branch_id, l.partner_id, l.id, current_date + 15, l.owner_id, 30
    from crm.leads l where l.id = v_lead
    returning id into v_q;

    insert into crm.quotation_lines (tenant_id, quotation_id, sequence, product_id, description,
                                     quantity, uom_id, unit_price, discount_pct, tax_id)
    select v_colombia, v_q, x.seq, pr.id, pr.name, x.qty, pr.uom_id, x.price, x.disc, pr.sale_tax_id
    from (values
      (10, 'KHV-CKR1', 150::numeric, 760.00::numeric, 5::numeric),
      (20, 'KHV-ESP',  400::numeric,  70.00::numeric, 0::numeric)
    ) as x(seq, sku, qty, price, disc)
    join core.products pr on pr.tenant_id = v_colombia and pr.sku = x.sku;
  end;
end $$;

select t.name as kiracı, count(distinct b.id) as şube, count(distinct l.id) as fırsat
from core.tenants t
left join core.branches b on b.tenant_id = t.id
left join crm.leads l on l.tenant_id = t.id
group by t.name order by t.name;
