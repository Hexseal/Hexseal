import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * File upload endpoint — routes to relayer local storage.
 *
 * Two flows:
 *   A) Profile JSON  → PUT /files/public-put/profile-${address}.json  (deterministic key)
 *   B) Everything else → POST /files/public/presign → PUT to uploadUrl  (random key)
 *
 * Deterministic keys mean no Redis index needed:
 *   GET ${relayerUrl}/public/profile-${address}.json → profile
 *
 * NEXT_PUBLIC_RELAYER_URL must point to a running relayer.
 * ngrok-skip-browser-warning header bypasses ngrok interstitial during local dev.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROFILE_KEY_RE = /^profile-0x[a-f0-9]{40}\.json$/i;

const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

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

    const contentType = file.type || 'application/octet-stream';
    const cleanRelayer = relayerUrl.replace(/\/$/, '');

    // ── Flow A: named profile JSON ─────────────────────────────────────────────
    // filename = profile-0x<address>.json → store at deterministic key
    if (PROFILE_KEY_RE.test(file.name)) {
      const key       = file.name.toLowerCase();
      const uploadUrl = `${cleanRelayer}/files/public-put/${key}`;
      const publicUrl = `${cleanRelayer}/public/${key}`;

      const putRes = await fetch(uploadUrl, {
        method:  'PUT',
        body:    file,
        headers: { 'Content-Type': contentType, ...NGROK_HEADERS },
        signal:  AbortSignal.timeout(60_000),
      });

      if (!putRes.ok) {
        console.error(`[ipfs/upload] Profile PUT failed: ${putRes.status}`);
        return NextResponse.json({ error: 'Upload failed' }, { status: 502 });
      }

      return NextResponse.json({ cid: '', url: publicUrl, storjUrl: publicUrl, ipfsUrl: null });
    }

    // ── Flow B: generic file — presign then PUT ────────────────────────────────
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';

    const presignRes = await fetch(`${cleanRelayer}/files/public/presign`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...NGROK_HEADERS },
      body:    JSON.stringify({ ext, contentType }),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!presignRes.ok) {
      const text = await presignRes.text().catch(() => presignRes.statusText);
      console.error(`[ipfs/upload] Relayer presign failed: ${presignRes.status} ${text}`);
      return NextResponse.json({ error: 'Relayer unavailable' }, { status: 502 });
    }

    const { uploadUrl, publicUrl } = await presignRes.json() as {
      uploadUrl: string;
      publicUrl: string;
    };

    const putRes = await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': contentType, ...NGROK_HEADERS },
      signal:  AbortSignal.timeout(60_000),
    });

    if (!putRes.ok) {
      console.error(`[ipfs/upload] Relayer PUT failed: ${putRes.status}`);
      return NextResponse.json({ error: 'Upload failed' }, { status: 502 });
    }

    return NextResponse.json({ cid: '', url: publicUrl, storjUrl: publicUrl, ipfsUrl: null });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ipfs/upload]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
