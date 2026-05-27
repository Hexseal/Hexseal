import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

const redis = Redis.fromEnv();
const PREFIX = 'sig404:profile:';

const IPFS_GATEWAYS = [
  process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://w3s.link',
  'https://w3s.link',
  'https://ipfs.io',
  'https://dweb.link',
];

async function fetchByCid(cid: string): Promise<unknown | null> {
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

  const cid = await redis.get<string>(`${PREFIX}${address}`);
  if (!cid) return NextResponse.json(null);

  const profile = await fetchByCid(cid);
  if (!profile) return NextResponse.json(null);

  return NextResponse.json({ ...(profile as object), cid });
}

// POST /api/profiles — update index with new profile CID
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
