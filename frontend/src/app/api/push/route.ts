import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';

const RELAYER_URL  = process.env.RELAYER_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';
const PUSH_SECRET  = process.env.PUSH_SECRET ?? '';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to, body: msgBody, url, from, tag } = body ?? {};

    if (!to || !isAddress(to)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
    }
    if (!msgBody) {
      return NextResponse.json({ error: 'body required' }, { status: 400 });
    }

    // Forward to relayer with server-side secret — the browser never sees PUSH_SECRET
    const res = await fetch(`${RELAYER_URL}/push/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PUSH_SECRET ? { 'X-Push-Secret': PUSH_SECRET } : {}),
      },
      body: JSON.stringify({ to, body: msgBody, url, from, tag }),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
