import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';

const RELAYER_URL  = process.env.RELAYER_INTERNAL_URL ?? process.env.RELAYER_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';
const PUSH_SECRET  = process.env.PUSH_SECRET ?? '';

/**
 * К-2. ЭТОТ МАРШРУТ БЫЛ ОТКРЫТЫМ РЕЛЕ.
 *
 * До 7 августа 2026 он не проверял ничего — ни подписи, ни пропуска, ни
 * источника запроса, ни отношения отправителя к адресату — и САМ подставлял
 * `X-Push-Secret`, единственный гейт релеера. Прямой удар в релеер без
 * секрета даёт 403; единственным обходом был наш же фронт, и он был открыт.
 *
 * Замер (сквозной, на настоящем релеере): посторонний без кошелька и подписи
 * слал `{to: <жертва>, body: "Спор решён не в вашу пользу…", url:
 * "https://evil.example/drain"}` и получал 200; уведомление доезжало до
 * устройства жертвы настоящим, от Hexseal, а служебный работник уводил по
 * этой ссылке открытую вкладку.
 *
 * `middleware.ts` этот маршрут НЕ покрывает (`matcher` без `/api/push`) —
 * значит защита обязана стоять здесь, а не считаться существующей где-то
 * ещё. Заперто тестом.
 *
 * Теперь: право слать доказывается ТЕМ ЖЕ пропуском склада мешков
 * (`x-bag-pass`), который проверяет релеер — здесь он непрозрачен, мы его
 * только передаём. И ссылка, текст, метка и заголовок из запроса НЕ БЕРУТСЯ
 * ВОВСЕ: их строит релеер из доказанного отправителя. Поэтому наружу
 * уезжают ровно три поля — кому, какого рода, и (для спора) адрес сделки.
 */
export async function POST(req: NextRequest) {
  const pass = req.headers.get('x-bag-pass');
  if (!pass) {
    return NextResponse.json(
      { error: 'Chat pass required', code: 'pass_required' },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { to, kind, deal } = (body ?? {}) as { to?: string; kind?: string; deal?: string };

  if (!to || !isAddress(to)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }

  try {
    const res = await fetch(`${RELAYER_URL}/push/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bag-pass': pass,
        ...(PUSH_SECRET ? { 'X-Push-Secret': PUSH_SECRET } : {}),
      },
      // Ни `url`, ни `body`, ни `tag`, ни `from`, ни `title`. Всё, что могло
      // бы увести человека или соврать ему, здесь просто отсутствует.
      body: JSON.stringify({ to, ...(kind ? { kind } : {}), ...(deal ? { deal } : {}) }),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    // К-3, вторая половина: раньше любой отказ становился `500 Internal
    // error` без разбора, и вызывающий не мог отличить «релеер лежит» от
    // «мы сами сломались». 502 — честное «дальше по цепочке не ответили»,
    // и оно доезжает до места, где его видно (lib/webpush.ts читает статус).
    return NextResponse.json(
      { error: 'Notification service unavailable', code: 'relay_unreachable' },
      { status: 502 },
    );
  }
}
