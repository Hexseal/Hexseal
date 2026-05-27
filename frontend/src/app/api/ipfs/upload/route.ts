import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * File upload endpoint — Storj via relayer presign.
 *
 * Storage: Storj permanent public bucket (no TTL, publicly readable).
 * Requires: NEXT_PUBLIC_RELAYER_URL pointing to the running relayer.
 *
 * Response:
 *   { cid, url, storjUrl, ipfsUrl }
 *   - url      = Storj permanent URL
 *   - storjUrl = same as url
 *   - cid      = '' (no IPFS — XP and all critical data is on-chain; profiles are cosmetic)
 *   - ipfsUrl  = null
 */

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

  const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
  if (!relayerUrl) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_RELAYER_URL is not configured.' },
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

    // ── Storj via relayer public presign ──────────────────────────────────────
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';
    const presignRes = await fetch(`${relayerUrl}/files/public/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ext,
        contentType: file.type || 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!presignRes.ok) {
      const text = await presignRes.text().catch(() => presignRes.statusText);
      console.error(`[ipfs/upload] Relayer presign failed: ${presignRes.status} ${text}`);
      return NextResponse.json({ error: 'Storage backend unavailable' }, { status: 502 });
    }

    const { uploadUrl, publicUrl } = await presignRes.json() as {
      uploadUrl: string;
      publicUrl: string;
    };

    const putRes = await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      signal:  AbortSignal.timeout(60_000),
    });

    if (!putRes.ok) {
      console.error(`[ipfs/upload] Storj PUT failed: ${putRes.status}`);
      return NextResponse.json({ error: 'Upload to storage failed' }, { status: 502 });
    }

    return NextResponse.json({
      cid:      '',           // no IPFS — not needed, everything critical is on-chain
      url:      publicUrl,
      storjUrl: publicUrl,
      ipfsUrl:  null,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ipfs/upload]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
