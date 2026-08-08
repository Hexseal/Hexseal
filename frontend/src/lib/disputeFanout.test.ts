/**
 * БЛОКЕР сквозной проверки, клиентская половина.
 *
 * `notifyArbitersOfDispute` уходил через ту же дверь, что и уведомления
 * чата, — а значит требовал пропуска склада, а значит требовал сеанса чата.
 * Спор открывает человек, который мог не заходить в чат ни разу: запрос не
 * уходил ВООБЩЕ, арбитры о споре не узнавали, и никто об этом не говорил.
 *
 * Здесь заперто: веер уходит без пропуска, а любой его отказ доезжает до
 * места, где его видно человеку, — молчание тут означает зависший спор.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({
  default: { error: toastError, success: vi.fn() },
  error: toastError,
}));

const { notifyArbitersOfDispute, notifyPush, onPushDeliveryFailure } = await import('./webpush');

const DEAL = '0xdea1000000000000000000000000000000000004';
const ARBITERS = [
  '0xc1c1000000000000000000000000000000000001',
  '0xc2c2000000000000000000000000000000000002',
];

let fetchMock: ReturnType<typeof vi.fn>;

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

beforeEach(() => {
  saved = g.localStorage;
  g.localStorage = fakeStorage();          // кладовая ПУСТА: сеанса чата нет
  toastError.mockClear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage; else g.localStorage = saved;
  vi.unstubAllGlobals();
});

function bodyOf(i: number) {
  const [, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('Блокер: веер по спору не зависит от того, пользуется ли человек чатом', () => {
  it('ЗАМЕР ДО ПОЧИНКИ: без сеанса чата не уходило НИ ОДНОГО запроса', async () => {
    await notifyArbitersOfDispute(ARBITERS, DEAL);

    expect(fetchMock).toHaveBeenCalledTimes(ARBITERS.length);
    expect(bodyOf(0)).toEqual({ to: ARBITERS[0], kind: 'dispute', deal: DEAL });
  });

  it('пропуск не прикладывается вовсе — эта дорога доказывает не «кто я», а «спор есть»', async () => {
    await notifyArbitersOfDispute(ARBITERS, DEAL);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('x-bag-pass');
  });

  it('адрес сделки едет в нижнем регистре — ссылку по нему строит сервер', async () => {
    await notifyArbitersOfDispute(ARBITERS, DEAL.toUpperCase().replace('0X', '0x'));
    expect(bodyOf(0).deal).toBe(DEAL);
  });

  it('переписка пропуск по-прежнему требует — послабление касается только спора', async () => {
    const outcome = await notifyPush(
      '0xbbbb000000000000000000000000000000000002', 'New message',
      '/chat?peer=0xaaaa000000000000000000000000000000000001',
    );
    expect(outcome).toBe('no-pass');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Блокер: отказ веера доезжает туда, где его видно', () => {
  it('сервер отказал — человеку СКАЗАНО, а не промолчано', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));

    const summary = await notifyArbitersOfDispute(ARBITERS, DEAL);

    expect(summary).toEqual({ sent: 0, failed: 2 });
    expect(toastError).toHaveBeenCalledTimes(1);       // одна надпись, не две
    expect(String(toastError.mock.calls[0][0])).toMatch(/арбитр|arbiter/i);
  });

  it('сеть оборвалась — то же самое, и наружу не летит необработанное отклонение', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const summary = await notifyArbitersOfDispute(ARBITERS, DEAL);

    expect(summary).toEqual({ sent: 0, failed: 2 });
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('часть дошла, часть нет — молчать нельзя и об этом', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));

    const summary = await notifyArbitersOfDispute(ARBITERS, DEAL);

    expect(summary).toEqual({ sent: 1, failed: 1 });
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('всё дошло — человека не тревожим', async () => {
    const summary = await notifyArbitersOfDispute(ARBITERS, DEAL);
    expect(summary).toEqual({ sent: 2, failed: 0 });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('подписчики на отказ получают своё — надпись не единственный слушатель', async () => {
    const seen: unknown[] = [];
    const off = onPushDeliveryFailure((f) => seen.push(f));
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));

    await notifyArbitersOfDispute(ARBITERS, DEAL);

    expect(seen).toHaveLength(2);
    off();
  });

  it('надпись сломалась — веер всё равно доходит до конца', async () => {
    toastError.mockImplementation(() => { throw new Error('toast сломался'); });
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(notifyArbitersOfDispute(ARBITERS, DEAL)).resolves.toEqual({ sent: 0, failed: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('арбитров нет вовсе — это тоже молчание, и о нём сказано', async () => {
    const summary = await notifyArbitersOfDispute([], DEAL);
    expect(summary).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
