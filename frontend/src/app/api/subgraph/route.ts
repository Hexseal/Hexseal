import { NextRequest, NextResponse } from 'next/server';
import { OPEN_JOBS_QUERY, OPEN_SERVICES_QUERY } from '@/lib/graph';

const SUBGRAPH_URL = process.env.SUBGRAPH_URL;

// Stale-while-revalidate cache.
// fresh window: serve from cache, no background fetch.
// stale window: serve stale immediately, refresh in background.
// expired: serve stale if present (better than a spinner), refresh in background.
// Only the very first request for a query ever blocks waiting for the subgraph.
const FRESH_TTL  = 120_000; // 2 min — serve from cache, no fetch
const STALE_TTL  =  30_000; // extra 30s stale window served instantly

interface CacheEntry { data: unknown; storedAt: number }
const _cache      = new Map<string, CacheEntry>();
const _inFlight   = new Set<string>();            // prevent duplicate background fetches

async function fetchSubgraph(body: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(SUBGRAPH_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!text || !res.ok) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function backgroundRefresh(body: string) {
  if (_inFlight.has(body)) return;
  _inFlight.add(body);
  fetchSubgraph(body)
    .then(data => { if (data) _cache.set(body, { data, storedAt: Date.now() }); })
    .catch(() => {})
    .finally(() => _inFlight.delete(body));
}

function pruneCache() {
  if (_cache.size < 100) return;
  const cutoff = Date.now() - FRESH_TTL - STALE_TTL;
  for (const [k, v] of _cache) {
    if (v.storedAt < cutoff) _cache.delete(k);
  }
}

// Warm the cache for the two most-visited board queries after server start.
// This ensures the first real visitor gets instant data even on a cold boot.
if (SUBGRAPH_URL) {
  // urql includes operationName for named queries — match the exact body format it sends
  const WARMUP_QUERIES = [
    JSON.stringify({ query: OPEN_JOBS_QUERY,     operationName: 'OpenJobs',     variables: { where: { status: 'open' },   first: 20, skip: 0 } }),
    JSON.stringify({ query: OPEN_SERVICES_QUERY, operationName: 'OpenServices', variables: { where: { status: 'active' }, first: 20, skip: 0 } }),
  ];
  // Delay 3s so the process finishes booting before hitting external services
  setTimeout(() => {
    for (const body of WARMUP_QUERIES) {
      if (!_cache.has(body)) backgroundRefresh(body);
    }
  }, 3_000);
}

export async function POST(req: NextRequest) {
  // Cache invalidation — post-job/post-service flows call this right after a
  // successful mint so the next board visit refetches instead of serving a
  // pre-mint snapshot for up to FRESH_TTL.
  if (req.nextUrl.searchParams.get('invalidate') === '1') {
    _cache.clear();
    return NextResponse.json({ ok: true });
  }

  if (!SUBGRAPH_URL) {
    return NextResponse.json(
      { errors: [{ message: 'SUBGRAPH_URL env var is not configured' }] },
      { status: 503 },
    );
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ errors: [{ message: 'Bad request body' }] }, { status: 400 });
  }

  // x-fresh: 1 — explicit user refresh, bypass the cache and fetch synchronously
  const forceFresh = req.headers.get('x-fresh') === '1';

  const entry = _cache.get(body);
  if (entry && !forceFresh) {
    const age = Date.now() - entry.storedAt;
    if (age > FRESH_TTL) {
      // Stale — return immediately, refresh in background
      backgroundRefresh(body);
    }
    return NextResponse.json(entry.data);
  }

  // Cache miss (or forced refresh) — must wait for the subgraph
  pruneCache();
  const data = await fetchSubgraph(body);
  if (!data) {
    // Forced refresh failed — serve the cached copy rather than erroring
    if (entry) return NextResponse.json(entry.data);
    return NextResponse.json(
      { errors: [{ message: 'Subgraph unavailable' }] },
      { status: 502 },
    );
  }
  if (body.length <= 8_000) _cache.set(body, { data, storedAt: Date.now() });
  return NextResponse.json(data);
}
