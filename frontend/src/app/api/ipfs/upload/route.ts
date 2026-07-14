import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

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

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!checkRateLimit(getClientIp(request))) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Max 10 requests per minute.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  // Server-side fetches use internal Docker network URL (http://relayer:3001).
  // Public URLs returned to the browser use the external URL (https://api.hexseal.net).
  const INTERNAL = (process.env.RELAYER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const PUBLIC   = (process.env.NEXT_PUBLIC_RELAYER_URL ?? INTERNAL).replace(/\/$/, '');

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

    // ── Flow A: named profile JSON ─────────────────────────────────────────────
    if (PROFILE_KEY_RE.test(file.name)) {
      const key       = file.name.toLowerCase();
      const uploadUrl = `${INTERNAL}/files/public-put/${key}`;
      const publicUrl = `${PUBLIC}/public/${key}`;

      const signature = formData.get('signature') as string | null;
      if (!signature) {
        return NextResponse.json({ error: 'Profile upload requires a wallet signature' }, { status: 400 });
      }

      const putRes = await fetch(uploadUrl, {
        method:  'PUT',
        body:    file,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Profile-Signature': signature,
        },
        signal: AbortSignal.timeout(60_000),
      });

      if (!putRes.ok) {
        const text = await putRes.text().catch(() => putRes.statusText);
        console.error(`[ipfs/upload] Profile PUT failed: ${putRes.status} ${text}`);
        return NextResponse.json({ error: 'Upload failed' }, { status: 502 });
      }

      return NextResponse.json({ cid: '', url: publicUrl, storjUrl: publicUrl, ipfsUrl: null });
    }

    // ── Flow B: generic file — presign then PUT ────────────────────────────────
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';

    const presignRes = await fetch(`${INTERNAL}/files/public/presign`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ext, contentType }),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!presignRes.ok) {
      const text = await presignRes.text().catch(() => presignRes.statusText);
      console.error(`[ipfs/upload] Relayer presign failed: ${presignRes.status} ${text}`);
      return NextResponse.json({ error: 'Relayer unavailable' }, { status: 502 });
    }

    let { uploadUrl, publicUrl } = await presignRes.json() as {
      uploadUrl: string;
      publicUrl: string;
    };

    // Rewrite any localhost/127.0.0.1 URLs the relayer returns when RELAYER_PUBLIC_URL is not set.
    // Upload goes to internal, public URL goes to external.
    const rewrite = (u: string, base: string) => {
      try {
        const parsed = new URL(u);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          return `${base}${parsed.pathname}`;
        }
      } catch { /* ignore */ }
      return u;
    };
    uploadUrl = rewrite(uploadUrl, INTERNAL);
    publicUrl = rewrite(publicUrl, PUBLIC);

    const putRes = await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': contentType },
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
