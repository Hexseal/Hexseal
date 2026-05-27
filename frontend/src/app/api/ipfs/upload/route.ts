import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * IPFS / File upload endpoint
 *
 * Storage strategy (decentralised-first):
 *   PRIMARY  — Storj via relayer presign  → permanent public URL (no expiry)
 *   SECONDARY — Lighthouse.storage        → IPFS CID (decentralised pin)
 *
 * Both backends are tried independently; each failure is logged but non-fatal.
 * At least one must succeed — otherwise 500 is returned.
 *
 * Response:
 *   { cid, url, storjUrl, ipfsUrl }
 *   - url      = Storj URL when available, else Lighthouse gateway URL
 *   - cid      = IPFS CID when Lighthouse succeeded, else ''
 *   - storjUrl = direct Storj permanent URL (or null)
 *   - ipfsUrl  = Lighthouse gateway URL (or null)
 */

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

  const relayerUrl    = process.env.NEXT_PUBLIC_RELAYER_URL;
  const lighthouseKey = process.env.LIGHTHOUSE_API_KEY;

  if (!relayerUrl && !lighthouseKey) {
    return NextResponse.json(
      { error: 'No storage backend configured. Set NEXT_PUBLIC_RELAYER_URL or LIGHTHOUSE_API_KEY.' },
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

    let storjUrl: string | null = null;
    let cid: string | null      = null;

    const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || LIGHTHOUSE_GATEWAY;

    // ── Primary: Storj via relayer public presign ──────────────────────────────
    // Files land in the permanent public bucket (no TTL, publicly readable).
    if (relayerUrl) {
      try {
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

        if (presignRes.ok) {
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

          if (putRes.ok) {
            storjUrl = publicUrl;
          } else {
            console.warn(`[ipfs/upload] Storj PUT failed: ${putRes.status}`);
          }
        } else {
          console.warn(`[ipfs/upload] Relayer presign failed: ${presignRes.status}`);
        }
      } catch (err) {
        console.warn('[ipfs/upload] Storj primary failed, continuing:', err instanceof Error ? err.message : err);
      }
    }

    // ── Secondary: Lighthouse IPFS pin ────────────────────────────────────────
    // Pins to IPFS for content-addressed decentralised access (CID).
    if (lighthouseKey) {
      try {
        const upstream = new FormData();
        upstream.append('file', file, file.name);

        const lhRes = await fetch(LIGHTHOUSE_UPLOAD, {
          method:  'POST',
          headers: { Authorization: `Bearer ${lighthouseKey}` },
          body:    upstream,
          signal:  AbortSignal.timeout(60_000),
        });

        if (lhRes.ok) {
          const data = await lhRes.json() as { Hash: string; Name: string };
          cid = data.Hash;
        } else {
          const text = await lhRes.text().catch(() => lhRes.statusText);
          console.warn(`[ipfs/upload] Lighthouse failed: ${lhRes.status} ${text}`);
        }
      } catch (err) {
        console.warn('[ipfs/upload] Lighthouse secondary failed, continuing:', err instanceof Error ? err.message : err);
      }
    }

    if (!storjUrl && !cid) {
      return NextResponse.json(
        { error: 'All storage backends failed. Check relayer and Lighthouse configuration.' },
        { status: 500 },
      );
    }

    // Primary URL: Storj (fast, permanent) when available; IPFS gateway as fallback
    const url = storjUrl || `${gateway}/ipfs/${cid}`;

    return NextResponse.json({
      cid:      cid      ?? '',
      url,                                                         // canonical URL (Storj > IPFS)
      storjUrl: storjUrl ?? null,                                  // direct Storj permanent URL
      ipfsUrl:  cid ? `${gateway}/ipfs/${cid}` : null,            // IPFS decentralised URL
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ipfs/upload]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
