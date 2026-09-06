import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadSession, setSession as persist, type Session } from './client';
import type { Me, MeYanit } from './types';
import { setLocale } from '../i18n';

interface SessionState {
  me: Me | null;
  /**
   * Oturum açık ama bu kimliğin PROFİL SATIRI yok.
   *
   * `me === null` ile aynı şey değil: orada oturum ya da ağ sorunu vardır,
   * burada kimlik geçerlidir, kullanıcı yalnızca henüz hiçbir kiracıya
   * bağlanmamıştır. İkisini ayırmak şart -- portal davetini kabul etmeye
   * gelen kişi bu hâlde ve onu giriş ekranına atmak, daveti kabul
   * edemeyeceği bir döngüye sokardı.
   */
  profilYok: boolean;
  loading: boolean;
  error: string | null;
  session: Session | null;
  signIn: (s: Session) => void;
  signOut: () => void;
  switchTenant: (tenantId: string) => void;
  setSupportMode: (on: boolean) => void;
  /** İzin kontrolü — YALNIZCA görünürlük içindir. Güvenlik sınırı RLS'tir. */
  can: (permission: string) => boolean;
  /** `crm.lead` için read.all ya da read.own'dan herhangi biri var mı */
  canAny: (prefix: string, action: string) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSess] = useState<Session | null>(() => loadSession());
  const [me, setMe] = useState<Me | null>(null);
  const [profilYok, setProfilYok] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) { setMe(null); setProfilYok(false); return; }
    setLoading(true); setError(null);
    try {
      const data = await api.get<MeYanit>('/me');
      if (!data.user) {
        // Profilsiz kimlik: `me` doldurulmaz, çünkü uygulamanın geri kalanı
        // profilin varlığına güveniyor. Durum ayrı bayrakta taşınır.
        setProfilYok(true); setMe(null);
      } else {
        setProfilYok(false);
        setMe(data as Me);
        if (data.tenant) setLocale('tr-TR');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Oturum alınamadı');
      setMe(null); setProfilYok(false);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<SessionState>(() => {
    const permissions = new Set(me?.permissions ?? []);
    return {
      me, profilYok, loading, error, session,
      signIn: (s) => { persist(s); setSess(s); },
      signOut: () => { persist(null); setSess(null); setMe(null); setProfilYok(false); },
      switchTenant: (tenantId) => {
        const next = { ...(session as Session), tenantId };
        persist(next); setSess(next);
      },
      setSupportMode: (on) => {
        const next = { ...(session as Session), supportMode: on };
        persist(next); setSess(next);
      },
      can: (p) => permissions.has(p),
      canAny: (prefix, action) =>
        permissions.has(`${prefix}.${action}.all`) || permissions.has(`${prefix}.${action}.own`),
      refresh,
    };
  }, [me, profilYok, loading, error, session, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession, SessionProvider içinde kullanılmalı');
  return ctx;
}
