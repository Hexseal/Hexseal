import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';

// Private RPC with API key — never exposed to client.
// Only RPC_URL is used (no NEXT_PUBLIC_ vars — those may point to broken endpoints).
const PRIVATE_RPC = process.env.RPC_URL ?? null;

// Public fallback RPC endpoints tried in order if private RPC fails.
const PUBLIC_RPCS: string[] = appChain.id === 8453
  ? ['https://mainnet.base.org', 'https://base-rpc.publicnode.com']
  : ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.blockpi.network/v1/rpc/public'];

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

  // Try private RPC first (6 s); auto-fallback to public pool if it fails.
  // Total budget: 6 s private + up to 3 × 4 s public = 18 s < Vercel 30 s limit.
  if (PRIVATE_RPC) {
    try {
      const res = await callRpc(PRIVATE_RPC, body, 6_000);
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
      console.warn(`[/api/rpc] Private RPC returned ${res.status}, falling back to public`);
    } catch {
      // Timeout / network error → fall through to public pool
    }
  }

  // Try each public fallback in order (4 s each — short enough to stay in budget)
  let lastErr = 'All RPC endpoints failed';
  for (const url of PUBLIC_RPCS) {
    try {
      const res = await callRpc(url, body, 4_000);
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
      lastErr = `${url} returned ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32603, message: `RPC proxy error: ${lastErr}` }, id: null },
    { status: 502 },
  );
}
