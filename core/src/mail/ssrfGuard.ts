/**
 * SSRF koruması -- kullanicinin verdigi mail sunucusuna baglanmadan ONCE.
 *
 * "Baglantiyi test et" ucu (mailRoutes -> verify.ts) kullanicinin serbest metin
 * `host`ine acilir. Kisitlanmazsa herhangi bir oturumlu kullanici sunucuyu
 * ic aga / loopback'e / bulut metadata ucuna (169.254.169.254) yonlendirir ve
 * donen kategori (network/tls/auth) port canliligini sizdirir -- ic ag tarayici.
 *
 * Savunma IKI KATMAN (validate-at-boundary + escape-at-sink):
 *   - Sinir: normalizeConfig, apacik ozel/loopback literal IP'leri reddeder.
 *   - Sink: baglanti aninda ad COZULUR ve donen HER adres dogrulanir; boylece
 *     DNS rebinding (once publik, sonra 127.0.0.1 cozen ad) da yakalanir.
 *
 * Genel kural DENYLIST'tir (kullanicinin mail sunucusu keyfi bir publik adrestir,
 * bu yuzden allowlist mumkun degil): ozel/rezerve araliklar reddedilir.
 *
 * DAR OVERRIDE -- MAIL_SSRF_ALLOW: virgulle ayrilmis host/IP listesi. SADECE bu
 * listedeki adresler denylist'i deler. URETIMDE BOS (yani hicbir ozel adrese
 * izin yok). Amaci test/kurulum: yerel sahte IMAP sunucusu (127.0.0.1) gibi
 * bilinen, denetlenebilir bir hedefe izin vermek. NODE_ENV hilesi DEGIL --
 * dar, acik, dokumante bir override; hem sinir hem sink katmani onu gorur.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors.js';

/**
 * MAIL_SSRF_ALLOW'daki izinli host/IP kumesi (kucuk harfe normalize). Cagri
 * aninda okunur ki test surec ici env ayarlayabilsin. Uretimde bos => bos kume.
 */
function allowSet(): Set<string> {
  const raw = process.env.MAIL_SSRF_ALLOW?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Bir IPv4/IPv6 adresi ic/ozel/rezerve mi? true => baglanmak YASAK. */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  // IP degil (cozulmemis ad) -- cagiran once cozmeli.
  return true;
}

/**
 * SINIR katmani icin: SADECE literal IP'lerde karar verir. Ad tabanli host
 * (imap.gmail.com gibi) icin false doner -- onu baglanti aninda ssrfGuard cozup
 * dogrular. Boylece mesru sunucu adlari sinirinda yanlislikla reddedilmez.
 */
export function isBlockedLiteralIp(host: string): boolean {
  if (allowSet().has(host.trim().toLowerCase())) return false; // dar override
  return net.isIP(host) !== 0 && isBlockedAddress(host);
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true;                         // 0.0.0.0/8
  if (a === 10) return true;                        // 10/8 ozel
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 ozel
  if (a === 192 && b === 168) return true;          // 192.168/16 ozel
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64/10 CGNAT
  if (a >= 224) return true;                        // multicast + rezerve
  return false;
}

function isBlockedV6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0]!;        // zone id at
  if (s === '::1' || s === '::') return true;        // loopback / unspecified
  if (s.startsWith('fe80')) return true;             // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) -> gomulu v4'u dogrula.
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isBlockedV4(m[1]!);
  return false;
}

/**
 * Adi cozer ve TUM cozulen adresleri dogrular. Herhangi biri engelliyse hata.
 * Baglanmak icin dogrulanmis bir IP dondurur (SNI icin cagiran orijinal host'u
 * `servername` olarak korur) -- boylece cozum ile baglanma arasindaki yaris
 * (DNS rebinding) kapanir.
 */
export async function resolveSafeAddress(host: string): Promise<string> {
  const allow = allowSet();
  const hostLc = host.trim().toLowerCase();
  const allowed = (ip: string) => allow.has(hostLc) || allow.has(ip.toLowerCase());

  // Zaten literal IP ise dogrudan dogrula (allowlist deler).
  if (net.isIP(host)) {
    if (!allowed(host) && isBlockedAddress(host)) throw blocked(host);
    return host;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new AppError(400, 'mail_host_unresolved', 'Sunucu adi cozulemedi.');
  }
  if (addrs.length === 0) throw new AppError(400, 'mail_host_unresolved', 'Sunucu adi cozulemedi.');
  for (const a of addrs) {
    if (!allowed(a.address) && isBlockedAddress(a.address)) throw blocked(host);
  }
  return addrs[0]!.address;
}

function blocked(host: string): AppError {
  return new AppError(
    400, 'mail_host_forbidden',
    `Bu sunucu adresine baglanilamaz (ic ag / ozel adres): ${host}`,
  );
}
