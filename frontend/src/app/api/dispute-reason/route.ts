import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';

export const runtime = 'nodejs';

const RELAYER = (process.env.RELAYER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export async function GET(req: NextRequest) {
  const agreement = req.nextUrl.searchParams.get('agreement')?.toLowerCase();
  if (!agreement || !isAddress(agreement)) {
    return NextResponse.json({ error: 'Invalid agreement address' }, { status: 400 });
  }
  const res = await fetch(`${RELAYER}/dispute-reason?agreement=${agreement}`);
  return NextResponse.json(await res.json(), { status: res.status });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const res = await fetch(`${RELAYER}/dispute-reason`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return NextResponse.json(await res.json(), { status: res.status });
}
