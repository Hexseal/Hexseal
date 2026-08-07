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
/**
 * Форма пропуска — `v1.<base64url>.<base64url>` (`relayer/bagPass.js`,
 * `issueBagPass`). Проверяется ЗДЕСЬ, до всякой сети: без этого посторонний
 * с любой строкой в заголовке заставлял наш сервер сходить к нашему же
 * серверу. Отказ он получал, но работу мы делали.
 *
 * Это проверка ФОРМЫ, а не подлинности: подпись пропуска знает только релеер,
 * и знать её здесь незачем. Форма отсекает мусор, потолок ниже — усердие.
 */
const PASS_SHAPE = /^v1\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,128}$/;

/**
 * Потолок походов на релеер с одного источника. В памяти процесса — как и
 * ограничитель самого релеера; при нескольких экземплярах Next потолок
 * умножится на их число, и это честная граница, а не недосмотр.
 *
 * 30 в минуту: живой разговор — это одно уведомление на сообщение, а веер по
 * спору идёт до 50 подряд, поэтому у рода `dispute` свой, более щедрый
 * потолок. Иначе починка блокера сама бы обрезала веер на середине.
 */
const PROXY_RATE_WINDOW_MS = 60_000;
const PROXY_RATE_MAX         = 30;
const PROXY_RATE_MAX_DISPUTE = 120;
const _proxyRate = new Map<string, { count: number; resetAt: number }>();

function proxyRateOk(key: string, max: number): boolean {
  const now = Date.now();
  const entry = _proxyRate.get(key);
  if (!entry || now > entry.resetAt) {
    _proxyRate.set(key, { count: 1, resetAt: now + PROXY_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function sourceOf(req: NextRequest): string {
  // За Cloudflare Tunnel заголовок ставит сам Cloudflare и вычищает
  // клиентский — тот же разбор, что в `relayer/app.js`, `clientIp`.
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',');
    return hops[hops.length - 1].trim();   // последний прыжок, не первый
  }
  return 'unknown';
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { to, kind, deal } = (body ?? {}) as { to?: string; kind?: string; deal?: string };

  // ⚠️ Веер по спору пропуска НЕ требует, и это не послабление, а починка.
  // Спор открывает человек, который мог не заходить в чат ни разу: требуя
  // пропуск, мы отрезали арбитраж от таких людей молча. Доказательство для
  // этой дороги лежит в цепи и проверяется релеером (`dealIsDisputed`).
  const isDispute = kind === 'dispute';

  const pass = req.headers.get('x-bag-pass');
  if (!isDispute) {
    if (!pass) {
      return NextResponse.json(
        { error: 'Chat pass required', code: 'pass_required' },
        { status: 401 },
      );
    }
    if (!PASS_SHAPE.test(pass)) {
      return NextResponse.json(
        { error: 'Malformed chat pass', code: 'pass_invalid' },
        { status: 401 },
      );
    }
  }

  if (!to || !isAddress(to)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }
  if (isDispute && (typeof deal !== 'string' || !isAddress(deal))) {
    return NextResponse.json({ error: 'Invalid deal address' }, { status: 400 });
  }

  const source = sourceOf(req);
  if (!proxyRateOk(
    `${isDispute ? 'dispute' : 'chat'}:${source}`,
    isDispute ? PROXY_RATE_MAX_DISPUTE : PROXY_RATE_MAX,
  )) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', code: 'rate_limited_proxy' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  try {
    const res = await fetch(`${RELAYER_URL}/push/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(pass ? { 'x-bag-pass': pass } : {}),
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
