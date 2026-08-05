import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestBagPass, putBag, listBags, fetchBag, pollBags, forgetBagPass,
  BagTransportError, BagPassError, BagRateLimitError,
  DEFAULT_BAG_POLL_INTERVALS,
  _resetBagPassCacheForTest,
  type BagSummary, type BagPollHandle,
} from './chatTransport';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

// I2 (ревью-координатор). wagmi's useAccount().address отдаёт адрес С
// КОНТРОЛЬНОЙ СУММОЙ (заглавные буквы по EIP-55), не нижним регистром — а
// сервер строит фразу для подписи и хранит recipient ИСКЛЮЧИТЕЛЬНО в нижнем
// регистре (ETH_ADDR_RE = /^0x[0-9a-f]{40}$/ в relayer/bagPass.js и app.js
// отвергает заглавные буквы вовсе). Фикстура `ALICE` сама уже в нижнем
// регистре — тест на `.toLowerCase()`, взятый прямо на ней, ничего не
// проверяет: `ALICE.toLowerCase() === ALICE`, мутация "убрать приведение"
// не меняет исход. Этот адрес — тот же самый ALICE, но с регистром, какой
// реально придёт из кошелька.
const ALICE_CHECKSUM = '0xA1cE00000000000000000000000000000000CAfE' as const;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Токен в РЕАЛЬНОЙ форме сервера (`v1.<base64url(addr.expiresAt)>.<mac>`,
 *  см. relayer/bagPass.js `issueBagPass()`), но с фиктивным mac — тесты на
 *  выброс кэша (C1) должны реально суметь извлечь адрес из тела, а
 *  произвольная строка вроде `'v1.old'` для этого не годится (в ней нет
 *  даже трёх точечных сегментов). `marker` — чтобы разные "версии" пропуска
 *  одного адреса были текстуально различимы в assert'ах. */
function fakePass(address: string, marker: string): string {
  const body = `${address.toLowerCase()}.${nowSec() + 3600}`;
  return `v1.${Buffer.from(body, 'utf8').toString('base64url')}.${marker}`;
}

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

  // I2 (ревью-координатор). На адресе С КОНТРОЛЬНОЙ СУММОЙ (как реально
  // приходит из wagmi) — иначе тест не отличает "приводим регистр" от
  // "просто передаём как есть", раз фикстура уже нижнего регистра.
  it('I2: адрес с контрольной суммой (как из wagmi) — подпись и тело POST в НИЖНЕМ регистре', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: 'v1.a', expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestBagPass(sign, ALICE_CHECKSUM);

    const signedMessage = sign.mock.calls[0][0] as string;
    expect(signedMessage).toBe(`hexseal:chat-bags:${ALICE}:${signedMessage.split(':').pop()}`);
    expect(signedMessage).not.toContain('CAfE');
    expect(signedMessage).not.toContain('A1cE');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(String(init.body)) as { address: string };
    expect(sentBody.address).toBe(ALICE); // не ALICE_CHECKSUM — сервер отверг бы заглавные ETH_ADDR_RE
  });

  it('I2: кэш по адресу нормализован — контрольная сумма и нижний регистр бьют в ОДНУ запись', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: 'v1.a', expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await requestBagPass(sign, ALICE);
    const second = await requestBagPass(sign, ALICE_CHECKSUM); // тот же адрес, другой регистр

    expect(second).toEqual(first);
    expect(sign).toHaveBeenCalledTimes(1); // не 2 — иначе кэш не признал их одним адресом
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

  // I5 (ревью-координатор, важная находка). Предыдущий тест смотрел ТОЛЬКО
  // тело — мутация, кладущая адрес отдельным заголовком (`x-sender`),
  // проходила чисто (проверено вживую: `'x-sender': recipient` в заголовках
  // putBag не красит ни один существующий тест). Адрес мог бы уехать телом,
  // заголовком или в самом URL сверх легитимного `recipient` — все три пути
  // здесь заперты явно, не только тело.
  it('I5: адрес отправителя не уезжает НИГДЕ — ни в теле, ни в заголовке, ни в URL сверх recipient', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    await putBag('v1.p', ALICE, new Uint8Array([1, 2, 3]));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // URL — ровно /bags/<recipient>, без query-строки и без лишних сегментов
    // (recipient — легитимный путь; НИЧЕГО кроме него).
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe(`/bags/${ALICE}`);
    expect(parsed.search).toBe('');

    // Заголовки — ровно x-bag-pass и content-type, никакого x-sender/from/…
    const headers = init.headers as Record<string, string>;
    const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
    expect(headerNames.sort()).toEqual(['content-type', 'x-bag-pass']);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'x-bag-pass') continue; // сам пропуск — не адрес
      expect(name.toLowerCase()).not.toMatch(/sender|from/i);
      expect(String(value).toLowerCase()).not.toBe(ALICE);
    }
  });

  // I2 (ревью-координатор): getula получателя из wagmi приходит с контрольной
  // суммой — сервер строит путь ТОЛЬКО из нижнего регистра
  // (`req.params.recipient.toLowerCase()` в relayer/app.js), значит если
  // клиент не приведёт сам, URL совпадёт с сервером только случайно (когда
  // в адресе нет ни одной буквы a-f, что для реального адреса — редкость).
  it('I2: recipient с контрольной суммой (как из wagmi) — URL в НИЖНЕМ регистре', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    await putBag('v1.p', ALICE_CHECKSUM, new Uint8Array([1]));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(`http://localhost:3001/bags/${ALICE}`);
    expect(String(url)).not.toContain('CAfE');
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

  // C1 (ревью-координатор, критическая находка). Пропуск живёт 12 часов по
  // КЛИЕНТСКИМ часам. Если сервер начал отвечать 401 раньше срока по этим
  // часам (перезапуск с новым секретом, разъехавшиеся в разрешённых ±5 мин
  // часы, урезанный прокси заголовок) — requestBagPass смотрит СВОИ часы,
  // видит "живой" кэш и отдаёт ТОТ ЖЕ мёртвый пропуск. Образец выше это не
  // ловит вообще, если сервер не считает пропуск протухшим ПО СВОИМ часам —
  // ключевая часть этого теста в том, что requestBagPass() успел закэшировать
  // ДОЛГИЙ срок ДО того, как сервер сказал "нет".
  it('C1: 401 при формально живом по МЕСТНЫМ часам пропуске — транспорт сам выбрасывает кэш, повтор даёт НОВУЮ подпись и успех', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const stalePass = fakePass(ALICE, 'stale');
    const freshPass = fakePass(ALICE, 'fresh');
    const fetchMock = vi.fn()
      // 1) requestBagPass -> пропуск с долгим сроком по МЕСТНЫМ часам (кэш будет жить ещё час)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: stalePass, expiresAt: nowSec() + 3600 }) })
      // 2) listBags этим пропуском -> СЕРВЕР считает его мёртвым прямо сейчас
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ code: 'pass_invalid' }) })
      // 3) requestBagPass повторно -> ОБЯЗАН реально сходить в сеть за подписью,
      //    раз кэш выброшен транспортом, а не тихо отдать stalePass снова
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: freshPass, expiresAt: nowSec() + 3600 }) })
      // 4) повтор listBags новым пропуском -> успех
      .mockResolvedValueOnce({ ok: true, json: async () => ([]) });
    vi.stubGlobal('fetch', fetchMock);

    const first = await requestBagPass(sign, ALICE);
    expect(first.pass).toBe(stalePass);

    let bags: BagSummary[];
    try {
      bags = await listBags(first.pass);
    } catch (e) {
      if (!(e instanceof BagPassError)) throw e;
      const fresh = await requestBagPass(sign, ALICE);
      bags = await listBags(fresh.pass);
    }

    expect(bags).toEqual([]);
    // Была дыра: без выброса кэша это осталось бы 1 — requestBagPass отдавал
    // бы тот же stalePass из кэша навсегда, и повтор падал бы тем же 401.
    expect(sign).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('forgetBagPass', () => {
  it('выбрасывает кэш конкретного адреса — следующий requestBagPass реально подписывает заново', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: fakePass(ALICE, 'a'), expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestBagPass(sign, ALICE);
    forgetBagPass(ALICE);
    await requestBagPass(sign, ALICE);

    expect(sign).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('регистр адреса значения не имеет', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: fakePass(ALICE, 'a'), expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestBagPass(sign, ALICE);
    forgetBagPass(ALICE.toUpperCase() as `0x${string}`);
    await requestBagPass(sign, ALICE);

    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('listBags/putBag/fetchBag сами зовут forgetBagPass на 401 — следующий requestBagPass того же адреса не отдаёт кэш', async () => {
    const sign = vi.fn().mockResolvedValue('0xsig');
    const passA = fakePass(ALICE, 'a');
    const passB = fakePass(ALICE, 'b');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: passA, expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await requestBagPass(sign, ALICE); // засеваем кэш живым по местным часам пропуском

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ code: 'pass_invalid' }),
    }));
    await expect(putBag(passA, ALICE, new Uint8Array([1]))).rejects.toBeInstanceOf(BagPassError);

    const fetchMock2 = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: passB, expiresAt: nowSec() + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock2);
    const after = await requestBagPass(sign, ALICE);
    expect(after.pass).toBe(passB); // не passA из кэша
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('putBag с пропуском ДРУГОГО адреса не задевает кэш вызывающего (парсим владельца ИЗ токена, не из аргументов вызова)', async () => {
    const BOB = '0xb0b000000000000000000000000000000000b0b0' as const;
    const sign = vi.fn().mockResolvedValue('0xsig');
    const aliceFirst = fakePass(ALICE, 'a1');
    const bobFirst = fakePass(BOB, 'b1');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: aliceFirst, expiresAt: nowSec() + 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pass: bobFirst, expiresAt: nowSec() + 3600 }) }));
    await requestBagPass(sign, ALICE);
    await requestBagPass(sign, BOB);

    // putBag зовётся ПРОПУСКОМ БОБА (Боб шлёт получателю Алисы), но 401
    // относится к пропуску Боба — кэш Алисы трогать не должен.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ code: 'pass_invalid' }),
    }));
    await expect(putBag(bobFirst, ALICE, new Uint8Array([1]))).rejects.toBeInstanceOf(BagPassError);

    // Кэш Алисы жив — requestBagPass(ALICE) не должен подписывать заново.
    const fetchMock3 = vi.fn();
    vi.stubGlobal('fetch', fetchMock3);
    const aliceAgain = await requestBagPass(sign, ALICE);
    expect(aliceAgain.pass).toBe(aliceFirst);
    expect(fetchMock3).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────── pollBags ──────────────────────────────── */

describe('pollBags', () => {
  it('переключает интервал по активности: 5с активно, 30с в фоне (умолчания)', async () => {
    expect(DEFAULT_BAG_POLL_INTERVALS).toEqual({ activeMs: 5_000, backgroundMs: 30_000, maxBackoffMs: 300_000 });

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

  // I3 (ревью-координатор, важная находка). Пол: Retry-After: 0.001 давал бы
  // 1мс — предыдущий тест на 429 брал retryAfterSec=90 (БОЛЬШЕ базового
  // интервала), так что Math.max(base, retryAfterSec*1000) выбирал бы
  // retryAfterSec*1000 ЛЮБЫМ способом (в том числе через Math.min по ошибке)
  // — этот тест намеренно берёт МЕНЬШЕЕ число, чтобы отличить "пол
  // держит базовый интервал" от "просто взяли то, что пришло".
  it('I3: пол — крошечный Retry-After не отступает МЕНЬШЕ базового интервала', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ code: 'rate_limited_read' }),
      headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '0.001' : null },
    }));
    const slept: number[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => { slept.push(ms); handle.stop(); resolveDone(); };

    handle = pollBags({ getPass: () => 'v1.p', isActive: () => true, onBags: () => {}, sleep });
    await done;

    expect(slept[0]).toBe(DEFAULT_BAG_POLL_INTERVALS.activeMs); // не 1мс
  });

  // Замер координатора вживую на настоящем таймере: Retry-After: 3000000
  // (3 млн секунд) давало delay в 3 МИЛЛИАРДА миллисекунд — выше предела,
  // который HTML/Node-таймер молча зажимает до ~1мс (32-битное знаковое
  // число, ~24.8 дня) — "отступление" переворачивалось в тесный цикл: три
  // отказа меньше чем за полсекунды, с предупреждением среды выполнения.
  it('I3: потолок — гигантский Retry-After не улетает за предел, который таймер зажимает до ~1мс', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ code: 'rate_limited_read' }),
      headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '3000000' : null },
    }));
    const slept: number[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => { slept.push(ms); handle.stop(); resolveDone(); };

    handle = pollBags({ getPass: () => 'v1.p', isActive: () => true, onBags: () => {}, sleep });
    await done;

    expect(slept[0]).toBe(DEFAULT_BAG_POLL_INTERVALS.maxBackoffMs);
    // Явно ниже предела 2**31-1, за которым setTimeout спецификацией
    // молча укорачивает delay до ~1мс — не только "меньше 3 миллиардов",
    // а безопасно меньше именно ЭТОЙ границы.
    expect(slept[0]).toBeLessThan(2 ** 31);
  });

  // Мелочи (ревью-координатор).
  it('мелочь: isActive() бросает — попадает в onError, опрос не гибнет молча', async () => {
    // isActive() бросает СИНХРОННО на первом тике, ДО единственного await
    // внутри loop() до этой точки (await opts.getPass()) — весь первый тик
    // (try → catch → onError → sleep) успевает отработать в ТОЙ ЖЕ
    // синхронной цепочке вызовов, которой ещё принадлежит сам вызов
    // pollBags(...) ниже, так что handle внутри первого sleep() ещё не
    // присвоен. isActive throws РОВНО один раз (флагом), второй тик проходит
    // штатно и его sleep() — уже безопасное место звать handle.stop().
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) }));
    const errors: unknown[] = [];
    let isActiveCalls = 0;
    const isActive = (): boolean => {
      isActiveCalls++;
      if (isActiveCalls === 1) throw new Error('isActive boom');
      return true;
    };
    let handle: BagPollHandle;
    let sleepCalls = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async () => {
      sleepCalls++;
      if (sleepCalls === 2) { handle.stop(); resolveDone(); }
    };

    handle = pollBags({
      getPass: () => 'v1.p', isActive,
      onBags: () => {}, onError: (e) => errors.push(e),
      sleep,
    });
    await done;

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('isActive boom');
  });

  it('мелочь: обработчик ошибок сам бросает — не убивает цикл, следующий тик всё равно планируется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('net down')));
    let ticks = 0;
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async () => {
      ticks++;
      if (ticks === 2) { handle.stop(); resolveDone(); }
    };
    const onError = (): void => { throw new Error('onError сам сломан'); };

    handle = pollBags({ getPass: () => 'v1.p', isActive: () => true, onBags: () => {}, onError, sleep });
    await done;

    // Дошли до ВТОРОГО тика — цикл пережил падение собственного обработчика
    // ошибок. Без фикса брошенное из onError вылетает из catch-блока и
    // убивает while изнутри — sleep() позвался бы только один раз.
    expect(ticks).toBe(2);
  });

  it('мелочь: ошибка в onBags (баг отрисовки у потребителя) не считается транспортной — не идёт в onError, не копит backoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ([]) }));
    const errors: unknown[] = [];
    const sleep = vi.fn(async () => {});

    // loop() — необработанный async IIFE внутри pollBags: подтверждаем, что
    // ошибка колбэка потребителя реально ВСПЛЫВАЕТ (не проглатывается тихо),
    // а не только что она "не идёт в onError". Слушатель снят сразу после
    // проверки — не должен утекать в остальные тесты файла.
    let unhandled: unknown = null;
    const onUnhandledRejection = (err: unknown) => { unhandled = err; };
    process.once('unhandledRejection', onUnhandledRejection);
    try {
      pollBags({
        getPass: () => 'v1.p', isActive: () => true,
        onBags: () => { throw new Error('render bug'); },
        onError: (e) => errors.push(e),
        sleep,
      });
      // Дать микрозадачам (getPass -> listBags -> onBags -> throw) и Node
      // (репортинг unhandledRejection случается на следующем тике event loop,
      // не в той же микрозадаче) реально прогнать сценарий целиком.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    expect(errors).toHaveLength(0); // НЕ через onError — это не сбой сети, а баг колбэка
    expect(sleep).not.toHaveBeenCalled(); // цикл не дошёл до планирования следующего тика — остановился
    expect(unhandled).toBeInstanceOf(Error);
    expect((unhandled as Error).message).toBe('render bug'); // всплыло по-настоящему, не проглочено
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

  // I4 (ревью-координатор, важная находка). Отступление раньше срабатывало
  // ТОЛЬКО на 429 — сеть лежит, 500, затянувшийся 401 давали ровно пять
  // секунд бесконечно, без нарастания и без предела. Замер координатора:
  // [5000, 5000, 5000, 5000]. Сервер (или сеть) сигналит "мне плохо" любым
  // из этих способов, не только явным 429, — клиент обязан отступать на всё.
  it('I4: повторяющаяся ЛЮБАЯ ошибка нарастает — не [5000,5000,5000,5000] вечно', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const slept: number[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 4) { handle.stop(); resolveDone(); }
    };

    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: () => {}, onError: () => {},
      sleep,
    });
    await done;

    expect(slept[0]).toBe(DEFAULT_BAG_POLL_INTERVALS.activeMs); // первый отказ — база, не сразу штраф
    expect(slept[1]).toBeGreaterThan(slept[0]);
    expect(slept[2]).toBeGreaterThan(slept[1]);
    expect(slept[3]).toBeLessThanOrEqual(DEFAULT_BAG_POLL_INTERVALS.maxBackoffMs); // растёт, но не бесконечно
  });

  it('I4: сброс нарастания при первом успехе — следующий отказ снова начинает с базового интервала', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) throw new TypeError('Failed to fetch');       // тики 1-2: отказ (нарастание)
      if (call === 3) return { ok: true, json: async () => ([]) }; // тик 3: успех (сброс)
      throw new TypeError('Failed to fetch');                       // тик 4: отказ СРАЗУ после успеха
    });
    vi.stubGlobal('fetch', fetchMock);

    const slept: number[] = [];
    let handle: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 4) { handle.stop(); resolveDone(); }
    };

    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: () => {}, onError: () => {},
      sleep,
    });
    await done;

    const base = DEFAULT_BAG_POLL_INTERVALS.activeMs;
    expect(slept[0]).toBe(base);          // тик1: первый отказ — база
    expect(slept[1]).toBeGreaterThan(base); // тик2: второй отказ подряд — нарастание
    expect(slept[2]).toBe(base);          // тик3: успех — обычный интервал, не капнутое нарастание
    expect(slept[3]).toBe(base);          // тик4: отказ СРАЗУ после успеха — снова с нуля
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

// Мелочь (ревью-координатор): NEXT_PUBLIC_RELAYER_URL с хвостовым слэшем
// (легко получить простой опечаткой в .env — шесть остальных потребителей
// в проекте, включая lib/xmtp.ts:911 и app/api/relay/route.ts, уже режут
// его через .replace(/\/$/, '')) давал бы URL вида
// "http://host//bags/pass" — двойной слэш. `vi.resetModules()` +
// динамический import — модуль читает переменную окружения один раз на
// уровне модуля (тот же приём, что lib/walletLock.test.ts уже применяет к
// своим модуль-level константам).
describe('RELAYER_URL', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_RELAYER_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_RELAYER_URL;
    else process.env.NEXT_PUBLIC_RELAYER_URL = ORIGINAL;
    vi.resetModules();
  });

  it('хвостовой слэш в NEXT_PUBLIC_RELAYER_URL не даёт двойной слэш в пути', async () => {
    process.env.NEXT_PUBLIC_RELAYER_URL = 'http://example.test:9000/';
    vi.resetModules();
    const fresh = await import('./chatTransport');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ pass: 'v1.a', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fresh.requestBagPass(vi.fn().mockResolvedValue('0xsig'), ALICE);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe('http://example.test:9000/bags/pass');
    expect(String(url)).not.toContain('//bags');
  });
});
