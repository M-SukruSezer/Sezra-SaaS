import type { FastifyInstance } from 'fastify';
import { registerResource } from './resource.js';
import { withContext } from './db.js';
import { contextFromRequest } from './auth.js';
import { translatePgError } from './errors.js';
import type { SezraModule } from './module.js';

/** Çekirdek varlıkların CRUD uçları — tüm modüller bunlara referans verir. */
export const coreModule: SezraModule = {
  code: 'core',
  register(app: FastifyInstance) {
    registerResource(app, {
      path: '/core/partners',
      schema: 'core', table: 'partners',
      columns: ['id', 'branch_id', 'code', 'name', 'is_company', 'is_customer', 'is_supplier',
        'is_employee', 'tax_office', 'tax_no', 'email', 'phone', 'address', 'district', 'city',
        'postal_code', 'country_code', 'iban', 'payment_term_days', 'credit_limit', 'notes',
        'tags', 'owner_id', 'is_active', 'created_at', 'updated_at'],
      writable: ['branch_id', 'code', 'name', 'is_company', 'is_customer', 'is_supplier',
        'is_employee', 'tax_office', 'tax_no', 'email', 'phone', 'address', 'district', 'city',
        'postal_code', 'country_code', 'iban', 'payment_term_days', 'credit_limit', 'notes',
        'tags', 'owner_id', 'is_active'],
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
  },
};
