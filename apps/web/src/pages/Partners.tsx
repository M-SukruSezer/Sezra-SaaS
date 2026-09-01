import { useState } from 'react';
import { api } from '../api/client';
import { useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageHead, SearchInput, Toolbar } from '../ui';
import { useSession } from '../api/session';
import type { Partner, Product } from '../api/types';
import { money } from '../i18n';

export function Partners() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const list = useList<Partner>('/core/partners', {
    q,
    is_customer: kind === 'customer' ? 'true' : undefined,
    is_supplier: kind === 'supplier' ? 'true' : undefined,
    limit: 100,
  });

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setError(null);
    try {
      await api.post('/core/partners', draft);
      setDraft(null);
      await list.reload();
    } catch (err) { setError(err); }
  };

  return (
    <>
      <PageHead
        title="Cariler"
        subtitle={`${list.total} kayıt`}
        actions={can('core.partner.create')
          ? <button className="btn btn-primary"
                    onClick={() => setDraft({ name: '', is_customer: true })}>Yeni cari</button>
          : null}
      />
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Unvan, VKN, e-posta, şehir…" />
        <select style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Tümü</option>
          <option value="customer">Müşteriler</option>
          <option value="supplier">Tedarikçiler</option>
        </select>
      </Toolbar>
      <ErrorBox error={error ?? list.error} />

      {draft && (
        <Card title="Yeni cari" actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setDraft(null)}>Vazgeç</button>
            <button className="btn btn-sm btn-primary" onClick={() => void save()}>Kaydet</button>
          </div>
        }>
          <div className="grid grid-2">
            <Field label="Unvan">
              <input value={String(draft.name ?? '')}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="VKN / TCKN" hint="10 ya da 11 hane">
              <input value={String(draft.tax_no ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_no: e.target.value || null })} />
            </Field>
            <Field label="Vergi dairesi">
              <input value={String(draft.tax_office ?? '')}
                     onChange={(e) => setDraft({ ...draft, tax_office: e.target.value })} />
            </Field>
            <Field label="Şehir">
              <input value={String(draft.city ?? '')}
                     onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </Field>
            <Field label="E-posta">
              <input type="email" value={String(draft.email ?? '')}
                     onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <Field label="Telefon">
              <input value={String(draft.phone ?? '')}
                     onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
          </div>
          <div className="row">
            <label className="row" style={{ fontSize: 13 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(draft.is_customer)}
                     onChange={(e) => setDraft({ ...draft, is_customer: e.target.checked })} /> Müşteri
            </label>
            <label className="row" style={{ fontSize: 13 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(draft.is_supplier)}
                     onChange={(e) => setDraft({ ...draft, is_supplier: e.target.checked })} /> Tedarikçi
            </label>
          </div>
        </Card>
      )}

      <Card padded={false} title={undefined}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Unvan</th><th>Tip</th><th>VKN</th><th>Şehir</th><th>İletişim</th><th className="r">Vade</th></tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td>
                    {p.is_customer && <span className="badge badge-info">Müşteri</span>}{' '}
                    {p.is_supplier && <span className="badge">Tedarikçi</span>}
                  </td>
                  <td className="num">{p.tax_no ?? '—'}</td>
                  <td>{p.city ?? '—'}</td>
                  <td className="muted">{p.email ?? p.phone ?? '—'}</td>
                  <td className="r">{p.payment_term_days} gün</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.data.length === 0 && <Empty />}
        </div>
      </Card>
    </>
  );
}

export function Products() {
  const [q, setQ] = useState('');
  const list = useList<Product>('/core/products', { q, limit: 100 });
  return (
    <>
      <PageHead title="Ürünler" subtitle={`${list.total} kayıt`} />
      <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Ad, SKU, barkod…" /></Toolbar>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>SKU</th><th>Ad</th><th>Tip</th><th className="r">Satış fiyatı</th><th>Durum</th></tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.sku}</td>
                  <td><strong>{p.name}</strong></td>
                  <td className="muted">{p.kind === 'service' ? 'Hizmet' : 'Stoklu'}</td>
                  <td className="r">{money(p.sale_price, p.currency)}</td>
                  <td>{p.is_active
                    ? <span className="badge badge-ok">Aktif</span>
                    : <span className="badge">Pasif</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && list.data.length === 0 && <Empty />}
        </div>
      </Card>
    </>
  );
}
