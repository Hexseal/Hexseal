import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';

// Server-side RPC URL — may include API key, never exposed to client.
// Falls back to official Base public endpoints which are geo-unrestricted.
const RPC_URL =
  process.env.RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ??
  (appChain.id === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, { status: 400 });
  }

  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: `RPC proxy error: ${msg}` }, id: null },
      { status: 502 },
    );
  }
}
