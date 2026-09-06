-- =============================================================================
-- 0501 — Envanter iş kuralları: defter → bakiye, maliyet, rezervasyon
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Yardımcılar
-- -----------------------------------------------------------------------------
create or replace function inventory.default_location(p_tenant_id uuid, p_branch_id uuid default null)
returns uuid
language sql
stable
security definer
set search_path = inventory, pg_temp
as $$
  select l.id
  from inventory.locations l
  join inventory.warehouses w on w.id = l.warehouse_id
  where l.tenant_id = p_tenant_id
    and l.kind = 'stock' and l.is_active and w.is_active
    and (p_branch_id is null or w.branch_id = p_branch_id or w.branch_id is null)
  -- Şubeye ait depo, kiracı geneline tercih edilir; sonra varsayılan işaretli olan
  order by (w.branch_id = p_branch_id) desc nulls last, w.is_default desc, l.code
  limit 1;
$$;

-- Kullanıcının şube kapsamına giren stok konumları.
--
-- Argümansız ve STABLE: RLS politikasında `(select ...)` ile sarmalandığında
-- PostgreSQL bunu satır başına değil SORGU BAŞINA bir kez çalıştırır
-- (core.accessible_branch_ids ile aynı kalıp).
--
-- SECURITY DEFINER olması şart: quants politikası, kullanıcının locations
-- tablosunu okuyabilmesine BAĞLI OLMAMALIDIR. Bağlı olsaydı, stok adedini
-- görmesi gereken ama konum kartlarını görmesi gerekmeyen bir satış temsilcisi
-- boş liste görürdü — ve sebebi politikadan okunamazdı.
create or replace function inventory.accessible_location_ids()
returns uuid[]
language sql
stable
security definer
set search_path = inventory, core, pg_temp
as $$
  select coalesce(array_agg(l.id), '{}')
  from inventory.locations l
  join inventory.warehouses w on w.id = l.warehouse_id
  where l.tenant_id = core.current_tenant_id()
    and (w.branch_id is null
         or core.accessible_branch_ids() @> array[w.branch_id]);
$$;

-- Bakiye hücresini delta kadar oynatır. Hücre yoksa açar.
create or replace function inventory.adjust_quant(
  p_tenant_id uuid, p_location_id uuid, p_product_id uuid, p_lot_id uuid, p_delta numeric
)
returns numeric
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare v_qty numeric;
begin
  insert into inventory.quants (tenant_id, location_id, product_id, lot_id, quantity)
  values (p_tenant_id, p_location_id, p_product_id, p_lot_id, p_delta)
  on conflict (tenant_id, location_id, product_id,
               coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set quantity = inventory.quants.quantity + excluded.quantity, updated_at = now()
  returning quantity into v_qty;
  return v_qty;
end;
$$;

-- FEFO: önce son kullanma tarihi yaklaşan lot çıkar. SKT'si olmayan lotlar en
-- sona bırakılır — tarihli mal her zaman öncelikli tüketilmelidir.
create or replace function inventory.pick_lot(
  p_product_id uuid, p_location_id uuid, p_quantity numeric default 0
)
returns uuid
language sql
stable
security definer
set search_path = inventory, pg_temp
as $$
  select q.lot_id
  from inventory.quants q
  left join inventory.lots l on l.id = q.lot_id
  where q.product_id = p_product_id
    and q.location_id = p_location_id
    and q.quantity - q.reserved >= p_quantity
  order by (l.expiry_date is null), l.expiry_date, q.quantity
  limit 1;
$$;

-- -----------------------------------------------------------------------------
-- Hareketli ortalama maliyet
-- -----------------------------------------------------------------------------
-- GİRİŞTE ortalama yeniden hesaplanır, ÇIKIŞTA o anki ortalama kullanılır.
-- Çıkış maliyeti harekete yazılır ve bir daha değişmez (0500, karar 3).
create or replace function inventory.apply_cost(
  p_tenant_id uuid, p_product_id uuid, p_quantity numeric, p_unit_cost numeric, p_incoming boolean
)
returns numeric
language plpgsql
security definer
set search_path = inventory, pg_temp
as $$
declare
  c inventory.product_costs;
  v_new_qty numeric;
begin
  select * into c from inventory.product_costs
   where tenant_id = p_tenant_id and product_id = p_product_id for update;

  if not found then
    insert into inventory.product_costs (tenant_id, product_id) 
    values (p_tenant_id, p_product_id) returning * into c;
  end if;

  if p_incoming then
    v_new_qty := c.quantity_on_hand + p_quantity;
    update inventory.product_costs
       set quantity_on_hand = v_new_qty,
           total_value = c.total_value + p_quantity * p_unit_cost,
           -- Negatif stoktan çıkışta ortalama bozulmasın diye sıfır koruması
           average_cost = case when v_new_qty > 0
                               then (c.total_value + p_quantity * p_unit_cost) / v_new_qty
                               else p_unit_cost end,
           updated_at = now()
     where tenant_id = p_tenant_id and product_id = p_product_id;
    return case when v_new_qty > 0
                then (c.total_value + p_quantity * p_unit_cost) / v_new_qty
                else p_unit_cost end;
  else
    -- Çıkış: maliyet MEVCUT ortalamadır, hareket onu taşır
    update inventory.product_costs
       set quantity_on_hand = c.quantity_on_hand - p_quantity,
           total_value = greatest(c.total_value - p_quantity * c.average_cost, 0),
           updated_at = now()
     where tenant_id = p_tenant_id and product_id = p_product_id;
    return c.average_cost;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Hareketi işle
-- -----------------------------------------------------------------------------
create or replace function inventory.post_move(p_id uuid)
returns inventory.moves
language plpgsql
security invoker
as $$
declare
  v_move  inventory.moves;
  v_cost  numeric;
  v_after numeric;
begin
  select * into v_move from inventory.moves where id = p_id for update;
  if not found then raise exception 'Stok hareketi bulunamadı' using errcode = 'P0002'; end if;
  if v_move.state <> 'draft' then
    raise exception 'Yalnızca taslak hareket işlenebilir (mevcut: %)', v_move.state
      using errcode = '23514';
  end if;

  -- Maliyet: giriş mi çıkış mı?
  if v_move.to_location_id is not null and v_move.from_location_id is null then
    -- GİRİŞ: ortalama güncellenir ama harekete ORTALAMA DEĞİL, FİİLİ ALIŞ
    -- FİYATI yazılır. Ortalama ürünün özelliğidir (product_costs); hareketin
    -- özelliği o partiye ne ödendiğidir. Ortalamayı harekete yazmak, "bu
    -- çuvala kaç liraya aldık" sorusunu cevapsız bırakırdı.
    perform inventory.apply_cost(v_move.tenant_id, v_move.product_id,
                                 v_move.quantity, v_move.unit_cost, true);
    v_cost := v_move.unit_cost;
  elsif v_move.from_location_id is not null and v_move.to_location_id is null then
    v_cost := inventory.apply_cost(v_move.tenant_id, v_move.product_id,
                                   v_move.quantity, 0, false);
  else
    -- İç transfer: toplam stok ve değer değişmez, yalnızca konum değişir
    select average_cost into v_cost from inventory.product_costs
     where tenant_id = v_move.tenant_id and product_id = v_move.product_id;
    v_cost := coalesce(v_cost, v_move.unit_cost);
  end if;

  if v_move.from_location_id is not null then
    -- Rezervasyondan doğan sevkiyatta ayrılmış miktar serbest bırakılır;
    -- aksi hâlde mal hem çıkmış hem hâlâ ayrılmış görünürdü.
    if v_move.reserves_stock then
      update inventory.quants
         set reserved = greatest(reserved - v_move.quantity, 0), updated_at = now()
       where tenant_id = v_move.tenant_id
         and location_id = v_move.from_location_id
         and product_id = v_move.product_id
         and lot_id is not distinct from v_move.lot_id;
    end if;

    v_after := inventory.adjust_quant(v_move.tenant_id, v_move.from_location_id,
                                      v_move.product_id, v_move.lot_id, -v_move.quantity);
    -- NEGATİF STOK ENGELİ: olmayan malı sevk etmek, hem stok hem maliyet
    -- muhasebesini sessizce bozar. Düzeltme yolu sayımdır, eksi bakiye değil.
    if v_after < 0 then
      raise exception 'Yetersiz stok: % konumunda % adet eksik kalıyor',
        (select code from inventory.locations where id = v_move.from_location_id), abs(v_after)
        using errcode = '23514';
    end if;
  end if;

  if v_move.to_location_id is not null then
    perform inventory.adjust_quant(v_move.tenant_id, v_move.to_location_id,
                                   v_move.product_id, v_move.lot_id, v_move.quantity);
  end if;

  update inventory.moves
     set state = 'done',
         unit_cost = v_cost,
         total_cost = round(v_cost * v_move.quantity, 2),
         number = coalesce(number, core.next_sequence('inventory_move', branch_id, v_move.tenant_id))
   where id = p_id returning * into v_move;

  perform core.emit_event('inventory.move.done', jsonb_build_object(
    'move_id', v_move.id, 'number', v_move.number, 'product_id', v_move.product_id,
    'quantity', v_move.quantity, 'unit_cost', v_move.unit_cost, 'total_cost', v_move.total_cost,
    'from_location_id', v_move.from_location_id, 'to_location_id', v_move.to_location_id,
    'source_module', v_move.source_module, 'source_id', v_move.source_id
  -- Kiracı AÇIKÇA geçilir: post_move olay işleyiciden (arka plan, oturum
  -- bağlamı yok) de çağrılıyor ve emit_event kiracıyı oturumdan çözemez.
  ), v_move.branch_id, null, v_move.tenant_id);

  return v_move;
end;
$$;

-- İşlenmiş hareket değiştirilemez — defter kaydı geriye dönük düzeltilmez,
-- karşı hareketle düzeltilir (muhasebedeki ters kayıt mantığı).
create or replace function inventory.fn_lock_done_move()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.state = 'done' then
      raise exception 'İşlenmiş stok hareketi silinemez (%)', old.number using errcode = '23514';
    end if;
    return old;
  end if;
  if old.state = 'done' and new.state = 'done'
     and (new.quantity, new.product_id, new.from_location_id, new.to_location_id, new.lot_id)
         is distinct from (old.quantity, old.product_id, old.from_location_id, old.to_location_id, old.lot_id)
  then
    raise exception 'İşlenmiş stok hareketi değiştirilemez (%) — düzeltme sayımla yapılır', old.number
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_moves_lock on inventory.moves;
create trigger trg_moves_lock before update or delete on inventory.moves
  for each row execute function inventory.fn_lock_done_move();

-- Bakiye ve maliyet tabloları ELLE değiştirilemez.
-- Bunu TETİKLEYİCİYLE yapmıyoruz: tetikleyici, tek meşru yazma yolu olan
-- inventory.adjust_quant'ı (security definer) da keserdi. Bunun yerine denetim
-- izinde kullanılan yaklaşımın aynısı uygulanıyor — uygulama rolünden INSERT/
-- UPDATE/DELETE yetkisi geri alınıyor (bkz. 0013 core.apply_grants). Definer
-- fonksiyonlar sahip rolüyle çalıştığı için etkilenmez.

-- -----------------------------------------------------------------------------
-- Giriş / çıkış kısayolları (köprüler bunları kullanır)
-- -----------------------------------------------------------------------------
create or replace function inventory.receive_stock(
  p_tenant_id uuid, p_branch_id uuid, p_product_id uuid, p_quantity numeric,
  p_unit_cost numeric, p_lot_id uuid default null,
  p_source_module text default null, p_source_table text default null,
  p_source_id uuid default null, p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_loc  uuid := inventory.default_location(p_tenant_id, p_branch_id);
  v_move uuid;
begin
  if v_loc is null then
    raise exception 'Kiracıda tanımlı stok konumu yok (kiracı %)', p_tenant_id
      using errcode = '22023', hint = 'Envanter modülü kurulum kancası depo açar.';
  end if;

  insert into inventory.moves (tenant_id, branch_id, product_id, lot_id,
                               from_location_id, to_location_id, quantity, unit_cost,
                               source_module, source_table, source_id, reference)
  values (p_tenant_id, p_branch_id, p_product_id, p_lot_id,
          null, v_loc, p_quantity, p_unit_cost,
          p_source_module, p_source_table, p_source_id, p_reference)
  returning id into v_move;

  perform inventory.post_move(v_move);
  return v_move;
end;
$$;

-- Rezervasyon: taslak çıkış hareketi açar ve bakiyede ayrılan miktarı artırır.
-- Stok YETMESE BİLE başarısız olmaz — satış siparişi zaten onaylanmıştır ve
-- envanter onu geri alamaz (modüller birbirini veto edemez). Bunun yerine
-- eksik miktar bir OLAY olarak duyurulur; satın alma tarafı buna abone olup
-- talep açabilir. Sessiz kalmak, sözü verilmiş ama karşılanamayacak siparişin
-- fark edilmemesi demekti.
create or replace function inventory.reserve_stock(
  p_tenant_id uuid, p_branch_id uuid, p_product_id uuid, p_quantity numeric,
  p_source_module text default null, p_source_table text default null,
  p_source_id uuid default null, p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_loc       uuid := inventory.default_location(p_tenant_id, p_branch_id);
  v_lot       uuid;
  v_move      uuid;
  v_available numeric;
begin
  if v_loc is null then
    raise exception 'Kiracıda tanımlı stok konumu yok (kiracı %)', p_tenant_id using errcode = '22023';
  end if;

  v_lot := inventory.pick_lot(p_product_id, v_loc, p_quantity);   -- FEFO

  insert into inventory.moves (tenant_id, branch_id, product_id, lot_id,
                               from_location_id, to_location_id, quantity,
                               state, reserves_stock,
                               source_module, source_table, source_id, reference)
  values (p_tenant_id, p_branch_id, p_product_id, v_lot,
          v_loc, null, p_quantity, 'draft', true,
          p_source_module, p_source_table, p_source_id, p_reference)
  returning id into v_move;

  insert into inventory.quants (tenant_id, location_id, product_id, lot_id, quantity, reserved)
  values (p_tenant_id, v_loc, p_product_id, v_lot, 0, p_quantity)
  on conflict (tenant_id, location_id, product_id,
               coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set reserved = inventory.quants.reserved + excluded.reserved, updated_at = now()
  returning quantity - reserved into v_available;

  if v_available < 0 then
    perform core.emit_event('inventory.stock.shortage', jsonb_build_object(
      'product_id', p_product_id, 'location_id', v_loc,
      'requested', p_quantity, 'short_by', abs(v_available),
      'source_module', p_source_module, 'source_id', p_source_id
    ), p_branch_id, null, p_tenant_id);
  end if;

  return v_move;
end;
$$;

-- Rezervasyonu sevkiyata çevirir: taslak hareketleri işler.
create or replace function inventory.ship_reservation(
  p_source_module text, p_source_table text, p_source_id uuid
)
returns integer
language plpgsql
security invoker
as $$
declare r record; v_n integer := 0;
begin
  for r in
    select id from inventory.moves
     where source_module = p_source_module and source_table = p_source_table
       and source_id = p_source_id and state = 'draft'
     order by created_at
  loop
    perform inventory.post_move(r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function inventory.deliver_stock(
  p_tenant_id uuid, p_branch_id uuid, p_product_id uuid, p_quantity numeric,
  p_source_module text default null, p_source_table text default null,
  p_source_id uuid default null, p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  v_loc  uuid := inventory.default_location(p_tenant_id, p_branch_id);
  v_lot  uuid;
  v_move uuid;
begin
  if v_loc is null then
    raise exception 'Kiracıda tanımlı stok konumu yok (kiracı %)', p_tenant_id using errcode = '22023';
  end if;

  v_lot := inventory.pick_lot(p_product_id, v_loc, p_quantity);   -- FEFO

  insert into inventory.moves (tenant_id, branch_id, product_id, lot_id,
                               from_location_id, to_location_id, quantity,
                               source_module, source_table, source_id, reference)
  values (p_tenant_id, p_branch_id, p_product_id, v_lot,
          v_loc, null, p_quantity,
          p_source_module, p_source_table, p_source_id, p_reference)
  returning id into v_move;

  perform inventory.post_move(v_move);
  return v_move;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sayım
-- -----------------------------------------------------------------------------
-- Sayım farkı, bakiyeyi elle düzelterek DEĞİL, düzeltme hareketi üreterek
-- kapatılır. Böylece "stok neden değişti" sorusu defterden yanıtlanır.
create or replace function inventory.apply_count(p_id uuid)
returns inventory.counts
language plpgsql
security invoker
as $$
declare
  v_count inventory.counts;
  r       record;
  v_move  uuid;
  v_scrap uuid;
begin
  if not core.has_perm('inventory.count.apply') then
    raise exception 'Sayım uygulama yetkiniz yok' using errcode = '42501';
  end if;

  select * into v_count from inventory.counts where id = p_id for update;
  if not found then raise exception 'Sayım bulunamadı' using errcode = 'P0002'; end if;
  if v_count.status <> 'draft' then
    raise exception 'Yalnızca taslak sayım uygulanabilir (mevcut: %)', v_count.status
      using errcode = '23514';
  end if;

  -- Fark hareketlerinin karşı tarafı: düzeltme (scrap) konumu
  select l.id into v_scrap from inventory.locations l
   where l.tenant_id = v_count.tenant_id and l.kind = 'scrap' limit 1;

  for r in
    select * from inventory.count_lines where count_id = p_id and difference <> 0
  loop
    insert into inventory.moves (tenant_id, branch_id, product_id, lot_id,
                                 from_location_id, to_location_id, quantity,
                                 source_module, source_table, source_id, reference, notes)
    values (
      v_count.tenant_id, v_count.branch_id, r.product_id, r.lot_id,
      case when r.difference < 0 then r.location_id else v_scrap end,
      case when r.difference < 0 then v_scrap else r.location_id end,
      abs(r.difference),
      'inventory', 'counts', p_id, v_count.number, 'Sayım farkı')
    returning id into v_move;
    perform inventory.post_move(v_move);
  end loop;

  update inventory.counts
     set status = 'applied', applied_at = now(),
         number = coalesce(number, core.next_sequence('inventory_count', branch_id))
   where id = p_id returning * into v_count;

  perform core.emit_event('inventory.count.applied', jsonb_build_object(
    'count_id', v_count.id, 'number', v_count.number,
    'warehouse_id', v_count.warehouse_id, 'count_date', v_count.count_date
  ), v_count.branch_id);

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Minimum stok uyarısı (pg_cron ile çalıştırılır — Bölüm 3.2)
-- -----------------------------------------------------------------------------
create or replace function inventory.check_reorder_levels(p_min_interval interval default '12 hours')
returns integer
language plpgsql
security definer
set search_path = inventory, core, pg_temp
as $$
declare
  r     record;
  v_n   integer := 0;
begin
  for r in
    select rr.id, rr.tenant_id, rr.branch_id, rr.product_id, rr.min_quantity, rr.max_quantity,
           p.name as product_name, p.sku,
           coalesce(pc.quantity_on_hand, 0) as on_hand
    from inventory.reorder_rules rr
    join core.products p on p.id = rr.product_id
    left join inventory.product_costs pc
      on pc.tenant_id = rr.tenant_id and pc.product_id = rr.product_id
    where rr.is_active
      and coalesce(pc.quantity_on_hand, 0) < rr.min_quantity
      -- Aynı uyarıyı sürekli tekrarlamamak için sessizlik penceresi
      and (rr.last_alert_at is null or rr.last_alert_at < now() - p_min_interval)
  loop
    perform core.emit_event('inventory.stock.low', jsonb_build_object(
      'product_id', r.product_id, 'sku', r.sku, 'product_name', r.product_name,
      'on_hand', r.on_hand, 'min_quantity', r.min_quantity, 'max_quantity', r.max_quantity,
      'suggested_quantity', greatest(coalesce(r.max_quantity, r.min_quantity) - r.on_hand, 0)
    ), r.branch_id, null, r.tenant_id);

    update inventory.reorder_rules set last_alert_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Olaylar
-- -----------------------------------------------------------------------------
select core.declare_event('inventory.move.done', 'inventory', 'Stok hareketi işlendi');
select core.declare_event('inventory.count.applied', 'inventory', 'Sayım farkları stoka işlendi');
select core.declare_event('inventory.stock.shortage', 'inventory',
       'Rezervasyon için yeterli stok yok — sözü verilen sipariş karşılanamıyor');
select core.declare_event('inventory.stock.low', 'inventory',
       'Ürün minimum stok seviyesinin altına düştü',
       '{"product_id":"uuid","on_hand":"numeric","min_quantity":"numeric","suggested_quantity":"numeric"}'::jsonb);
