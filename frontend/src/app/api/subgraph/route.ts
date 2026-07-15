import { NextRequest, NextResponse } from 'next/server';

// SUBGRAPH_URL (no NEXT_PUBLIC_ prefix) is read at runtime on the server.
// Set it in Vercel env vars — update to switch subgraph versions without redeploying.
const SUBGRAPH_URL = process.env.SUBGRAPH_URL;

// Server-side cache: avoids hitting the subgraph on every board reload.
// Key = query body string, Value = parsed response + expiry timestamp.
const _cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL = 30_000; // 30 seconds

export async function POST(req: NextRequest) {
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

  const cached = _cache.get(body);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let res: Response;
  try {
    res = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { errors: [{ message: `Subgraph fetch error: ${msg}` }] },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { errors: [{ message: `Subgraph read error: ${msg}` }] },
      { status: 502 },
    );
  }

  if (!text) {
    return NextResponse.json(
      { errors: [{ message: `Subgraph empty response (HTTP ${res.status})` }] },
      { status: 502 },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ');
    return NextResponse.json(
      { errors: [{ message: `Subgraph non-JSON (HTTP ${res.status}): ${preview}` }] },
      { status: 502 },
    );
  }

  if (res.ok && body.length <= 8_000) {
    if (_cache.size >= 100) {
      const now = Date.now();
      for (const [k, v] of _cache) {
        if (v.expiresAt < now) _cache.delete(k);
      }
    }
    if (_cache.size < 100) {
      _cache.set(body, { data, expiresAt: Date.now() + CACHE_TTL });
    }
  }

  return NextResponse.json(data, { status: res.status });
}
