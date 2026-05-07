import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { isAddress } from 'viem';

export const runtime = 'nodejs';

function s3() {
  return new S3Client({
    endpoint: 'https://s3.filebase.com',
    region: 'us-east-1',
    credentials: {
      accessKeyId:     process.env.FILEBASE_KEY!,
      secretAccessKey: process.env.FILEBASE_SECRET!,
    },
  });
}

const BUCKET = () => process.env.FILEBASE_BUCKET!;

// GET /api/dispute-reason?agreement=0x...
export async function GET(req: NextRequest) {
  const agreement = req.nextUrl.searchParams.get('agreement')?.toLowerCase();
  if (!agreement || !isAddress(agreement)) {
    return NextResponse.json({ error: 'Invalid agreement address' }, { status: 400 });
  }

  try {
    const res = await s3().send(new GetObjectCommand({
      Bucket: BUCKET(),
      Key: `dispute-reason-${agreement}.json`,
    }));
    const text = await res.Body?.transformToString();
    if (!text) return NextResponse.json({ reason: null });
    return NextResponse.json(JSON.parse(text));
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ reason: null });
    }
    console.error('[dispute-reason GET]', err);
    return NextResponse.json({ reason: null });
  }
}

// POST /api/dispute-reason  body: { agreement, raiser, reason }
export async function POST(req: NextRequest) {
  let body: { agreement?: string; raiser?: string; reason?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agreement, raiser, reason } = body;
  if (!agreement || !isAddress(agreement)) {
    return NextResponse.json({ error: 'Invalid agreement address' }, { status: 400 });
  }
  if (!reason || reason.trim().length === 0) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }
  if (reason.length > 2000) {
    return NextResponse.json({ error: 'Reason too long (max 2000 chars)' }, { status: 400 });
  }

  const payload = JSON.stringify({
    agreement: agreement.toLowerCase(),
    raiser:    raiser?.toLowerCase() ?? '',
    reason:    reason.trim(),
    timestamp: Date.now(),
  });

  try {
    await s3().send(new PutObjectCommand({
      Bucket:      BUCKET(),
      Key:         `dispute-reason-${agreement.toLowerCase()}.json`,
      Body:        payload,
      ContentType: 'application/json',
    }));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[dispute-reason POST]', err);
    return NextResponse.json({ error: 'Failed to save reason' }, { status: 500 });
  }
}
