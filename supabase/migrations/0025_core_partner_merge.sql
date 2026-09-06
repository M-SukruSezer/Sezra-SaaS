-- =============================================================================
-- 0025 — Mükerrer cari birleştirme
--
-- Aynı firmanın iki kez açılması, elle veri girilen her sistemde olur:
-- "ABC Ltd." ve "ABC Limited". İkisi de belge taşımaya başladıktan sonra
-- birini silmek mümkün değildir — silinen carinin faturaları öksüz kalır.
--
-- BİRLEŞTİRME KAYITLARI TAŞIR, SİLMEZ. Kaynak carinin tüm belgeleri hedefe
-- bağlanır, kaynak PASİFE alınır ve adına "(birleştirildi)" düşülür. Kayıt
-- durur çünkü denetim izi ona bakıyor olabilir.
--
-- YABANCI ANAHTARLAR DİNAMİK BULUNUR. Elle bir tablo listesi yazılsaydı, yeni
-- bir modül eklendiğinde o modülün cari bağlantısı listeye eklenmeyi unutulur
-- ve birleştirme o tabloyu SESSİZCE atlardı -- yani veri, kimsenin fark
-- etmeyeceği bir yerde bozulurdu. Katalogdan okumak bunu imkânsız kılar.
-- =============================================================================
set client_min_messages = warning;

/**
 * İki cariyi birleştirir: kaynağın her kaydı hedefe geçer.
 *
 * Aynı kiracıda olmaları şart: farklı kiracıların carilerini birleştirmek,
 * kiracı izolasyonunu uygulama katmanından delmek olurdu.
 */
create or replace function core.merge_partners(p_kaynak uuid, p_hedef uuid)
returns jsonb
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_tenant   uuid := core.current_tenant_id();
  v_kaynak   core.partners;
  v_hedef    core.partners;
  r          record;
  v_sayi     bigint;
  v_toplam   bigint := 0;
  v_rapor    jsonb := '{}'::jsonb;
begin
  if v_tenant is null then
    raise exception 'Aktif kiracı yok' using errcode = '42501';
  end if;
  if not core.has_perm('core.partner.write.all') then
    raise exception 'Cari birleştirme yetkiniz yok' using errcode = '42501';
  end if;
  if p_kaynak = p_hedef then
    raise exception 'Bir cari kendisiyle birleştirilemez' using errcode = '23514';
  end if;

  select * into v_kaynak from core.partners where id = p_kaynak and tenant_id = v_tenant;
  if not found then raise exception 'Kaynak cari bulunamadı' using errcode = 'P0002'; end if;
  select * into v_hedef from core.partners where id = p_hedef and tenant_id = v_tenant;
  if not found then raise exception 'Hedef cari bulunamadı' using errcode = 'P0002'; end if;

  -- core.partners'a işaret eden HER yabancı anahtar kolonu katalogdan bulunur.
  for r in
    select nsp.nspname as sema, cls.relname as tablo, att.attname as kolon
    from pg_constraint con
    join pg_class cls   on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid
                         and att.attnum = con.conkey[1]
    join pg_class hedef on hedef.oid = con.confrelid
    join pg_namespace hnsp on hnsp.oid = hedef.relnamespace
    where con.contype = 'f'
      and hnsp.nspname = 'core' and hedef.relname = 'partners'
      -- Tek kolonlu yabancı anahtarlar; bileşik anahtar bu şemada yok.
      and array_length(con.conkey, 1) = 1
      and cls.relkind = 'r'
    order by nsp.nspname, cls.relname
  loop
    execute format('update %I.%I set %I = $1 where %I = $2',
                   r.sema, r.tablo, r.kolon, r.kolon)
      using p_hedef, p_kaynak;
    get diagnostics v_sayi = row_count;
    if v_sayi > 0 then
      v_toplam := v_toplam + v_sayi;
      v_rapor := v_rapor || jsonb_build_object(
        format('%s.%s', r.sema, r.tablo), v_sayi);
    end if;
  end loop;

  -- Hedefte BOŞ olan iletişim alanları kaynaktan tamamlanır. Doldurulmuş bir
  -- alanın üzerine yazmak, kullanıcının hangi kaydı "doğru" seçtiği bilgisini
  -- yok saymak olurdu.
  update core.partners t set
    email        = coalesce(t.email, v_kaynak.email),
    phone        = coalesce(t.phone, v_kaynak.phone),
    website      = coalesce(t.website, v_kaynak.website),
    tax_no       = coalesce(t.tax_no, v_kaynak.tax_no),
    tax_office   = coalesce(t.tax_office, v_kaynak.tax_office),
    address      = coalesce(t.address, v_kaynak.address),
    district     = coalesce(t.district, v_kaynak.district),
    city         = coalesce(t.city, v_kaynak.city),
    postal_code  = coalesce(t.postal_code, v_kaynak.postal_code),
    iban         = coalesce(t.iban, v_kaynak.iban),
    sector       = coalesce(t.sector, v_kaynak.sector),
    credit_limit = coalesce(t.credit_limit, v_kaynak.credit_limit),
    notes        = coalesce(t.notes, v_kaynak.notes),
    -- Roller BİRLEŞİR: kaynak tedarikçiyse hedef de tedarikçi olur.
    is_customer  = t.is_customer or v_kaynak.is_customer,
    is_supplier  = t.is_supplier or v_kaynak.is_supplier,
    -- Etiketler tekilleştirilerek birleşir.
    tags = (select coalesce(array_agg(distinct e), '{}')
            from unnest(t.tags || v_kaynak.tags) e)
  where t.id = p_hedef;

  -- Kaynak SİLİNMEZ: denetim izi ve geçmiş raporlar ona bakıyor olabilir.
  update core.partners
     set is_active = false,
         name = case when name like '%(birleştirildi)' then name
                     else name || ' (birleştirildi)' end,
         notes = concat_ws(E'\n',
                   notes,
                   format('%s tarihinde "%s" carisine birleştirildi.',
                          to_char(now(), 'DD.MM.YYYY'), v_hedef.name))
   where id = p_kaynak;

  return jsonb_build_object(
    'tasinan', v_toplam,
    'tablolar', v_rapor,
    'kaynak', v_kaynak.name,
    'hedef', v_hedef.name);
end;
$$;

comment on function core.merge_partners(uuid, uuid) is
  'Mükerrer cariyi hedefe birleştirir. Yabancı anahtarlar katalogdan '
  'bulunur; kaynak silinmez, pasife alınır.';
