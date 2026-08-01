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

// Abuse bounds — invalidate/x-fresh are unauthenticated, so cap how hard they
// can drive traffic to the subgraph.
const INVALIDATE_COOLDOWN = 5_000; // ignore repeat cache clears within 5s
const FORCE_FRESH_MIN_AGE = 3_000; // x-fresh still serves cache younger than 3s
const MAX_CACHE_ENTRIES   = 200;   // hard cap on distinct cached bodies

// `?meta=1` — сколько блоков сабграф уже проиндексировал. Отвечает мимо
// основного кэша: смысл пробы ровно в том, чтобы узнать текущее положение дел,
// а запись возрастом до двух минут об этом не говорит ничего. Свой микрокэш на
// секунду держится: время блока Base Sepolia — 2 с, так что секунда задержки не
// добавляет, зато десяток вкладок, опрашивающих одновременно, стоят одного
// запроса к сабграфу вместо десяти.
const META_QUERY  = '{ _meta { block { number } } }';
const META_TTL    = 1_000;

interface CacheEntry { data: unknown; storedAt: number }
const _cache      = new Map<string, CacheEntry>();
const _inFlight   = new Set<string>();            // prevent duplicate background fetches
let _lastInvalidate = 0;
let _meta: { block: number; storedAt: number } | null = null;
let _metaInFlight: Promise<number | null> | null = null;

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

async function readMetaBlock(): Promise<number | null> {
  if (_meta && Date.now() - _meta.storedAt < META_TTL) return _meta.block;
  if (_metaInFlight) return _metaInFlight;

  const probe = (async (): Promise<number | null> => {
    const data = await fetchSubgraph(JSON.stringify({ query: META_QUERY })) as
      { data?: { _meta?: { block?: { number?: number } } } } | null;
    const n = data?.data?._meta?.block?.number;
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    _meta = { block: n, storedAt: Date.now() };
    return n;
  })();

  _metaInFlight = probe;
  void probe.catch(() => null).finally(() => {
    if (_metaInFlight === probe) _metaInFlight = null;
  });
  return probe;
}

function pruneCache() {
  if (_cache.size < 100) return;
  const cutoff = Date.now() - FRESH_TTL - STALE_TTL;
  for (const [k, v] of _cache) {
    if (v.storedAt < cutoff) _cache.delete(k);
  }
  // Still over the hard cap (flood of distinct bodies) — evict oldest first
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [k] of oldest.slice(0, _cache.size - MAX_CACHE_ENTRIES + 1)) _cache.delete(k);
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
  // pre-mint snapshot for up to FRESH_TTL. Cooldown-limited since it is
  // unauthenticated; always answers ok so callers can fire-and-forget.
  if (req.nextUrl.searchParams.get('invalidate') === '1') {
    const now = Date.now();
    if (now - _lastInvalidate >= INVALIDATE_COOLDOWN) {
      _lastInvalidate = now;
      _cache.clear();
    }
    return NextResponse.json({ ok: true });
  }

  if (!SUBGRAPH_URL) {
    return NextResponse.json(
      { errors: [{ message: 'SUBGRAPH_URL env var is not configured' }] },
      { status: 503 },
    );
  }

  // Проба индексации — см. комментарий у META_QUERY. Клиент (lib/subgraphSync)
  // дожидается по ней, что сабграф догнал блок его транзакции, и только потом
  // сбрасывает кэш; сброс раньше цементировал непроиндексированный снимок ещё
  // на полный FRESH_TTL.
  if (req.nextUrl.searchParams.get('meta') === '1') {
    return NextResponse.json({ block: await readMetaBlock() });
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ errors: [{ message: 'Bad request body' }] }, { status: 400 });
  }

  // x-fresh: 1 — explicit user refresh, bypass the cache and fetch synchronously.
  // A just-fetched entry (<FORCE_FRESH_MIN_AGE) is served anyway, bounding
  // forced subgraph hits to one per query shape per few seconds.
  const forceFresh = req.headers.get('x-fresh') === '1';

  const entry = _cache.get(body);
  if (entry && (!forceFresh || Date.now() - entry.storedAt < FORCE_FRESH_MIN_AGE)) {
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
