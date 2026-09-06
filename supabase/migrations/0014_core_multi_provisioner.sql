-- =============================================================================
-- 0014 — Bir modül birden fazla kurulum kancası kaydedebilsin
-- =============================================================================
-- 0012'de core.tenant_provisioners'ın birincil anahtarı yalnızca module_code'du,
-- yani modül başına TEK kanca. İkinci bir kanca kaydetmek, birincisini hata
-- vermeden EZİYORDU — sessiz veri kaybı sınıfı bir hata.
--
-- İhtiyaç somut: Bordro→Muhasebe köprüsü (0305), İK açık olan kiracıda finance
-- şemasına hesap eşlemesi kurar. Bu kanca 'hr' modülüne bağlıdır ama fonksiyonu
-- finance'a aittir; hr.provision_hr ile yan yana yaşaması gerekir.
--
-- Anahtar (module_code, fn_name) oluyor: aynı fonksiyonu iki kez kaydetmek hâlâ
-- idempotent, farklı fonksiyonlar ise birikiyor.
-- =============================================================================

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'core.tenant_provisioners'::regclass
      and contype = 'p'
      and array_length(conkey, 1) = 1
  ) then
    alter table core.tenant_provisioners drop constraint tenant_provisioners_pkey;
    alter table core.tenant_provisioners
      add constraint tenant_provisioners_pkey primary key (module_code, fn_name);
  end if;
end $$;

create index if not exists ix_tenant_provisioners_order
  on core.tenant_provisioners (sequence, module_code);

create or replace function core.register_provisioner(
  p_module text, p_fn text, p_sequence smallint default 100
)
returns void
language sql
as $$
  insert into core.tenant_provisioners (module_code, fn_name, sequence)
  values (p_module, p_fn, p_sequence)
  on conflict (module_code, fn_name) do update set sequence = excluded.sequence;
$$;
