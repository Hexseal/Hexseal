import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Profile index — no external storage needed.
 *
 * Profiles are stored on the relayer at a deterministic URL:
 *   GET ${RELAYER_PUBLIC_URL}/public/profile-${address}.json
 *
 * No Redis / Upstash required. The relayer IS the index.
 */

const RELAYER_URL = (
  process.env.NEXT_PUBLIC_RELAYER_URL || process.env.RELAYER_PUBLIC_URL || ''
).replace(/\/$/, '');

// GET /api/profiles?address=0x...
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')?.toLowerCase();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
  if (!RELAYER_URL) return NextResponse.json(null);

  try {
    const res = await fetch(`${RELAYER_URL}/public/profile-${address}.json`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json(null);
    const profile = await res.json();
    return NextResponse.json({ ...profile, cid: `profile-${address}.json` });
  } catch {
    return NextResponse.json(null);
  }
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
