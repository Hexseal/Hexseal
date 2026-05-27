import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const runtime = 'nodejs';

const redis = Redis.fromEnv();
const PREFIX = 'sig404:terms:';

// GET /api/job-terms?hash=0x...
export async function GET(req: NextRequest) {
  const hash = req.nextUrl.searchParams.get('hash');
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    return NextResponse.json({ text: null });
  }

  const text = await redis.get<string>(`${PREFIX}${hash.toLowerCase()}`);
  return NextResponse.json({ text: text ?? null });
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

  await redis.set(`${PREFIX}${hash.toLowerCase()}`, text.trim());
  return NextResponse.json({ ok: true });
}
