import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';

// Private RPC with API key — never exposed to client.
// Only RPC_URL is used (no NEXT_PUBLIC_ vars — those may point to broken endpoints).
const PRIVATE_RPC = process.env.RPC_URL ?? null;

// Official Base public endpoints — always work, no auth required.
const PUBLIC_RPC = appChain.id === 8453
  ? 'https://mainnet.base.org'
  : 'https://sepolia.base.org';

async function callRpc(url: string, body: unknown, timeoutMs = 6_000): Promise<Response> {
  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 },
    );
  }

  // Try private RPC first (6 s); auto-fallback to public if it fails or returns non-2xx.
  // Keep total latency under ~14 s so Vercel's 30 s serverless limit is never hit.
  if (PRIVATE_RPC) {
    try {
      const res = await callRpc(PRIVATE_RPC, body, 6_000);
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
      console.warn(`[/api/rpc] Private RPC returned ${res.status}, falling back to public`);
    } catch {
      // Timeout / network error → fall through to public
    }
  }

  // Public fallback (8 s)
  try {
    const res = await callRpc(PUBLIC_RPC, body, 8_000);
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
