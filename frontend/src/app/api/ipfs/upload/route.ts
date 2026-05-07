import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

export const runtime = 'nodejs';

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60 * 1000;

function getRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);
    const rateLimit = getRateLimit(clientIp);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Max 10 requests per minute.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // 100 MB limit. Files are encrypted client-side before upload,
    // so the actual plaintext can be slightly smaller.
    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 413 }
      );
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

    const bucket = process.env.FILEBASE_BUCKET;
    const accessKey = process.env.FILEBASE_KEY;
    const secretKey = process.env.FILEBASE_SECRET;

    if (!bucket || !accessKey || !secretKey) {
      return NextResponse.json(
        { error: 'Filebase not configured. Set FILEBASE_BUCKET, FILEBASE_KEY, FILEBASE_SECRET.' },
        { status: 500 }
      );
    }

    // Upload to Filebase via S3-compatible API
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const s3Client = new S3Client({
      endpoint: 'https://s3.filebase.com',
      region: 'us-east-1',
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
    });

    // Filebase requires Content-Type and returns CID in response metadata
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: safeName,
      Body: buffer,
      ContentType: file.type || 'application/octet-stream',
    });

    await s3Client.send(command);

    // Filebase stores the IPFS CID in object metadata (x-amz-meta-cid).
    // ETag is just an MD5 — NOT the CID. Use HeadObject to read the real CID.
    const headResponse = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: safeName })
    );
    const cid = headResponse.Metadata?.cid ?? '';

    if (!cid) {
      return NextResponse.json({ error: 'Upload succeeded but CID not returned by Filebase' }, { status: 500 });
    }

    const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://corporate-orange-boa.myfilebase.com';

    // Mirror to Pinata in background (fire-and-forget, no PINATA_JWT = skip)
    const pinataJwt = process.env.PINATA_JWT;
    if (pinataJwt) {
      const pinForm = new FormData();
      pinForm.append('file', new Blob([buffer], { type: file.type || 'application/octet-stream' }), safeName);
      pinForm.append('pinataMetadata', JSON.stringify({ name: safeName }));
      fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwt}` },
        body: pinForm,
      }).catch((e: unknown) => {
        console.warn('[ipfs] Pinata mirror failed:', (e as Error).message);
      });
    }

    return NextResponse.json({
      cid,
      url: `${gateway}/ipfs/${cid}`,
    });
  } catch (error: any) {
    console.error('Filebase upload error:', error);
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
  }
}
