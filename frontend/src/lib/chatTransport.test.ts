import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requestBagPass, putBag, listBags, fetchBag, pollBags,
  BagTransportError, BagPassError, BagRateLimitError,
  DEFAULT_BAG_POLL_INTERVALS,
  _resetBagPassCacheForTest,
  type BagSummary, type BagPollHandle,
} from './chatTransport';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.restoreAllMocks();
  _resetBagPassCacheForTest();
});

/* ─────────────────────────── requestBagPass ──────────────────────────── */

describe('requestBagPass', () => {
  it('подписывает hexseal:chat-bags:<адрес>:<секунды> и шлёт x-ts/x-sig, без sender в теле', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: 'v1.a', expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { pass, expiresAt } = await requestBagPass(sign, ALICE);
    expect(pass).toBe('v1.a');
    expect(expiresAt).toBeGreaterThan(nowSec());

    expect(sign).toHaveBeenCalledTimes(1);
    const signedMessage = sign.mock.calls[0][0] as string;
    expect(signedMessage).toMatch(/^hexseal:chat-bags:0xa1ce00000000000000000000000000000000cafe:\d+$/);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/bags/pass');
    expect((init.headers as Record<string, string>)['x-sig']).toBe('0xsig');
    expect((init.headers as Record<string, string>)['x-ts']).toMatch(/^\d+$/);
    expect(JSON.parse(String(init.body))).toEqual({ address: ALICE });
  });

  it('повторный вызов с живым пропуском — ноль обращений в сеть, ноль запросов подписи', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: 'v1.a', expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await requestBagPass(sign, ALICE);
    const second = await requestBagPass(sign, ALICE);

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('протухший в кэше пропуск — одна новая подпись, один запрос, новый пропуск', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn()
      // Срок настолько близко к "сейчас", что сразу попадает в буфер устаревания.
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: 'v1.old', expiresAt: nowSec() + 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: 'v1.new', expiresAt: nowSec() + 3600 }) });
    vi.stubGlobal('fetch', fetchMock);

    const first = await requestBagPass(sign, ALICE);
    const second = await requestBagPass(sign, ALICE);

    expect(first.pass).toBe('v1.old');
    expect(second.pass).toBe('v1.new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('разные адреса кэшируются раздельно', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const BOB = '0xb0b000000000000000000000000000000000b0b0' as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: 'v1.alice', expiresAt: nowSec() + 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: 'v1.bob', expiresAt: nowSec() + 3600 }) });
    vi.stubGlobal('fetch', fetchMock);

    const a = await requestBagPass(sign, ALICE);
    const b = await requestBagPass(sign, BOB);
    expect(a.pass).toBe('v1.alice');
    expect(b.pass).toBe('v1.bob');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('отказ сервера бросает ошибку С КОДОМ, не текстом для парсинга', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: 'Signature does not match claimed address', code: 'address_mismatch' }),
    }));
    const sign = vi.fn().mockResolvedValue('0xsig');
    let caught: unknown;
    try { await requestBagPass(sign, ALICE); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagPassError);
    expect((caught as BagPassError).code).toBe('address_mismatch');
    expect((caught as BagPassError).status).toBe(401);
  });

  it('429 бросает BagRateLimitError с retryAfterSec из заголовка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429,
      json: async () => ({ error: 'Rate limit exceeded', code: 'rate_limited_pass' }),
      headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '90' : null },
    }));
    const sign = vi.fn().mockResolvedValue('0xsig');
    let caught: unknown;
    try { await requestBagPass(sign, ALICE); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagRateLimitError);
    expect((caught as BagRateLimitError).code).toBe('rate_limited_pass');
    expect((caught as BagRateLimitError).retryAfterSec).toBe(90);
  });

  it('мусор вместо {pass, expiresAt} не проходит за успех', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    await expect(requestBagPass(vi.fn().mockResolvedValue('0xsig'), ALICE)).rejects.toThrow();
  });

  it('упавшая сеть бросается наружу как есть', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(requestBagPass(vi.fn().mockResolvedValue('0xsig'), ALICE)).rejects.toThrow();
  });
});

/* ─────────────────────────────── putBag ───────────────────────────────── */

describe('putBag', () => {
  it('не шлёт адрес отправителя и не использует Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    await putBag('v1.p', ALICE, new Uint8Array([1, 2, 3]));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost:3001/bags/${ALICE}`);
    expect(init.method).toBe('PUT');
    const body = String(init.body ?? '');
    expect(body).not.toMatch(/sender/i);
    expect((init.headers as Record<string, string>)['content-type']).not.toBe('application/json');
    expect((init.headers as Record<string, string>)['x-bag-pass']).toBe('v1.p');
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it('возвращает key из ответа сервера', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'alice/123-abc.bin' }) }));
    await expect(putBag('v1.p', ALICE, new Uint8Array([9]))).resolves.toEqual({ key: 'alice/123-abc.bin' });
  });

  it('мусор вместо {key} не проходит за успех', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(putBag('v1.p', ALICE, new Uint8Array([1]))).rejects.toThrow();
  });

  it('протухший пропуск — BagPassError с кодом, не пустой успех', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ code: 'pass_expired' }),
    }));
    let caught: unknown;
    try { await putBag('v1.old', ALICE, new Uint8Array([1])); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagPassError);
    expect((caught as BagPassError).code).toBe('pass_expired');
  });

  it('упавшая сеть бросается наружу', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(putBag('v1.p', ALICE, new Uint8Array([1]))).rejects.toThrow();
  });
});

/* ─────────────────────────────── listBags ─────────────────────────────── */

describe('listBags', () => {
  it('шлёт x-bag-pass и добавляет ?since= только если передан', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', fetchMock);

    await listBags('v1.p');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:3001/bags');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'x-bag-pass': 'v1.p' });

    await listBags('v1.p', 1234);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://localhost:3001/bags?since=1234');
  });

  it('пустой список — обычное значение, а не ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) }));
    await expect(listBags('v1.p')).resolves.toEqual([]);
  });

  it('корректный список проходит как есть', async () => {
    const item: BagSummary = { key: 'a/1.bin', sender: ALICE, size: 42, uploadedAt: 1000 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([item]) }));
    await expect(listBags('v1.p')).resolves.toEqual([item]);
  });

  it('мусор в списке — элемент без key и с нечисловым size — не проходит за данные', async () => {
    const ALICE_ADDR: `0x${string}` = ALICE;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ([{ sender: ALICE_ADDR }]), // нет key и size
    }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  // Разложено на два отдельных случая (не один, где ключа И размера нет
  // сразу) намеренно: один общий фикстур не различает, СКОЛЬКО именно
  // проверок в isBagSummary реально работает — потеря любой из двух молча
  // прошла бы мимо теста выше. Мутация: убрать проверку size в реализации —
  // без разделения тест "мусор в списке" остаётся зелёным (key всё равно
  // отсутствует), с разделением "size не число" красный ровно от неё.
  it('элемент с валидным key, но size не число — не проходит', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ([{ key: 'a/1.bin', sender: ALICE, size: 'lots', uploadedAt: 1000 }]),
    }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  it('элемент без key, но с валидным size — тоже не проходит', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ([{ sender: ALICE, size: 42, uploadedAt: 1000 }]),
    }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  it('элемент с валидными key/size, но uploadedAt не число — тоже не проходит', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ([{ key: 'a/1.bin', sender: ALICE, size: 42, uploadedAt: 'скоро' }]),
    }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  it('ответ не массивом — тоже мусор, не тихая пустота', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bags: [] }) }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  it('битый JSON в успешном ответе пробрасывается, а не превращается в пустой список', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); },
    }));
    await expect(listBags('v1.p')).rejects.toThrow();
  });

  it('пустой список и отказ доступа — РАЗНЫЕ результаты, не «тихо, будто пусто»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) }));
    await expect(listBags('v1.p')).resolves.toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ code: 'pass_invalid' }),
    }));
    let caught: unknown;
    try { await listBags('v1.p'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagPassError);
    expect((caught as BagPassError).code).toBe('pass_invalid');
  });

  it('429 бросает BagRateLimitError с числом секунд', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ code: 'rate_limited_read' }),
      headers: { get: () => '60' },
    }));
    let caught: unknown;
    try { await listBags('v1.p'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagRateLimitError);
    expect((caught as BagRateLimitError).retryAfterSec).toBe(60);
  });

  it('упавшая сеть бросается наружу, а не превращается в пустой список', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(listBags('v1.p')).rejects.toThrow();
  });
});

/* ─────────────────────────────── fetchBag ──────────────────────────────── */

describe('fetchBag', () => {
  it('несуществующий/чужой мешок — null, а упавшая сеть — исключение', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchBag('v1.p', 'нет/такого.bin')).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchBag('v1.p', 'любой/ключ.bin')).rejects.toThrow();
  });

  it('успешный ответ отдаёт ровно те же байты', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, arrayBuffer: async () => bytes.buffer,
    }));
    const got = await fetchBag('v1.p', 'a/1.bin');
    expect(got).toEqual(bytes);
  });

  it('обрыв сети ПОСРЕДИ скачивания (после 200) тоже бросает, а не отдаёт пусто/частично', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => { throw new TypeError('network error'); },
    }));
    await expect(fetchBag('v1.p', 'a/1.bin')).rejects.toThrow();
  });

  it('протухший пропуск на скачивании — BagPassError с кодом, не null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ code: 'pass_expired' }),
    }));
    let caught: unknown;
    try { await fetchBag('v1.p', 'a/1.bin'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BagPassError);
    expect((caught as BagPassError).code).toBe('pass_expired');
  });

  it('заголовок x-bag-pass идёт в запрос', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    await fetchBag('v1.p', 'a/1.bin');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:3001/bags/a/1.bin');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'x-bag-pass': 'v1.p' });
  });
});

/* ──────────────────── образец повтора из шапки модуля ─────────────────── */

describe('образец повтора (из документации модуля)', () => {
  it('поймать 401, обновить пропуск через requestBagPass, повторить РОВНО один раз', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn()
      // 1) listBags с протухшим пропуском -> 401 pass_expired
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ code: 'pass_expired' }) })
      // 2) requestBagPass -> новый пропуск (дёшево не бывает при первом вызове — подписи ещё не было)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: 'v1.new', expiresAt: nowSec() + 3600 }) })
      // 3) повтор listBags с новым пропуском -> список
      .mockResolvedValueOnce({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', fetchMock);

    let bags: BagSummary[];
    try {
      bags = await listBags('v1.old');
    } catch (e) {
      if (!(e instanceof BagPassError)) throw e;
      const fresh = await requestBagPass(sign, ALICE);
      bags = await listBags(fresh.pass);
    }

    expect(bags).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

/* ─────────────────────────────── pollBags ──────────────────────────────── */

describe('pollBags', () => {
  it('переключает интервал по активности: 5с активно, 30с в фоне (умолчания)', async () => {
    expect(DEFAULT_BAG_POLL_INTERVALS).toEqual({ activeMs: 5_000, backgroundMs: 30_000 });

    let activeFlag = true;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) }));

    const slept: number[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 1) activeFlag = false; // тик 2 идёт в фоне
      if (slept.length === 2) { handle.stop(); resolveDone(); }
    };

    handle = pollBags({ getPass: () => 'v1.p', isActive: () => activeFlag, onBags: () => {}, sleep });
    await done;

    expect(slept).toEqual([DEFAULT_BAG_POLL_INTERVALS.activeMs, DEFAULT_BAG_POLL_INTERVALS.backgroundMs]);
  });

  it('не наслаивается сам на себя, если ответ пришёл дольше интервала', async () => {
    let resolveFirst!: (v: unknown) => void;
    const first = new Promise((r) => { resolveFirst = r; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', fetchMock);

    let handle: BagPollHandle;
    const sleep = vi.fn(async () => { handle.stop(); });
    handle = pollBags({ getPass: () => 'v1.p', isActive: () => true, onBags: () => {}, sleep });

    // Дать циклу шанс уйти в fetch, но НЕ резолвить его — интервал за это
    // время "прошёл бы" много раз, если бы опрос не ждал ответа.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    resolveFirst({ ok: true, json: async () => ([]) });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // второй тик ещё не стартовал — мы уже остановили цикл
  });

  it('429 — следующий тик откладывается минимум до Retry-After, а не бьёт с базовым интервалом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ code: 'rate_limited_read' }),
      headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '90' : null },
    }));

    const errors: unknown[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => {
      expect(ms).toBe(90_000); // не intervals.activeMs (5000)
      handle.stop();
      resolveDone();
    };

    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: () => {}, onError: (e) => errors.push(e),
      sleep,
    });
    await done;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(BagRateLimitError);
  });

  it('ошибка listBags не роняет опрос — onError зовётся, следующий тик всё равно планируется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const errors: unknown[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async () => { handle.stop(); resolveDone(); };

    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: () => {}, onError: (e) => errors.push(e),
      sleep,
    });
    await done;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
  });

  it('stop() останавливает опрос — после него новых запросов не бывает', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', fetchMock);

    const sleep = async () => {};
    const handle = pollBags({ getPass: () => 'v1.p', isActive: () => true, onBags: () => {}, sleep });
    await Promise.resolve(); await Promise.resolve();
    handle.stop();
    const callsAtStop = fetchMock.mock.calls.length;
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  });
});

/* ──────────────────────── общий класс ошибок ──────────────────────────── */

describe('BagTransportError', () => {
  it('BagPassError и BagRateLimitError — подклассы BagTransportError', () => {
    const pe = new BagPassError('x', 'pass_expired', 401);
    const re = new BagRateLimitError('x', 'rate_limited_read', 60);
    expect(pe).toBeInstanceOf(BagTransportError);
    expect(re).toBeInstanceOf(BagTransportError);
  });
});
