import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const LIGHTHOUSE_UPLOAD  = 'https://node.lighthouse.storage/api/v0/add';
const LIGHTHOUSE_GATEWAY = 'https://gateway.lighthouse.storage';

// ─── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX    = 10;
const RATE_LIMIT_WINDOW = 60_000;

function checkRateLimit(ip: string): boolean {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(request: NextRequest) {
  if (!checkRateLimit(getClientIp(request))) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Max 10 requests per minute.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const apiKey = process.env.LIGHTHOUSE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'IPFS storage not configured. Set LIGHTHOUSE_API_KEY.' },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024} MB` },
        { status: 413 },
      );
    }

    // Forward to Lighthouse — they accept standard multipart/form-data
    const upstream = new FormData();
    upstream.append('file', file, file.name);

    const res = await fetch(LIGHTHOUSE_UPLOAD, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body:    upstream,
      signal:  AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Lighthouse error ${res.status}: ${text}`);
    }

    // Response: { Name: string, Hash: string (CID), Size: string }
    const data = await res.json() as { Hash: string; Name: string };
    const cid  = data.Hash;

    const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || LIGHTHOUSE_GATEWAY;
    return NextResponse.json({ cid, url: `${gateway}/ipfs/${cid}` });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ipfs/upload]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
