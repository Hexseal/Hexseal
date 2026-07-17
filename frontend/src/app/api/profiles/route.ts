import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { fetchRelayerProfile } from './_relayer';

export const runtime = 'nodejs';

/**
 * Profile index — no external storage needed.
 *
 * Profiles are stored on the relayer at a deterministic URL:
 *   GET ${RELAYER_PUBLIC_URL}/public/profile-${address}.json
 *
 * No Redis / Upstash required. The relayer IS the index.
 */

// GET /api/profiles?address=0x...
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')?.toLowerCase();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
  if (!isAddress(address)) return NextResponse.json({ error: 'invalid address' }, { status: 400 });

  const profile = await fetchRelayerProfile(address);
  return NextResponse.json(profile);
}

// POST /api/profiles — called after upload to confirm save (no-op now, kept for compat)
export async function POST(request: NextRequest) {
  try {
    const { address } = await request.json() as { address?: string; profileCid?: string };
    if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
