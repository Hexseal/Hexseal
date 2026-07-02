import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

/**
 * Job / service terms storage
 *
 * Text is stored directly in Redis (hash → text or legacy IPFS CID).
 * On-chain: termsHash = keccak256(text) for integrity verification.
 *
 * Backward compat: if Redis value is an IPFS CID (old records), fetch from public IPFS gateways.
 */

const redis = Redis.fromEnv();
const PREFIX = 'hexseal:terms:';

const IPFS_GATEWAYS = [
  'https://gateway.lighthouse.storage',
  'https://cloudflare-ipfs.com',
  'https://ipfs.io',
];

function isCid(value: string): boolean {
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})/.test(value);
}

async function fetchLegacyCid(cid: string): Promise<string | null> {
  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}`, { signal: AbortSignal.timeout(6_000) });
      if (res.ok) return await res.text();
    } catch {
      // try next gateway
    }
  }
  return null;
}

// GET /api/job-terms?hash=0x...
export async function GET(req: NextRequest) {
  const hash = req.nextUrl.searchParams.get('hash');
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    return NextResponse.json({ text: null });
  }

  const stored = await redis.get<string>(`${PREFIX}${hash.toLowerCase()}`);
  if (!stored) return NextResponse.json({ text: null });

  // Legacy: stored value is an IPFS CID — fetch from public gateways
  if (isCid(stored)) {
    const text = await fetchLegacyCid(stored);
    return NextResponse.json({ text: text ?? null });
  }

  return NextResponse.json({ text: stored });
}

// POST /api/job-terms  body: { hash, text }
export async function POST(req: NextRequest) {
  let body: { hash?: string; text?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { hash, text } = body;
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    return NextResponse.json({ error: 'Invalid hash' }, { status: 400 });
  }
  if (!text || text.trim().length === 0) {
    return NextResponse.json({ error: 'Text required' }, { status: 400 });
  }
  if (text.length > 10000) {
    return NextResponse.json({ error: 'Terms too long (max 10000 chars)' }, { status: 400 });
  }

  await redis.set(`${PREFIX}${hash.toLowerCase()}`, text.trim());
  return NextResponse.json({ ok: true });
}
