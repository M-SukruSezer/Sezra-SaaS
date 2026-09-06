-- =============================================================================
-- Demo kiracı: Örnek Ticaret A.Ş. (Bölüm 10, madde 7)
-- Düzce Merkez + Zonguldak şubeleri, 4 kullanıcı, gerçekçi CRM verisi.
-- Ayrıca izolasyonun sınandığı ikinci bir kiracı: "Rakip Ticaret".
-- Owner (BYPASSRLS) rolüyle çalıştırılmalıdır.
-- =============================================================================
set client_min_messages = warning;

-- --- Kullanıcılar -------------------------------------------------------------
insert into core.users (id, email, full_name, is_platform_admin) values
  ('11111111-1111-1111-1111-111111111111', 'sezra@sezra.dev',        'Sezra (Platform)',  true),
  ('22222222-2222-2222-2222-222222222222', 'admin@ornek.test',    'Merve Yıldız',      false),
  ('33333333-3333-3333-3333-333333333333', 'duzce.satis@ornek.test','Ali Kaya',        false),
  ('44444444-4444-4444-4444-444444444444', 'zonguldak.mudur@ornek.test','Deniz Aras',  false),
  ('55555555-5555-5555-5555-555555555555', 'admin@rakipticaret.test',   'Rakip Yönetici',    false),
  -- Ana platform yöneticisi. Sezra (Platform) demo kimliğinden ayrıdır:
  -- bu satır kurulumu yapan gerçek kişiyi temsil eder.
  ('66666666-6666-6666-6666-666666666666', 'm.sukrusezer@gmail.com', 'M. Şükrü Sezer',    true)
on conflict (id) do nothing;

-- --- Kiracılar ---------------------------------------------------------------
do $$
declare
  v_ornek uuid;
  v_rakip    uuid;
  v_zonguldak uuid;
  v_duzce    uuid;
  v_ms_ali   uuid;
  v_ms_deniz uuid;
  v_ms_admin uuid;
  v_role_sales uuid;
  v_role_bm  uuid;
begin
  if exists (select 1 from core.tenants where slug = 'ornek-ticaret') then
    return;
  end if;

  -- 'buyume' planı İK içermez; ek modül olarak açıyoruz. Rakip Ticaret'de İK
  -- KAPALI kalıyor — modül aktivasyonunun gerçekten izolasyon ürettiğini
  -- testler bu iki kiracıyı karşılaştırarak doğruluyor.
  v_ornek := core.provision_tenant(
    'Örnek Ticaret A.Ş.', 'ornek-ticaret', 'buyume',
    '22222222-2222-2222-2222-222222222222', 'Genel Ticaret', 'Düzce Merkez',
    array['hr', 'quality', 'maintenance']);

  v_rakip := core.provision_tenant(
    'Rakip Ticaret', 'rakip-ticaret', 'baslangic',
    '55555555-5555-5555-5555-555555555555', 'Genel Ticaret', 'Merkez');

  select id into v_duzce from core.branches where tenant_id = v_ornek and code = 'MERKEZ';

  insert into core.branches (tenant_id, code, name, city)
  values (v_ornek, 'ZONGULDAK', 'Zonguldak', 'Zonguldak')
  returning id into v_zonguldak;

  select id into v_role_sales from core.roles where tenant_id is null and code = 'sales';
  select id into v_role_bm    from core.roles where tenant_id is null and code = 'branch_manager';

  -- Ali: Düzce'ye kilitli satış temsilcisi (yalnızca KENDİ fırsatlarını görür)
  insert into core.memberships (user_id, tenant_id, is_default)
  values ('33333333-3333-3333-3333-333333333333', v_ornek, true)
  returning id into v_ms_ali;
  insert into core.membership_roles (membership_id, role_id) values (v_ms_ali, v_role_sales);
  insert into core.membership_branches (membership_id, branch_id) values (v_ms_ali, v_duzce);

  -- Deniz: Zonguldak şube müdürü (şubesinin TÜM verisini görür)
  insert into core.memberships (user_id, tenant_id, is_default)
  values ('44444444-4444-4444-4444-444444444444', v_ornek, true)
  returning id into v_ms_deniz;
  insert into core.membership_roles (membership_id, role_id) values (v_ms_deniz, v_role_bm);
  insert into core.membership_branches (membership_id, branch_id) values (v_ms_deniz, v_zonguldak);

  -- Ana platform yöneticisi: Örnek Ticaret'te şirket yöneticisi üyeliği.
  -- Platform konsoluna erişim is_platform_admin bayrağından gelir; bu üyelik
  -- ayrıca normal ERP ekranlarını gerçek bir kiracı bağlamında görmesi içindir.
  -- Şube kısıtı YOKTUR (membership_branches boş = tüm şubeler).
  insert into core.memberships (user_id, tenant_id, is_default)
  values ('66666666-6666-6666-6666-666666666666', v_ornek, true)
  returning id into v_ms_admin;
  insert into core.membership_roles (membership_id, role_id)
  select v_ms_admin, id from core.roles where tenant_id is null and code = 'tenant_admin';

  -- --- Ürünler ---------------------------------------------------------------
  insert into core.products (tenant_id, sku, name, kind, uom_id, sale_price, sale_tax_id)
  select v_ornek, x.sku, x.name, 'stockable',
         (select id from core.uoms where tenant_id = v_ornek and code = x.uom),
         x.price,
         (select id from core.taxes where tenant_id = v_ornek and code = x.tax)
  from (values
    ('URN-101',  'Standart Ürün 101',                'ADET',  75.00,  'KDV10'),
    ('URN-102',  'Standart Ürün 102',                   'ADET',  115.00, 'KDV10'),
    ('URN-103',  'Standart Ürün 103',            'ADET',  95.00,  'KDV10'),
    ('HAM-201', 'Hammadde 201',  'KG',    780.00, 'KDV1'),
    ('URN-104',  'Standart Ürün 104',        'ADET',  145.00, 'KDV10')
  ) as x(sku, name, uom, price, tax);

  -- --- Cariler ---------------------------------------------------------------
  insert into core.partners (tenant_id, branch_id, name, is_customer, tax_office, tax_no, city, owner_id) values
    (v_ornek, v_duzce,     'Alfa Sanayi Ltd. Şti.', true, 'Düzce',     '1234567890', 'Düzce',     '33333333-3333-3333-3333-333333333333'),
    (v_ornek, v_duzce,     'Beta Lojistik A.Ş.',             true, 'Düzce',     '2234567890', 'Düzce',     '33333333-3333-3333-3333-333333333333'),
    (v_ornek, v_zonguldak, 'Gama Yapı Ltd. Şti.',            true, 'Zonguldak', '3234567890', 'Zonguldak', '44444444-4444-4444-4444-444444444444'),
    (v_ornek, v_zonguldak, 'Delta Enerji A.Ş.',        true, 'Zonguldak', '4234567890', 'Zonguldak', '44444444-4444-4444-4444-444444444444');

  insert into core.partners (tenant_id, name, is_supplier, tax_office, tax_no, city)
  values (v_ornek, 'Epsilon Hammadde İthalat Ltd.', true, 'İstanbul', '5234567890', 'İstanbul');

  -- --- Fırsatlar -------------------------------------------------------------
  insert into crm.leads (tenant_id, branch_id, pipeline_id, stage_id, name, partner_id,
                         source, expected_revenue, owner_id, expected_close_date)
  select v_ornek, x.branch, p.id, s.id, x.title,
         (select id from core.partners where tenant_id = v_ornek and name = x.partner),
         x.source, x.revenue, x.owner, current_date + x.days
  from (values
    (null::uuid, 'Alfa Sanayi Ltd. Şti.', 'Yıllık toplu tedarik sözleşmesi', 'referans',   145000.00, '33333333-3333-3333-3333-333333333333'::uuid, 'Teklif',     21),
    (null,       'Beta Lojistik A.Ş.',             'Şube ikmal anlaşması','instagram',   82000.00, '33333333-3333-3333-3333-333333333333', 'İletişimde', 30),
    (null,       'Gama Yapı Ltd. Şti.',            'Ofis donanımı + tedarik', 'walk-in',   210000.00, '44444444-4444-4444-4444-444444444444', 'Yeni',       45),
    (null,       'Delta Enerji A.Ş.',        'Toptan hammadde satışı',        'referans',   64000.00, '44444444-4444-4444-4444-444444444444', 'Teklif',     14)
  ) as x(branch, partner, title, source, revenue, owner, stage_name, days)
  cross join lateral (select id from crm.pipelines where tenant_id = v_ornek and is_default) p
  cross join lateral (select id from crm.stages where tenant_id = v_ornek and name = x.stage_name) s;

  -- Şube ataması: cariye göre
  update crm.leads l set branch_id = pa.branch_id
  from core.partners pa where pa.id = l.partner_id and l.tenant_id = v_ornek;

  -- Kaybedilmiş bir fırsat (kayıp sebebi analizi raporu için)
  insert into crm.leads (tenant_id, branch_id, pipeline_id, stage_id, name, source,
                         expected_revenue, owner_id, lost_reason_id)
  select v_ornek, v_duzce,
         (select id from crm.pipelines where tenant_id = v_ornek and is_default),
         (select id from crm.stages where tenant_id = v_ornek and is_lost),
         'Düzce AVM kiosk', 'walk-in', 55000.00,
         '33333333-3333-3333-3333-333333333333',
         (select id from crm.lost_reasons where tenant_id = v_ornek and name = 'Fiyat yüksek');

  -- --- Aktiviteler -----------------------------------------------------------
  insert into crm.activities (tenant_id, branch_id, lead_id, kind, subject, due_at, assigned_to, owner_id)
  select l.tenant_id, l.branch_id, l.id, 'call', 'Teklif takip araması',
         now() - interval '2 days', l.owner_id, l.owner_id
  from crm.leads l where l.tenant_id = v_ornek and l.status = 'open'
  limit 3;

  -- --- Teklif ----------------------------------------------------------------
  declare
    v_q uuid;
    v_lead uuid;
  begin
    select id into v_lead from crm.leads
     where tenant_id = v_ornek and name = 'Yıllık toplu tedarik sözleşmesi';

    insert into crm.quotations (tenant_id, branch_id, partner_id, lead_id, valid_until, owner_id, payment_term_days)
    select v_ornek, l.branch_id, l.partner_id, l.id, current_date + 15, l.owner_id, 30
    from crm.leads l where l.id = v_lead
    returning id into v_q;

    insert into crm.quotation_lines (tenant_id, quotation_id, sequence, product_id, description,
                                     quantity, uom_id, unit_price, discount_pct, tax_id)
    select v_ornek, v_q, x.seq, pr.id, pr.name, x.qty, pr.uom_id, x.price, x.disc, pr.sale_tax_id
    from (values
      (10, 'HAM-201', 150::numeric, 760.00::numeric, 5::numeric),
      (20, 'URN-101',  400::numeric,  70.00::numeric, 0::numeric)
    ) as x(seq, sku, qty, price, disc)
    join core.products pr on pr.tenant_id = v_ornek and pr.sku = x.sku;
  end;

  -- --- İnsan Kaynakları ------------------------------------------------------
  declare
    v_dep_ops   uuid;
    v_dep_adm   uuid;
    v_pos_bar   uuid;
    v_pos_sef   uuid;
    v_emp       record;
    v_run       hr.payroll_runs;
    v_leave     uuid;
    v_yillik    uuid;
  begin
    -- Departmanlar KİRACI GENELİ (branch_id null): her iki şubenin personeli de
    -- Operasyon'a bağlı. Şubeye bağlanırsa diğer şubenin müdürü departman adını
    -- göremez (RLS şube kapsamı) ve listede boş görünür.
    insert into hr.departments (tenant_id, branch_id, code, name) values
      (v_ornek, null, 'OPS', 'Operasyon'),
      (v_ornek, null, 'IDR', 'İdari');
    select id into v_dep_ops from hr.departments where tenant_id = v_ornek and code = 'OPS';
    select id into v_dep_adm from hr.departments where tenant_id = v_ornek and code = 'IDR';

    insert into hr.positions (tenant_id, department_id, code, name) values
      (v_ornek, v_dep_ops, 'OPERATOR', 'Operatör'),
      (v_ornek, v_dep_ops, 'SEF',     'Vardiya Şefi'),
      (v_ornek, v_dep_adm, 'MUH',     'Muhasebe Uzmanı');
    select id into v_pos_bar from hr.positions where tenant_id = v_ornek and code = 'OPERATOR';
    select id into v_pos_sef from hr.positions where tenant_id = v_ornek and code = 'SEF';

    -- Kadro: iki şubeye dağılmış, farklı ücret seviyeleri.
    -- Şube müdürü Deniz yalnızca Zonguldak kadrosunu görebilmeli (RLS testi).
    insert into hr.employees (tenant_id, branch_id, employee_no, first_name, last_name,
                              hire_date, department_id, position_id, birth_date)
    values
      (v_ornek, v_duzce,     'P-001', 'Elif',  'Demir',  date '2021-03-15', v_dep_ops, v_pos_sef, date '1994-06-02'),
      (v_ornek, v_duzce,     'P-002', 'Burak', 'Şahin',  date '2024-02-01', v_dep_ops, v_pos_bar, date '2001-11-20'),
      (v_ornek, v_duzce,     'P-003', 'Ceren', 'Aydın',  date '2023-09-10', v_dep_ops, v_pos_bar, date '2000-04-18'),
      (v_ornek, v_zonguldak, 'P-004', 'Mert',  'Koç',    date '2022-07-01', v_dep_ops, v_pos_sef, date '1996-01-09'),
      (v_ornek, v_zonguldak, 'P-005', 'Sena',  'Yalçın', date '2025-01-06', v_dep_ops, v_pos_bar, date '2003-08-25');

    -- Sözleşmeler: şef kadrosu asgari ücretin üstünde, operatörler asgari ücretli
    insert into hr.employee_contracts (tenant_id, branch_id, employee_id, valid_from,
                                       wage_basis, wage_amount, employment_type)
    select v_ornek, e.branch_id, e.id, greatest(e.hire_date, date '2025-01-01'),
           'gross',
           case e.employee_no
             when 'P-001' then 42000.00
             when 'P-004' then 38500.00
             else 26005.50
           end,
           'full_time'::hr.employment_type
    from hr.employees e where e.tenant_id = v_ornek;

    -- İzin senaryosu: Burak yıllık izin talep etti, henüz onay bekliyor
    select id into v_yillik from hr.leave_types where tenant_id = v_ornek and code = 'YILLIK';
    insert into hr.leave_requests (tenant_id, branch_id, employee_id, leave_type_id,
                                   date_from, date_to, reason, status, owner_id)
    select v_ornek, e.branch_id, e.id, v_yillik,
           current_date + 10, current_date + 14, 'Aile ziyareti', 'pending',
           '22222222-2222-2222-2222-222222222222'
    from hr.employees e where e.tenant_id = v_ornek and e.employee_no = 'P-003';

    -- Ceren'in bakiyesi hazırlansın ki ekranda "kalan gün" dolu görünsün
    perform hr.ensure_leave_balance(e.id, v_yillik, extract(year from current_date)::smallint)
    from hr.employees e where e.tenant_id = v_ornek;

    -- Puantaj: son 7 günün vardiya kayıtları
    insert into hr.attendance (tenant_id, branch_id, employee_id, work_date, shift_id,
                               check_in, check_out)
    select v_ornek, e.branch_id, e.id, d.day::date, s.id,
           d.day::date + s.start_time, d.day::date + s.end_time
    from hr.employees e
    cross join generate_series(current_date - 6, current_date - 1, interval '1 day') as d(day)
    join lateral (select id, start_time, end_time from hr.shifts
                   where tenant_id = v_ornek and code = 'TAMGUN' limit 1) s on true
    where e.tenant_id = v_ornek
      and extract(isodow from d.day) < 7;
  end;

  -- --- Satın Alma --------------------------------------------------------------
  declare
    v_tedarikci uuid;
    v_req       uuid;
    v_order     uuid;
  begin
    select id into v_tedarikci from core.partners
     where tenant_id = v_ornek and name = 'Epsilon Hammadde İthalat Ltd.';

    -- Tedarikçi fiyat listesi: kademeli fiyat (100 kg üstü daha ucuz)
    insert into purchasing.supplier_prices (tenant_id, partner_id, product_id, supplier_sku,
                                            unit_price, uom_id, min_quantity, lead_time_days)
    select v_ornek, v_tedarikci, pr.id, x.sku, x.price, pr.uom_id, x.min_qty, x.lead
    from (values
      ('HAM-201', 'YC-COL-001', 690.00::numeric,   0::numeric, 7::smallint),
      ('HAM-201', 'YC-COL-001', 640.00::numeric, 100::numeric, 10::smallint)
    ) as x(sku, supplier_sku, price, min_qty, lead)
    join core.products pr on pr.tenant_id = v_ornek and pr.sku = x.sku;

    -- Onaylanmış talep → sipariş → kısmi mal kabul senaryosu
    insert into purchasing.requisitions (tenant_id, branch_id, suggested_partner_id,
                                         needed_by, justification, status, owner_id)
    values (v_ornek, v_duzce, v_tedarikci, current_date + 14,
            'Düzce şubesi hammadde stoğu kritik seviyede', 'draft',
            '44444444-4444-4444-4444-444444444444')
    returning id into v_req;

    insert into purchasing.requisition_lines (tenant_id, requisition_id, sequence, product_id,
                                              description, quantity, uom_id, unit_price, tax_id)
    select v_ornek, v_req, 10, pr.id, pr.name, 120, pr.uom_id, 690.00, pr.sale_tax_id
    from core.products pr where pr.tenant_id = v_ornek and pr.sku = 'HAM-201';
  end;

  -- --- Envanter ----------------------------------------------------------------
  declare
    v_prod  uuid;
    v_lot   uuid;
  begin
    select id into v_prod from core.products
     where tenant_id = v_ornek and sku = 'HAM-201';

    -- Açılış stoğu: son kullanma tarihli bir parti.
    -- SKT takibi olmadan FEFO uygulanamaz; demo bunu göstermeli.
    insert into inventory.lots (tenant_id, product_id, code, production_date, expiry_date)
    values (v_ornek, v_prod, 'PRT-2026-08', current_date - 20, current_date + 25)
    returning id into v_lot;

    perform inventory.receive_stock(
      v_ornek, v_duzce, v_prod, 40, 615.00, v_lot,
      'seed', 'opening_balance', null, 'Açılış stoğu');

    -- Minimum seviye kuralı: 25 birim altına düşünce uyarı, 150 birime tamamla
    insert into inventory.reorder_rules (tenant_id, branch_id, product_id,
                                         min_quantity, max_quantity)
    values (v_ornek, v_duzce, v_prod, 25, 150);

    -- Barkodlar: tekli ve koli. Koli okutulduğunda stok 1 değil 12 artar.
    insert into inventory.barcodes (tenant_id, product_id, code, quantity, kind, is_gtin) values
      (v_ornek, v_prod, '8690504000013',  1, 'unit', true),
      (v_ornek, v_prod, 'KOLI-CKR1-12',  12, 'case', false);
  end;

  -- --- Kalite Kontrol ----------------------------------------------------------
  declare
    v_prod uuid;
    v_plan uuid;
  begin
    select id into v_prod from core.products
     where tenant_id = v_ornek and sku = 'HAM-201';

    -- Hammadde giriş kontrolü. Ölçütler her sektörde mal kabulde fiilen
    -- bakılan şeyler: nem, yabancı madde, görsel uygunluk, ambalaj bütünlüğü.
    insert into quality.plans (tenant_id, code, name, product_id, stage, sample_pct)
    values (v_ornek, 'GKK-HAM', 'Hammadde giriş kalite kontrolü', v_prod, 'incoming', 10)
    returning id into v_plan;

    insert into quality.check_points
      (tenant_id, plan_id, sequence, code, name, kind, unit,
       min_value, max_value, expected_bool, expected_choice, choices, is_critical, instructions)
    values
      (v_ornek, v_plan, 10, 'NEM', 'Nem oranı', 'numeric', '%',
       9.0, 12.5, null, null, null, true,
       'Nem ölçerle üç ayrı noktadan ölçüp ortalamayı girin'),
      (v_ornek, v_plan, 20, 'YBM', 'Yabancı madde oranı', 'numeric', '%',
       null, 1.0, null, null, null, true,
       '100 g numunede taş, dal, kabuk ayrıştırılıp tartılır'),
      (v_ornek, v_plan, 30, 'AMB', 'Ambalaj bütünlüğü', 'boolean', null,
       null, null, true, null, null, false,
       'Çuvalda yırtık, ıslaklık, koku geçişi var mı'),
      (v_ornek, v_plan, 40, 'KOKU', 'Koku değerlendirmesi', 'choice', null,
       null, null, null, 'temiz', array['temiz','hafif küf','küflü','fermente'], true,
       'Çuval açıldığında ilk koku'),
      (v_ornek, v_plan, 50, 'NOT', 'Denetçi notu', 'text', null,
       null, null, null, null, null, false,
       'Gözlemler, fotoğraf referansı');
  end;

  -- --- Bakım & Ekipman ---------------------------------------------------------
  declare
    v_eq_duzce uuid;
    v_eq_zong  uuid;
    v_eq_deg   uuid;
    v_mplan    uuid;
    v_servis   uuid;
    v_parca    uuid;
  begin
    select id into v_servis from core.partners
     where tenant_id = v_ornek and is_supplier limit 1;

    -- Yedek parça da bir ÜRÜNDÜR (Bölüm 7): ayrı parça kataloğu icat edilmez.
    insert into core.products (tenant_id, sku, name, kind, uom_id)
    select v_ornek, 'PRC-CONTA', 'Sızdırmazlık contası', 'stockable', uom_id
    from core.products where tenant_id = v_ornek and sku = 'HAM-201'
    returning id into v_parca;

    insert into maintenance.equipment
      (tenant_id, branch_id, code, name, category, manufacturer, model, serial_no,
       partner_id, purchase_date, warranty_until, purchase_cost, location_note,
       is_critical, usage_counter, usage_unit)
    values
      (v_ornek, v_duzce, 'EKP-001', 'Üretim Hattı 1', 'üretim hattı',
       'Alfa Makine', 'AM-200', 'LM-88213', v_servis,
       date '2023-05-10', date '2025-05-10', 285000.00, 'Üretim alanı, sol',
       true, 184000, 'devir'),
      (v_ornek, v_duzce, 'EKP-002', 'Kompresör', 'yardımcı ekipman',
       'Beta Makine', 'BM-65', 'MK-4471', v_servis,
       date '2023-05-10', date '2025-05-10', 62000.00, 'Üretim alanı, sağ',
       true, 96000, 'devir'),
      (v_ornek, v_zonguldak, 'EKP-003', 'Üretim Hattı 2', 'üretim hattı',
       'Gama Makine', 'GM-100', 'NS-20714', v_servis,
       date '2024-11-01', date '2026-11-01', 148000.00, 'Üretim alanı',
       true, 41000, 'devir');

    select id into v_eq_duzce from maintenance.equipment
     where tenant_id = v_ornek and code = 'EKP-001';

    -- Kategori planı: her üretim hattına uygulanır. Hem takvim hem sayaç
    -- bazlı; hangisi önce gelirse iş emri o zaman açılır.
    insert into maintenance.plans
      (tenant_id, code, name, category, interval_days, interval_usage,
       lead_days, estimated_minutes, instructions)
    values (v_ornek, 'BKM-PERIYODIK', 'Periyodik bakım ve conta değişimi',
            'üretim hattı', 90, 20000, 7, 120,
            'Hat durdurulur, iç devre temizlenir, sızdırmazlık contaları yenilenir')
    returning id into v_mplan;

    insert into maintenance.plan_tasks (tenant_id, plan_id, sequence, name, instructions) values
      (v_ornek, v_mplan, 10, 'Hattı durdurma ve boşaltma', 'İç devre tamamen boşaltılır'),
      (v_ornek, v_mplan, 20, 'Temizleyici devridaim', '20 dk devridaim, ardından 3 kez durulama'),
      (v_ornek, v_mplan, 30, 'Sızdırmazlık contası değişimi', 'Her istasyon için ayrı conta'),
      (v_ornek, v_mplan, 40, 'Basınç ve sıcaklık kontrolü', '9 bar / 93 °C hedef'),
      (v_ornek, v_mplan, 50, 'Test çevrimi', 'İki çevrim alınıp çıktı ölçülür');
  end;
end $$;

select t.name as kiracı,
       count(distinct b.id) as şube,
       count(distinct l.id) as fırsat,
       count(distinct e.id) as personel,
       count(distinct pr.id) as satın_alma_talebi,
       coalesce(sum(distinct pc.quantity_on_hand), 0) as stok
from core.tenants t
left join core.branches b on b.tenant_id = t.id
left join crm.leads l on l.tenant_id = t.id
left join hr.employees e on e.tenant_id = t.id
left join purchasing.requisitions pr on pr.tenant_id = t.id
left join inventory.product_costs pc on pc.tenant_id = t.id
group by t.name order by t.name;
