/**
 * API istemcisi.
 *
 * Kimlik başlıkları tek yerde eklenir. Üretimde Supabase oturum token'ı,
 * yerel geliştirmede x-user-id kullanılır (AUTH_MODE=dev).
 */
const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export interface Session {
  userId: string;
  tenantId?: string;
  supportMode?: boolean;
  accessToken?: string;
}

let session: Session | null = null;

export function setSession(s: Session | null): void {
  session = s;
  if (s) localStorage.setItem('sezra.session', JSON.stringify(s));
  else localStorage.removeItem('sezra.session');
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem('sezra.session');
  if (raw) { try { session = JSON.parse(raw) as Session; } catch { /* bozuksa yok say */ } }
  return session;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function headers(withBody: boolean): Record<string, string> {
  // Gövdesiz POST'ta content-type göndermek Fastify'ın "boş gövde" hatasını
  // tetikler; başlık yalnızca gerçekten gövde varken eklenir.
  const h: Record<string, string> = withBody ? { 'content-type': 'application/json' } : {};
  if (!session) return h;
  if (session.accessToken) h.authorization = `Bearer ${session.accessToken}`;
  else h['x-user-id'] = session.userId;
  if (session.tenantId) h['x-tenant-id'] = session.tenantId;
  if (session.supportMode) h['x-support-mode'] = 'on';
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `HTTP ${res.status}`);
  }
  return payload as T;
}

export interface ListResponse<T> { data: T[]; meta: { total: number; limit: number; offset: number } }
export interface ItemResponse<T> { data: T }

export const api = {
  get:    <T>(path: string) => request<T>('GET', path),
  post:   <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch:  <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: (path: string) => request<void>('DELETE', path),

  list: <T>(path: string, params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    return request<ListResponse<T>>('GET', q ? `${path}?${q}` : path);
  },
};
