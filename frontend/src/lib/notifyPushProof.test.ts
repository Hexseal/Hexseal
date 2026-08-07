/**
 * К-2 (клиентская половина) и К-3 (вторая половина).
 *
 * К-2: `notifyPush` уезжал на `/api/push` без единого доказательства, кто
 * его послал, и вёз ссылку с меткой, которые сервер брал как есть. Теперь он
 * обязан привезти пропуск склада — тот же, которым уже пользуется переписка,
 * из той же кладовой браузера, БЕЗ нового окна кошелька.
 *
 * К-3: `.catch(() => {})` глушил ответ целиком — статус не читался никогда.
 * Отправитель видел отправленное, получатель не видел уведомления, сервер
 * молчал. Теперь исход возвращается вызывающему и его слышно.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { notifyPush, notifyArbitersOfDispute, onPushDeliveryFailure } = await import('./webpush');

const ME    = '0xaaaa000000000000000000000000000000000001';
const PEER  = '0xbbbb000000000000000000000000000000000002';
const PASS_STORAGE_PREFIX = 'hexseal_bagpass_';   // тот же, что пишет lib/chatTransport.ts

let fetchMock: ReturnType<typeof vi.fn>;

/** Минимальный localStorage — среда тестов node, окна нет. С `length`/`key()`:
 *  запасная дорога поиска пропуска перебирает кладовую по префиксу, и без них
 *  тест проверял бы не то, что делает браузер. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

const g = globalThis as unknown as { localStorage?: unknown };
let saved: unknown;

function storePass(addr: string, pass: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  (g.localStorage as Storage).setItem(
    PASS_STORAGE_PREFIX + addr.toLowerCase(),
    JSON.stringify({ pass, expiresAt }),
  );
}

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
  vi.unstubAllGlobals();
});

function sentHeaders() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.headers as Record<string, string>;
}
function sentBody() {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('К-2: notifyPush везёт пропуск и не везёт ссылку', () => {
  it('пропуск берётся из кладовой по адресу отправителя — окна кошелька нет', async () => {
    storePass(ME, 'v1.mine.mac');
    storePass(PEER, 'v1.theirs.mac');   // чужой пропуск того же устройства

    await notifyPush(PEER, 'New message', `/chat?peer=${ME}`, `/chat?peer=${PEER}`);

    expect(sentHeaders()['x-bag-pass']).toBe('v1.mine.mac');
  });

  it('ни ссылка, ни текст, ни метка на сервер не уезжают', async () => {
    storePass(ME, 'v1.mine.mac');

    await notifyPush(PEER, 'секретный текст', `/chat?peer=${ME}`, 'метка');

    const body = sentBody();
    expect(body).toEqual({ to: PEER });
  });

  it('пропуска нет — запроса нет вовсе, и вызывающему это сказано', async () => {
    const outcome = await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);

    expect(outcome).toBe('no-pass');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('протухший пропуск за живой не считается', async () => {
    storePass(ME, 'v1.stale.mac', Math.floor(Date.now() / 1000) - 10);

    const outcome = await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);

    expect(outcome).toBe('no-pass');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('оповещение арбитров едет родом «спор» с адресом сделки, а не ссылкой', async () => {
    storePass(ME, 'v1.mine.mac');
    const deal = '0xdea1000000000000000000000000000000000004';
    const arbiters = ['0xcccc000000000000000000000000000000000003'];

    await notifyArbitersOfDispute(arbiters, deal);

    const body = sentBody();
    expect(body.kind).toBe('dispute');
    expect(body.deal).toBe(deal);
    expect(body).not.toHaveProperty('url');
    // ⚠️ Пропуск здесь НЕ прикладывается, даже когда он есть: доказательство
    // для этой дороги лежит в цепи, а не у человека. Разбор — блокер
    // сквозной проверки, lib/disputeFanout.test.ts.
    expect(sentHeaders()).not.toHaveProperty('x-bag-pass');
  });

  it('без подсказки и с двумя пропусками берётся самый долгоживущий', async () => {
    const now = Math.floor(Date.now() / 1000);
    storePass('0x1111111111111111111111111111111111111111', 'v1.old.mac',  now + 60);
    storePass(ME,                                           'v1.fresh.mac', now + 3600);

    // Ссылка не той формы — подсказки об отправителе из неё не извлечь,
    // значит работает запасная дорога поиска.
    await notifyPush(PEER, 'New message', '/dashboard');

    expect(sentHeaders()['x-bag-pass']).toBe('v1.fresh.mac');
  });
});

describe('К-3 (вторая половина): отказ доставки слышно', () => {
  it('429 от сервера возвращается вызывающему, а не глотается', async () => {
    storePass(ME, 'v1.mine.mac');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }));

    const outcome = await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);

    expect(outcome).toBe('rate-limited');
  });

  it('любой другой отказ сервера — «error», не «ok»', async () => {
    storePass(ME, 'v1.mine.mac');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 502 }));

    expect(await notifyPush(PEER, 'New message', `/chat?peer=${ME}`)).toBe('error');
  });

  it('сеть оборвалась — «error», и наружу не летит необработанное отклонение', async () => {
    storePass(ME, 'v1.mine.mac');
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    expect(await notifyPush(PEER, 'New message', `/chat?peer=${ME}`)).toBe('error');
  });

  it('успех — «ok»', async () => {
    storePass(ME, 'v1.mine.mac');
    expect(await notifyPush(PEER, 'New message', `/chat?peer=${ME}`)).toBe('ok');
  });

  it('о каждом отказе узнаёт подписчик — интерфейсу есть что показать', async () => {
    storePass(ME, 'v1.mine.mac');
    const seen: unknown[] = [];
    const off = onPushDeliveryFailure((info) => seen.push(info));

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: PEER, outcome: 'rate-limited' });

    off();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);
    expect(seen).toHaveLength(1);   // отписались — больше не приходит
  });

  it('успех подписчика не тревожит', async () => {
    storePass(ME, 'v1.mine.mac');
    const seen: unknown[] = [];
    const off = onPushDeliveryFailure((info) => seen.push(info));

    await notifyPush(PEER, 'New message', `/chat?peer=${ME}`);

    expect(seen).toHaveLength(0);
    off();
  });

  it('падение самого подписчика не ломает отправку следующего уведомления', async () => {
    storePass(ME, 'v1.mine.mac');
    const off = onPushDeliveryFailure(() => { throw new Error('подписчик сломался'); });

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(notifyPush(PEER, 'New message', `/chat?peer=${ME}`)).resolves.toBe('rate-limited');

    off();
  });
});
