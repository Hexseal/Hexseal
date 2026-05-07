import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export const runtime = 'nodejs';

const INDEX_KEY = 'sig404-profiles-index.json';

function makeS3() {
  return new S3Client({
    endpoint: 'https://s3.filebase.com',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.FILEBASE_KEY!,
      secretAccessKey: process.env.FILEBASE_SECRET!,
    },
    forcePathStyle: true,
  });
}

async function readIndex(): Promise<Record<string, string>> {
  try {
    const res = await makeS3().send(new GetObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET!,
      Key: INDEX_KEY,
    }));
    const body = await res.Body?.transformToString();
    if (!body) return {};
    const parsed = JSON.parse(body) as { profiles?: Record<string, string> };
    return parsed.profiles ?? {};
  } catch {
    return {};
  }
}

async function writeIndex(profiles: Record<string, string>): Promise<void> {
  const body = JSON.stringify({ profiles, updatedAt: Date.now() });
  await makeS3().send(new PutObjectCommand({
    Bucket: process.env.FILEBASE_BUCKET!,
    Key: INDEX_KEY,
    Body: body,
    ContentType: 'application/json',
  }));
}

async function fetchByCid(cid: string): Promise<unknown | null> {
  const gateways = [
    process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://corporate-orange-boa.myfilebase.com',
    'https://ipfs.io',
    'https://dweb.link',
  ];
  for (const gw of gateways) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return res.json();
    } catch {
      // try next gateway
    }
  }
  return null;
}

// GET /api/profiles?address=0x...
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address')?.toLowerCase();
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });

  const profiles = await readIndex();
  const cid = profiles[address];
  if (!cid) return NextResponse.json(null);

  const profile = await fetchByCid(cid);
  if (!profile) return NextResponse.json(null);

  return NextResponse.json({ ...(profile as object), cid });
}

// POST /api/profiles — update index with new profile CID
// Body: { address: string, profileCid: string }
export async function POST(request: NextRequest) {
  try {
    const { address, profileCid } = await request.json() as { address?: string; profileCid?: string };
    if (!address || !profileCid) {
      return NextResponse.json({ error: 'address and profileCid required' }, { status: 400 });
    }
    const profiles = await readIndex();
    profiles[address.toLowerCase()] = profileCid;
    await writeIndex(profiles);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
