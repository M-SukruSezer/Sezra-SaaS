import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadSession, setSession as persist, type Session } from './client';
import type { Me } from './types';
import { setLocale } from '../i18n';

interface SessionState {
  me: Me | null;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) { setMe(null); return; }
    setLoading(true); setError(null);
    try {
      const data = await api.get<Me>('/me');
      setMe(data);
      if (data.tenant) setLocale('tr-TR');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Oturum alınamadı');
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<SessionState>(() => {
    const permissions = new Set(me?.permissions ?? []);
    return {
      me, loading, error, session,
      signIn: (s) => { persist(s); setSess(s); },
      signOut: () => { persist(null); setSess(null); setMe(null); },
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
  }, [me, loading, error, session, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession, SessionProvider içinde kullanılmalı');
  return ctx;
}
