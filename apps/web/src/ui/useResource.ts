import { useCallback, useEffect, useState } from 'react';
import { api, type ListResponse } from '../api/client';

/** Liste uçları için tek satırlık veri kancası. */
export function useList<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const key = JSON.stringify(params);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res: ListResponse<T> = await api.list<T>(path, JSON.parse(key));
      setData(res.data);
      // Rapor uçları sayfalama yapmaz ve meta döndürmez
      setTotal(res.meta?.total ?? res.data.length);
    } catch (err) { setError(err); } finally { setLoading(false); }
  }, [path, key]);

  useEffect(() => { void reload(); }, [reload]);
  return { data, total, loading, error, reload };
}

/** Tekil kayıt / özel uçlar için. */
export function useItem<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const res = await api.get<{ data: T }>(path);
      setData(res.data);
    } catch (err) { setError(err); } finally { setLoading(false); }
  }, [path]);

  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, error, reload };
}
