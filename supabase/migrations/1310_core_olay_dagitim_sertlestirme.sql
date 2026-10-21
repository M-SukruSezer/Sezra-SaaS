-- =============================================================================
-- 1310 — Olay dağıtımının sertleştirilmesi
-- =============================================================================
-- `core.dispatch_events` iki ayrı hata taşıyordu. İkisi de testle gösterildi
-- (supabase/tests/20_modul_bagimlilik.sql).
--
-- 1) KONTROL ANI ile KULLANIM ANI arasındaki boşluk (TOCTOU).
--    `core.emit_event` fan-out sırasında `core.tenant_modules.enabled` ve
--    `s.is_active` kontrolü yapıyor — doğru. Ama teslimat bir kez kuyruğa
--    girdikten sonra dağıtım bu iki koşulu BİR DAHA sormuyordu. Handler ilk
--    denemede hata alıp geri çekilmede beklerken yönetici modülü kapatırsa,
--    sonraki turda handler yine çalışıyor ve kiracı kapattığı modülün verisini
--    üretmeye devam ediyordu. Aynısı aboneliğin sonradan pasifleştirilmesi
--    için de geçerliydi.
--
--    Çözüm: seçim sorgusuna her iki koşul da eklendi. Koşulu sağlamayan
--    teslimat SİLİNMEZ, kuyrukta bekler — modül yeniden açılırsa kaldığı
--    yerden devam eder. (`core.event_status` enum'ında 'skipped' yok ve
--    teslimatı 'dead' saymak, geçici olarak kapatılmış bir modülün işini
--    kalıcı olarak çöpe atardı.)
--
-- 2) YENİDEN DENEME SAYACI HİÇ ARTMIYORDU.
--    PL/pgSQL'de `begin ... exception` bloğu örtük bir savepoint kurar.
--    Handler hata verdiğinde blok içinde yapılan `attempts = attempts + 1`
--    güncellemesi de GERİ ALINIR. Eski exception işleyicisi `attempts`
--    kolonunu hiç atamadığı için sayaç sıfırda kalıyordu; dolayısıyla
--    `attempts + 1 >= max_attempts` koşulu asla sağlanmıyor, teslimat asla
--    'dead' olmuyor ve geri çekilme de hep `power(3, 0) = 1` saniye olarak
--    hesaplanıyordu.
--
--    Net sonuç: kalıcı olarak hata veren tek bir olay, veritabanına karşı
--    saniyede bir dönen sonsuz bir döngüye dönüşüyordu ve özenle tasarlanmış
--    ölü-mektup mekanizması hiç devreye girmiyordu.
--
--    Çözüm: deneme sayısı cursor'dan gelen `r.attempts` üzerinden yeniden
--    hesaplanıp AÇIKÇA yazılıyor.
-- =============================================================================

create or replace function core.dispatch_events(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  r          record;
  v_event    jsonb;
  v_done     integer := 0;
  v_attempt  integer;
begin
  for r in
    select d.id as delivery_id, d.attempts, s.handler_fn, s.max_attempts,
           e.id as event_id, e.tenant_id, e.branch_id, e.topic, e.payload,
           e.actor_id, e.occurred_at
    from core.event_deliveries d
    join core.event_subscriptions s on s.id = d.subscription_id
    join core.events e on e.id = d.event_id
    -- Modül aktifliği TESLİMAT ANINDA yeniden sorulur: kuyruğa girdikten
    -- sonra kapatılmış bir modülün handler'ı çalışmamalı.
    join core.tenant_modules tm
      on tm.module_code = s.module_code
     and tm.tenant_id   = e.tenant_id
     and tm.enabled
    where d.status in ('pending', 'failed')
      and d.next_attempt_at <= now()
      and s.is_active
    order by d.next_attempt_at
    limit p_limit
    for update of d skip locked
  loop
    v_event := jsonb_build_object(
      'id', r.event_id, 'tenant_id', r.tenant_id, 'branch_id', r.branch_id,
      'topic', r.topic, 'payload', r.payload, 'actor_id', r.actor_id,
      'occurred_at', r.occurred_at
    );

    begin
      update core.event_deliveries
         set status = 'processing', attempts = attempts + 1
       where id = r.delivery_id;

      execute format('select %s($1)', r.handler_fn) using v_event;

      update core.event_deliveries
         set status = 'done', processed_at = now(), last_error = null
       where id = r.delivery_id;
      v_done := v_done + 1;

    exception when others then
      -- Handler hatası tüm partiyi düşürmemeli: üstel geri çekilme ile yeniden dene.
      --
      -- `attempts` BURADA AÇIKÇA YAZILMALI. Yukarıdaki `attempts = attempts + 1`
      -- güncellemesi, bu bloğun örtük savepoint'i yüzünden geri alınmış durumda;
      -- kolonun değeri yine `r.attempts`. Atama yapılmazsa sayaç hiç artmaz.
      v_attempt := r.attempts + 1;

      -- CASE dalları `unknown` çözülüp text'e düştüğü için enum'a açık dönüşüm
      -- ŞART. Bu olmadan handler hatası, hatayı KAYDEDEMEDEN dispatcher'ı
      -- düşürür ve asıl sebep hiçbir yerde görünmez.
      update core.event_deliveries
         set attempts = v_attempt,
             status = (case when v_attempt >= r.max_attempts then 'dead' else 'failed' end)::core.event_status,
             last_error = left(sqlstate || ' ' || sqlerrm, 2000),
             next_attempt_at = now() + (power(3, least(v_attempt, 5)) || ' seconds')::interval
       where id = r.delivery_id;
    end;
  end loop;

  return v_done;
end;
$$;

comment on function core.dispatch_events(integer) is
  'Bekleyen olay teslimatlarını işler. Modül aktifliği ve abonelik durumu teslimat anında yeniden kontrol edilir; başarısız handler üstel geri çekilmeyle yeniden denenir ve max_attempts dolunca ''dead'' olur.';
