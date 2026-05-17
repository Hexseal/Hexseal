import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const REGION_MAP: Record<string, number> = {
  // CIS = 0
  RU: 0, BY: 0, KZ: 0, UZ: 0, AZ: 0, AM: 0, GE: 0, MD: 0, TJ: 0, TM: 0, KG: 0,
  // Asia = 1
  CN: 1, JP: 1, KR: 1, TH: 1, VN: 1, ID: 1, PH: 1, MY: 1, SG: 1, MM: 1, KH: 1, LA: 1, IN: 1,
  // Europe = 2
  DE: 2, FR: 2, IT: 2, ES: 2, PL: 2, NL: 2, SE: 2, NO: 2, DK: 2,
  FI: 2, PT: 2, BE: 2, AT: 2, CH: 2, CZ: 2, RO: 2, HU: 2, GR: 2, UA: 2,
  // US = 3
  US: 3,
  // LATAM = 4
  BR: 4, MX: 4, AR: 4, CO: 4, CL: 4, PE: 4, VE: 4, EC: 4, BO: 4, PY: 4, UY: 4,
  GT: 4, HN: 4, SV: 4, NI: 4, CR: 4, PA: 4, DO: 4, CU: 4,
  // CA = 5
  CA: 5, GB: 5,
  // AU = 6
  AU: 6, NZ: 6,
};

// Internal cache code 10 = VPN/proxy (contractRegion=3, same $10 price)
const FEE_MAP: Record<number, { usdc: number; label: string; contractRegion: number }> = {
  0:  { usdc: 2_000_000,  label: 'CIS · $2',    contractRegion: 0 },
  1:  { usdc: 4_000_000,  label: 'Asia · $4',   contractRegion: 1 },
  2:  { usdc: 7_000_000,  label: 'Europe · $7', contractRegion: 2 },
  3:  { usdc: 10_000_000, label: 'US · $10',    contractRegion: 3 },
  4:  { usdc: 4_000_000,  label: 'LATAM · $4',  contractRegion: 4 },
  5:  { usdc: 10_000_000, label: 'CA · $10',    contractRegion: 5 },
  6:  { usdc: 7_000_000,  label: 'AU · $7',     contractRegion: 6 },
  10: { usdc: 10_000_000, label: 'VPN · $10',   contractRegion: 3 },
};

const CACHE_TTL_SECONDS = 3600;
const REDIS_PREFIX = 'region:ip:';

let redis: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = Redis.fromEnv();
}

const _localCache = new Map<string, { region: number; expires: number }>();

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;
  return '127.0.0.1';
}

async function getCached(ip: string): Promise<number | null> {
  if (redis) {
    const val = await redis.get<number>(`${REDIS_PREFIX}${ip}`);
    return val ?? null;
  }
  const entry = _localCache.get(ip);
  if (entry && Date.now() < entry.expires) return entry.region;
  return null;
}

async function setCached(ip: string, region: number): Promise<void> {
  if (redis) {
    await redis.set(`${REDIS_PREFIX}${ip}`, region, { ex: CACHE_TTL_SECONDS });
  } else {
    _localCache.set(ip, { region, expires: Date.now() + CACHE_TTL_SECONDS * 1000 });
  }
}

// Resolve region code (0-3) and VPN flag using ip-api.com (has free proxy detection).
// Falls back to ipapi.co without VPN detection if ip-api.com is unavailable.
async function resolveRegion(ip: string): Promise<{ cacheCode: number; contractRegion: number }> {
  // ip-api.com: free tier, HTTP only, proxy+hosting fields, fails gracefully on private IPs
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,countryCode,proxy,hosting`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    const data = await res.json();

    if (data.status === 'success') {
      const isVpn = !!(data.proxy || data.hosting);
      if (isVpn) return { cacheCode: 10, contractRegion: 3 };
      const region = REGION_MAP[data.countryCode as string] ?? 1;
      return { cacheCode: region, contractRegion: region };
    }
    // status === 'fail' means private/reserved IP — fall through to ipapi.co
  } catch {
    // ip-api.com unreachable — fall through
  }

  // Fallback: ipapi.co (no VPN detection, but more reliable HTTPS)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://ipapi.co/${ip}/json/`, {
      headers: { 'User-Agent': 'Signature404/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    const region = REGION_MAP[data.country_code as string] ?? 1;
    return { cacheCode: region, contractRegion: region };
  } catch {
    return { cacheCode: 1, contractRegion: 1 };
  }
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);

  const cached = await getCached(ip);
  if (cached !== null) {
    const fee = FEE_MAP[cached] ?? FEE_MAP[1];
    return NextResponse.json({ region: fee.contractRegion, fee: fee.usdc, label: fee.label });
  }

  const { cacheCode, contractRegion } = await resolveRegion(ip);
  await setCached(ip, cacheCode);

  const fee = FEE_MAP[cacheCode] ?? FEE_MAP[1];
  return NextResponse.json({ region: contractRegion, fee: fee.usdc, label: fee.label });
}
