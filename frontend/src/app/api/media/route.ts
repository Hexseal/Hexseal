import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Media proxy — serves public files (avatars, images) from the relayer.
 *
 * Browser <img> tags can't set custom headers (ngrok-skip-browser-warning).
 * This proxy fetches server-side with the bypass header, so the browser
 * always gets the actual image — never the ngrok interstitial page.
 *
 * GET /api/media?key=<filename>  →  proxies GET ${RELAYER_URL}/public/<filename>
 */

const RELAYER_URL = (
  process.env.NEXT_PUBLIC_RELAYER_URL || process.env.RELAYER_PUBLIC_URL || ''
).replace(/\/$/, '');

// SVG excluded: can contain <script> tags and would execute on app origin.
// JSON excluded: not needed here (profiles go through /api/profiles).
const KEY_RE = /^[\w\-.]+\.(jpg|jpeg|png|gif|webp)$/i;

// Server-side content-type map — never trust upstream Content-Type header.
const EXT_TYPES: Record<string, string> = {
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  gif:  'image/gif',
  webp: 'image/webp',
};

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key');
  if (!key || !KEY_RE.test(key)) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 400 });
  }
  if (!RELAYER_URL) {
    return NextResponse.json({ error: 'Relayer not configured' }, { status: 500 });
  }

  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const contentType = EXT_TYPES[ext] ?? 'application/octet-stream';

  try {
    const res = await fetch(`${RELAYER_URL}/public/${encodeURIComponent(key)}`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return new NextResponse(null, { status: res.status });
    }

    const body = await res.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,        // from our allowlist, not upstream
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
