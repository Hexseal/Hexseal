import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  acquireWalletLock,
  withWalletLock,
  awaitFreshForwarderNonce,
  rememberSpentForwarderNonce,
} from './walletLock';

// Очередь лока живёт в модульной Map, общей на весь файл тестов. Каждому тесту
// — свой адрес, иначе один упавший тест оставляет лок взятым и все следующие
// молча висят на нём до трёхминутного потолка.
let n = 0;
const addr = () => `0x${String(++n).padStart(40, '1')}`;

/** Промис, который тест резолвит сам. Ждать таймерами здесь нельзя: смысл
 *  лока — порядок между промисами, а сравнение «кто раньше по setTimeout(0)»
 *  зависит от того, сколько await'ов оказалось на каждой стороне. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Даёт очереди микрозадач провернуться до конца. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

describe('acquireWalletLock', () => {
  it('второй захват ждёт освобождения первого', async () => {
    // Ровно то, ради чего лок существует: два запроса подписи для одного
    // кошелька, стартовавшие рядом. Второй, улетевший в кошелёк не дождавшись
    // первого, получает -32002 'already pending', а в мобильном MetaMask такой
    // запрос не отменяется ничем, кроме полного закрытия приложения кошелька.
    const a = addr();
    const release1 = await acquireWalletLock(a);

    let secondGotIt = false;
    const second = acquireWalletLock(a).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(secondGotIt).toBe(false); // держим — второй стоит

    release1();
    const release2 = await second;
    expect(secondGotIt).toBe(true);
    release2();
  });

  it('разные кошельки друг друга не блокируют', async () => {
    // Лок — на адрес, а не глобальный: очередь у чужого кошелька не должна
    // останавливать наш.
    const releaseA = await acquireWalletLock(addr());
    const releaseB = await acquireWalletLock(addr()); // не должно зависнуть
    releaseA();
    releaseB();
  });

  it('адрес нечувствителен к регистру', async () => {
    // Один и тот же кошелёк приходит сюда то как checksum-адрес (viem), то
    // как lowercase (наши собственные вызовы) — без нормализации это были бы
    // две независимые очереди, то есть лока фактически нет.
    const a = `0x${'aB'.repeat(20)}`;
    const release1 = await acquireWalletLock(a.toUpperCase().replace('0X', '0x'));

    let secondGotIt = false;
    const second = acquireWalletLock(a.toLowerCase()).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(secondGotIt).toBe(false);

    release1();
    (await second)();
    expect(secondGotIt).toBe(true);
  });

  it('очередь из трёх соблюдает порядок', async () => {
    const a = addr();
    const order: number[] = [];
    const release1 = await acquireWalletLock(a);
    order.push(1);

    const second = acquireWalletLock(a).then(r => { order.push(2); return r; });
    await settle(); // second встал в хвост раньше third
    const third  = acquireWalletLock(a).then(r => { order.push(3); return r; });

    await settle();
    expect(order).toEqual([1]);

    release1();
    (await second)();
    (await third)();
    expect(order).toEqual([1, 2, 3]);
  });

  it('провал под локом всё равно освобождает очередь', async () => {
    // Отказ от подписи в кошельке — самый обычный исход, и он не должен
    // заклинивать все остальные действия до перезагрузки страницы.
    const a = addr();
    await expect(
      withWalletLock(a, async () => { throw new Error('user rejected'); }),
    ).rejects.toThrow('user rejected');

    // Если бы лок не отпустился, этот await не вернулся бы никогда.
    const release = await acquireWalletLock(a);
    release();
  });

  it('withWalletLock держит лок на всё время колбэка и отдаёт его результат', async () => {
    const a = addr();
    const gate = deferred();

    let finished = false;
    const result = withWalletLock(a, async () => {
      await gate.promise;   // «окно подписи» открыто ровно пока мы не разрешим
      finished = true;
      return 'sig';
    });

    let secondGotIt = false;
    const second = acquireWalletLock(a).then(r => { secondGotIt = true; return r; });

    await settle();
    expect(finished).toBe(false);
    expect(secondGotIt).toBe(false); // колбэк ещё внутри — второй ждёт

    gate.resolve();
    expect(await result).toBe('sig');
    (await second)();
    expect(secondGotIt).toBe(true);
  });

  it('withWalletLock сериализует конкурирующие подписи', async () => {
    // Три «окна подписи» подряд: пересечения быть не должно ни в одной точке.
    const a = addr();
    let concurrent = 0;
    let maxConcurrent = 0;
    const sign = () => withWalletLock(a, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await settle();
      concurrent--;
    });

    await Promise.all([sign(), sign(), sign()]);
    expect(maxConcurrent).toBe(1);
  });
});

// ─── nonce форвардера ─────────────────────────────────────────────────────────

const FWD = `0x${'f0'.repeat(20)}`;

/** Хранилища в node-окружении нет вовсе, поэтому подкладываем своё. Без него
 *  проверяется только резервная память вкладки — а весь смысл выбора
 *  `localStorage` в том, что запись переживает выгрузку вкладки. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem:    (k: string) => map.get(k) ?? null,
    setItem:    (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear:      () => map.clear(),
    key:        (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as unknown as Storage;
}

/** Чтение с цепи по сценарию: отдаёт значения по списку, последнее — навсегда.
 *  `null` в списке означает сбой пробы. */
function reader(values: (bigint | null)[]) {
  let i = 0;
  const calls: number[] = [];
  const read = async () => {
    const v = values[Math.min(i, values.length - 1)];
    calls.push(i);
    i++;
    if (v === null) throw new Error('RPC hiccup');
    return v;
  };
  return { read, get count() { return calls.length; } };
}

/** Опрос без настоящих таймеров: считаем сны, но не спим. */
function fakeSleep() {
  const slept: number[] = [];
  return { sleep: async (ms: number) => { slept.push(ms); }, slept };
}

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('память о nonce форвардера', () => {
  it('первая транзакция кошелька не ждёт ничего', async () => {
    // Ничего этим адресом ещё не отправляли — ноль законное значение, и
    // выжидать шесть секунд на первом же действии человека это чистый вред.
    const a = addr();
    const r = reader([0n]);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a, FWD, r.read, { sleep: s.sleep })).toBe(0n);
    expect(r.count).toBe(1);
    expect(s.slept).toEqual([]);
  });

  it('вторая транзакция ждёт, пока счётчик не сдвинется', async () => {
    // Ровно живой случай арбитра: commit израсходовал 0, claim читает заново и
    // получает всё ещё 0 с отставшей реплики. Подписать с 0 второй раз — это
    // «MinimalForwarder: nonce mismatch» и неработающая кнопка.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 0n);
    const r = reader([0n, 0n, 0n, 1n]);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a, FWD, r.read, { sleep: s.sleep, intervalMs: 750 })).toBe(1n);
    expect(r.count).toBe(4);
    expect(s.slept).toEqual([750, 750, 750]);
  });

  it('исчерпание попыток пишет в журнал и отдаёт прочитанное', async () => {
    // Транзакция могла не долететь до цепи вовсе — тогда счётчик не сдвинется
    // никогда. Молча висеть здесь нельзя: внятный отказ контракта человек
    // увидит и повторит, а вечная «крутилка» выглядит как сломанный сайт.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 3n);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = reader([3n]);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a, FWD, r.read, { sleep: s.sleep, attempts: 4 })).toBe(3n);
    expect(r.count).toBe(4);          // первое чтение + три повтора
    expect(s.slept).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('сбой одной пробы не роняет путь', async () => {
    // Моргнувшая сеть на середине опроса не должна отменять действие человека:
    // следующая проба может увидеть уже сдвинувшийся счётчик.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 0n);
    const r = reader([0n, null, 1n]);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a, FWD, r.read, { sleep: s.sleep })).toBe(1n);
  });

  it('сбой первого чтения пробрасывается наружу', async () => {
    // Без nonce подписывать нечего — это как было до починки, так и осталось.
    const a = addr();
    const r = reader([null]);
    await expect(awaitFreshForwarderNonce(a, FWD, r.read, { sleep: fakeSleep().sleep }))
      .rejects.toThrow('RPC hiccup');
  });

  it('счётчик помнится по паре кошелёк+форвардер', async () => {
    // У legacy-агриментов свой форвардер со своим независимым счётчиком: общая
    // запись на два форвардера сравнивала бы несравнимое.
    const a = addr();
    const other = `0x${'ab'.repeat(20)}`;
    rememberSpentForwarderNonce(a, FWD, 7n);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a, other, reader([0n]).read, { sleep: s.sleep })).toBe(0n);
    expect(s.slept).toEqual([]);
  });

  it('протухшая запись не заставляет ждать', async () => {
    // nonce запоминается в момент отправки, до того как известен исход. Если та
    // отправка не долетела, без срока годности КАЖДОЕ будущее действие этого
    // кошелька выжидало бы потолок впустую — во всех следующих сессиях.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 4n);
    const s = fakeSleep();

    const nonce = await awaitFreshForwarderNonce(a, FWD, reader([4n]).read, {
      sleep: s.sleep,
      now: () => Date.now() + 6 * 60_000,   // запись шестиминутной давности
    });
    expect(nonce).toBe(4n);
    expect(s.slept).toEqual([]);
  });

  it('запись двигается только вверх', async () => {
    // Соседняя вкладка могла потратить больший nonce; затереть её запись
    // меньшим значением — снова открыть ту же гонку.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 5n);
    rememberSpentForwarderNonce(a, FWD, 2n);
    const s = fakeSleep();

    // 3 > 2, но 5 уже потрачен — значит читаем протухшее и обязаны ждать.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await awaitFreshForwarderNonce(a, FWD, reader([3n]).read, { sleep: s.sleep, attempts: 2 });
    expect(s.slept).toHaveLength(1);
  });

  it('повтор того же nonce не освежает срок годности', async () => {
    // Застрявший nonce (подпись ушла, но до цепи не долетела) переподписывается
    // на каждой повторной попытке. Если бы каждая такая отправка обновляла
    // отметку времени, запись не протухала бы никогда — и кошелёк выжидал бы
    // потолок вечно, ровно в том случае, ради которого срок годности заведён.
    const a = addr();
    const t0 = Date.now();
    // Обе отправки обязаны попасть в РАЗНЫЕ моменты времени, иначе тест не
    // отличает «не обновили отметку» от «обновили на ту же миллисекунду».
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    rememberSpentForwarderNonce(a, FWD, 1n);
    vi.setSystemTime(t0 + 4 * 60_000);
    rememberSpentForwarderNonce(a, FWD, 1n);   // «ещё одна попытка тем же nonce»
    vi.useRealTimers();
    const s = fakeSleep();

    const nonce = await awaitFreshForwarderNonce(a, FWD, reader([1n]).read, {
      sleep: s.sleep,
      now: () => t0 + 6 * 60_000,   // шесть минут от ПЕРВОЙ отправки
    });
    expect(nonce).toBe(1n);
    expect(s.slept).toEqual([]);
  });

  it('адрес нечувствителен к регистру', async () => {
    // viem отдаёт checksum-адрес, наши собственные вызовы — lowercase. Без
    // нормализации это две независимые записи, то есть защиты нет.
    const a = `0x${'cD'.repeat(20)}`;
    rememberSpentForwarderNonce(a.toUpperCase().replace('0X', '0x'), FWD.toUpperCase().replace('0X', '0x'), 1n);
    const s = fakeSleep();

    expect(await awaitFreshForwarderNonce(a.toLowerCase(), FWD.toLowerCase(), reader([1n, 2n]).read, { sleep: s.sleep }))
      .toBe(2n);
    expect(s.slept).toHaveLength(1);
  });

  it('память переживает выгрузку вкладки', async () => {
    // Android выгружает вкладку посреди подписи — подтверждённый баг этого
    // проекта. Память модуля при этом исчезает целиком, и защита пропадала бы
    // ровно там, где нужнее всего: на втором шаге двухшагового действия,
    // которое человек продолжает после возврата.
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
    const a = addr();

    const before = await import('./walletLock');
    before.rememberSpentForwarderNonce(a, FWD, 0n);

    // Свежий экземпляр модуля = вкладка перезагрузилась: Map внутри пустая.
    vi.resetModules();
    const after = await import('./walletLock');

    const s = fakeSleep();
    const nonce = await after.awaitFreshForwarderNonce(a, FWD, reader([0n, 1n]).read, { sleep: s.sleep });
    expect(nonce).toBe(1n);
    expect(s.slept).toHaveLength(1);   // запись пережила перезагрузку — ждали
  });

  it('без localStorage защита остаётся в пределах вкладки', async () => {
    // Приватный режим, iframe, отключённое хранилище — не повод потерять
    // защиту совсем.
    const a = addr();
    rememberSpentForwarderNonce(a, FWD, 0n);
    expect((globalThis as { localStorage?: Storage }).localStorage).toBeUndefined();

    const s = fakeSleep();
    expect(await awaitFreshForwarderNonce(a, FWD, reader([0n, 1n]).read, { sleep: s.sleep })).toBe(1n);
    expect(s.slept).toHaveLength(1);
  });
});
