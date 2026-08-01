import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';

// Private RPC with API key — server-only, never exposed to client.
// Set DRPC_URL (no NEXT_PUBLIC_ prefix) in .env.vps so the key stays
// out of the JS bundle. docker-compose injects it at container runtime.
// Pick the first NON-EMPTY candidate. `??` alone was wrong here: an env var set to
// an empty string (e.g. a docker-compose `environment:` entry interpolating an unset
// ${DRPC_URL}) is not nullish, so it won the chain and silently disabled the private
// RPC — pushing every call onto rate-limited public endpoints.
//
// ORDER MATTERS, and it is paid-first on purpose. BASE_SEPOLIA_RPC_URL used to sit
// second, ahead of RPC_URL — but that variable is the generic chain RPC the whole
// repo shares (forge scripts, cast, the relayer), and in the owner's environment it
// points at the FREE public `base-sepolia.drpc.org`. A free public endpoint has no
// business being a candidate for the *private* slot: if DRPC_URL is ever empty, the
// "private" attempt below would just be a fourth public endpoint, sharing one rate
// limit with the three fallbacks — every one of them gets throttled together and the
// route 502s (the failure docker-compose's own comment warns about). Whatever
// distinguishes the private slot (its own quota, an API key, a paid plan) is exactly
// what public URLs don't have, so paid candidates go first and the shared/generic one
// is a last resort. The fallback pool below is unchanged: it is *supposed* to be public.
const PRIVATE_RPC =
  [process.env.DRPC_URL, process.env.RPC_URL, process.env.BASE_SEPOLIA_RPC_URL]
    .map(v => v?.trim())
    .find((v): v is string => !!v) ?? null;

// A public host winning the private slot is survivable but never intentional — and it
// was invisible in the logs, which is how it stayed hidden. Say so once at startup.
// Matched on hostname, not substring: drpc's FREE endpoint is `base-sepolia.drpc.org`
// while the paid one is `…drpc.live/…?dkey=`, and a substring test for "drpc" would
// flag the paid one too.
const PUBLIC_RPC_HOSTS = ['base.org', 'drpc.org', 'publicnode.com', 'blockpi.network'];
if (PRIVATE_RPC) {
  let host = '';
  try { host = new URL(PRIVATE_RPC).hostname; } catch { /* не URL — сказать нечего */ }
  if (PUBLIC_RPC_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    console.warn(
      `[/api/rpc] private RPC slot resolved to a public endpoint (${host}) — ` +
      'set DRPC_URL (or RPC_URL) to a keyed endpoint, or every call shares one public rate limit',
    );
  }
}

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
