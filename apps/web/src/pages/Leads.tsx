import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, ErrorBox, Field, PageHead, SearchInput, StatusBadge, Toolbar } from '../ui';
import { money, date } from '../i18n';
import { useSession } from '../api/session';
import type { Board, Lead, LostReason, Partner, Stage } from '../api/types';

export function LeadList() {
  const { me, can } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const leads = useList<Lead>('/crm/leads', { q, status: status || undefined, limit: 100 });
  const currency = me?.tenant?.currency ?? 'TRY';

  return (
    <>
      <PageHead
        title="Fırsatlar"
        subtitle={`${leads.total} kayıt`}
        actions={can('crm.lead.create')
          ? <Link className="btn btn-primary" to="/crm/leads/yeni">Yeni fırsat</Link> : null}
      />
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Fırsat, kişi, e-posta…" />
        <select style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Tüm durumlar</option>
          <option value="open">Açık</option>
          <option value="won">Kazanıldı</option>
          <option value="lost">Kaybedildi</option>
        </select>
      </Toolbar>
      <ErrorBox error={leads.error} />

      <Card padded={false}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fırsat</th><th>Kişi</th><th>Durum</th>
                <th className="r">Beklenen ciro</th><th className="r">Olasılık</th><th>Kapanış</th>
              </tr>
            </thead>
            <tbody>
              {leads.data.map((l) => (
                <tr key={l.id} style={{ cursor: 'pointer' }}>
                  <td><Link to={`/crm/leads/${l.id}`}><strong>{l.name}</strong></Link></td>
                  <td className="muted">{l.contact_name ?? '—'}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td className="r">{money(l.expected_revenue, l.currency || currency)}</td>
                  <td className="r">%{l.probability}</td>
                  <td>{date(l.expected_close_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!leads.loading && leads.data.length === 0 && <Empty />}
        </div>
      </Card>
    </>
  );
}

export function LeadForm() {
  const { id } = useParams();
  const isNew = !id || id === 'yeni';
  const nav = useNavigate();
  const { me, can } = useSession();

  const board = useItem<Board>('/crm/board');
  const lead = useItem<Lead>(isNew ? null : `/crm/leads/${id}`);
  const partners = useList<Partner>('/core/partners', { is_customer: 'true', limit: 200 });
  const stages = useList<Stage>('/crm/stages', { limit: 50 });
  const reasons = useList<LostReason>('/crm/lost-reasons', { limit: 50 });

  const [form, setForm] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const value = <K extends keyof Lead>(key: K): string =>
    String(form[key] ?? lead.data?.[key] ?? '');

  const set = (key: string, v: unknown) => setForm((f) => ({ ...f, [key]: v }));

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const payload: Record<string, unknown> = { ...form };
      if (isNew) {
        payload.pipeline_id = board.data?.pipeline.id;
        payload.stage_id ??= board.data?.stages[0]?.id;
      }
      // Boş metin alanlarını null'a çevir: '' bir tarih ya da uuid değildir
      for (const [k, v] of Object.entries(payload)) if (v === '') payload[k] = null;

      const res = isNew
        ? await api.post<{ data: Lead }>('/crm/leads', payload)
        : await api.patch<{ data: Lead }>(`/crm/leads/${id}`, payload);
      nav(`/crm/leads/${res.data.id}`);
      setForm({});
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  const readOnly = !isNew && !can('crm.lead.write.all') && !can('crm.lead.write.own');
  const currency = me?.tenant?.currency ?? 'TRY';

  if (!isNew && lead.loading) return <p className="muted">Yükleniyor…</p>;
  if (!isNew && lead.error) return <ErrorBox error={lead.error} />;

  return (
    <>
      <PageHead
        title={isNew ? 'Yeni fırsat' : (lead.data?.name ?? '')}
        subtitle={!isNew && lead.data ? <StatusBadge status={lead.data.status} /> : undefined}
        actions={<Link className="btn" to="/crm/board">Tahtaya dön</Link>}
      />
      <ErrorBox error={error} />

      <div className="split">
        <Card title="Fırsat bilgileri">
          <Field label="Başlık">
            <input value={value('name')} disabled={readOnly}
                   onChange={(e) => set('name', e.target.value)} />
          </Field>

          <div className="grid grid-2">
            <Field label="Müşteri">
              <select value={value('partner_id')} disabled={readOnly}
                      onChange={(e) => set('partner_id', e.target.value)}>
                <option value="">— seçilmedi —</option>
                {partners.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Aşama">
              <select value={value('stage_id')} disabled={readOnly}
                      onChange={(e) => set('stage_id', e.target.value)}>
                {stages.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-2">
            <Field label="İlgili kişi">
              <input value={value('contact_name')} disabled={readOnly}
                     onChange={(e) => set('contact_name', e.target.value)} />
            </Field>
            <Field label="Telefon">
              <input value={value('phone')} disabled={readOnly}
                     onChange={(e) => set('phone', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-2">
            <Field label={`Beklenen ciro (${currency})`}>
              <input type="number" step="0.01" value={value('expected_revenue')} disabled={readOnly}
                     onChange={(e) => set('expected_revenue', e.target.value)} />
            </Field>
            <Field label="Tahmini kapanış">
              <input type="date" value={value('expected_close_date').slice(0, 10)} disabled={readOnly}
                     onChange={(e) => set('expected_close_date', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-2">
            <Field label="Kaynak" hint="referans, instagram, walk-in…">
              <input value={value('source')} disabled={readOnly}
                     onChange={(e) => set('source', e.target.value)} />
            </Field>
            <Field label="Kayıp sebebi" hint="yalnızca kaybedildi aşamasında geçerli">
              <select value={value('lost_reason_id')} disabled={readOnly}
                      onChange={(e) => set('lost_reason_id', e.target.value)}>
                <option value="">—</option>
                {reasons.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Notlar">
            <textarea rows={4} value={value('notes')} disabled={readOnly}
                      onChange={(e) => set('notes', e.target.value)} />
          </Field>

          {!readOnly && (
            <button className="btn btn-primary" onClick={() => void save()}
                    disabled={saving || Object.keys(form).length === 0}>
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          )}
        </Card>

        <div className="grid">
          {!isNew && lead.data && (
            <Card title="Özet">
              <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
                <div><dt className="stat-label">Olasılık</dt><dd style={{ margin: 0 }}>%{lead.data.probability}</dd></div>
                <div><dt className="stat-label">Oluşturulma</dt><dd style={{ margin: 0 }}>{date(lead.data.created_at)}</dd></div>
                <div><dt className="stat-label">Son güncelleme</dt><dd style={{ margin: 0 }}>{date(lead.data.updated_at)}</dd></div>
              </dl>
            </Card>
          )}
          {readOnly && (
            <Card title="Yetki">
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                Bu kaydı görüntüleyebiliyorsunuz ama düzenleme yetkiniz yok.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
