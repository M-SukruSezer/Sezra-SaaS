# 07 - Sezra SaaS ile Odoo 20 Mimari Karşılaştırması

Bu doküman, [01](01-module-architecture-map.md)-[06](06-reference-tables.md)
arasındaki Odoo 20 ölçümlerini Sezra SaaS'ın kendi kod tabanıyla karşılaştırır.
Sezra tarafındaki her iddia `core/`, `modules/`, `apps/` ve
`supabase/migrations/` okunarak doğrulanmıştır; satır numaraları verilmiştir.

Doküman Türkçe yazıldı çünkü Sezra'nın kod yorumları Türkçe. Diğer REA
dokümanları İngilizce kalıyor (Odoo kaynağı İngilizce).

## Özet: iki farklı felsefe

**Odoo**, iş mantığını Python'a koyar ve modülleri *birbirini genişleterek*
bağlar. 693 modülün 401'i (%58) yalnızca iki modülü uzlaştırmak için var olan
`auto_install` köprüsüdür. Bağımlılık grafiği kum saati biçiminde, en derin
zincir 16 katman.

**Sezra**, iş mantığını PostgreSQL fonksiyonlarına koyar ve modülleri *olaylarla*
bağlar. TypeScript katmanında çapraz modül bağımlılığı **sıfırdır**: 11 modülün
hepsi yalnızca `@sezra/core`'a bağlıdır (her `modules/*/package.json`'da
`dependencies: { "@sezra/core": "*", "fastify": "^5.2.0" }`). Topoloji yıldız,
derinlik 1.

Bu, Sezra'nın "daha küçük Odoo" olmadığı anlamına gelir. Farklı bir tasarım ve
birkaç önemli noktada **daha sağlam** bir tasarım.

## Yapısal karşılaştırma

| Boyut | Odoo 20 Community | Sezra SaaS |
|---|---|---|
| Modül sayısı | 693 | 11 + `core` |
| Köprü modül | 401 `auto_install` | 0 (TS); köprüler SQL fonksiyonu |
| Topoloji / derinlik | Kum saati, 16 | Yıldız, 1 |
| İş mantığının yeri | Python (4.224 model sınıfı) | PostgreSQL fonksiyonları |
| Modül sözleşmesi | `__manifest__.py` (depends, auto_install, assets, category...) | `SezraModule { code, register }` (`core/src/module.ts`) + `core.modules` satırı |
| Bağımlılık beyanı | `depends`, yükleyici **uygular** | `core.modules.depends_on` var, **uygulanmıyor** |
| Çapraz modül entegrasyon | Boş hook + `getattr` dinamik dağıtım + köprü modül | Olay otobüsü + SQL köprü fonksiyonları |
| Olay otobüsü | **Yok** | Outbox + LISTEN/NOTIFY + yoklama + sözleşme |
| Olay sözleşmesi | - | `core.declare_event(topic, module, description, payload_doc)` |
| Yetki modeli | `ir.access`: 2.587 satır, 531'i domain'li | RLS politikaları + `core.permissions` |
| Çok kiracılılık sınırı | `res.company` + kayıt kuralları (uygulama katmanı) | Postgres RLS + GUC (**veritabanı katmanı**) |
| Model genişletme | `_inherit`: `res.config.settings`'i 134 modül açıyor | Yok — şema sahipliği tek modülde |
| Kiracı başına modül | Veritabanı başına kurulum | `core.tenant_modules` + `core.plan_modules` |
| Alan sayısı uç örnek | `res.config.settings` 784, `account.move` 537 | Şema başına sahiplik sayesinde böyle bir birikim yok |

## Sezra'nın Odoo'dan daha iyi olduğu beş nokta

Bunlar övgü değil, karşılaştırmalı ölçüm sonucu.

**1. Gerçek bir olay otobüsü var; Odoo'da hiç yok.**
`core.emit_event` / `core.subscribe` / `core.declare_event`
(`supabase/migrations/0007_core_event_bus.sql`), kalıcı outbox tablosu,
LISTEN/NOTIFY ile düşük gecikme **ve** periyodik tarama ile dayanıklılık
(`core/src/events.ts`). Odoo'nun karşılığı, bir modülün boş bir metot bırakıp
diğerinin onu `super()` ile ezmesidir — yani kuyruk, yeniden deneme, ölü mektup
kutusu yok. `core.declare_event`'in `payload_doc` alanı ise Odoo'da karşılığı
olmayan bir şey: olayın **sözleşmesi** veritabanında belgelenmiş.

**2. Yetki sınırı veritabanında, uygulamada değil.**
`core/src/db.ts` bağlamı GUC'larla taşıyor (`app.user_id`, `app.tenant_id`,
`app.support_mode`, `app.accountant_mode`) ve `set local` kullandığı için
transaction bitince düşüyor — havuzdaki bir bağlantı sonraki isteğe önceki
kullanıcının kimliğiyle geçemiyor. Üstüne `assertSafeDbRole()` açılışta etkin
rolün BYPASSRLS/superuser olmadığını doğruluyor (`core/src/app.ts:15`).
Odoo'da yetki Python'da uygulanır ve herhangi bir `sudo()` çağrısı onu atlar;
`account.move._post` içindeki `AccessError` kontrolü
(`account/models/account_move.py:6153`) bunun tipik örneğidir — kod disiplinine
bağlı bir sınır, yapısal bir sınır değil.

**3. Çapraz modül bağımlılığı sıfır.**
Odoo'da `account` modülünün 157 doğrudan bağımlısı var ve `account.move` 114
modül tarafından açılıyor. Sezra'da her modül tek bir şemaya sahip ve
TypeScript'ten yalnızca kendi şemasına dokunuyor (her modülde tek bir
`schema: '<kendi adı>'` değeri). Bu, Odoo'nun 784 alanlı
`res.config.settings`'inin Sezra'da oluşmasını yapısal olarak engelliyor.

**4. SaaS kiracılığı modelin içinde.**
`core.tenant_modules` (kiracı başına aç/kapa) ve `core.plan_modules` (plana göre
yetkilendirme) ile aynı veritabanında çok kiracılı modül yönetimi var. Odoo'da
modül kurulumu veritabanı başınadır; müşteri başına ayrı veritabanı gerekir.

**5. API yüzeyi beyan temelli ve beyaz listeli.**
`ResourceDef` (`core/src/resource.ts`) okunabilir ve yazılabilir kolonları ayrı
ayrı beyaz listeliyor; `tenant_id` yazılabilir listeye hiç konmuyor, veritabanı
dolduruyor. Odoo'da bir alanın API'den dönüp dönmeyeceği örtüktür.

## Somut öneriler

Önem sırasına göre. Her biri okunan koda dayanıyor.

### P1 — `depends_on` beyan ediliyor ama uygulanmıyor

**Bulgu.** `core.modules.depends_on text[]` kolonu var
(`supabase/migrations/0002_core_tenants_users.sql`) ve `core.register_module`
onu dolduruyor. Ancak açılıştaki doğrulama yalnızca modülün *var olup
olmadığına* bakıyor (`core/src/app.ts:152-163`):

```ts
const registered = await sql<{ code: string }[]>`select code from core.modules`;
const known = new Set(registered.map((r) => r.code));
for (const mod of opts.modules) {
  if (!known.has(mod.code)) { throw new Error(...); }
  await mod.register(app);
}
```

`depends_on` hiç okunmuyor. Ayrıca yükleme sırası `apps/api/src/modules.ts`
dizisindeki **elle yazılmış sıraya** bağlı.

**Neden önemli.** Odoo'nun yükleyicisi `depends`'i topolojik olarak sıralar ve
eksik bağımlılıkta kurulumu reddeder. Sezra'da `finance` olmadan `purchasing`
yüklenebilir; `0404_purchasing_finance_bridge.sql` içindeki
`finance.on_purchase_receipt_confirmed` yine kayıtlı kalır ve çalışmaya çalışır.

**Durum: DÜZELTİLDİ.** `core/src/module.ts` içine saf bir
`resolveModuleOrder(modules, registry)` fonksiyonu eklendi; kapıda üç şeyi
doğruluyor (kayıtlı mı, bağımlılıkları yükleniyor mu, döngü var mı) ve yükleme
sırasını `depends_on`'dan türetiyor. `core/src/app.ts:157` artık diziyi değil
bu sırayı geziyor, yani `modules.ts`'deki elle sıra yalnızca "hangi modüller"
sorusunu yanıtlıyor. Testler: `apps/api/test/module_deps.test.ts` (8 iddia,
hepsi geçiyor). Fonksiyon veritabanına dokunmadığı için testinin çoğu DB
gerektirmiyor.

### P1 — Dağıtım, modül aktifliğini teslimat anında yeniden sormuyordu (TOCTOU)

**Bu maddenin ilk hâli yanlıştı; düzeltilmiş hâli aşağıda.** İlk yazımda
"kapalı bir modülün handler'ı yeni olaylarda da çalışır" demiştim. Yanlış:
`core.emit_event` fan-out sırasında hem `core.tenant_modules.enabled` hem
`s.is_active` kontrolü yapıyor, yani yeni bir olay kapalı modüle hiç
teslimat üretmiyor. Bunu `emit_event`'i okumadan, yalnızca `dispatch_events`'e
bakarak yazmıştım. Aynı hatayla abonelik sayısını da 7 sanmıştım; gerçek sayı
**13** (grep deseni çok satırlı çağrıları kaçırmış).

**Gerçek bulgu.** Kontrol yalnızca KUYRUĞA ALMA anında yapılıyordu; dağıtım
anında bir daha sorulmuyordu. `core.dispatch_events`'in seçim sorgusu ne
`tenant_modules.enabled`'a ne de `s.is_active`'e bakıyordu:

```sql
where d.status in ('pending', 'failed')
  and d.next_attempt_at <= now()
```

**Sonuç.** Handler ilk denemede hata alıp geri çekilmede beklerken yönetici
modülü kapatırsa, sonraki turda handler yine çalışıyordu. Kiracı kapattığı
modülün verisini üretmeye devam ediyordu. Aboneliğin sonradan
pasifleştirilmesi için de aynısı geçerliydi. Testle gösterildi: modül
kapatıldıktan sonra prob handler çağrıldı (`prob satırı = 1`).

**Durum: DÜZELTİLDİ.** `supabase/migrations/1310_core_olay_dagitim_sertlestirme.sql`
seçim sorgusuna `core.tenant_modules` join'i ve `s.is_active` koşulunu ekliyor.
Koşulu sağlamayan teslimat **silinmiyor**, kuyrukta bekliyor — modül yeniden
açılırsa kaldığı yerden devam ediyor. ('skipped' durumu `core.event_status`
enum'ında yok ve geçici kapatmayı 'dead' saymak işi kalıcı olarak çöpe atardı.)

### P1 — Yeniden deneme sayacı hiç artmıyordu (sonsuz döngü)

Bu, yukarıdakini test ederken çıktı ve ikisinden de ciddiydi.

**Bulgu.** `core.dispatch_events` handler'ı `begin ... exception` bloğu içinde
çağırıyor. PL/pgSQL'de bu blok örtük bir savepoint kurar: handler hata
verdiğinde blok içindeki

```sql
update core.event_deliveries set status = 'processing', attempts = attempts + 1
```

güncellemesi de **geri alınır**. Eski exception işleyicisi `attempts` kolonunu
hiç atamadığı için sayaç sıfırda kalıyordu.

**Ölçüm.** `max_attempts = 5` olan bir teslimat, kasten hata veren bir
handler'la 6 tur dağıtıldıktan sonra: `attempts = 0`, `status = 'failed'`.

**Sonuç.** `attempts + 1 >= max_attempts` koşulu asla sağlanmıyor, teslimat
asla `'dead'` olmuyor ve geri çekilme de hep `power(3, 0) = 1` saniye olarak
hesaplanıyordu. Yani kalıcı olarak hata veren tek bir olay, veritabanına karşı
**saniyede bir dönen sonsuz bir döngüye** dönüşüyordu; özenle tasarlanmış
ölü-mektup mekanizması hiç devreye girmiyordu. Kodun yorumu "üstel geri
çekilme ile yeniden dene" diyor — niyet açık, uygulama sessizce çalışmıyordu.

**Durum: DÜZELTİLDİ.** Aynı migration'da deneme sayısı cursor'dan gelen
`r.attempts` üzerinden yeniden hesaplanıp açıkça yazılıyor. Test: 3 denemeden
sonra `attempts = 3`, `status = 'dead'`, `last_error = 'P0001...'`.

### P2 — Köprü sahipliği ve migration numaralandırması çelişiyor

**Bulgu.** `0404_purchasing_finance_bridge.sql` bir `finance.*` fonksiyonu
tanımlıyor ama `purchasing` aralığındaki (04xx) bir numarada duruyor. Dosyanın
kendi yorumu bunu kabul ediyor:

> "buradaki fonksiyon FINANCE modülüne aittir, migration sırası yüzünden bu
> numarada duruyor."

Aynı durum `0305` (bordro köprüsü), `0803_pos_bridge_reports.sql`,
`0903_projects_bridge_reports.sql` ve `1200_crm_instant_sale.sql` için de
geçerli.

**Neden önemli.** Odoo bu sorunu köprüyü **ayrı bir modül** yaparak çözer:
`sale_stock` kendi manifest'ine, kendi `depends`'ine ve kendi kurulum/kaldırma
yaşam döngüsüne sahiptir. Sezra'da köprü, iki modülden birinin numara
aralığında duran bir migration dosyası; sahipliği yalnızca yorumdan anlaşılıyor.

**Öneri.** Köprüleri kendi numara aralığına veya ön ekine taşı (ör. `9xxx` ya da
`bridge_<a>_<b>_`), `core.modules`'a köprü kaydı aç
(`code = 'purchasing_finance'`, `depends_on = '{purchasing,finance}'`) ve
aboneliği o köprü koduna bağla. Böylece P1'deki iki kontrol köprüleri de
kapsar ve "bu fonksiyon kime ait" sorusu yorumdan veriye taşınır.

### P2 — Genişletme noktası yok

**Bulgu.** Sezra'da bir modülün başka bir modülün davranışını değiştirmesinin
yolu yok. Odoo'nun `_inherit`'i tam olarak bunu yapar: 4.224 sınıf 1.489 modeli
oluşturuyor, yani ortalama bir model 2,8 sınıftan derleniyor.

**Değerlendirme.** Bu şu an bir **özellik**, hata değil: Odoo'nun
`res.config.settings`'i 134 modül tarafından açıldığı için 784 alana ulaşmış.
Ama müşteriye özel davranış ya da eklenti ihtiyacı doğduğunda mekanizma yok.

**Öneri.** Yeni bir soyutlama eklemeden önce **var olanı kullan**: olay otobüsü
zaten bir genişletme noktası. İhtiyaç çıktığında `core.subscribe` ile
müşteri-özel handler bağlamak, `_inherit` benzeri bir metot ezme mekanizması
kurmaktan çok daha güvenli. Odoo'nun frontend tarafındaki ölçüm bunu
destekliyor: 764 `patch()` çağrısı (kayıt defteri yerine doğrudan ezme) yükseltmede
sessizce kırılan kısımdır; `fields` kayıt defterine eklenen 360 widget kırılmaz.
İsim üzerinden sözleşme, ezilen gövde üzerinden sözleşmeden daha dayanıklıdır.

### P3 — Migration numaralandırması karışmış

**Bulgu.** 120 migration'ın 119'u 4 haneli ön ek (`0001`-`1309`), biri 14 haneli
zaman damgası (`20261017132244_mesaj_media_preferences.sql`) kullanıyor.

**Öneri.** Birini seç. Elle 4 haneli numara, köprü sahipliği sorununu
(P2) besliyor ve iki geliştirici aynı numarayı aldığında çarpışıyor; zaman
damgası bunu çözer ama okunabilir sıralamayı kaybettirir. Dosya adında modül
kodunu tutmak (`<zaman>_<modül>_<konu>.sql`) ikisini birleştirir.

### P3 — Modül kaldırma semantiği yok

**Bulgu.** `core.modules`'a kayıt var, `core.tenant_modules` ile aç/kapa var,
ama bir modülün şemasını/verisini kaldırma yolu yok. Odoo'da kaldırma
(`uninstall`) modelin tablolarını ve `ir.access` satırlarını temizler.

**Öneri.** Şimdilik gerekmiyorsa yapma; ama `tenant_modules.enabled = false`
durumunda o modülün verisinin ne olacağını (erişilemez mi, silinir mi, dondurulur
mu) yazılı bir karara bağla. Şu anda kapalı bir modülün verisi yazılmaya devam
ediyor (P1, ikinci madde).

## Uygulanan düzeltmeler ve test durumu

| Değişiklik | Dosya | Test |
|---|---|---|
| `depends_on` kapısı + topolojik yükleme sırası | `core/src/module.ts` (yeni `resolveModuleOrder`), `core/src/app.ts:157`, `core/src/index.ts` | `apps/api/test/module_deps.test.ts` — 8 iddia |
| Dağıtımda modül aktifliği ve abonelik durumu yeniden kontrolü | `supabase/migrations/1310_core_olay_dagitim_sertlestirme.sql` | `supabase/tests/20_modul_bagimlilik.sql` — bölüm 1-3 |
| Yeniden deneme sayacının artması + `dead` durumu | aynı migration | aynı test — bölüm 4 |

**Ölçülen sonuçlar.**

- `npm run test:db`: TÜM VERİTABANI TESTLERİ GEÇTİ (migration sıfırdan
  kurulan şemaya da uygulandı).
- `npm run test:api`: 285 test, 277 geçti, 8 başarısız.

**O 8 başarısız test benim değişikliğimden kaynaklanmıyor.** Yükleme sırasını
geçici olarak eski hâline (dizi sırası) alıp paketi tekrar çalıştırdım: aynı
3 test grubu (`IMAP çekme + senkron`, `POP3 çekme`, `SMTP gönderme`) yine
başarısız, toplam 9 (fazlası benim yeni testim, henüz düzeltme yokken).
Yani bu üç dosya **önceden bozuk**: mail hesabı oluşturma ucu 201 yerine 400
dönüyor. Kapsam dışı bıraktım; istersen ayrıca bakarım.

## Odoo'dan almaya değmeyecek olanlar

Karşılaştırmanın diğer yarısı: ölçümlerin kopyalanmaması gerektiğini gösterdiği
desenler.

| Odoo deseni | Ölçüm | Neden alınmamalı |
|---|---|---|
| Model genişletme serbestliği | `res.config.settings` 784 alan, `account.move` 537 alan / 271 compute | Sezra'nın tek-şema-tek-sahip kuralı bu birikimi engelliyor; bırakma |
| `auto_install` köprü bolluğu | 693 modülün 401'i köprü | Modül sayısını yapay şişiriyor; Sezra'nın olay otobüsü aynı işi daha az parçayla yapıyor |
| Frontend `patch()` | 764 çağrı; `portal_rating` 16 patch / 0 bileşen | Yükseltmede sessizce kırılır; kayıt defteri deseni tercih edilmeli |
| Derin bağımlılık zinciri | 16 katman, modüllerin %59'u 9-11. katmanda | Sezra'nın yıldız topolojisi daha anlaşılır; korunmalı |
| Kategori alanının serbestliği | Bir manifest'te kategori olarak `Send sms to customer for order confirmation` yazıyor | Serbest metin alanları doğrulanmazsa böyle bozulur |

## Doğrulanmamış ve kapsam dışı

1. **Üç P1 bulgusu artık gözlem, çıkarım değil** — testle üretildi ve
   düzeltildi (yukarıdaki tablo). Dokümanın geri kalanı (mimari
   karşılaştırma, Odoo ölçümleri) hâlâ statik okumaya dayanıyor.
   Bu dokümanın ilk hâlindeki iki iddia test sırasında yanlış çıktı ve
   düzeltildi; ikisi de `emit_event`'i okumadan yazdığım için oluşmuştu.
2. **RLS politikalarının kendisi denetlenmedi.** `core/src/db.ts`'nin bağlamı
   doğru taşıdığı okundu; politikaların her tabloda doğru yazıldığı
   doğrulanmadı. `supabase/tests/01_rls_isolation.sql` böyle bir test içeriyor
   ama çalıştırılmadı.
3. **Odoo Enterprise yok.** `helpdesk`, `maintenance`, `quality`, `projects`
   Sezra'da var ama Odoo Community'de karşılıkları yok (Enterprise'da). Bu
   dört modül için karşılaştırma yapılamadı.
4. **`apps/web` ve `apps/pos-client` frontend'i karşılaştırılmadı.** Odoo'nun
   OWL kayıt defteri mimarisi ([05](05-web-controllers-owl.md)) ile Sezra'nın
   React tarafı ayrı bir inceleme konusu.
