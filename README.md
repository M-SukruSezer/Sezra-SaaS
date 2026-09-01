# Sezra SaaS — Çok Kiracılı ERP Platformu

KOBİ'lere yönelik, modüler, Türkçe-native bulut ERP. Odoo'nun addon mantığına
benzer ama daha hafif; Türkiye mevzuatı (KDV, tevkifat, Tekdüzen Hesap Planı,
SGK/bordro) çekirdeğe gömülü.

## Durum

| Katman | Durum |
|---|---|
| Çekirdek (kiracı, şube, RBAC, RLS, olay veri yolu, denetim izi, onboarding) | ✅ Tamam, testli |
| CRM & Satış — veri katmanı, iş kuralları, raporlar | ✅ Tamam, testli |
| CRM — API katmanı | ⬜ Sırada |
| CRM — UI | ⬜ Sırada |
| Muhasebe & Finans | ⬜ |
| İnsan Kaynakları & Bordro | ⬜ |
| Satın Alma | ⬜ |

43 otomatik test geçiyor (kiracı izolasyonu, şube izolasyonu, kayıt kuralları,
modül aktivasyonu, KDV/tevkifat matematiği, olay yayını, denetim izi).

## Hızlı başlangıç (yerel)

Sistem PostgreSQL'i üzerinde rolleri ve veritabanını oluştur:

```bash
sudo -u postgres bash scripts/dev-db-setup.sh
```

Ardından şemayı kur ve testleri çalıştır:

```bash
DATABASE_URL=postgresql://sezra_owner:sezra_owner@localhost:5432/sezra_dev bash scripts/test.sh
```

Yalnızca migration uygulamak için:

```bash
DATABASE_URL=postgresql://sezra_owner:sezra_owner@localhost:5432/sezra_dev bash scripts/migrate.sh
```

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
core/                  paylaşılan TypeScript katmanı (kimlik, olaylar, API iskeleti)
modules/{crm,finance,hr,purchasing}/
apps/api/  apps/web/
docs/                  mimari kararlar ve modül geliştirme rehberi
scripts/
```

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
