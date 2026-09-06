import type { FastifyInstance } from 'fastify';
import { registerResource } from './resource.js';
import { withContext } from './db.js';
import { contextFromRequest } from './auth.js';
import { badRequest, notFound, translatePgError } from './errors.js';
import type { SezraModule } from './module.js';
import { registerPlatformRoutes } from './platform.js';
import { registerFxRoutes } from './fx.js';
import { registerSearch, registerSearchSource } from './search.js';
import { registerNotifications } from './notifications.js';
import { registerPartnerDetail, registerPartnerRelation } from './partnerDetail.js';
import { registerSmsRoutes } from './smsRoutes.js';
import { registerPortalRoutes } from './portalRoutes.js';

/** Çekirdek varlıkların CRUD uçları — tüm modüller bunlara referans verir. */
export const coreModule: SezraModule = {
  code: 'core',
  register(app: FastifyInstance) {
    registerResource(app, {
      path: '/core/partners',
      schema: 'core', table: 'partners', readFrom: 'v_partner_list',
      columns: ['id', 'branch_id', 'code', 'name', 'is_company', 'is_customer', 'is_supplier',
        'is_employee', 'tax_office', 'tax_no', 'email', 'phone', 'address', 'district', 'city',
        'postal_code', 'country_code', 'iban', 'payment_term_days', 'credit_limit', 'notes',
        'tags', 'owner_id', 'is_active', 'created_at', 'updated_at',
        'owner_name', 'branch_name',
        'sector', 'discount_pct', 'consent_sms', 'consent_email',
        'consent_whatsapp', 'consent_at', 'website'],
      filterable: ['branch_id', 'code', 'name', 'is_customer', 'is_supplier', 'is_employee',
        'city', 'owner_id', 'is_active', 'tax_no'],
      sortable: ['name', 'code', 'city', 'created_at', 'updated_at'],
      writable: ['branch_id', 'code', 'name', 'is_company', 'is_customer', 'is_supplier',
        'is_employee', 'tax_office', 'tax_no', 'email', 'phone', 'website', 'address',
        'district', 'city', 'postal_code', 'country_code', 'iban', 'payment_term_days',
        'credit_limit', 'notes', 'tags', 'owner_id', 'is_active',
        // İYS izni KANAL BAZINDA: tek bayrak olsaydı SMS'e izin veren
        // müşteriye e-posta da gönderilirdi.
        'sector', 'discount_pct', 'consent_sms', 'consent_email', 'consent_whatsapp'],
      searchable: ['name', 'tax_no', 'email', 'phone', 'city'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/products',
      schema: 'core', table: 'products',
      columns: ['id', 'sku', 'barcode', 'name', 'description', 'kind', 'category_id', 'uom_id',
        'purchase_uom_id', 'sale_price', 'purchase_price', 'currency', 'sale_tax_id',
        'purchase_tax_id', 'is_sellable', 'is_purchasable', 'is_active', 'attributes',
        'created_at', 'updated_at'],
      writable: ['sku', 'barcode', 'name', 'description', 'kind', 'category_id', 'uom_id',
        'purchase_uom_id', 'sale_price', 'purchase_price', 'currency', 'sale_tax_id',
        'purchase_tax_id', 'is_sellable', 'is_purchasable', 'is_active', 'attributes'],
      searchable: ['name', 'sku', 'barcode'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/product-categories',
      schema: 'core', table: 'product_categories',
      columns: ['id', 'parent_id', 'code', 'name', 'path', 'created_at'],
      writable: ['parent_id', 'code', 'name', 'path'],
      searchable: ['name'], defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/taxes',
      schema: 'core', table: 'taxes',
      columns: ['id', 'code', 'name', 'rate', 'kind', 'withholding_num', 'withholding_den',
        'exemption_code', 'is_default_sale', 'is_default_purchase', 'is_active'],
      writable: ['code', 'name', 'rate', 'kind', 'withholding_num', 'withholding_den',
        'exemption_code', 'is_default_sale', 'is_default_purchase', 'is_active'],
      defaultSort: 'rate', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/uoms',
      schema: 'core', table: 'uoms',
      columns: ['id', 'code', 'name', 'category', 'ratio', 'is_active'],
      writable: ['code', 'name', 'category', 'ratio', 'is_active'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/branches',
      schema: 'core', table: 'branches',
      columns: ['id', 'code', 'name', 'address', 'city', 'phone', 'is_headquarter', 'is_active'],
      writable: ['code', 'name', 'address', 'city', 'phone', 'is_headquarter', 'is_active'],
      defaultSort: 'name', defaultOrder: 'asc',
    });

    registerResource(app, {
      path: '/core/documents',
      schema: 'core', table: 'documents',
      columns: ['id', 'branch_id', 'related_module', 'related_table', 'related_id', 'name',
        'mime_type', 'size_bytes', 'storage_path', 'owner_id', 'created_at'],
      writable: ['branch_id', 'related_module', 'related_table', 'related_id', 'name',
        'mime_type', 'size_bytes', 'storage_path', 'checksum'],
      defaultSort: 'created_at',
    });

    // Denetim izi — salt okunur
    app.get('/core/audit-log', async (req) => {
      const ctx = contextFromRequest(req);
      const q = req.query as Record<string, string>;
      const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
      try {
        return await withContext(ctx, async (tx) => {
          const rows = await tx`
            select a.id, a.actor_id, u.full_name as actor_name, a.action,
                   a.entity_schema, a.entity_table, a.entity_id, a.changed_fields,
                   a.support_session, a.occurred_at
            from core.audit_log a
            left join core.users u on u.id = a.actor_id
            ${q.entity_table ? tx`where a.entity_table = ${q.entity_table}` : tx``}
            order by a.occurred_at desc
            limit ${limit} offset ${offset}`;
          return { data: rows, meta: { limit, offset } };
        });
      } catch (err) { throw translatePgError(err); }
    });

    // Kullanıcı davet etme (RBAC ataması dâhil)
    app.post('/core/users/invite', async (req, reply) => {
      const ctx = contextFromRequest(req);
      const body = req.body as {
        email: string; full_name?: string; role_code: string; branch_ids?: string[];
      };
      try {
        const result = await withContext(ctx, async (tx) => {
          const [row] = await tx`
            select core.invite_user(${body.email}, ${body.full_name ?? null},
                                    ${body.role_code}, ${body.branch_ids ?? null}) as user_id`;
          return row;
        });
        reply.code(201);
        return { data: result };
      } catch (err) { throw translatePgError(err); }
    });

    // Kiracının kullanıcıları ve rolleri
    // ========================= Ayarlar =========================
    registerResource(app, {
      path: '/core/sequences',
      schema: 'core', table: 'sequences',
      columns: ['id', 'branch_id', 'code', 'prefix', 'suffix', 'padding',
        'period', 'period_key', 'next_value', 'updated_at'],
      // next_value ELLE değiştirilebilir ama code değiştirilemez: kod, belgeyi
      // üreten fonksiyonun aradığı anahtardır; değişirse numaralandırma kopar.
      writable: ['branch_id', 'prefix', 'suffix', 'padding', 'period'],
      searchable: ['code', 'prefix'],
      defaultSort: 'code', defaultOrder: 'asc',
    });

    /** Şirket kartı. Okuma her üyeye açık, yazma core.tenant.write.all ister. */
    app.get('/core/tenant', async (req) => {
      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          const [row] = await tx`
            select t.id, t.slug, t.name, t.legal_name, t.tax_office, t.tax_no,
                   t.sector, t.country_code, t.currency, t.locale, t.timezone,
                   t.fiscal_year_start_month, t.created_at,
                   s.plan_code, s.status::text as subscription_status,
                   s.seats, s.branch_quota, s.trial_ends_at
            from core.tenants t
            left join core.subscriptions s
              on s.tenant_id = t.id and s.status in ('trial', 'active', 'past_due')
            where t.id = coalesce(core.current_tenant_id(), core.support_tenant_id())`;
          if (!row) throw notFound('Şirket bulunamadı');
          return { data: row };
        });
      } catch (err) { throw translatePgError(err); }
    });

    app.patch('/core/tenant', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      // Beyaz liste: slug ve plan buradan değişmez. Slug adres demektir,
      // plan ise faturalamayı ilgilendirir ve platform konsolundan yönetilir.
      const allowed = ['name', 'legal_name', 'tax_office', 'tax_no', 'sector',
        'country_code', 'currency', 'locale', 'timezone', 'fiscal_year_start_month'];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in b) patch[k] = b[k];
      if (Object.keys(patch).length === 0) throw badRequest('Güncellenecek alan yok');


      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          const [row] = await tx`
            update core.tenants set ${tx(patch)}
            where id = core.current_tenant_id() returning *`;
          if (!row) throw notFound('Şirket güncellenemedi ya da yetkiniz yok');
          return { data: row };
        });
      } catch (err) { throw translatePgError(err); }
    });

    /**
     * Kendi profili.
     *
     * `is_platform_admin` beyaz listede DEĞİL: kullanıcının kendini platform
     * yöneticisi yapabilmesi, tüm kiracıları açan bir yetki yükseltmesi olurdu.
     * Veritabanında da ayrıca engelli; burada ikinci katman.
     */
    app.patch('/core/profile', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const allowed = ['full_name', 'phone', 'avatar_url', 'locale', 'timezone'];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in b) patch[k] = b[k];
      if (Object.keys(patch).length === 0) throw badRequest('Güncellenecek alan yok');

      /**
       * Profil görseli DOĞRULANIR.
       *
       * Bu ucu HER kullanıcı çağırabilir; istemcideki kontrol bir kolaylık,
       * sınır değildir. Doğrulanmasaydı bir kullanıcı buraya megabaytlarca
       * veri ya da `data:text/html` gibi bir belge yazabilirdi -- ve o değer
       * `/me` ile her istekte, kullanıcı listelerinde de her satırda taşınır.
       *
       * Yalnızca base64 kodlu bitmap kabul edilir. SVG YOK: bir belge türüdür
       * ve buraya yazma yetkisi herkeste.
       */
      if ('avatar_url' in patch && patch.avatar_url !== null) {
        const v = patch.avatar_url;
        if (typeof v !== 'string') throw badRequest('avatar_url metin olmalı');
        const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v);
        if (!m) throw badRequest('Profil görseli base64 kodlu PNG, JPEG ya da WebP olmalı');
        const bayt = Buffer.from(m[2]!, 'base64').length;
        if (bayt === 0) throw badRequest('Profil görseli boş');
        if (bayt > 256 * 1024) throw badRequest('Profil görseli 256 KB\'ı aşamaz');
      }

      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          const [row] = await tx`
            update core.users set ${tx(patch)}
            where id = core.current_user_id()
            returning id, email, full_name, phone, avatar_url, locale, timezone`;
          if (!row) throw notFound('Profil güncellenemedi');
          return { data: row };
        });
      } catch (err) { throw translatePgError(err); }
    });

    app.get('/core/users', async (req) => {
      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          const rows = await tx`
            select u.id, u.email, u.full_name, u.last_seen_at, m.is_active,
                   coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as roles,
                   coalesce(array_agg(distinct b.name) filter (where b.name is not null), '{}') as branches
            from core.memberships m
            join core.users u on u.id = m.user_id
            left join core.membership_roles mr on mr.membership_id = m.id
            left join core.roles r on r.id = mr.role_id
            left join core.membership_branches mb on mb.membership_id = m.id
            left join core.branches b on b.id = mb.branch_id
            where m.tenant_id = core.current_tenant_id()
            group by u.id, u.email, u.full_name, u.last_seen_at, m.is_active
            order by u.full_name`;
          return { data: rows };
        });
      } catch (err) { throw translatePgError(err); }
    });

    /**
     * Üyenin rollerini ve şube kapsamını değiştirir.
     *
     * YETKİ SINIRI VERİTABANINDA: `core.set_member_roles` hem izni hem de
     * "son yönetici" kuralını kendisi uygular. Burada tekrar kontrol etmek,
     * iki ayrı doğruluk kaynağı yaratır ve ikisi zamanla ayrışır.
     */
    app.post('/core/users/:id/roles', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { role_codes?: unknown; branch_ids?: unknown };
      if (!Array.isArray(b.role_codes) || b.role_codes.length === 0) {
        throw badRequest('role_codes en az bir rol içermeli');
      }
      const roller = b.role_codes.filter((r): r is string => typeof r === 'string');
      // NULL ile BOŞ DİZİ farklı: null "tüm şubeler", boş dizi "hiçbiri".
      const subeler = b.branch_ids === undefined || b.branch_ids === null
        ? null
        : (b.branch_ids as unknown[]).filter((x): x is string => typeof x === 'string');
      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          await tx`select core.set_member_roles(${id}, ${roller}, ${subeler})`;
          return { data: { ok: true } };
        });
      } catch (err) { throw translatePgError(err); }
    });

    /** Üyeliği açar/kapatır. Kayıt silinmez: geçmiş kullanıcıya bağlıdır. */
    app.post('/core/users/:id/active', async (req) => {
      const { id } = req.params as { id: string };
      const b = (req.body ?? {}) as { active?: unknown };
      if (typeof b.active !== 'boolean') throw badRequest('active bir boolean olmalı');
      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          await tx`select core.set_member_active(${id}, ${b.active as boolean})`;
          return { data: { ok: true } };
        });
      } catch (err) { throw translatePgError(err); }
    });

    // Atanabilir roller
    app.get('/core/roles', async (req) => {
      const ctx = contextFromRequest(req);
      try {
        return await withContext(ctx, async (tx) => {
          const rows = await tx`
            select id, code, name, description, is_system, rank from core.roles order by rank, name`;
          return { data: rows };
        });
      } catch (err) { throw translatePgError(err); }
    });

    // Platform konsolu: kiracı uçları değil, Sezra tarafının işletme ekranı.
    registerPlatformRoutes(app);
    registerFxRoutes(app);
    registerSearch(app);
    registerNotifications(app);
    registerPartnerDetail(app);
    registerSmsRoutes(app);
    registerPortalRoutes(app);

    /** SMS geçmişi: kim, kime, ne zaman ve neden gitmedi. */
    registerResource(app, {
      path: '/core/sms-messages',
      schema: 'core', table: 'sms_messages',
      columns: ['id', 'branch_id', 'partner_id', 'contact_id', 'phone', 'body',
        'is_commercial', 'status', 'provider', 'provider_ref', 'error',
        'sent_at', 'owner_id', 'created_at'],
      // GÖNDERİLEN MESAJ DÜZENLENMEZ: kayıt, gönderilmiş bir iletinin
      // kanıtıdır; sonradan metnini değiştirmek onu kanıt olmaktan çıkarır.
      writable: [],
      searchable: ['phone', 'body'],
      defaultSort: 'created_at', defaultOrder: 'desc',
    });

    /* ---- Cari kartının çekirdek ilişkileri -----------------------------
       İlgili kişiler her kiracıda var ve bir modüle bağlı değil. */
    /* Dosyalar: belge deposu kaydı ilgili modül/tablo/kimlikle bağlanıyor,
       dolayısıyla cariye ait olanlar da buradan çıkar. */
    registerPartnerRelation({
      anahtar: 'dosya', etiket: 'Dosya', sira: 95,
      izin: 'core.document.read.all',
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet from core.documents
          where related_table = 'partners' and related_id = ${id}`;
        return { adet: Number((r as { adet: number }).adet), toplam: null };
      },
      satirlar: (tx, id, limit) => tx`
        select d.id, d.name, d.mime_type, d.size_bytes, d.created_at,
               u.full_name as owner_name
        from core.documents d
        left join core.users u on u.id = d.owner_id
        where d.related_table = 'partners' and d.related_id = ${id}
        order by d.created_at desc limit ${limit}`,
    });

    registerPartnerRelation({
      anahtar: 'kisi', etiket: 'İlgili kişi', sira: 90,
      ozet: async (tx, id) => {
        const [r] = await tx`
          select count(*)::int as adet from core.partner_contacts where partner_id = ${id}`;
        return { adet: Number((r as { adet: number }).adet), toplam: null };
      },
      satirlar: (tx, id, limit) => tx`
        select id, name, title, email, phone, is_primary
        from core.partner_contacts where partner_id = ${id}
        order by is_primary desc, name limit ${limit}`,
    });

    /* ---- Genel aramanın çekirdek kaynakları ----------------------------
       Cari ve ürün her kiracıda vardır; modüle bağlı değiller, o yüzden
       burada duruyorlar. Diğer kayıtları kendi modülleri tanıtır. */
    registerSearchSource({
      etiket: 'Cari', sira: 1, izin: 'core.partner.read.all',
      ara: (tx, desen, limit) => tx`
        select id, name as baslik,
               nullif(concat_ws(' · ', code, tax_no, city), '') as alt
        from core.v_partner_list
        where name ilike ${desen} or coalesce(code, '') ilike ${desen}
           or coalesce(tax_no, '') ilike ${desen} or coalesce(email, '') ilike ${desen}
           or coalesce(phone, '') ilike ${desen}
        order by name limit ${limit}`
        .then((r) => r.map((x) => ({
          ...x, yol: `/partners/${(x as { id: string }).id}`,
        } as never))),
    });

    registerSearchSource({
      etiket: 'Ürün', sira: 2, izin: 'core.product.read.all',
      ara: (tx, desen, limit) => tx`
        select id, name as baslik, nullif(concat_ws(' · ', sku, barcode), '') as alt
        from core.products
        where name ilike ${desen} or sku ilike ${desen}
           or coalesce(barcode, '') ilike ${desen}
        order by name limit ${limit}`
        .then((r) => r.map((x) => ({ ...x, yol: '/products' } as never))),
    });
  },
};
