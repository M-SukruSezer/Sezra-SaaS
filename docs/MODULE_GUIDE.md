# Yeni Modül Ekleme Rehberi

Bir modül altı şeyi tanımlar: **şema, izinler, RLS, olaylar, kurulum kancası,
raporlar**. Aşağıdaki iskeleti izleyen bir modül, çekirdeğin sunduğu kiracı
izolasyonunu, şube kapsamını, denetim izini ve olay entegrasyonunu bedava alır.

Migration numaralandırması: `0001-0099` çekirdek, `0100+` modüller
(CRM 0100, Muhasebe 0200, İK 0300, Satın Alma 0400), `9999` yetkiler (daima son).

Bir modülün tablosuna referans veren köprü fonksiyonları, **o modülün numara
aralığında** yaşar — sahibi başka modül olsa bile. Bordro→Muhasebe köprüsü
(`0305_hr_finance_bridge.sql`) finance'a aittir ama hr.payroll_runs'a referans
verdiği için 0300'lerdedir. Dosya başındaki yorum bu sapmayı açıklamalıdır.

`1100+` aralığı kiracı modülü değildir: platform ve çekirdek-üstü özellikler
buradadır (destek erişimi, davet akışı, platform yöneticisi, mali müşavir
erişimi, mail hesabı/mesajları, cari sicil alanları). Her karta çakışmayı
önleyen bir alt aralık verilir.

### Dış servis entegrasyonu bir modül değil, bir adapter'dır

SMS, mail (IMAP/POP3/SMTP) ve VKN'den firma bilgisi gibi üçüncü taraf
servisler yeni bir kiracı modülü açmaz. Kalıp `core/src/<alan>/` altında
sabittir: `types.ts` (sağlayıcı arayüzü) + `registry.ts` (kayıt + seçim) +
sağlayıcı adapter dosyaları (`netgsm.ts`, `gib.ts`, …). Ürünün geri kalanı
somut sağlayıcıya değil arayüze bağlanır; sağlayıcı değişince form ve uç
değişmez. Yeni bir dış servis bağlarken **bu kalıbı kopyalayın, yeni mimari
icat etmeyin.** İzin/onay kontrolleri (İYS izni, salt-okunur uçlar) arayüz
katmanında değil `core` fonksiyonlarında yaşamalıdır — API'yi doğrudan çağıran
bir entegrasyon da aynı sınıra takılsın.

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

### Eylem izni tek başına yetmez

İş akışı fonksiyonları satırı `select ... for update` ile kilitler. PostgreSQL
bu kilit için SELECT politikasına **ek olarak UPDATE politikasının da** geçmesini
ister. Yani bir role `...approve` vermek yeterli değildir; ilgili varlıkta
`write` izni de gerekir:

```sql
-- YANLIŞ: rol hiçbir talebi onaylayamaz, "kayıt bulunamadı" hatası alır
select core.grant_to_role('branch_manager', array['purchasing.requisition.approve']);

-- DOĞRU
select core.grant_to_role('branch_manager', array[
  'purchasing.requisition.approve', 'purchasing.requisition.write.all']);
```

Bir eylem BAŞKA bir varlığı da güncelliyorsa onun write izni de gerekir —
örneğin mal kabul, sipariş satırlarının `received_quantity` alanını ilerlettiği
için `purchasing.order.write.all` ister. Bu sınıf hata çalışma zamanında
"kayıt bulunamadı" olarak görünür ve yetki sorunu gibi durmaz; rol testi yazmak
tek güvenilir yakalama yöntemidir.

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

### Tetikleyici sırası ad sırasıdır

PostgreSQL, aynı olaydaki BEFORE tetikleyicilerini **ad sırasına göre** çalıştırır.
Çekirdeğin `tenant_id`/`owner_id`/`created_by` dolduran tetikleyicisi bu yüzden
`trg_00_` önekiyle adlandırılır ve her zaman ilk çalışır.

Modül tetikleyicinizde `new.tenant_id` okuyorsanız bu garantiye güvenebilirsiniz.
Ama daha sağlamı, değeri **ilişkili satırdan** almaktır:

```sql
-- Kırılgan: çekirdek tetikleyicisinin önce çalışmasına bağlı
new.hourly_cost := projects.hourly_cost_for(new.tenant_id, ...);

-- Sağlam: değer zaten okunan üst kayıttan gelir
select * into v_proj from projects.projects where id = new.project_id;
new.hourly_cost := projects.hourly_cost_for(v_proj.tenant_id, ...);
```

Bu sınıf hata **sessizdir**: `tenant_id` NULL olunca sorgu satır bulamaz ve
fonksiyon sıfır döner — hata vermez, yalnızca yanlış hesaplar.

### `.own` kapsamı owner_id'ye bakar

Kayıt bazlı yetki `owner_id = core.current_user_id()` üzerinden çalışır ve
çekirdek varsayılanı owner_id'yi **kaydı oluşturan** kişi yapar. Bazı varlıklarda
sahiplik bu değildir: bir zaman kaydının sahibi onu giren yönetici değil, saati
çalışan kişidir. Böyle durumlarda modül tetikleyicisi owner_id'yi bilerek ezer:

```sql
new.owner_id := new.user_id;   -- sahip, çalışan kişidir
```

Atlanırsa kullanıcı kendi kaydını `.own` kapsamında göremez.

### Handler'lar oturum bağlamına GÜVENEMEZ

Olay işleyici arka planda, kullanıcı oturumu olmadan çalışır. `core.current_tenant_id()`
orada `NULL` döner. Bu yüzden handler'dan çağrılan her şey kiracıyı AÇIKÇA
almalıdır:

```sql
-- YANLIŞ: handler içinde "aktif kiracı bulunamadı" ile düşer
perform core.emit_event('inventory.move.done', payload, v_branch);
select core.next_sequence('inventory_move', v_branch);

-- DOĞRU
perform core.emit_event('inventory.move.done', payload, v_branch, null, v_tenant);
select core.next_sequence('inventory_move', v_branch, v_tenant);
```

Bir fonksiyon hem kullanıcı isteğinden hem handler'dan çağrılabiliyorsa
(ör. `inventory.post_move`), kiracıyı işlediği SATIRDAN okumalıdır — oturumdan
değil.

## 6. Kurulum kancası

Yeni kiracıda modülün varsayılan verisini kuran fonksiyon:

```sql
create function finance.provision_finance(p_tenant_id uuid) returns void
language plpgsql security definer as $$ ... $$;

select core.register_provisioner('finance', 'finance.provision_finance', 30::smallint);
```

`core.provision_tenant()` yalnızca kiracıda **açık** modüllerin kancalarını
çağırır — çekirdek, modüllerin içeriğini bilmez.

Bir modül **birden fazla** kanca kaydedebilir; sıra `sequence` ile belirlenir.
Bu, modüller arası köprüler için gerekli: örneğin bordro hesap eşlemelerini
kuran kanca `finance` şemasına aittir ama `hr` modülüne bağlıdır, çünkü yalnızca
İK açık olan kiracıda anlamlıdır:

```sql
select core.register_provisioner('hr', 'finance.provision_payroll_accounts', 45::smallint);
```

## 7. Raporlar

```sql
create or replace view finance.v_trial_balance
with (security_invoker = on) as ...
```

`security_invoker = on` **zorunludur**; unutulursa test paketi kırılır.

RLS politikası, kullanıcının **başka bir tabloyu** okuyabilmesine dayanmamalıdır.
`inventory.quants` politikası önce konumun şubesini `inventory.locations`'tan
okuyordu; stok adedini görmesi gereken ama konum kartlarını görmesi gerekmeyen
satış temsilcisi boş liste alıyordu ve sebep politikadan okunmuyordu. Doğrusu,
gerekli bilgiyi `security definer` bir yardımcıyla üretmektir:

```sql
create function inventory.accessible_location_ids() returns uuid[]
language sql stable security definer as $$ ... $$;

-- politikada: (select inventory.accessible_location_ids()) @> array[location_id]
```

Yardımcı **argümansız** olmalıdır — o zaman `(select ...)` ile sarmalandığında
satır başına değil sorgu başına bir kez çalışır.

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
