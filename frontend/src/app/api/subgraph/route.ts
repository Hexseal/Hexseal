import { NextRequest, NextResponse } from 'next/server';

// SUBGRAPH_URL (no NEXT_PUBLIC_ prefix) is read at runtime on the server.
// Update it in Vercel env vars to switch subgraph versions without redeploying code.
// Do NOT use NEXT_PUBLIC_SUBGRAPH_URL here — NEXT_PUBLIC_ vars are baked into the
// client bundle at build time and can't be changed without a full redeploy.
const SUBGRAPH_URL =
  process.env.SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1755241/hexseal/v0.0.3';

export async function POST(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ errors: [{ message: 'Bad request body' }] }, { status: 400 });
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

  return NextResponse.json(data, { status: res.status });
}
