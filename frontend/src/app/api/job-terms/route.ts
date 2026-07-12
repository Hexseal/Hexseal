import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const RELAYER = (process.env.RELAYER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export async function GET(req: NextRequest) {
  const hash = req.nextUrl.searchParams.get('hash');
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    return NextResponse.json({ text: null });
  }
  const res = await fetch(`${RELAYER}/job-terms?hash=${hash}`);
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const res = await fetch(`${RELAYER}/job-terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return NextResponse.json(await res.json(), { status: res.status });
}
