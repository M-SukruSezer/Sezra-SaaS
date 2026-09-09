import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RequestContext } from './db.js';
import { unauthorized } from './errors.js';

const base64urlDecode = (s: string) => Buffer.from(s, 'base64url');

interface JwtClaims { sub?: string; exp?: number; role?: string }

/** Supabase'in ürettiği HS256 JWT'sini doğrular. */
function verifyHs256(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Bozuk token');
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = base64urlDecode(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw unauthorized('Token imzası geçersiz');
  }

  const claims = JSON.parse(base64urlDecode(payload).toString('utf8')) as JwtClaims;
  if (claims.exp && claims.exp * 1000 < Date.now()) throw unauthorized('Token süresi dolmuş');
  if (!claims.sub) throw unauthorized('Token kullanıcı taşımıyor');
  return claims;
}

const AUTH_MODE = process.env.AUTH_MODE ?? 'auth';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? '';

if (AUTH_MODE === 'dev' && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_MODE=dev üretimde kullanılamaz');
}

/**
 * İstekten kullanıcı bağlamını çıkarır.
 *
 * `x-tenant-id` başlığı istemciden gelir ve BURADA doğrulanmaz — doğrulama
 * veritabanında `core.current_tenant_id()` içinde üyelik tablosuna karşı yapılır.
 * Uygulama katmanında doğrulamak, unutulabilecek bir kontrol demektir; veritabanı
 * katmanında ise atlanması imkânsızdır.
 */
export function contextFromRequest(req: FastifyRequest): RequestContext {
  const tenantId = (req.headers['x-tenant-id'] as string | undefined)?.trim() || undefined;
  const supportMode = req.headers['x-support-mode'] === 'on';
  const accountantMode = req.headers['x-accountant-mode'] === 'on';

  if (AUTH_MODE === 'dev') {
    const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) throw unauthorized('dev modunda x-user-id başlığı zorunlu');
    return { userId, tenantId, supportMode, accountantMode, requestId: req.id };
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Authorization başlığı eksik');
  if (!JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET tanımlı değil');

  const claims = verifyHs256(header.slice(7), JWT_SECRET);
  return { userId: claims.sub!, tenantId, supportMode, accountantMode, requestId: req.id };
}
