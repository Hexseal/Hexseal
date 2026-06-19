import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

const redis = Redis.fromEnv();
const PREFIX = 'hexseal:profile:';

const IPFS_GATEWAYS = [
  process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage',
  'https://gateway.lighthouse.storage',
  'https://w3s.link',
  'https://ipfs.io',
];

/**
 * Fetch profile data from either a direct URL (Storj) or an IPFS CID.
 * Redis now stores either:
 *   - a Storj URL (starts with "https://") — fetched directly
 *   - an IPFS CID (legacy / Lighthouse backup) — tried via gateways
 */
async function fetchProfileData(ref: string): Promise<unknown | null> {
  // Direct URL (Storj or any https)
  if (ref.startsWith('https://') || ref.startsWith('http://')) {
    try {
      const res = await fetch(ref, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res.json();
    } catch {
      // fall through to IPFS gateways as last resort
    }
  }

  // IPFS CID fallback (legacy records or when Storj URL fetch fails)
  const cid = ref.startsWith('http') ? null : ref;
  if (!cid) return null;

  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return res.json();
    } catch {
      // try next gateway
    }
  }
  return null;
}

// GET /api/profiles?address=0x...
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')?.toLowerCase();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });

  const ref = await redis.get<string>(`${PREFIX}${address}`);
  if (!ref) return NextResponse.json(null);

  const profile = await fetchProfileData(ref);
  if (!profile) return NextResponse.json(null);

  // Always include the stored ref so client knows where the profile lives
  return NextResponse.json({ ...(profile as object), cid: ref });
}

// POST /api/profiles — update index with new profile ref (Storj URL or IPFS CID)
// Body: { address: string, profileCid: string }
export async function POST(request: NextRequest) {
  try {
    const { address, profileCid } = await request.json() as { address?: string; profileCid?: string };
    if (!address || !profileCid) {
      return NextResponse.json({ error: 'address and profileCid required' }, { status: 400 });
    }
    await redis.set(`${PREFIX}${address.toLowerCase()}`, profileCid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
