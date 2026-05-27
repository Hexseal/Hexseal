import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

/**
 * Job / service terms storage
 *
 * Storage strategy:
 *   - Text is uploaded to IPFS (Lighthouse) — permanent, content-addressed
 *   - Redis stores hash → CID mapping (tiny string, fast lookup cache)
 *   - On-chain: termsHash = keccak256(text) for integrity verification
 *
 * If Redis is wiped: text is still on IPFS (not lost), only lookup breaks.
 * Integrity check: fetch text from IPFS, keccak256 it, compare to on-chain hash.
 *
 * Backward compat: if the Redis value looks like plain text (not a CID),
 * it's returned directly (old records from before the IPFS migration).
 */

const redis = Redis.fromEnv();
const PREFIX = 'sig404:terms:';

const LIGHTHOUSE_UPLOAD  = 'https://node.lighthouse.storage/api/v0/add';
const LIGHTHOUSE_GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage';

function isCid(value: string): boolean {
  // IPFS CIDv0 starts with 'Qm', CIDv1 starts with 'b' (base32/base58)
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})/.test(value);
}

async function uploadTextToIPFS(text: string): Promise<string | null> {
  const apiKey = process.env.LIGHTHOUSE_API_KEY;
  if (!apiKey) return null;

  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const form = new FormData();
    form.append('file', blob, 'terms.txt');

    const res = await fetch(LIGHTHOUSE_UPLOAD, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    form,
      signal:  AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { Hash: string };
    return data.Hash ?? null;
  } catch {
    return null;
  }
}

async function fetchTextFromIPFS(cid: string): Promise<string | null> {
  const gateways = [
    LIGHTHOUSE_GATEWAY,
    'https://gateway.lighthouse.storage',
    'https://cloudflare-ipfs.com',
    'https://ipfs.io',
  ];

  for (const gw of gateways) {
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

  // New format: stored value is an IPFS CID — fetch text from IPFS
  if (isCid(stored)) {
    const text = await fetchTextFromIPFS(stored);
    return NextResponse.json({ text: text ?? null, cid: stored });
  }

  // Old format (backward compat): stored value is the text itself
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

  const trimmed = text.trim();

  // Upload to IPFS — best effort (non-fatal if Lighthouse key not set)
  const cid = await uploadTextToIPFS(trimmed);

  if (cid) {
    // Store hash → CID (tiny, permanent reference)
    await redis.set(`${PREFIX}${hash.toLowerCase()}`, cid);
    return NextResponse.json({ ok: true, cid, ipfsUrl: `${LIGHTHOUSE_GATEWAY}/ipfs/${cid}` });
  }

  // Fallback: no Lighthouse key configured — store text directly in Redis
  // (same as before, text is not lost, just not on IPFS yet)
  console.warn('[job-terms] LIGHTHOUSE_API_KEY not set — storing text in Redis as fallback');
  await redis.set(`${PREFIX}${hash.toLowerCase()}`, trimmed);
  return NextResponse.json({ ok: true, cid: null });
}
