# Mimari Kararlar

Bu belge, promptta istenen "kararlarını gerekçelendir" maddesinin karşılığıdır.
Her başlık bir karar, gerekçesi ve reddedilen alternatifi içerir.

## 1. Modüler monolit, mikroservis değil

Her modül kendi **PostgreSQL şemasında** yaşar (`core`, `crm`, `finance`, `hr`,
`purchasing`) ama tek veritabanında. Modüller arası iletişim tablo JOIN'i değil,
olay veri yoludur.

Neden: KOBİ ölçeğinde mikroservis, dağıtık transaction ve operasyon maliyeti
getirir; karşılığında bir fayda vermez. Şema ayrımı, ileride bir modülü ayrı
servise çıkarmak gerekirse logical replication ile taşımayı mümkün kılar —
yani kapıyı kapatmıyoruz, sadece bugün açmıyoruz.

## 2. Kiracı izolasyonu: paylaşılan şema + `tenant_id` + RLS

Reddedilen alternatif: kiracı başına şema. 500 kiracıda 500 × N tablo demektir;
migration süresi ve `pg_class` şişmesi yönetilemez hâle gelir.

İzolasyon **uygulama kodunda değil, veritabanında** garanti edilir:

- `tenant_id` taşıyan her tabloda RLS **ve** `FORCE ROW LEVEL SECURITY` açıktır.
- Politikalar elle değil, `core.apply_rls()` üreticisiyle yazılır.
- `supabase/tests/02_crm_flow.sql` içindeki koruma testi, RLS'i açılmamış bir
  kiracı tablosu kaldıysa test paketini kırar.

### Fail-closed tasarım

`core.current_tenant_id()` istemcinin gönderdiği `app.tenant_id` GUC'sini üyelik
tablosuna karşı doğrular. Doğrulayamazsa `NULL` döner — ve `tenant_id = NULL`
hiçbir satırla eşleşmediği için kullanıcı **hiçbir şey** görmez. Bir saldırgan
başka kiracının UUID'sini bilse bile geçemez (test 1.4).

### Performans

Politikalarda kullanılan bağlam fonksiyonları **argümansız ve STABLE**'dır ve
daima `(select core.fn())` biçiminde sarmalanır. Böylece PostgreSQL bunları
satır başına değil sorgu başına bir kez (InitPlan) çalıştırır.

Daha DRY görünen `can_select(entity, owner, branch)` imzası bilinçli olarak
reddedildi: argümanlar satır başına değiştiği için InitPlan'a hoisting mümkün
olmaz, her satırda fonksiyon çağrısı doğardı. DRY'lik bunun yerine politika
**üreticisinde** sağlanıyor.

`core.apply_rls()` her tabloya `(tenant_id)`, `(tenant_id, branch_id)` ve
`(tenant_id, owner_id)` composite indekslerini otomatik ekler.

## 3. Şube (branch): ikinci izolasyon katmanı

`core.membership_branches` boşsa kullanıcı kiracının **tüm** şubelerini görür;
satır varsa yalnızca listelenenleri. Bu kural `core.accessible_branch_ids()`
içinde tek yerde yaşar.

Colombia Coffee senaryosu: Zonguldak şube müdürü Düzce fırsatlarını göremez,
şirket yöneticisi ikisini de görür (test 2 ve 4).

## 4. Yetkilendirme: Odoo'nun "Access Rights + Record Rules" ikilisi

İzin kodu sözleşmesi: `<modül>.<varlık>.<eylem>[.<kapsam>]`

| Kapsam | Anlamı |
|---|---|
| `.all` | erişilebilir şubelerdeki tüm kayıtlar |
| `.own` | yalnızca `owner_id` = kullanıcı olan kayıtlar |
| (yok) | eylem yetkisi, ör. `crm.order.confirm` |

Satış temsilcisi `crm.lead.read.own` alır, şube müdürü `crm.lead.read.all`.
Aynı politika şablonu her modülde çalışır; modül başına özel politika yazılmaz.

### Modül aktivasyonu yetkiye gömülü

`core.permission_codes()`, izinleri `core.tenant_modules` ile JOIN'ler. Kiracıda
modül kapalıysa o modülün izinleri **hiç dönmez** — dolayısıyla RLS politikaları
kapanır. "Sadece CRM + Muhasebe alan kiracı" senaryosu tek noktadan çözülür
(test 6). Ayrı bir "modül açık mı" kontrolü koda serpiştirmeye gerek kalmaz.

### Platform admini kazara her şeyi görmez

`is_platform_admin` tek başına yetmez; kiracı verisi görmek için oturumda
`set local app.support_mode = 'on'` gerekir. Bu, destek erişimini bilinçli bir
eyleme dönüştürür ve `audit_log.support_session` alanında işaretlenir (test 7).

## 5. Olay veri yolu: transactional outbox

`core.emit_event()` olayı, onu doğuran iş kaydıyla **aynı transaction'da** yazar.
"Sipariş kaydedildi ama olay kayboldu" durumu imkânsızdır.

- Fan-out yalnızca kiracıda **açık** modüllerin aboneliklerine yapılır.
- Teslimatlar `core.event_deliveries`'te abone başına ayrı satırdır; biri
  patlarsa diğerleri etkilenmez.
- Yeniden deneme üstel geri çekilmelidir (3^n saniye), `max_attempts` sonrası
  `dead` durumuna düşer.
- Düşük gecikme için `pg_notify`, dayanıklılık için `pg_cron` +
  `core.dispatch_events()`.
- Tanımsız bir konuya olay yayınlamak hata verir (`core.event_types` zorunlu) —
  yazım hatasıyla sessizce kaybolan olay olmaz.

Prompttaki "önce sıkı bağlama sonra ayır" tuzağından kaçınmak için bu altyapı
ilk modülden itibaren kullanılıyor: CRM, Muhasebe modülünün varlığını bilmez.

## 6. Para ve vergi matematiği tek yerde

`core.compute_line_amounts()` satış, satın alma ve fatura modüllerinin ortak
hesap motorudur. Teklifle faturanın kuruş farkı üretmesi böylece imkânsızlaşır.

- **Yuvarlama:** her satır kendi içinde 2 haneye yuvarlanır, belge toplamı
  yuvarlanmış satırların toplamıdır (GİB e-Fatura doğrulamasının beklediği
  davranış).
- **Tevkifat:** oran ondalık değil `num/den` (ör. 9/10) olarak saklanır;
  7/10 gibi değerlerde yuvarlama hatası doğmaz.

## 7. Çekirdek veri modelinden bilinçli iki sapma

**`users` + `memberships`.** Prompt `users(id, tenant_id, email, role)` diyordu.
`tenant_id`'yi kullanıcıya gömmek, bir muhasebecinin birden çok kiracıya hizmet
vermesini imkânsız kılardı; ayrıca Sezra'nın platform rolü hiçbir kiracıya ait
değildir. Rol, kullanıcının değil kullanıcı-kiracı **ilişkisinin** özelliğidir.
Tek kiracılı kullanıcı bu modelin dejenere hâlidir; hiçbir şey kaybedilmiyor.

**Vergi tanımları `core`'da, `finance`'ta değil.** Teklif ve satın alma siparişi
de KDV oranına ihtiyaç duyar; `finance`'a koymak CRM'i Muhasebe modülüne bağımlı
kılar ve "Envanter'siz kiracı" senaryosunu bozardı. Vergi **hesaplama motoru**
yine de `finance`'ta kalacak — `core`'da yalnızca tanımlar var.

## 8. RLS ile iş kuralı ayrımı

RLS "hangi satırı görürsün" sorusunu yanıtlar. "Ne zaman değişebilir" sorusu
(onaylanmış belge kilitlenir) trigger'larda çözülür. İkisini karıştırmak
politikaları okunamaz hâle getirir ve hata ayıklamayı imkânsızlaştırır.

## 9. View'lerde `security_invoker = on` zorunlu

PostgreSQL'de view varsayılan olarak **sahibinin** haklarıyla çalışır ve RLS'i
tamamen atlar. Çok kiracılı bir sistemde bu doğrudan veri sızıntısıdır. Tüm
raporlama view'leri `with (security_invoker = on)` ile oluşturulur ve test
paketi bunu her çalışmada denetler.

## 10. i18n en baştan

Türkçe-native ama `tenants.locale` / `users.locale` ilk günden şemada.
Sonradan eklemenin maliyeti, baştan koymanın maliyetinin katbekatıdır.
