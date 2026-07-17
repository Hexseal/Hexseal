import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { fetchRelayerProfile } from '../_relayer';

export const runtime = 'nodejs';

/**
 * Batch profile lookup — same source as /api/profiles (deterministic relayer
 * URLs, no index/DB), but issued as one client request instead of N.
 *
 * fetchProfile() in lib/profiles-ipfs.ts coalesces same-tick calls into a
 * single request here, so a list of N cards (each calling useProfile) fires
 * one round-trip instead of N parallel ones. Note this only collapses the
 * browser→Next.js hop — the relayer itself is still one file read per
 * address, just issued server-side and chunked below rather than fired as
 * N unbounded client requests.
 */

const MAX_ADDRESSES = 100;
// Cap how many relayer requests this route fires at once — MAX_ADDRESSES is a
// hard ceiling, not the typical batch size, but without a cap a single call
// with a full batch would open up to 100 concurrent connections to one
// relayer process.
const CONCURRENCY = 20;

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
      .filter(a => isAddress(a))
  )).slice(0, MAX_ADDRESSES);

  const result: Record<string, unknown> = {};
  for (let i = 0; i < addresses.length; i += CONCURRENCY) {
    const chunk = addresses.slice(i, i + CONCURRENCY);
    const profiles = await Promise.all(chunk.map(fetchRelayerProfile));
    chunk.forEach((address, j) => { result[address] = profiles[j]; });
  }

  return NextResponse.json(result);
}
