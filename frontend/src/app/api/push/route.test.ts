/**
 * К-2 — открытое реле уведомлений (половина фронта).
 *
 * `POST /api/push` не проверял НИЧЕГО — ни подписи, ни пропуска, ни
 * отношения отправителя к адресату — и САМ подставлял `X-Push-Secret`,
 * единственный гейт релеера. Прямой удар в релеер без секрета даёт 403;
 * единственным обходом был наш же фронт. `middleware.ts` этот маршрут не
 * покрывает (`matcher` без `/api/push`) — проверено ниже отдельно, чтобы
 * защита, которой нет, не считалась существующей.
 *
 * После починки: право слать доказывается тем же пропуском, что и склад
 * мешков, а ссылка/текст/метка из запроса не берутся вовсе и на релеер не
 * уезжают.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const RELAYER = 'http://relayer.test';

process.env.RELAYER_INTERNAL_URL = RELAYER;
process.env.PUSH_SECRET = 'test-push-secret';

const { POST } = await import('./route');
const { config: middlewareConfig } = await import('@/middleware');

const VICTIM = '0xc1c1000000000000000000000000000000000003';
// Настоящей ФОРМЫ, а не заглушка: маршрут отсекает мусор по форме ещё до
// сети, и короткая выдумка вроде 'v1.YWJj.zzz' проверяла бы не то. Тело —
// base64url("0xaaaa…0001.1893456000"), подпись — 43 символа, как отдаёт
// base64url от sha256 (relayer/bagPass.js).
const PASS = 'v1.MHhhYWFhMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxLjE4OTM0NTYwMDA.' +
  'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: JSON.stringify(body as any),
  }) as never;
}

function forwarded() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('К-2: /api/push требует доказательства, а ссылку не пересылает', () => {
  it('ЗАМЕР ДО ПОЧИНКИ: посторонний без кошелька и подписи получал 200 и уводил вкладку', async () => {
    const res = await POST(req({
      to: VICTIM,
      body: 'Спор решён не в вашу пользу. Подтвердите кошелёк, чтобы вернуть депозит.',
      url: 'https://evil.example/drain',
    }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('с пропуском — уходит на релеер, и пропуск едет вместе с запросом', async () => {
    const res = await POST(req({ to: VICTIM }, { 'x-bag-pass': PASS }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${RELAYER}/push/send`);
    expect((init.headers as Record<string, string>)['x-bag-pass']).toBe(PASS);
  });

  it('ни ссылка, ни текст, ни метка, ни отправитель на релеер не уезжают', async () => {
    await POST(req({
      to: VICTIM,
      url: 'https://evil.example/drain',
      body: 'Спор решён не в вашу пользу.',
      tag: 'deal',
      from: '0xb0b0000000000000000000000000000000000002',
      title: 'Hexseal Support',
    }, { 'x-bag-pass': PASS }));

    const sent = forwarded();
    expect(sent.to).toBe(VICTIM);
    expect(sent).not.toHaveProperty('url');
    expect(sent).not.toHaveProperty('body');
    expect(sent).not.toHaveProperty('tag');
    expect(sent).not.toHaveProperty('from');
    expect(sent).not.toHaveProperty('title');
  });

  it('род «спор» с адресом сделки пересылается — этой дороге ссылку строит релеер', async () => {
    const deal = '0xdea1000000000000000000000000000000000004';
    await POST(req({ to: VICTIM, kind: 'dispute', deal }, { 'x-bag-pass': PASS }));

    const sent = forwarded();
    expect(sent.kind).toBe('dispute');
    expect(sent.deal).toBe(deal);
  });

  it('негодный адрес получателя — 400 и ни одного похода на релеер', async () => {
    const res = await POST(req({ to: 'не адрес' }, { 'x-bag-pass': PASS }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отказ релеера доезжает статусом, а не подменяется успехом', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429, headers: { 'content-type': 'application/json' },
    }));
    const res = await POST(req({ to: VICTIM }, { 'x-bag-pass': PASS }));
    expect(res.status).toBe(429);
  });

  it('релеер недоступен — 502, а не тихое «ok»', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(req({ to: VICTIM }, { 'x-bag-pass': PASS }));
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty('error');
  });

  it('род «спор» пропуска не требует — доказательство там на цепи, а не у человека', async () => {
    const deal = '0xdea1000000000000000000000000000000000004';
    const res = await POST(req({ to: VICTIM, kind: 'dispute', deal }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forwarded()).toEqual({ to: VICTIM, kind: 'dispute', deal });
  });

  it('ЗАМЕР ДО ПОЧИНКИ: посторонний с мусорным пропуском гонял наш сервер к нашему серверу без предела', async () => {
    // Отказ приходил — но работа делалась: каждый запрос стоил похода на
    // релеер. Форма пропуска проверяется здесь, до всякой сети.
    // (Кириллица в заголовке не годится: её отвергает сам http-стек, до
    // сервера такой запрос не доезжает вовсе — проверяли бы не нас.)
    const res = await POST(req({ to: VICTIM }, { 'x-bag-pass': 'not-a-pass-at-all' }));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пропуск верной формы, но чужой — на релеер ходим, а вот бесконечно нет', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid bag pass' }), { status: 401 }));

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await POST(req({ to: VICTIM }, {
        'x-bag-pass': PASS,
        'x-forwarded-for': '203.0.113.7',
      }))).status);
    }

    const throttled = statuses.filter((s) => s === 429).length;
    // Потолок маршрута — 30/мин на источник: походов на релеер должно быть
    // ровно столько, а не сорок.
    expect(throttled).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBe(statuses.length - throttled);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it('исчерпавший потолок мешает только своему источнику', async () => {
    for (let i = 0; i < 40; i++) {
      await POST(req({ to: VICTIM }, { 'x-bag-pass': PASS, 'x-forwarded-for': '203.0.113.8' }));
    }
    const other = await POST(req({ to: VICTIM }, { 'x-bag-pass': PASS, 'x-forwarded-for': '203.0.113.9' }));
    expect(other.status).toBe(200);
  });

  it('middleware этот маршрут НЕ покрывает — защита обязана быть в самом маршруте', () => {
    // Не «на всякий случай»: опровергатель проверял именно это, и именно
    // отсутствие /api/push в matcher оставляло маршрут голым. Если кто-то
    // однажды впишет его в matcher, это не отменит проверки выше — но и
    // считать её существующей сегодня нельзя.
    expect(middlewareConfig.matcher).not.toContain('/api/push');
    expect(middlewareConfig.matcher.some((m: string) => m.startsWith('/api'))).toBe(false);
  });
});
