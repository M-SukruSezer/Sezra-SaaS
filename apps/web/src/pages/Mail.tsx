import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useItem, useList } from '../ui/useResource';
import { Card, Empty, EmptyPage, ErrorBox, Field, PageFoot, PageHead } from '../ui';
import { date } from '../i18n';

/**
 * Gelen kutusu.
 *
 * BAGLI HESABIN POSTASI. Sunucuda RLS owner-only: baska kullanici, kiraci
 * yoneticisi, destek modu ve mali musavir bu ekrani ve altindaki mesajlari
 * goremez. Kimlik bilgisi sifreli saklanir, yalnizca senkron/gonderim aninda
 * cozulur ve hicbir yanitta donmez.
 *
 * body_html ASLA ham render EDILMEZ (XSS yolu): her mesaj duz metin (body_text)
 * olarak gosterilir; sunucu HTML-only gelen mesajlarda metni kendisi turetir.
 */

interface MailAccount {
  id: string;
  provider: 'imap' | 'pop3' | 'ms_graph' | 'gmail';
  display_name: string;
  email_address: string;
  status: string;
}

interface MailListRow {
  id: string;
  direction: 'incoming' | 'outgoing';
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string[];
  snippet: string | null;
  has_attachments: boolean;
  seen: boolean;
  send_status: string | null;
  sent_at: string | null;
  received_at: string;
}

interface MailMessage extends MailListRow {
  cc_addrs: string[];
  message_id: string | null;
  in_reply_to: string | null;
  body_text: string | null;
  body_html: string | null;
  size_bytes: number | null;
  send_error: string | null;
}

interface SyncState {
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  message_count: number;
}

interface SyncOutcome {
  ok: boolean;
  fetched: number;
  skipped: number;
  trimmed: number;
  category?: string;
  detail?: string;
}

type Yon = 'incoming' | 'outgoing';

const kisiAdi = (m: { from_name: string | null; from_addr: string | null }) =>
  m.from_name?.trim() || m.from_addr || 'Bilinmeyen gonderen';

export function MailInbox() {
  const hesaplar = useList<MailAccount>('/core/mail/accounts');
  const [seciliHesap, setSeciliHesap] = useState('');
  const [yon, setYon] = useState<Yon>('incoming');
  const [seciliMesaj, setSeciliMesaj] = useState('');
  const [senkronda, setSenkronda] = useState(false);
  const [senkronSonuc, setSenkronSonuc] = useState<SyncOutcome | null>(null);
  const [hata, setHata] = useState<unknown>(null);
  const [yaziyor, setYaziyor] = useState(false);

  // Ilk yuklemede: IMAP/POP3 olan ilk hesabi sec.
  useEffect(() => {
    if (seciliHesap || hesaplar.data.length === 0) return;
    const ilk = hesaplar.data.find((h) => h.provider === 'imap' || h.provider === 'pop3')
      ?? hesaplar.data[0];
    if (ilk) setSeciliHesap(ilk.id);
  }, [hesaplar.data, seciliHesap]);

  const hesap = hesaplar.data.find((h) => h.id === seciliHesap);
  const oauthHesap = hesap?.provider === 'ms_graph' || hesap?.provider === 'gmail';

  const mesajlar = useList<MailListRow>(
    seciliHesap ? `/core/mail/accounts/${seciliHesap}/messages` : '',
    { direction: yon, limit: 100 },
  );
  const durum = useItem<SyncState>(
    seciliHesap ? `/core/mail/accounts/${seciliHesap}/sync-state` : null,
  );
  const mesaj = useItem<MailMessage>(seciliMesaj ? `/core/mail/messages/${seciliMesaj}` : null);

  // Hesap ya da yon degisince acik mesaji birak.
  useEffect(() => { setSeciliMesaj(''); }, [seciliHesap, yon]);

  const ac = async (satir: MailListRow) => {
    setSeciliMesaj(satir.id);
    if (!satir.seen && satir.direction === 'incoming') {
      try {
        await api.post(`/core/mail/messages/${satir.id}/seen`, { seen: true });
        await mesajlar.reload();
      } catch { /* okundu isareti kritik degil */ }
    }
  };

  const senkronla = async () => {
    if (!seciliHesap) return;
    setSenkronda(true); setHata(null); setSenkronSonuc(null);
    try {
      const r = await api.post<{ data: SyncOutcome }>(`/core/mail/accounts/${seciliHesap}/sync`, {});
      setSenkronSonuc(r.data);
      await Promise.all([mesajlar.reload(), durum.reload()]);
    } catch (err) { setHata(err); } finally { setSenkronda(false); }
  };

  if (!hesaplar.loading && hesaplar.data.length === 0) {
    return (
      <EmptyPage
        title="Once bir e-posta hesabi baglayin"
        action={<Link className="btn btn-primary" to="/settings/mail">Mail hesaplari</Link>}
      >
        Gelen kutusu, Ayarlar &gt; Mail Hesaplari ekranindan bagladiginiz IMAP ya da
        POP3 hesabinin postasini gosterir. Kimlik bilgileriniz sifreli saklanir ve
        yalnizca size gorunur.
      </EmptyPage>
    );
  }

  const okunmamis = mesajlar.data.filter((m) => !m.seen && m.direction === 'incoming').length;

  return (
    <>
      <PageHead
        kicker="Posta"
        title="Gelen Kutusu"
        subtitle={
          yon === 'incoming' && okunmamis > 0
            ? `${okunmamis} okunmamis mesaj`
            : 'Bagli hesabinizin postasi. Yalnizca size gorunur.'
        }
        actions={
          <button className="btn btn-primary" disabled={!seciliHesap || senkronda || oauthHesap}
                  onClick={() => void senkronla()}>
            {senkronda ? 'Senkronize ediliyor...' : 'Senkronize et'}
          </button>
        }
      />
      <ErrorBox error={hata ?? hesaplar.error ?? mesajlar.error} />

      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {hesaplar.data.length > 1 && (
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Hesap</span>
            <select value={seciliHesap} onChange={(e) => setSeciliHesap(e.target.value)}>
              {hesaplar.data.map((h) => (
                <option key={h.id} value={h.id}>{h.display_name} ({h.email_address})</option>
              ))}
            </select>
          </label>
        )}
        <div className="row" style={{ gap: 4 }}>
          <button className={`btn${yon === 'incoming' ? ' btn-primary' : ''}`}
                  onClick={() => setYon('incoming')}>Gelen</button>
          <button className={`btn${yon === 'outgoing' ? ' btn-primary' : ''}`}
                  onClick={() => setYon('outgoing')}>Gonderilen</button>
        </div>
        <button className="btn" onClick={() => { setYaziyor(true); setSeciliMesaj(''); }}
                disabled={!seciliHesap || oauthHesap}>Yeni e-posta</button>
      </div>

      {oauthHesap && (
        <Card title="Bu hesap icin senkron yok">
          <p className="muted">
            Microsoft Graph ve Gmail hesaplari OAuth kimlik dogrulamasi gerektirir; bu
            surumde yalnizca IMAP/POP3 ve SMTP destekleniyor. Hesap "yapilandirilmamis"
            olarak kalir.
          </p>
        </Card>
      )}

      {!oauthHesap && (durum.data || senkronSonuc) && (
        <p className="hint" style={{ marginBottom: 12 }}>
          {senkronSonuc && (senkronSonuc.ok
            ? `Senkron tamam: ${senkronSonuc.fetched} yeni mesaj`
              + (senkronSonuc.skipped ? `, ${senkronSonuc.skipped} buyuk mesaj atlandi` : '')
              + (senkronSonuc.trimmed ? `, ${senkronSonuc.trimmed} eski mesaj saklama siniri geregi silindi` : '')
            : `Senkron basarisiz: ${senkronSonuc.detail ?? 'bilinmeyen hata'}`)}
          {!senkronSonuc && durum.data?.last_error && `Son senkron hatasi: ${durum.data.last_error}`}
          {!senkronSonuc && !durum.data?.last_error && durum.data?.last_synced_at
            && `Son senkron: ${date(durum.data.last_synced_at)}`}
        </p>
      )}

      {yaziyor && hesap && (
        <ComposePanel
          accountId={hesap.id}
          fromEmail={hesap.email_address}
          onClose={() => setYaziyor(false)}
          onSent={() => { setYaziyor(false); setYon('outgoing'); void mesajlar.reload(); }}
        />
      )}

      <div className="split">
        <Card title={yon === 'incoming' ? 'Gelen mesajlar' : 'Gonderilen mesajlar'} padded={false}>
          {mesajlar.data.length === 0 && !mesajlar.loading ? (
            <Empty title={yon === 'incoming' ? 'Gelen mesaj yok' : 'Gonderilmis mesaj yok'}>
              {yon === 'incoming'
                ? 'Senkronize et dugmesiyle bagli hesabinizin yeni postalarini cekin.'
                : 'Yeni e-posta ile panelden ilk mesajinizi gonderin.'}
            </Empty>
          ) : (
            <ul className="mail-liste">
              {mesajlar.data.map((m) => (
                <li key={m.id}>
                  <button
                    className={`mail-satir${m.id === seciliMesaj ? ' mail-satir-secili' : ''}${
                      !m.seen && m.direction === 'incoming' ? ' mail-satir-yeni' : ''}`}
                    onClick={() => void ac(m)}
                  >
                    <span className="mail-satir-ust">
                      <span className="mail-satir-kisi">
                        {yon === 'incoming'
                          ? kisiAdi(m)
                          : (m.to_addrs.join(', ') || '(alici yok)')}
                      </span>
                      <span className="mail-satir-zaman">
                        {date(m.direction === 'outgoing' ? (m.sent_at ?? m.received_at) : m.received_at)}
                      </span>
                    </span>
                    <span className="mail-satir-konu">
                      {!m.seen && m.direction === 'incoming' && (
                        <span className="badge badge-info">Yeni</span>
                      )}
                      {m.send_status === 'failed' && (
                        <span className="badge badge-danger">Gonderilemedi</span>
                      )}
                      {m.has_attachments && <span className="badge">Ek</span>}
                      {' '}{m.subject || '(konu yok)'}
                    </span>
                    {m.snippet && <span className="mail-satir-onizleme">{m.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Mesaj">
          {mesaj.loading && <p className="muted">Yukleniyor...</p>}
          {mesaj.error ? <ErrorBox error={mesaj.error} /> : null}
          {!seciliMesaj && !mesaj.loading && (
            <p className="muted">Okumak icin soldan bir mesaj secin.</p>
          )}
          {mesaj.data && <MesajGorunumu m={mesaj.data} />}
          {mesaj.data && mesaj.data.direction === 'incoming' && hesap && (
            <ReplyInline account={hesap} m={mesaj.data}
                         onSent={() => { setYon('outgoing'); void mesajlar.reload(); }} />
          )}
        </Card>
      </div>

      <PageFoot>
        <span>Mesajlar yalnizca size gorunur; kiraci yoneticisi ve destek erisimi dahil kimse okuyamaz.</span>
        <span>Saklama siniri: hesap basina son 500 gelen mesaj. Ek indirme bu surumde yok.</span>
      </PageFoot>
    </>
  );
}

function MesajGorunumu({ m }: { m: MailMessage }) {
  return (
    <article className="mail-govde">
      <h2 style={{ marginTop: 0 }}>{m.subject || '(konu yok)'}</h2>
      <dl className="mail-ust-veri">
        <div><dt>Gonderen</dt><dd>{kisiAdi(m)}</dd></div>
        {m.to_addrs.length > 0 && <div><dt>Alici</dt><dd>{m.to_addrs.join(', ')}</dd></div>}
        {m.cc_addrs.length > 0 && <div><dt>Bilgi</dt><dd>{m.cc_addrs.join(', ')}</dd></div>}
        <div><dt>Tarih</dt><dd>{date(m.direction === 'outgoing' ? (m.sent_at ?? m.received_at) : m.received_at)}</dd></div>
        {m.send_status === 'failed' && m.send_error && (
          <div><dt>Gonderim hatasi</dt><dd>{m.send_error}</dd></div>
        )}
      </dl>
      {m.has_attachments && (
        <p className="hint">Bu mesajin eki var. Ek indirme bu surumde desteklenmiyor.</p>
      )}
      {m.body_html && (
        <p className="hint">Orijinali HTML biciminde; guvenlik geregi duz metne cevrildi.</p>
      )}
      <pre className="mail-metin">{m.body_text || '(bos mesaj)'}</pre>
    </article>
  );
}

function ReplyInline({ account, m, onSent }: {
  account: MailAccount; m: MailMessage; onSent: () => void;
}) {
  const [acik, setAcik] = useState(false);
  if (!acik) {
    return (
      <button className="btn" style={{ marginTop: 12 }} onClick={() => setAcik(true)}>
        Yanitla
      </button>
    );
  }
  const konu = m.subject?.startsWith('RE:') ? m.subject : `RE: ${m.subject ?? ''}`;
  return (
    <div style={{ marginTop: 12 }}>
      <ComposePanel
        accountId={account.id}
        fromEmail={account.email_address}
        preset={{
          to: m.from_addr ?? '',
          subject: konu,
          in_reply_to: m.message_id ?? undefined,
          body: `\n\n--- ${kisiAdi(m)} yazdi ---\n${(m.body_text ?? '').split('\n').map((l) => `> ${l}`).join('\n')}`,
        }}
        embedded
        onClose={() => setAcik(false)}
        onSent={() => { setAcik(false); onSent(); }}
      />
    </div>
  );
}

function ComposePanel({
  accountId, fromEmail, preset, embedded, onClose, onSent,
}: {
  accountId: string;
  fromEmail: string;
  preset?: { to?: string; cc?: string; subject?: string; body?: string; in_reply_to?: string };
  embedded?: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(preset?.to ?? '');
  const [cc, setCc] = useState(preset?.cc ?? '');
  const [subject, setSubject] = useState(preset?.subject ?? '');
  const [body, setBody] = useState(preset?.body ?? '');
  const [gonderiliyor, setGonderiliyor] = useState(false);
  const [hata, setHata] = useState<unknown>(null);
  const [sonuc, setSonuc] = useState<string | null>(null);

  const gonder = async (e: FormEvent) => {
    e.preventDefault();
    setGonderiliyor(true); setHata(null); setSonuc(null);
    try {
      const r = await api.post<{ data: { status: string; detail?: string } }>(
        `/core/mail/accounts/${accountId}/send`,
        {
          to: to.split(',').map((s) => s.trim()).filter(Boolean),
          cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
          subject,
          body_text: body,
          in_reply_to: preset?.in_reply_to,
        },
      );
      if (r.data.status === 'sent') { onSent(); }
      else { setSonuc(r.data.detail ?? 'Mesaj gonderilemedi. Giden kutusuna kayit edildi.'); }
    } catch (err) { setHata(err); } finally { setGonderiliyor(false); }
  };

  return (
    <Card title={embedded ? 'Yanit' : 'Yeni e-posta'}
          actions={<button className="btn btn-ghost" onClick={onClose}>Kapat</button>}>
      <form onSubmit={gonder}>
        <ErrorBox error={hata} />
        {sonuc && <p className="hint">{sonuc}</p>}
        <Field label="Kimden"><input value={fromEmail} readOnly /></Field>
        <Field label="Alici" hint="Virgulle birden fazla adres">
          <input value={to} required inputMode="email"
                 onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Bilgi (CC)">
          <input value={cc} inputMode="email" onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="Konu">
          <input value={subject} required onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Mesaj">
          <textarea value={body} required rows={embedded ? 6 : 10}
                    onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" type="submit" disabled={gonderiliyor}>
            {gonderiliyor ? 'Gonderiliyor...' : 'Gonder'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClose}>Vazgec</button>
        </div>
      </form>
    </Card>
  );
}
