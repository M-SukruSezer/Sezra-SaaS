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

**554 otomatik test geçiyor, 0 başarısız** — 443'ü veritabanı katmanında, 12 SQL
paketine dağılmış (kiracı ve şube izolasyonu, kayıt kuralları, ücret ve maliyet
gizliliği, modül aktivasyonu, KDV/tevkifat, çift taraflı kayıt, muhasebe
değişmezliği, kapalı dönem, bordro hesabı, kademeli tedarikçi fiyatı, kısmi mal
kabul, hareketli ortalama maliyet, negatif stok engeli, FEFO, olay yayını,
denetim izi), 111'i API katmanında (çekirdek, CRM, Muhasebe, SMS, çek/senet,
müşteri portalı — aynı izolasyonun HTTP üzerinden de geçerli olduğunu ve uçtan
uca akışın çalıştığını doğrular).

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
                       9999 yetkiler
supabase/seed/         demo kiracı (Örnek Ticaret A.Ş.)
supabase/tests/        RLS izolasyon ve iş akışı testleri
core/                  çekirdek TypeScript katmanı
                         db.ts        kiracı bağlamlı transaction
                         resource.ts  genel CRUD üreteci
                         events.ts    olay işleyici
                         coreModule   cari, ürün, vergi, kullanıcı uçları
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
