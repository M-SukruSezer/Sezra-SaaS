-- =============================================================================
-- 0011 — Tutar hesaplama (KDV + tevkifat)  — Bölüm 6
-- =============================================================================
-- Satır tutarı hesabı satış, satın alma ve fatura modüllerinde birebir aynıdır.
-- Tek bir yerde tutulur ki "teklifte 1 kuruş, faturada 2 kuruş" farkı doğmasın.
--
-- Yuvarlama kuralı: her SATIR kendi içinde 2 haneye yuvarlanır, belge toplamı
-- yuvarlanmış satırların toplamıdır. (Toplamı yuvarlamak yerine satırı yuvarlamak
-- GİB e-Fatura doğrulamasının beklediği davranıştır.)
-- =============================================================================

create type core.line_amounts as (
  subtotal    numeric(18,2),
  tax         numeric(18,2),
  withholding numeric(18,2),
  total       numeric(18,2)
);

create or replace function core.compute_line_amounts(
  p_quantity     numeric,
  p_unit_price   numeric,
  p_discount_pct numeric default 0,
  p_tax_id       uuid default null
)
returns core.line_amounts
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_tax    core.taxes;
  v_out    core.line_amounts;
  v_gross  numeric;
begin
  v_gross := coalesce(p_quantity, 0) * coalesce(p_unit_price, 0)
             * (1 - coalesce(p_discount_pct, 0) / 100.0);
  v_out.subtotal := round(v_gross, 2);
  v_out.tax := 0;
  v_out.withholding := 0;

  if p_tax_id is not null then
    select * into v_tax from core.taxes where id = p_tax_id;
    if found and v_tax.kind <> 'exempt' then
      v_out.tax := round(v_out.subtotal * v_tax.rate / 100.0, 2);
      -- Kısmi tevkifat: hesaplanan KDV'nin num/den kadarı alıcıya devredilir,
      -- satıcının tahsil edeceği tutardan DÜŞÜLÜR.
      if v_tax.withholding_num is not null and v_tax.withholding_den is not null
         and v_tax.withholding_den <> 0 then
        v_out.withholding := round(v_out.tax * v_tax.withholding_num::numeric / v_tax.withholding_den, 2);
      end if;
    end if;
  end if;

  v_out.total := v_out.subtotal + v_out.tax - v_out.withholding;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- Genel satır/başlık tetikleyicileri
-- -----------------------------------------------------------------------------
-- Satır tutarlarını hesaplar. Her belge satırı tablosuna takılabilir; tablo
-- şu kolonları taşımalıdır: quantity, unit_price, discount_pct, tax_id,
-- line_subtotal, line_tax, line_withholding, line_total.
create or replace function core.fn_calc_document_line()
returns trigger
language plpgsql
as $$
declare v core.line_amounts;
begin
  v := core.compute_line_amounts(new.quantity, new.unit_price, new.discount_pct, new.tax_id);
  new.line_subtotal    := v.subtotal;
  new.line_tax         := v.tax;
  new.line_withholding := v.withholding;
  new.line_total       := v.total;
  return new;
end;
$$;

-- Başlık toplamlarını satırlardan yeniden hesaplar.
-- TG_ARGV[0] = başlık tablosu (şema.tablo), TG_ARGV[1] = satırdaki FK kolonu
create or replace function core.fn_recalc_document_totals()
returns trigger
language plpgsql
as $$
declare
  v_header text := tg_argv[0];
  v_fk     text := tg_argv[1];
  v_doc_id uuid;
begin
  v_doc_id := coalesce(
    (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> v_fk)::uuid, null);
  if v_doc_id is null then
    return null;
  end if;

  execute format($q$
    update %s h set
      subtotal          = coalesce(s.subtotal, 0),
      discount_total    = coalesce(s.discount_total, 0),
      tax_total         = coalesce(s.tax, 0),
      withholding_total = coalesce(s.withholding, 0),
      total             = coalesce(s.total, 0),
      updated_at        = now()
    from (
      select sum(l.line_subtotal) as subtotal,
             sum(round(l.quantity * l.unit_price, 2) - l.line_subtotal) as discount_total,
             sum(l.line_tax) as tax,
             sum(l.line_withholding) as withholding,
             sum(l.line_total) as total
      from %I.%I l where l.%I = $1
    ) s
    where h.id = $1
  $q$, v_header, tg_table_schema, tg_table_name, v_fk) using v_doc_id;

  return null;
end;
$$;

create or replace function core.attach_document_line_math(
  p_schema text, p_line_table text, p_header_table text, p_fk text
)
returns void
language plpgsql
as $$
begin
  execute format(
    'drop trigger if exists trg_%1$s_calc on %2$I.%1$I;
     create trigger trg_%1$s_calc before insert or update on %2$I.%1$I
       for each row execute function core.fn_calc_document_line();',
    p_line_table, p_schema);

  execute format(
    'drop trigger if exists trg_%1$s_totals on %2$I.%1$I;
     create trigger trg_%1$s_totals after insert or update or delete on %2$I.%1$I
       for each row execute function core.fn_recalc_document_totals(%3$L, %4$L);',
    p_line_table, p_schema, p_header_table, p_fk);
end;
$$;
