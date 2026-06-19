import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { isAddress } from 'viem';

export const runtime = 'nodejs';

const redis = Redis.fromEnv();
const PREFIX = 'hexseal:dispute:';

interface DisputeRecord {
  agreement: string;
  raiser:    string;
  reason:    string;
  timestamp: number;
}

// GET /api/dispute-reason?agreement=0x...
export async function GET(req: NextRequest) {
  const agreement = req.nextUrl.searchParams.get('agreement')?.toLowerCase();
  if (!agreement || !isAddress(agreement)) {
    return NextResponse.json({ error: 'Invalid agreement address' }, { status: 400 });
  }

  const record = await redis.get<DisputeRecord>(`${PREFIX}${agreement}`);
  return NextResponse.json(record ?? { reason: null });
}

// POST /api/dispute-reason  body: { agreement, raiser, reason }
export async function POST(req: NextRequest) {
  let body: { agreement?: string; raiser?: string; reason?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agreement, raiser, reason } = body;
  if (!agreement || !isAddress(agreement)) {
    return NextResponse.json({ error: 'Invalid agreement address' }, { status: 400 });
  }
  if (!reason || reason.trim().length === 0) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }
  if (reason.length > 2000) {
    return NextResponse.json({ error: 'Reason too long (max 2000 chars)' }, { status: 400 });
  }

  const record: DisputeRecord = {
    agreement: agreement.toLowerCase(),
    raiser:    raiser?.toLowerCase() ?? '',
    reason:    reason.trim(),
    timestamp: Date.now(),
  };

  await redis.set(`${PREFIX}${agreement.toLowerCase()}`, record);
  return NextResponse.json({ ok: true });
}
