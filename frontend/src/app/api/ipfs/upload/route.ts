import { NextRequest, NextResponse } from 'next/server';
import { createHmac, createHash } from 'node:crypto';

export const runtime = 'nodejs';

/**
 * File upload endpoint — direct Storj S3 upload (no relayer needed).
 *
 * Uses STORJ_ACCESS_KEY / STORJ_SECRET_KEY / STORJ_BUCKET_PUBLIC / STORJ_ENDPOINT
 * env vars to upload directly from Vercel → Storj without touching the relayer.
 *
 * Falls back to relayer presign if Storj vars are missing.
 *
 * Response: { cid: '', url, storjUrl, ipfsUrl: null }
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

// ─── Minimal AWS SigV4 for Storj S3-compatible gateway ─────────────────────────

function hmacSHA256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function storjPut(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const endpoint  = (process.env.STORJ_ENDPOINT  ?? 'https://gateway.storjshare.io').replace(/\/$/, '');
  const bucket    = process.env.STORJ_BUCKET_PUBLIC ?? 'hexseal-public';
  const accessKey = process.env.STORJ_ACCESS_KEY!;
  const secretKey = process.env.STORJ_SECRET_KEY!;
  const region    = 'us-east-1'; // Storj ignores this but SigV4 requires it
  const service   = 's3';

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const host        = new URL(endpoint).host;
  const urlPath     = `/${bucket}/${key}`;
  const payloadHash = sha256hex(buffer);

  // Sorted canonical headers (alphabetical order required by SigV4)
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-acl:public-read\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-acl;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'PUT',
    urlPath,
    '',                  // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate    = hmacSHA256(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmacSHA256(kDate,    region);
  const kService = hmacSHA256(kRegion,  service);
  const kSigning = hmacSHA256(kService, 'aws4_request');
  const signature = hmacSHA256(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const uploadUrl = `${endpoint}/${bucket}/${key}`;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type':          contentType,
      'Host':                  host,
      'x-amz-acl':            'public-read',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date':           amzDate,
      'Authorization':         authorization,
    },
    body: buffer,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Storj PUT ${res.status}: ${text.slice(0, 300)}`);
  }

  return uploadUrl; // public URL (bucket must allow public reads on Storj side)
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

    const ext         = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';
    const key         = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const contentType = file.type || 'application/octet-stream';

    // ── Path A: direct Storj upload (preferred — no relayer needed) ────────────
    const hasStorj = !!(process.env.STORJ_ACCESS_KEY && process.env.STORJ_SECRET_KEY);
    if (hasStorj) {
      const buffer    = Buffer.from(await file.arrayBuffer());
      const publicUrl = await storjPut(buffer, key, contentType);
      return NextResponse.json({ cid: '', url: publicUrl, storjUrl: publicUrl, ipfsUrl: null });
    }

    // ── Path B: relayer presign fallback (local dev without Storj creds) ───────
    const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayerUrl) {
      return NextResponse.json(
        { error: 'No storage backend configured (set STORJ_ACCESS_KEY or NEXT_PUBLIC_RELAYER_URL).' },
        { status: 500 },
      );
    }

    const presignRes = await fetch(`${relayerUrl}/files/public/presign`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ext, contentType }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!presignRes.ok) {
      const text = await presignRes.text().catch(() => presignRes.statusText);
      console.error(`[ipfs/upload] Relayer presign failed: ${presignRes.status} ${text}`);
      return NextResponse.json({ error: 'Storage backend unavailable' }, { status: 502 });
    }
    const { uploadUrl, publicUrl } = await presignRes.json() as { uploadUrl: string; publicUrl: string };

    const putRes = await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': contentType },
      signal:  AbortSignal.timeout(60_000),
    });
    if (!putRes.ok) {
      console.error(`[ipfs/upload] Relayer PUT failed: ${putRes.status}`);
      return NextResponse.json({ error: 'Upload to storage failed' }, { status: 502 });
    }

    return NextResponse.json({ cid: '', url: publicUrl, storjUrl: publicUrl, ipfsUrl: null });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ipfs/upload]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
