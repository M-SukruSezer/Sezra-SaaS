/**
 * Kasa istemcisinin sunucu erişimi.
 *
 * Her çağrı çevrimdışı olabileceğini VARSAYAR: ağ hatası bir istisna değil,
 * beklenen bir durumdur. Bu yüzden çağrılar hata fırlatmak yerine
 * `{ ok: false }` döner ve arayüz akışını kesmez.
 */
const BASE = '/api';

let userId = localStorage.getItem('sezra.pos.user') ?? '';
export const setUser = (id: string): void => {
  userId = id;
  localStorage.setItem('sezra.pos.user', id);
};
export const getUser = (): string => userId;

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; offline: boolean };

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    // exactOptionalPropertyTypes açık olduğu için `body: undefined` geçersiz;
    // alan yalnızca gövde VARSA eklenir.
    const init: RequestInit = {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(userId ? { 'x-user-id': userId } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    if (!res.ok) {
      // 502 = proxy hedefe ulaşamadı; bu "çevrimdışı"dır, sunucu hatası değil.
      const offline = res.status === 502 || res.status === 504;
      return { ok: false, offline, error: payload?.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: payload?.data ?? payload };
  } catch (err) {
    // fetch'in kendisi patladıysa ağ yok demektir.
    return { ok: false, offline: true, error: err instanceof Error ? err.message : 'Ağ hatası' };
  }
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
};
