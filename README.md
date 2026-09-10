# Sezra SaaS — Çok Kiracılı ERP Platformu

KOBİ'lere yönelik, modüler, Türkçe-native bulut ERP. Odoo'nun addon mantığına
benzer ama daha hafif; Türkiye mevzuatı (KDV, tevkifat, Tekdüzen Hesap Planı,
SGK/bordro) çekirdeğe gömülü.

## Durum

| Katman | Durum |
|---|---|
| Çekirdek (kiracı, şube, RBAC, RLS, olay veri yolu, denetim izi, onboarding) | Tamam, testli |
| CRM & Satış — veri katmanı, iş kuralları, raporlar | Tamam, testli |
| CRM — API katmanı | Tamam, testli |
| CRM — UI (React) | Tamam, tarayıcıda doğrulandı |
| Muhasebe & Finans | Tamam, testli (veri + API + UI) |
| İnsan Kaynakları & Bordro | Tamam — veri katmanı + UI testli; API katmanı çalışır, HTTP testleri şu an ekleniyor |
| Satın Alma & Tedarikçi | Tamam — veri katmanı + UI testli; API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 2** — Envanter & Stok | Tamam — veri katmanı + UI testli; API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 2** — Barkod | Tamam — veri katmanı + UI testli (çoklu barkod, GTIN doğrulama, okutarak sayım); API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 2** — Kalite Kontrol | Tamam — veri katmanı + UI testli (muayene planları, uygunsuzluk, tasarruf); API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 2** — Bakım & Ekipman | Tamam — veri katmanı + UI testli (periyodik plan, iş emri, duruş, güvenilirlik); API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 3** — Satış Noktası (POS) | Tamam — veri katmanı + yönetici UI + **kasiyer istemcisi** testli; API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 4** — Proje & Zaman Çizelgesi | Tamam — veri katmanı + UI testli (görev ağacı, hakediş, kârlılık); API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Faz 4** — Destek Masası | Tamam — veri katmanı + UI testli (SLA, yazışma, memnuniyet); API katmanı çalışır, HTTP testleri şu an ekleniyor |
| **Platform** — Mali Müşavir erişimi | Tamam, testli — davet akışı, salt-okunur RLS, müşavir paneli (`/musavir`) |
| **Platform** — Mail hesabı bağlama | Tamam, testli — IMAP/POP3 bağlantı kurulumu; şifreli kimlik bilgisi saklaması; Ayarlar > Mail Hesapları ekranı |
| **Platform** — Mail modülü (gelen kutusu + gönderme) | Tamam, testli — IMAP/POP3 çekme + artımlı senkron; SMTP gönderme; Mail ekranı (`/mail`) |
| **CRM/Cari** — VKN'den firma bilgisi | Tamam, testli — "VKN'den getir" adapter sorgusu (GİB + opsiyonel ücretli sağlayıcı); resmi sicil alanları (MERSİS no, vergi dairesi kodu, mükellefiyet türü) |
| **Faz 1** — Temel veri tamamlama (T-033) | Tamam, testli — araç lokasyon tipi, ürün artikel no / raf yeri, cari varsayılan para birimi, pasif cari/ürün seçim engeli |

**Otomatik test sayısı** — veritabanı katmanında 18 SQL paketi (kiracı ve şube
izolasyonu, kayıt kuralları, ücret ve maliyet gizliliği, modül aktivasyonu,
KDV/tevkifat, çift taraflı kayıt, muhasebe değişmezliği, kapalı dönem, bordro
hesabı, kademeli tedarikçi fiyatı, kısmi mal kabul, hareketli ortalama maliyet,
negatif stok engeli, FEFO, olay yayını, denetim izi, mali müşavir RLS izolasyonu,
mail hesabı gizli bilgi sızıntısı, cari resmi sicil alanları, mail mesajı RLS ve
KVKK saklama sınırı), API katmanında 9 paket / 200 test (çekirdek + CRM, Muhasebe,
modüller, platform yönetimi, davet akışı, mali müşavir uçları, mail hesabı uçları,
mail modülü akışı, VKN firma sorgusu). Son ölçüm: `bash scripts/test-api.sh` →
API 200/200, `npm run typecheck` → 0 hata, `python3 scripts/check_no_emoji.py` →
359 dosya temiz.

**Faz 1 tamamlandı**: CRM & Satış, Muhasebe & Finans, İnsan Kaynakları & Bordro,
Satın Alma & Tedarikçi.
**Faz 2 tamamlandı**: Envanter & Stok, Barkod, Kalite Kontrol, Bakım & Ekipman.
**Faz 3 tamamlandı**: Satış Noktası (POS).
**Faz 4 tamamlandı**: Proje & Zaman Çizelgesi, Destek Masası.

### Uçtan uca çalışan akış

```
CRM: teklif → onay → sipariş → onay
        ↓ sales.order.confirmed olayı (transactional outbox)
Muhasebe: fatura taslağı → muhasebeleştir → yevmiye kaydı (120 / 600 / 391)
        ↓
        tahsilat → 102 BANKALAR → mizan → kâr/zarar → KDV özeti → e-Fatura

İK: dönem aç → hesapla → onayla
        ↓ hr.payroll.approved olayı
Muhasebe: bordro tahakkuku → 770 gider / 335 personel / 360 vergi / 361 SGK

Satın Alma: talep → onay → sipariş → onay → (kısmi) mal kabul
        ↓ purchasing.receipt.confirmed olayı  ── TEK olay, ÜÇ bağımsız abone
        ├→ Muhasebe: alış faturası taslağı — KABUL EDİLEN miktar üzerinden
        │            (100 sipariş, 60 teslim, 5 hasarlı → fatura 55 adet)
        ├→ Envanter: stok girişi + hareketli ortalama maliyet güncellemesi
        └→ Kalite:   plandaki ölçütlerle taslak muayene (otomatik GEÇMEZ)
```

CRM, İK ve Satın Alma, Muhasebe ve Envanter modüllerinin varlığını bilmez; tek
bağ olaydır. Faz 2'de Envanter, Faz 1'de yayınlanan olaylara ABONE OLARAK
devreye girdi — Satın Alma ve CRM'de **tek satır değişmedi**.

### Envanter modeli

Stok bir bakiye değil, bir **defterdir**: `inventory.moves` tek gerçek kaynak,
`inventory.quants` ondan türetilir ve doğrudan yazılamaz (uygulama rolünden
INSERT/UPDATE/DELETE yetkisi alınmıştır). Düzeltme, bakiyeyi değiştirerek değil
sayım hareketi üreterek yapılır — muhasebedeki ters kayıt mantığının aynısı.

Satış siparişi onayı stok **düşürmez, rezerve eder**. Sipariş bir taahhüttür,
sevkiyat değil; mal fiilen çıktığında (`inventory.ship_reservation`) rezervasyon
çıkışa döner. Stok yetmezse rezervasyon başarısız olmaz — envanter satışı veto
edemez — eksik miktar `inventory.stock.shortage` olayı olarak duyurulur ve
ekranda negatif "kullanılabilir" olarak görünür.

Maliyet **hareketli ortalamadır**. Giriş hareketi fiili alış fiyatını taşır,
çıkış hareketi o anki ortalamayı; ikisi de sonradan değişmez, yoksa yeni bir
alış kapanmış ayın kâr/zararını geriye dönük bozardı.

### Destek masası

**SLA hedefi bilet açılırken dondurulur** — politika sonradan sıkılaştırılırsa
açık biletler geçmişe dönük ihlal sayılmaz.

**Müşteri beklenirken SLA saati durur.** Müşteriye soru sorup yanıt beklerken
geçen süre bizim gecikmemiz değildir; duraklatılan süre birikir ve hedeften
düşülür. Bunu yapmayan bir ölçüm, ekibi müşterinin cevap hızıyla cezalandırır.

**İlk yanıt ayrı ölçülür** ve **iç not ilk yanıt sayılmaz** — ekip kendi arasında
konuşurken müşteri hâlâ bekliyordur. Aynı nedenle müşteriye hiç dönülmeden bilet
çözülemez.

SLA ihlali bilet çözülürken değil, **vadesi geçtiğinde** işaretlenir: sadece
çözümde bakmak, hiç çözülmeyen biletlerin raporda hiç görünmemesi demekti — oysa
en kötü ihlal tam olarak odur.

### Proje & zaman çizelgesi

**Zaman kaydı tek, kullanımı iki.** Aynı satır hem faturaya (müşteriye kaç saat
yansıyacak) hem maliyete (bu saatin işletmeye maliyeti ne) kaynaklık eder. İki
ayrı tablo tutmak, "faturalanan 40 saat ama maliyette 38 görünüyor" sınıfı bir
tutarsızlığı kaçınılmaz kılardı.

**Saatin maliyeti işlendiği anda dondurulur** — çalışan zam alınca geçmiş
projelerin kârlılığı değişmez. Test bunu doğruluyor: maaş 45.000'den 90.000'e
çıkarıldığında eski kayıt 230,77 TL/saat kalıyor, yeni kayıt 461,54'ten
hesaplanıyor.

**Faturalanmamış hakediş varken proje kapatılamaz.** Uyarı değil, engel: gelirin
unutulmasının en yaygın yolu budur.

Maliyet ve marj **ayrı yetkiye** tabidir (`projects.report.profitability`) —
ekip arkadaşının saatlik maliyeti, maaşını ele verir.

Faz 1'de yayınlanan `crm.lead.won` olayı Faz 4'te yeni bir abone kazandı:
kazanılan fırsattan **taslak proje** doğuyor. CRM'de tek satır değişmedi.

### Satış noktası (POS)

**Fişin kimliğini kasa üretir, sunucu değil.** Kasa internetsiz çalışabilmelidir;
fiş id'si cihazda üretilir ve `/pos/sync` idempotenttir — aynı paket ağ hatası
yüzünden iki kez ulaşsa da fiş çoğalmaz. Bu yüzden kasa istemcisi "gönderdim mi?"
sorusunu çözmek zorunda değildir: emin olmadığında yeniden gönderir.

**Fiyat KDV dahildir.** Etikette "95 TL" yazar ve kasada üstüne vergi
eklenmez, içinden ayrıştırılır (95 = 86,36 matrah + 8,64 KDV). Toptan satış yapan
kiracı terminal bazında hariç'e çevirebilir.

**POS satışı stoku hemen düşürür, rezerve etmez.** Satış siparişinde mal sonra
sevk edilir (rezervasyon); kasada müşteri malı alıp çıkar. İki modülün aynı olaya
farklı tepki vermesi tutarsızlık değil, iki ticari gerçeğin doğru modellenmesidir.

**İade orijinal fişi değiştirmez**, eksi tutarlı yeni bir fiş üretir — ve
müşterinin verdiği parayı değil satışın tutarını geri verir (95 TL'lik satışa
100 TL verilip 5 TL para üstü alınmışsa iade 95'tir).

**Kasa farkı gizlenmez.** Açılış bakiyesi, beklenen nakit ve sayılan nakit ayrı
saklanır; fark hesaplanır ve Z raporunda görünür. Kasiyer rolünde kasa kapatma
ve iade yetkisi yoktur — ikisi de açığı gizlemenin en kolay yollarıdır.

Muhasebeye **fiş başına kayıt atılmaz**: günde binlerce fiş kesen bir satış noktasında
defter kullanılamaz hâle gelirdi. Kayıt kasa kapanışında, ödeme türü kırılımıyla
ve iadeler netlenerek atılır.

POS **iki ayrı istemciye** sahiptir ve bu bilinçlidir:

| İstemci | Port | Kim kullanır | Neden ayrı |
|---|---|---|---|
| `apps/web` | 5173 | Yönetici | Kasa izleme, Z raporu, satış raporları |
| `apps/pos-client` | 5174 | Kasiyer | Çevrimdışı çalışır, dokunmatik için tasarlandı |

İkisini tek uygulamada birleştirmek, internet kesildiğinde yönetimi de
kilitlerdi. Kasiyer istemcisi vardiya başında kataloğu indirip yerelde saklar;
bağlantı koptuğunda satışa devam eder, fişleri kuyruğa alır ve bağlantı gelince
`/pos/sync` ile gönderir. Kuyruk "gönderdim mi?" sorusunu kesin çözmek zorunda
değildir — uç idempotent olduğu için emin olamadığında tekrar gönderir.

Kasa istemcisi tutarları YERELDE de hesaplar (müşteriye anında göstermek için)
ama bu sonuç hiçbir yere yazılmaz: kaydın doğrusu her zaman sunucunun hesabıdır.
İki uygulamanın zamanla ayrışma riski gerçektir, o yüzden yerel hesap yalnızca
ekran içindir.

Kuyrukta fiş varken kasa **kapatılamaz**: sunucu beklenen nakdi eksik hesaplar
ve kasa farkı yanlış çıkardı.

### Bakım & ekipman

Periyodik bakım **planı** ile **iş emri** ayrı şeylerdir: plan "her 90 günde bir
periyodik bakım" der, iş emri "12 Mart'ta Düzce'deki makineye yapılan iş"tir. Aynı
plandan yüzlerce iş emri doğar; her biri kendi maliyetini, süresini ve kullanılan
parçasını taşır.

Vade hem **takvimden** hem **kullanım sayacından** hesaplanır — sayaçlı bir makinede
ikisi de anlamlıdır ve hangisi önce gelirse iş emri o zaman açılır. Bunun için
bakım anındaki sayaç değeri iş emrine dondurulur; "son bakımdan bu yana kaç devir
yapıldı" sorusu ancak öyle yanıtlanabilir.

Cron her çalıştığında kopya iş emri üretmez: açık iş emri varken aynı plan
ikincisini açamaz (kısmi benzersizlik indeksi). Arıza bildirimi ekipmanı
**durdurur** — "bakımda" ile "arızalı" farklı durumlardır. Yapılmamış görev
varken iş emri kapatılamaz; bakımı kâğıt üzerinde yapmanın önündeki engel budur.

Kullanılan yedek parça `core.products`'a bağlanır (ayrı parça kataloğu icat
edilmez) ve stoktan düşümü **olayla** yapılır — Bakım, Envanter'siz de çalışır.

### Kalite kontrol

Muayene sonuç satırı, ölçümü yaparken geçerli olan **limitleri kopyalayarak**
saklar. Plan sonradan değiştiğinde geçmiş muayeneler yeniden yorumlanmaz —
"bu parti neden geçti?" sorusu o günün ölçütüyle yanıtlanır.

Geçti/kaldı elle seçilmez, ölçümlerden türetilir. `is_critical` sonucu değil,
doğan **uygunsuzluğun ağırlığını** belirler. "Kaldı ama yine de alalım" meşru
bir karardır ama muayene sonucunu değiştirerek değil, gerekçeli bir tasarrufla
kayda geçer — ve sapmayla kabul gerekçesizse veritabanı reddeder.

Muayene **taslak doğar**: mal kabul olayı kontrolü hatırlatır, yerine geçmez.
Planı olmayan ürün için hiç kayıt açılmaz; doldurulmayan boş formlar, kalite
kontrolün en hızlı öldüğü yerdir.

**Barkod** ayrı bir modül değil, envanterin bir yeteneğidir — kiracı "barkod
satın almaz". Bir ürünün birden çok barkodu olabilir (tekli / koli / palet) ve
her biri kendi ADET ÇARPANINI taşır: koli okutulduğunda sayım 1 değil 12 artar.
GTIN işaretli kodlarda kontrol hanesi doğrulanır (elle girişteki tek haneli
yazım hatası orada yakalanır); işletmenin kendi iç kodları `is_gtin = false`
ile serbestçe kaydedilir. Mevcut `core.products.barcode` alanındaki kodlar da
çözümlenir, kimse katalogunu kopyalamak zorunda kalmaz.

### Bordro mevzuatı

Hesaplama mantığı kodda, **sayılar veritabanında** (`hr.payroll_parameter_sets`).
Asgari ücret, SGK tavanı, gelir vergisi dilimleri ve damga oranı parametredir;
yeni yıl = tek satır SQL, sıfır dağıtım.

Platformla gelen `TR-2025` seti **`is_verified = false`** işaretlidir: oranlar
kanuni ve istikrarlı, ancak tutarlar ve vergi dilimleri Resmî Gazete'den teyit
edilmedi. Teyit edilmemiş bir setle bordro **hesaplanabilir ama onaylanamaz** —
yanlış bordronun sessizce üretilmesine karşı yapısal engel budur. Üretime
çıkmadan önce değerleri doğrulayıp `is_verified = true` yapın.

Motorun doğruluğu bilinen bir referans değerle sınanıyor: 2025 brüt asgari
ücretin neti **22.104,67 TL** çıkmalı (`supabase/tests/04_hr.sql`). Bu tek
sayı SGK kesintisi, asgari ücret gelir vergisi istisnası ve damga vergisi
istisnası zincirinin tamamını doğrular.

> **AGİ notu:** Asgari geçim indirimi 2022'de kaldırıldı; yerini asgari ücret
> istisnası aldı. Motor istisnayı uygular, AGİ'yi değil. AGİ yeniden yürürlüğe
> girerse `agi_enabled` parametresi ve yeri hazır.

### Mali müşavir erişimi

Bir kiracı yöneticisi, dış mali müşavirini `POST /core/accountantInvite` ile davet
eder. Müşavir daveti kabul edene kadar erişim başlamaz; kiracı başına en fazla bir
aktif müşavir olabilir (kısmi benzersizlik indeksi, `1150_core_accountant_access`).

Müşavir veriyi **yapısal olarak** salt okur: RLS politika üreticisi `musavir` terimini
yalnızca `for select` politikasına koyar; `insert/update/delete` üreticileri bu terimi
hiç görmez. Uygulama katmanı denetimi değil, veritabanı yapısı bunu garanti eder.

Müşavir istekleri normal API uçlarına `x-tenant-id: <kiracı>` +
`x-accountant-mode: on` başlıklarıyla gelir; `core.accountant_tenant_id()` yetkilendirmeyi
kontrol eder. Müşavir kendi doğal kiracısını görmaya devam eder; cross-tenant sızıntı yoktur.

UI: `apps/web/src/pages/Musavir.tsx` — bekleyen davetler, kiracı listesi, kiracı seçimi.

### Mail hesabı bağlama

Kullanıcılar IMAP veya POP3 posta kutularını `Ayarlar > Mail Hesapları` ekranından
bağlar (`apps/web/src/pages/Settings.tsx`). OAuth sağlayıcıları (Microsoft Graph, Gmail)
ortam değişkenleriyle yapılandırılır; yapılandırılmamış sağlayıcılar yalnızca
`configured: false` döner — kimlik bilgisi istemciye sızmaz.

**Güvenlik garantileri** (tümü kod ve testlerle doğrulanmış):

- Parola/token `core/src/mail/crypto.ts` içindeki AES-256-GCM ile şifreli saklanır;
  anahtar ortam değişkeninden gelir, veritabanı düz metni görmez.
- `core.mail_account_list()` şifreli blobu SELECT etmez; yalnızca `has_secret: bool` döner.
- Denetim izi scrub'lu özel tetikleyiciyle yazılır — genel `core.attach_audit`
  kullanılmaz (o `to_jsonb(new)` ile şifreli blobu audit_log'a yazardı).
- RLS: kullanıcı yalnızca kendi hesaplarını görür; destek modu bu tabloyu atlayamaz.

`POST /core/mail/accounts/:id/verify` ucu kaydedilen hesapta gerçek bağlantı
testi ("Bağlantıyı test et") yapar. Posta çekme ve gönderme bir sonraki bölümde.

### Mail modülü — gelen kutusu ve gönderme

Bağlantı kurulumunun (yukarıda) üzerine gelen posta **çekme ve gönderme** eklenir;
yine harici kütüphane yok, yalnızca `node:net` + `node:tls`
(`core/src/mail/fetch.ts`, `send.ts`).

- **Çekme salt-okumadır**: IMAP'te `BODY.PEEK`, POP3'te `DELE` yok — sunucudaki
  hiçbir mesaj silinmez ya da okundu işaretlenmez.
- **Artımlı senkron**: IMAP'te son çekilen UID'den sonrası, POP3'te bilinen UIDL
  kümesinde olmayanlar. Her koşuda mesaj sayısı ve mesaj başına bayt üst sınırı
  var; bir hesap paneli ve veritabanını boğamaz. `UIDVALIDITY` değişirse yerel
  mesajlar boşaltılıp baştan çekilir.
- **KVKK saklama sınırı**: hesap başına en fazla 500 gelen mesaj saklanır
  (`core.mail_message_keep()`); senkron sonrası `core.mail_messages_trim()` en
  eskileri siler. Gelen kutusu bir arşiv değil çalışma penceresidir. Giden
  mesajlar (gönderim kanıtı) bu sınırdan muaftır.
- **Gövde HAM saklanır ama arayüz ham render etmez** (XSS yolu): `body_text` her
  zaman doldurulur ve panel yalnızca onu gösterir; `body_html` hiç render
  edilmez, mesajın HTML olduğu bir not olarak belirtilir.
- **RLS yalnızca sahip** (`owner_id = core.current_user_id()`). Kiracı yöneticisi,
  destek modu ve mali müşavir dahil kimse başkasının postasını göremez;
  politikada onlar için OR dalı yoktur. `core.attach_audit` bu tablolarda bilerek
  çağrılmaz — `to_jsonb(new)` mesaj gövdesini `audit_log`'a yazardı.
- SMTP parolası `secret_cipher`'dan yalnızca gönderim anında çözülür; hiçbir
  yanıta, loga veya hata mesajına girmez. Başarısız gönderim de kaydedilir
  (`send_status = 'failed'`) — denetimde "neden gitmedi" cevabı kalsın.

UI: `apps/web/src/pages/Mail.tsx` — hesap seçimi, mesaj listesi, okuma,
yaz/yanıtla.

### Cari açarken VKN'den firma bilgisi

"Yeni cari" formundaki **VKN'den getir** butonu, 10 haneli vergi numarasını kendi
backend'imize sorar; backend sağlayıcıya gider ve yalnızca forma yazılabilir
alanları döndürür. Akış her zaman
frontend -> kendi backend -> sağlayıcı -> geri; API anahtarı istemciye sızmaz, uç
yalnızca `configured` bool verir.

Sağlayıcı seçimi ertelenmiş bir karardır (SMS ve e-Fatura'daki adapter kalıbının
aynısı, `core/src/company/`): bugün GİB'in herkese açık listesi, opsiyonel olarak
daha zengin veri veren ücretli bir sağlayıcı. VKN sağlayıcılara sırayla sorulur,
ilk "bulundu" yanıtı kazanır.

`core.partners` üç nullable sicil alanı kazandı: `mersis_no` (16 hane),
`tax_office_code` (GİB vergi dairesi kodu — dairenin *adından* ayrı) ve
`tax_liability_type` (mükellefiyet türü, serbest metin). CHECK kısıtları yalnızca
dolu değeri sınar; eski cariler NULL kalır. Kullanıcı her durumda bilgileri elle
girebilir; teknik hata detayı (sağlayıcı, durum kodu, ham gövde) yanıta konmaz ve
VKN loglanmaz.

### T-033 Faz 1 — temel veri tamamlama

- **Araç lokasyon tipi**: `inventory.location_kind` enum'una `vehicle` eklendi;
  araç üzerindeki stok `inventory.v_stock_on_hand` raporunda ürün-depo kırılımında
  görünür hale geldi.
- **Ürün kartı**: `artikel_no` (üreticinin kendi ürün kodu, SKU'dan bağımsız
  bilgi alanı) ve `shelf_location` (depoda raf/göz kısa notu — konum yönetimi yine
  `inventory.locations` üzerinde yapılır).
- **Cari kartı**: `currency` (varsayılan belge para birimi, ISO 4217; NULL =
  sistem varsayılanı). `core.v_partner_list` görünümü kolonu içerecek şekilde
  yeniden oluşturuldu.
- **Pasif seçim engeli**: pasif (`is_active = false`) bir cari ya da ürün yeni
  ticari belgede seçilemez. Kural formda gizlemekle değil **veritabanı
  tetikleyicisiyle** uygulanır (`crm.quotations` / `sale_orders`,
  `purchasing.orders`, `pos.orders` başlıkları; ilgili satır tabloları ürün için).
  Tetikleyici INSERT'te ve yalnızca `partner_id` / `product_id` **değiştiğinde**
  çalışır — geçmiş belgelerde tutar/not güncellemek serbest kalır, ama var olan
  bir belgeyi pasif bir kayda yönlendirmek engellenir. SELECT'e hiç dokunulmaz:
  raporlar ve geçmiş belge listeleri pasif kayıtları görmeye devam eder. Fatura,
  tahsilat/ödeme ve mal kabul bilerek kapsam dışıdır (eski borcun kapatılması ve
  verilmiş siparişin mal kabulü her zaman tamamlanabilmeli).

## Hızlı başlangıç (yerel)

Sistem PostgreSQL'i üzerinde rolleri ve veritabanını oluştur:

```bash
sudo -u postgres bash scripts/dev-db-setup.sh
```

Ortam dosyasını hazırla ve bağımlılıkları kur:

```bash
cp .env.example .env && npm install
```

Veritabanı + API testlerinin tamamını çalıştır:

```bash
bash scripts/test-api.sh
```

Çalıştır — **iki sunucu birden gerekir**, ayrı terminallerde:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Kasiyer ekranı (opsiyonel, ayrı istemci):

```bash
npm run dev:pos
```

Arayüz `http://localhost:5173`, kasa `http://localhost:5174`,
API `http://localhost:3000`. Vite `/api/*`
isteklerini API'ye proxy'ler; API ayakta değilse arayüz "API sunucusuna
ulaşılamıyor" hatası gösterir (sessiz 500 değil).

| Betik | İşlevi |
|---|---|
| `scripts/db-reset.sh` | şemayı sıfırdan kurar + demo veriyi yükler |
| `scripts/test.sh` | veritabanı katmanı testleri (RLS, akış) |
| `scripts/test-api.sh` | yukarıdakiler + tedarik zinciri geçidi + TypeScript derlemesi + API testleri |
| `scripts/audit.sh` | tedarik zinciri geçidi: `npm audit`, bilinen açık varsa düşer (`npm run audit:gate`) |
| `scripts/migrate.sh` | yalnızca migration uygular |

### Roller

| Rol | Yetki | Kullanım |
|---|---|---|
| `sezra_owner` | tabloların sahibi, **BYPASSRLS** | migration, kiracı kurulumu |
| `sezra_app` | sahip değil, BYPASSRLS yok | API katmanının bağlandığı rol |

Supabase'de bunların karşılığı `postgres` ve `authenticated`tır. **API asla owner
rolüyle bağlanmamalıdır** — bağlanırsa RLS bir güvenlik sınırı olmaktan çıkar.

## Dizin yapısı

```
supabase/migrations/   0001-0099 çekirdek, 0100 CRM, 0200 Muhasebe, 0300 İK,
                       0400 Satın Alma, 0500 Envanter, 0600 Kalite,
                       0700 Bakım, 0800 POS, 0900 Proje, 1000 Destek,
                       1100-1140 destek erişimi + davet + platform yöneticisi,
                       1150-1151 mali müşavir erişimi,
                       1160 mail hesabı bağlama,
                       1170 cari resmi sicil alanları (VKN sorgusu),
                       1180 mail mesaj saklama + senkron durumu,
                       1190-1194 T-033 Faz 1 (araç lokasyonu, ürün/cari alanları,
                                 pasif seçim engeli),
                       9999 yetkiler
supabase/seed/         demo kiracı (Örnek Ticaret A.Ş.)
supabase/tests/        RLS izolasyon ve iş akışı testleri
core/                  çekirdek TypeScript katmanı
                         db.ts              kiracı bağlamlı transaction
                         resource.ts        genel CRUD üreteci
                         events.ts          olay işleyici
                         coreModule         cari, ürün, vergi, kullanıcı uçları
                         accountantRoutes   mali müşavir davet / panel uçları
                         mailRoutes         mail hesabı bağlama + gelen kutusu +
                                            gönderme uçları
                         companyRoutes      VKN'den firma bilgisi sorgulama uçları
                         mail/              adapter deseni: crypto.ts (AES-256-GCM),
                                            types.ts (IMAP/POP3/Graph/Gmail),
                                            verify.ts (bağlantı testi),
                                            fetch.ts (IMAP/POP3 çekme), send.ts (SMTP),
                                            ssrfGuard.ts
                         company/           adapter deseni: types.ts + registry.ts +
                                            gib.ts / paid.ts sağlayıcılar,
                                            vkn.ts (VKN/TCKN doğrulama)
modules/crm/           CRM API modülü
modules/finance/       Muhasebe & Finans API modülü
modules/hr/            İK & Bordro API modülü
modules/purchasing/    Satın Alma API modülü
modules/inventory/     Envanter & Stok API modülü
modules/quality/       Kalite Kontrol API modülü
modules/maintenance/   Bakım & Ekipman API modülü
modules/pos/           Satış Noktası API modülü
modules/projects/      Proje & Zaman Çizelgesi API modülü
modules/helpdesk/      Destek Masası API modülü
apps/api/              Fastify sunucusu (modülleri yükler)
apps/web/              React yönetim arayüzü
apps/pos-client/       Kasiyer istemcisi (çevrimdışı çalışır)
docs/                  mimari kararlar ve modül geliştirme rehberi
scripts/
```

## Arayüz

React + TypeScript, modül başına lazy yüklenebilir sayfalar ve ortak bir
tasarım sistemi (`apps/web/src/styles.css` — tek token katmanı; modüller kendi
rengini/aralığını uydurmaz).

Menü, butonlar ve alanlar `/me` ucundan gelen izinlere göre görünür/gizlenir.
**Bu yalnızca görünürlüktür**: kullanıcı URL'yi elle yazsa bile API ve RLS onu
durdurur. Yerel geliştirmede giriş ekranından farklı demo kullanıcılara geçip
aynı ekranın nasıl değiştiği görülebilir — satış temsilcisi 1 fırsat görürken
şirket yöneticisi 4 görür, raporlar menüsü temsilciye hiç çıkmaz.

## Oturum bağlamı

Uygulama her istekte iki GUC ayarlar; RLS bunların üzerinden çalışır:

```sql
set local app.user_id   = '<auth.users.id>';
set local app.tenant_id = '<aktif kiracı>';   -- opsiyonel, doğrulanır
```

`app.tenant_id` istemciden gelir ama **asla güvenilmez**: `core.current_tenant_id()`
onu üyelik tablosuna karşı doğrular, doğrulayamazsa `NULL` döner ve tüm politikalar
kapanır (fail-closed).

Ayrıntı için [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ve
[docs/MODULE_GUIDE.md](docs/MODULE_GUIDE.md).
