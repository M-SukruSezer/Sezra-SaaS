# Sezra SaaS — Çok Kiracılı ERP Platformu

KOBİ'lere yönelik, modüler, Türkçe-native bulut ERP. Odoo'nun addon mantığına
benzer ama daha hafif; Türkiye mevzuatı (KDV, tevkifat, Tekdüzen Hesap Planı,
SGK/bordro) çekirdeğe gömülü.

## Durum

| Katman | Durum |
|---|---|
| Çekirdek (kiracı, şube, RBAC, RLS, olay veri yolu, denetim izi, onboarding) | ✅ Tamam, testli |
| CRM & Satış — veri katmanı, iş kuralları, raporlar | ✅ Tamam, testli |
| CRM — API katmanı | ✅ Tamam, testli |
| CRM — UI (React) | ✅ Tamam, tarayıcıda doğrulandı |
| Muhasebe & Finans | ✅ Tamam, testli (veri + API + UI) |
| İnsan Kaynakları & Bordro | ⬜ |
| Satın Alma | ⬜ |

**141 otomatik test geçiyor** — 98'i veritabanı katmanında (kiracı ve şube
izolasyonu, kayıt kuralları, modül aktivasyonu, KDV/tevkifat, çift taraflı kayıt,
muhasebe değişmezliği, kapalı dönem, olay yayını, denetim izi), 43'ü API
katmanında (aynı izolasyonun HTTP üzerinden de geçerli olduğunu ve uçtan uca
akışın çalıştığını doğrular).

### Uçtan uca çalışan akış

```
CRM: teklif → onay → sipariş → onay
        ↓ sales.order.confirmed olayı (transactional outbox)
Muhasebe: fatura taslağı → muhasebeleştir → yevmiye kaydı (120 / 600 / 391)
        ↓
        tahsilat → 102 BANKALAR → mizan → kâr/zarar → KDV özeti → e-Fatura
```

CRM, Muhasebe modülünün varlığını bilmez; tek bağ olaydır.

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

API'yi çalıştır:

```bash
npm run dev
```

| Betik | İşlevi |
|---|---|
| `scripts/db-reset.sh` | şemayı sıfırdan kurar + demo veriyi yükler |
| `scripts/test.sh` | veritabanı katmanı testleri (RLS, akış) |
| `scripts/test-api.sh` | yukarıdakiler + TypeScript derlemesi + API testleri |
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
supabase/migrations/   0001-0099 çekirdek, 0100+ modüller, 9999 yetkiler
supabase/seed/         demo kiracı (Colombia Coffee)
supabase/tests/        RLS izolasyon ve iş akışı testleri
core/                  çekirdek TypeScript katmanı
                         db.ts        kiracı bağlamlı transaction
                         resource.ts  genel CRUD üreteci
                         events.ts    olay işleyici
                         coreModule   cari, ürün, vergi, kullanıcı uçları
modules/crm/           CRM API modülü
apps/api/              Fastify sunucusu (modülleri yükler)
apps/web/              React arayüzü
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
