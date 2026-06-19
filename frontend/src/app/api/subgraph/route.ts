import { NextRequest, NextResponse } from 'next/server';

const SUBGRAPH_URL =
  process.env.SUBGRAPH_URL ||
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1755241/hexseal/v0.0.3';

export async function POST(req: NextRequest) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ errors: [{ message: 'Bad request body' }] }, { status: 400 });
  }

  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { errors: [{ message: `Subgraph proxy error: ${msg}` }] },
      { status: 502 },
    );
  }
}
