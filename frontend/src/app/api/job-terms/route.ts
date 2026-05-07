import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

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

// GET /api/job-terms?hash=0x...
export async function GET(req: NextRequest) {
  const hash = req.nextUrl.searchParams.get('hash');
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    return NextResponse.json({ text: null });
  }
  try {
    const res = await s3().send(new GetObjectCommand({
      Bucket: BUCKET(),
      Key: `job-terms-${hash.toLowerCase()}.txt`,
    }));
    const text = await res.Body?.transformToString();
    return NextResponse.json({ text: text ?? null });
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ text: null });
    }
    console.error('[job-terms GET]', err);
    return NextResponse.json({ text: null });
  }
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
  try {
    await s3().send(new PutObjectCommand({
      Bucket:      BUCKET(),
      Key:         `job-terms-${hash.toLowerCase()}.txt`,
      Body:        text.trim(),
      ContentType: 'text/plain',
    }));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[job-terms POST]', err);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
