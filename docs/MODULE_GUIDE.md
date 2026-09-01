# Yeni Modül Ekleme Rehberi

Bir modül altı şeyi tanımlar: **şema, izinler, RLS, olaylar, kurulum kancası,
raporlar**. Aşağıdaki iskeleti izleyen bir modül, çekirdeğin sunduğu kiracı
izolasyonunu, şube kapsamını, denetim izini ve olay entegrasyonunu bedava alır.

Migration numaralandırması: `0001-0099` çekirdek, `0100+` modüller
(CRM 0100, Muhasebe 0200, İK 0300, Satın Alma 0400), `9999` yetkiler (daima son).

## 1. Modülü kaydet

```sql
select core.register_module('finance', 'Muhasebe & Finans', 1::smallint, '{core}', false,
       'Tekdüzen hesap planı, yevmiye, KDV, fatura');
```

## 2. Tabloları oluştur

Kiracıya ait her tablo şu kolonları taşımalı:

| Kolon | Zorunlu mu | Ne işe yarar |
|---|---|---|
| `tenant_id uuid not null` | **evet** | kiracı izolasyonu |
| `branch_id uuid` | şube kırılımı gerekiyorsa | şube kapsamı |
| `owner_id uuid` | kayıt bazlı yetki gerekiyorsa | `.own` kapsamı |
| `created_by`, `updated_by` | önerilir | otomatik doldurulur |
| `created_at`, `updated_at` | evet | `updated_at` otomatik |

## 3. Tabloyu çekirdeğe bağla

Tek çağrı; tetikleyiciler + RLS + denetim izi + indeksler birlikte gelir:

```sql
select core.register_tenant_table(
  'finance',        -- şema
  'invoices',       -- tablo
  'finance.invoice',-- izin kodu ön eki
  true,             -- branch_id var mı
  true              -- owner_id var mı
);
```

Belge satırı tabloları ayrı izin kodu almaz; yetkiyi başlıktan devralır
(örnek: `0101_crm_logic.sql` içindeki satır politikası döngüsü).

Belge satırlarında tutar hesabı için:

```sql
select core.attach_document_line_math('finance', 'invoice_lines', 'finance.invoices', 'invoice_id');
```

## 4. İzinleri tanımla ve rollere dağıt

```sql
select core.declare_entity_permissions('finance', 'invoice', 'Fatura');
select core.declare_permission('finance.invoice.approve', 'finance', 'finance.invoice',
                               'approve', 'Fatura onayla');

select core.grant_module_to_role('tenant_admin', 'finance');
select core.grant_to_role('accounting', array['finance.invoice.read.all', ...]);
```

`core.grant_to_role` tanımsız bir izin kodu verilirse **hata verir** — sessizce
yutmaz.

## 5. Olayları tanımla ve abone ol

Yayınlayacağın olayları önce bildir:

```sql
select core.declare_event('finance.invoice.posted', 'finance', 'Fatura muhasebeleşti');
```

Başka modülün olayına abone ol:

```sql
select core.subscribe('sales.order.confirmed', 'finance', 'finance.on_sales_order_confirmed');
```

Handler imzası sabittir:

```sql
create function finance.on_sales_order_confirmed(p_event jsonb) returns void ...
-- p_event = { id, tenant_id, branch_id, topic, payload, actor_id, occurred_at }
```

Handler **idempotent** olmalıdır: yeniden deneme mekanizması aynı olayı ikinci
kez teslim edebilir.

## 6. Kurulum kancası

Yeni kiracıda modülün varsayılan verisini kuran fonksiyon:

```sql
create function finance.provision_finance(p_tenant_id uuid) returns void
language plpgsql security definer as $$ ... $$;

select core.register_provisioner('finance', 'finance.provision_finance', 30::smallint);
```

`core.provision_tenant()` yalnızca kiracıda **açık** modüllerin kancalarını
çağırır — çekirdek, modüllerin içeriğini bilmez.

## 7. Raporlar

```sql
create or replace view finance.v_trial_balance
with (security_invoker = on) as ...
```

`security_invoker = on` **zorunludur**; unutulursa test paketi kırılır.

## 8. Test yaz

`supabase/tests/` altına ekle. En az şunlar sınanmalı:

- başka kiracının kullanıcısı bu modülün verisini göremez
- şube kısıtlı kullanıcı yalnızca kendi şubesini görür
- `.own` kapsamlı rol yalnızca kendi kayıtlarını görür
- modül kapatılınca erişim biter
- yayınlanan olaylar `core.events`'e düşer

```bash
bash scripts/test.sh
```
