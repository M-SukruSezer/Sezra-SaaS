-- =============================================================================
-- 0202 — Finans: RLS, izinler, Tekdüzen Hesap Planı kurulumu
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
select core.register_tenant_table('finance', 'accounts',        'finance.account',  false, false);
select core.register_tenant_table('finance', 'fiscal_years',    'finance.period',   false, false);
select core.register_tenant_table('finance', 'fiscal_periods',  'finance.period',   false, false);
select core.register_tenant_table('finance', 'journals',        'finance.account',  false, false);
select core.register_tenant_table('finance', 'journal_entries', 'finance.entry',    true,  true);
select core.register_tenant_table('finance', 'invoices',        'finance.invoice',  true,  true);
select core.register_tenant_table('finance', 'payments',        'finance.payment',  true,  true);
select core.register_tenant_table('finance', 'bank_accounts',   'finance.bank',     true,  false);
select core.register_tenant_table('finance', 'bank_statements', 'finance.bank',     false, false);
select core.register_tenant_table('finance', 'einvoice_documents', 'finance.einvoice', false, false);

-- Bakiye tablosu: yalnızca okunur ve denetlenmez (kendisi zaten türetilmiş veri;
-- her güncellemesini audit_log'a yazmak gürültüden başka bir şey üretmez).
alter table finance.account_balances enable row level security;
alter table finance.account_balances force row level security;
drop policy if exists p_account_balances_select on finance.account_balances;
create policy p_account_balances_select on finance.account_balances for select
  using (tenant_id = (select core.support_tenant_id())
         or (tenant_id = (select core.current_tenant_id())
             and (branch_id is null or (select core.accessible_branch_ids()) @> array[branch_id])
             and (select core.has_perm('finance.report.read'))));

alter table finance.account_mappings enable row level security;
alter table finance.account_mappings force row level security;
drop policy if exists p_account_mappings_select on finance.account_mappings;
create policy p_account_mappings_select on finance.account_mappings for select
  using (tenant_id = (select core.support_tenant_id()) or tenant_id = (select core.current_tenant_id()));
drop policy if exists p_account_mappings_write on finance.account_mappings;
create policy p_account_mappings_write on finance.account_mappings for all
  using (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('finance.account.write.all')))
  with check (tenant_id = (select core.current_tenant_id()) and (select core.has_perm('finance.account.write.all')));

-- Alt tablolar yetkiyi başlıktan devralır
do $$
declare v record;
begin
  for v in select * from (values
      ('journal_entry_lines',   'journal_entries', 'entry_id'),
      ('invoice_lines',         'invoices',        'invoice_id'),
      ('payment_allocations',   'payments',        'payment_id'),
      ('bank_statement_lines',  'bank_statements', 'statement_id')
    ) as t(child, parent, fk)
  loop
    execute format('alter table finance.%I enable row level security', v.child);
    execute format('alter table finance.%I force row level security', v.child);
    execute format('drop policy if exists p_%s_all on finance.%I', v.child, v.child);
    execute format($p$create policy p_%1$s_all on finance.%1$I for all
        using (exists (select 1 from finance.%2$I h where h.id = %3$I))
        with check (exists (select 1 from finance.%2$I h where h.id = %3$I))$p$,
      v.child, v.parent, v.fk);
    execute format('create index if not exists ix_%1$s_tenant on finance.%1$I (tenant_id)', v.child);
    perform core.attach_updated_at('finance', v.child);
    perform core.attach_row_defaults('finance', v.child);
    perform core.attach_audit('finance', v.child);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- İzinler
-- -----------------------------------------------------------------------------
select core.declare_entity_permissions('finance', 'account',  'Hesap planı', false);
select core.declare_entity_permissions('finance', 'period',   'Mali dönem',  false);
select core.declare_entity_permissions('finance', 'entry',    'Yevmiye kaydı');
select core.declare_entity_permissions('finance', 'invoice',  'Fatura');
select core.declare_entity_permissions('finance', 'payment',  'Tahsilat / ödeme');
select core.declare_entity_permissions('finance', 'bank',     'Banka', false);
select core.declare_entity_permissions('finance', 'einvoice', 'e-Fatura', false);

select core.declare_permission('finance.entry.post',    'finance', 'finance.entry',   'approve', 'Yevmiye kaydını muhasebeleştir / ters kaydını al');
select core.declare_permission('finance.invoice.post',  'finance', 'finance.invoice', 'approve', 'Faturayı muhasebeleştir');
select core.declare_permission('finance.payment.post',  'finance', 'finance.payment', 'approve', 'Tahsilat/ödemeyi muhasebeleştir');
select core.declare_permission('finance.period.close',  'finance', 'finance.period',  'approve', 'Mali dönem kapat');
select core.declare_permission('finance.report.read',   'finance', 'finance.report',  'read',    'Mizan, defter, P&L ve KDV raporları');
select core.declare_permission('finance.report.pl',     'finance', 'finance.report',  'read',    'Kâr/zarar tablosunu görüntüle');

select core.grant_module_to_role('tenant_admin', 'finance');

select core.grant_to_role('accounting', array[
  'finance.account.read.all','finance.account.write.all','finance.account.create',
  'finance.period.read.all','finance.period.write.all','finance.period.create','finance.period.close',
  'finance.entry.read.all','finance.entry.write.all','finance.entry.create','finance.entry.post',
  'finance.invoice.read.all','finance.invoice.write.all','finance.invoice.create','finance.invoice.post',
  'finance.payment.read.all','finance.payment.write.all','finance.payment.create','finance.payment.post',
  'finance.bank.read.all','finance.bank.write.all','finance.bank.create',
  'finance.einvoice.read.all','finance.einvoice.create',
  'finance.report.read','finance.report.pl'
]);

-- Şube müdürü: kendi şubesinin faturalarını görür ve P&L'ini okur, ama
-- muhasebeleştiremez. (Örnek Ticaret A.Ş.'deki şube bazlı P&L erişimi.)
select core.grant_to_role('branch_manager', array[
  'finance.invoice.read.all','finance.invoice.create',
  'finance.payment.read.all',
  'finance.entry.read.all',
  'finance.account.read.all',
  'finance.report.read','finance.report.pl'
]);

select core.grant_to_role('sales', array[
  'finance.invoice.read.own'
]);

select core.grant_to_role('warehouse', array[
  'finance.invoice.read.all','finance.invoice.create','finance.account.read.all'
]);

select core.grant_to_role('readonly', array[
  'finance.invoice.read.all','finance.entry.read.all','finance.account.read.all','finance.report.read'
]);

-- -----------------------------------------------------------------------------
-- Kurulum kancası — Tekdüzen Hesap Planı
-- -----------------------------------------------------------------------------
create or replace function finance.provision_finance(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = finance, core, pg_temp
as $$
declare
  r          record;
  v_year     date := date_trunc('year', current_date)::date;
begin
  -- THP'nin KOBİ için gerekli çekirdeği. Kiracı buradan devam ederek kendi
  -- alt hesaplarını (120.01 gibi) açar; şablon dokunulmaz değildir.
  for r in
    select * from (values
      ('1',   'DÖNEN VARLIKLAR',                          'asset',     false, null,  false, false),
      ('10',  'HAZIR DEĞERLER',                           'asset',     false, '1',   false, false),
      ('100', 'KASA',                                     'asset',     true,  '10',  false, false),
      ('101', 'ALINAN ÇEKLER',                            'asset',     true,  '10',  false, false),
      ('102', 'BANKALAR',                                 'asset',     true,  '10',  false, false),
      ('108', 'DİĞER HAZIR DEĞERLER',                     'asset',     true,  '10',  false, false),
      ('12',  'TİCARİ ALACAKLAR',                         'asset',     false, '1',   false, false),
      ('120', 'ALICILAR',                                 'asset',     true,  '12',  true,  false),
      ('121', 'ALACAK SENETLERİ',                         'asset',     true,  '12',  true,  false),
      ('128', 'ŞÜPHELİ TİCARİ ALACAKLAR',                 'asset',     true,  '12',  true,  false),
      ('15',  'STOKLAR',                                  'asset',     false, '1',   false, false),
      ('153', 'TİCARİ MALLAR',                            'asset',     true,  '15',  false, false),
      ('157', 'DİĞER STOKLAR',                            'asset',     true,  '15',  false, false),
      ('19',  'DİĞER DÖNEN VARLIKLAR',                    'asset',     false, '1',   false, false),
      ('191', 'İNDİRİLECEK KDV',                          'asset',     true,  '19',  false, false),
      ('193', 'PEŞİN ÖDENEN VERGİLER VE FONLAR',          'asset',     true,  '19',  false, false),
      ('2',   'DURAN VARLIKLAR',                          'asset',     false, null,  false, false),
      ('25',  'MADDİ DURAN VARLIKLAR',                    'asset',     false, '2',   false, false),
      ('255', 'DEMİRBAŞLAR',                              'asset',     true,  '25',  false, false),
      ('257', 'BİRİKMİŞ AMORTİSMANLAR',                   'asset',     true,  '25',  false, false),
      ('3',   'KISA VADELİ YABANCI KAYNAKLAR',            'liability', false, null,  false, false),
      ('30',  'MALİ BORÇLAR',                             'liability', false, '3',   false, false),
      ('300', 'BANKA KREDİLERİ',                          'liability', true,  '30',  false, false),
      ('32',  'TİCARİ BORÇLAR',                           'liability', false, '3',   false, false),
      ('320', 'SATICILAR',                                'liability', true,  '32',  true,  false),
      ('321', 'BORÇ SENETLERİ',                           'liability', true,  '32',  true,  false),
      ('33',  'DİĞER BORÇLAR',                            'liability', false, '3',   false, false),
      ('335', 'PERSONELE BORÇLAR',                        'liability', true,  '33',  false, false),
      ('36',  'ÖDENECEK VERGİ VE DİĞER YÜKÜMLÜLÜKLER',    'liability', false, '3',   false, false),
      ('360', 'ÖDENECEK VERGİ VE FONLAR',                 'liability', true,  '36',  false, false),
      ('361', 'ÖDENECEK SOSYAL GÜVENLİK KESİNTİLERİ',     'liability', true,  '36',  false, false),
      ('39',  'DİĞER KISA VADELİ YABANCI KAYNAKLAR',      'liability', false, '3',   false, false),
      ('391', 'HESAPLANAN KDV',                           'liability', true,  '39',  false, false),
      ('5',   'ÖZKAYNAKLAR',                              'equity',    false, null,  false, false),
      ('50',  'ÖDENMİŞ SERMAYE',                          'equity',    false, '5',   false, false),
      ('500', 'SERMAYE',                                  'equity',    true,  '50',  false, false),
      ('57',  'GEÇMİŞ YILLAR KÂRLARI',                    'equity',    false, '5',   false, false),
      ('570', 'GEÇMİŞ YILLAR KÂRLARI',                    'equity',    true,  '57',  false, false),
      ('59',  'DÖNEM NET KÂRI (ZARARI)',                  'equity',    false, '5',   false, false),
      ('590', 'DÖNEM NET KÂRI',                           'equity',    true,  '59',  false, false),
      ('591', 'DÖNEM NET ZARARI',                         'equity',    true,  '59',  false, false),
      ('6',   'GELİR TABLOSU HESAPLARI',                  'income',    false, null,  false, true),
      ('60',  'BRÜT SATIŞLAR',                            'income',    false, '6',   false, true),
      ('600', 'YURTİÇİ SATIŞLAR',                         'income',    true,  '60',  false, true),
      ('601', 'YURTDIŞI SATIŞLAR',                        'income',    true,  '60',  false, true),
      ('602', 'DİĞER GELİRLER',                           'income',    true,  '60',  false, true),
      ('61',  'SATIŞ İNDİRİMLERİ',                        'income',    false, '6',   false, true),
      ('610', 'SATIŞTAN İADELER',                         'income',    true,  '61',  false, true),
      ('611', 'SATIŞ İSKONTOLARI',                        'income',    true,  '61',  false, true),
      ('62',  'SATIŞLARIN MALİYETİ',                      'cost',      false, '6',   false, true),
      ('621', 'SATILAN TİCARİ MALLAR MALİYETİ',           'cost',      true,  '62',  false, true),
      ('63',  'FAALİYET GİDERLERİ',                       'expense',   false, '6',   false, true),
      ('631', 'PAZARLAMA SATIŞ VE DAĞITIM GİDERLERİ',     'expense',   true,  '63',  false, true),
      ('632', 'GENEL YÖNETİM GİDERLERİ',                  'expense',   true,  '63',  false, true),
      ('64',  'DİĞER FAALİYETLERDEN OLAĞAN GELİR VE KÂRLAR','income',  false, '6',   false, true),
      ('642', 'FAİZ GELİRLERİ',                           'income',    true,  '64',  false, true),
      ('66',  'BORÇLANMA GİDERLERİ',                      'expense',   false, '6',   false, true),
      ('660', 'KISA VADELİ BORÇLANMA GİDERLERİ',          'expense',   true,  '66',  false, true),
      ('7',   'MALİYET HESAPLARI',                        'expense',   false, null,  false, true),
      ('76',  'PAZARLAMA SATIŞ VE DAĞITIM GİDERLERİ',     'expense',   false, '7',   false, true),
      ('760', 'PAZARLAMA SATIŞ VE DAĞITIM GİDERLERİ',     'expense',   true,  '76',  false, true),
      ('77',  'GENEL YÖNETİM GİDERLERİ',                  'expense',   false, '7',   false, true),
      ('770', 'GENEL YÖNETİM GİDERLERİ',                  'expense',   true,  '77',  false, true)
    ) as x(code, name, type, is_leaf, parent_code, requires_partner, is_pl)
    order by length(x.code), x.code
  loop
    insert into finance.accounts (tenant_id, code, name, type, is_leaf, parent_id, requires_partner, is_pl)
    values (p_tenant_id, r.code, r.name, r.type::finance.account_type, r.is_leaf,
            (select id from finance.accounts
              where tenant_id = p_tenant_id and code = r.parent_code),
            r.requires_partner, r.is_pl)
    on conflict (tenant_id, code) do nothing;
  end loop;

  -- Yevmiyeler
  insert into finance.journals (tenant_id, code, name, kind) values
    (p_tenant_id, 'SATIS', 'Satış Faturaları', 'sale'),
    (p_tenant_id, 'ALIS',  'Alış Faturaları',  'purchase'),
    (p_tenant_id, 'KASA',  'Kasa',             'cash'),
    (p_tenant_id, 'BANKA', 'Banka',            'bank'),
    (p_tenant_id, 'GENEL', 'Genel',            'general')
  on conflict do nothing;

  -- Hesap eşlemeleri — otomatik kayıtların hangi hesabı kullanacağı
  insert into finance.account_mappings (tenant_id, key, account_id)
  select p_tenant_id, m.key, a.id
  from (values
    ('receivable',              '120'),
    ('payable',                 '320'),
    ('vat_output',              '391'),
    ('vat_input',               '191'),
    ('vat_withholding_payable', '360'),
    ('sales_income',            '600'),
    ('sales_discount',          '611'),
    -- Varsayılan (stoklu işletme): alışlar stoka girer. Hizmet işletmesi bunu
    -- muhasebe ayarlarından 770'e çevirebilir.
    ('purchase_expense',        '153'),
    ('cash',                    '100'),
    ('bank',                    '102'),
    ('period_profit',           '590')
  ) as m(key, code)
  join finance.accounts a on a.tenant_id = p_tenant_id and a.code = m.code
  on conflict (tenant_id, key) do nothing;

  -- Belge numaraları
  insert into core.sequences (tenant_id, code, prefix, padding, period) values
    (p_tenant_id, 'finance_journal',          'YEV-', 6, 'year'),
    (p_tenant_id, 'finance_sale_invoice',     'SFT-', 6, 'year'),
    (p_tenant_id, 'finance_purchase_invoice', 'AFT-', 6, 'year'),
    (p_tenant_id, 'finance_payment',          'TAH-', 6, 'year'),
    -- ÇEK VE SENET AYRI SERİ: ikisi ayrı kıymetli evrak türü ve muhasebe
    -- ikisini ayrı takip eder. Seri satırı yoksa `core.next_sequence` kodun
    -- ilk üç harfinden ön ek türetir -- `finance_cek` ve `finance_senet`
    -- için ikisi de 'FIN-' olur ve numaralar çakışır.
    (p_tenant_id, 'finance_cek',              'CEK-', 6, 'year'),
    (p_tenant_id, 'finance_senet',            'SNT-', 6, 'year')
  on conflict do nothing;

  -- İçinde bulunulan mali yıl ve ayları
  insert into finance.fiscal_years (tenant_id, name, date_from, date_to)
  values (p_tenant_id, to_char(v_year, 'YYYY'), v_year,
          (v_year + interval '1 year - 1 day')::date)
  on conflict do nothing;
end;
$$;

select core.register_provisioner('finance', 'finance.provision_finance', 30::smallint);
