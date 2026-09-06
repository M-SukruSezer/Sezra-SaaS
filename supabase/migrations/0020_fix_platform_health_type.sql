-- =============================================================================
-- 0020 — Düzeltme: core.platform_health() dönüş tipi uyuşmazlığı
--
-- HATA:
--   `attempts` kolonu `integer` bildiriliyordu ama sorgu `max(d.attempts)`
--   döndürüyor ve `event_deliveries.attempts` bir `smallint`. PostgreSQL
--   dönüş tipini SATIR DÖNDÜĞÜNDE denetlediği için, kuyrukta başarısız
--   teslimat OLMADIĞI sürece hata görünmüyordu:
--     "structure of query does not match function result type"
--
--   Yani platform konsolunun "İşlenemeyen olaylar" kartı tam da ihtiyaç
--   duyulduğu anda -- bir teslimat düştüğünde -- 500 veriyordu. Sorunu
--   bildirmesi gereken ekranın, sorun çıkınca çökmesi.
--
-- NEDEN AÇIKÇA CAST EDİLİYOR:
--   Bildirimi `smallint` yapmak da mümkündü, ama deneme sayısı ileride
--   smallint sınırını aşabilecek bir sayaç. Geniş tipte bildirip dar tipi
--   ona çevirmek, ters yönden daha dayanıklı.
-- =============================================================================

create or replace function core.platform_health()
returns table (
  tenant_id     uuid,
  tenant_name   text,
  topic         text,
  module_code   text,
  status        text,
  delivery_count integer,
  attempts      integer,
  last_error    text,
  last_attempt  timestamptz
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.platform_guard();
  return query
  select
    e.tenant_id, t.name, e.topic, s.module_code, d.status::text,
    count(*)::integer, max(d.attempts)::integer, max(d.last_error), max(d.next_attempt_at)
  from core.event_deliveries d
  join core.events e on e.id = d.event_id
  join core.event_subscriptions s on s.id = d.subscription_id
  left join core.tenants t on t.id = e.tenant_id
  where d.status in ('failed', 'dead')
  group by e.tenant_id, t.name, e.topic, s.module_code, d.status
  order by (d.status = 'dead') desc, count(*) desc;
end;
$$;
