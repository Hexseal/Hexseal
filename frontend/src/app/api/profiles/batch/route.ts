import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Batch profile lookup — same source as /api/profiles (deterministic relayer
 * URLs, no index/DB), but issued as one client request instead of N.
 *
 * fetchProfile() in lib/profiles-ipfs.ts coalesces same-tick calls into a
 * single request here, so a list of N cards (each calling useProfile) fires
 * one round-trip instead of N parallel ones.
 */

const RELAYER_URL = (
  process.env.NEXT_PUBLIC_RELAYER_URL || process.env.RELAYER_PUBLIC_URL || ''
).replace(/\/$/, '');

const MAX_ADDRESSES = 100;

// Addresses are interpolated straight into the relayer path below — restrict
// to exactly what an address can be so nothing (`../`, `/`, query strings) can
// escape the `profile-<addr>.json` filename it's meant to stay inside.
const ETH_ADDR = /^0x[0-9a-f]{40}$/;

// POST /api/profiles/batch  { addresses: string[] }  →  { [address]: profile | null }
export async function POST(request: NextRequest) {
  let body: { addresses?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (!Array.isArray(body.addresses)) {
    return NextResponse.json({ error: 'addresses must be an array' }, { status: 400 });
  }

  const addresses = Array.from(new Set(
    body.addresses
      .filter((a): a is string => typeof a === 'string')
      .map(a => a.toLowerCase())
      .filter(a => ETH_ADDR.test(a))
  )).slice(0, MAX_ADDRESSES);

  if (!RELAYER_URL || addresses.length === 0) {
    return NextResponse.json({});
  }

  const entries = await Promise.all(addresses.map(async (address) => {
    try {
      const res = await fetch(`${RELAYER_URL}/public/profile-${address}.json`, {
        headers: { 'ngrok-skip-browser-warning': 'true' },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });
      if (!res.ok) return [address, null] as const;
      const profile = await res.json();
      return [address, { ...profile, cid: `profile-${address}.json` }] as const;
    } catch {
      return [address, null] as const;
    }
  }));

  return NextResponse.json(Object.fromEntries(entries));
}
