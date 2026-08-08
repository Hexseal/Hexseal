/**
 * chatTransportCursor.test.ts — курсор опроса и отмена в полёте.
 *
 * Задача 6 плана «Клиент чата», места 1 и 2 из четырёх, на которые план
 * наступит:
 *
 *  1. `pollBags` фиксирует точку отсчёта при создании — на каждом тике
 *     потребитель получает ВЕСЬ ящик заново. При активной переписке это и
 *     есть модель нагрузки: разговор на тысячу сообщений означает тысячу
 *     сводок каждые пять секунд, каждому участнику.
 *  2. `AbortSignal` есть у `listBags` и отсутствует у `fetchBag`/`putBag` —
 *     уход со страницы отменяет перечисление и не отменяет ни одного
 *     скачивания.
 *
 * ⚠️ ОТДЕЛЬНЫЙ ФАЙЛ от `chatTransport.test.ts` намеренно: тот держит 60+
 * замков предыдущей задачи, и правило проекта («массовый вырез при переносе
 * тестов удалил два теста и снял замок, оставив всё зелёным») велит не
 * трогать чужой большой файл ради своих новых свойств. Здесь только новое.
 *
 * Ответы сервера — НАСТОЯЩИЕ `Response`, не объектные подделки: правило
 * плана, куплено находкой, где 650 зелёных тестов означали полностью
 * нерабочий вход. Плюс один замок на НАСТОЯЩЕМ релеере (стенд Задачи 1) —
 * семантика `since` на сервере нестрогая (`>=`, relayer/app.js), и клиент,
 * посчитавший её строгой, терял бы мешки молча; подделка такого не покажет,
 * если подделку писал тот же человек, что и клиент.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pollBags, fetchBag, putBag, listBags,
  DEFAULT_BAG_POLL_INTERVALS,
  _resetBagPassCacheForTest,
  type BagSummary, type ListBagsResult, type BagPollHandle,
} from './chatTransport';
import { startChatStand } from './__stand__/chatStand';

const BOB = '0xb0b1000000000000000000000000000000005eed' as const;

beforeEach(() => {
  vi.restoreAllMocks();
  // ⚠️ `restoreAllMocks()` НЕ снимает `stubGlobal` — это разные механизмы, и
  // подделанный `fetch` пережил бы конец своего теста. Замерено здесь же:
  // без этой строки замок на живом релеере (последний в файле) висел 30
  // секунд и падал по таймауту, потому что настоящие запросы к стенду
  // уходили в подделку предыдущего теста. Ровно тот класс, от которого
  // `_resetBagPassCacheForTest` стоит строкой ниже — состояние уровня
  // процесса протекает в соседний тест.
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
});

/* ─────────────────────────── поддельный склад ──────────────────────────── */

interface FakeBag { key: string; sender: `0x${string}`; size: number; uploadedAt: number }

/**
 * Отвечает на `GET /bags` РОВНО той же семантикой `since`, что настоящий
 * сервер: НЕСТРОГОЕ `>=` (relayer/app.js, И-3 — «два мешка в одну
 * миллисекунду это настоящая гонка, а не теоретическая»). Записанное здесь
 * `>=` — не догадка: то же самое проверяется на живом релеере последним
 * замком этого файла.
 */
function fakeStore(bags: FakeBag[]) {
  const seenSince: (number | null)[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const raw = u.searchParams.get('since');
    const since = raw === null ? null : Number(raw);
    seenSince.push(since);
    const inbox = since === null ? bags : bags.filter(b => b.uploadedAt >= since);
    void init;
    return new Response(JSON.stringify({ inbox, sent: [], peers: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchMock, seenSince };
}

/** Прогоняет ровно `ticks` тиков и останавливает опрос. */
function runTicks(ticks: number, opts: Partial<Parameters<typeof pollBags>[0]> = {}) {
  const delivered: ListBagsResult[] = [];
  const slept: number[] = [];
  let handle!: BagPollHandle;
  let resolveDone!: () => void;
  const done = new Promise<void>(r => { resolveDone = r; });
  const sleep = async (ms: number) => {
    slept.push(ms);
    if (slept.length >= ticks) { handle.stop(); resolveDone(); }
  };
  handle = pollBags({
    getPass: () => 'v1.p',
    isActive: () => true,
    onBags: (r) => { delivered.push(r); },
    sleep,
    ...opts,
  });
  return { done, delivered, slept, stop: () => handle.stop() };
}

/* ───────────────────────────── курсор опроса ───────────────────────────── */

describe('курсор опроса двигается за последним полученным', () => {
  it('замер: первый тик — 3 мешка, второй — 0; сегодня было бы 3 и 3', async () => {
    // Что красит: пока `pollBags` шлёт неподвижный `opts.since`, второй
    // ответ содержит те же три мешка, и замер даёт [3, 3].
    const { fetchMock, seenSince } = fakeStore([
      { key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 },
      { key: 'b/2', sender: BOB, size: 10, uploadedAt: 1500 },
      { key: 'b/3', sender: BOB, size: 10, uploadedAt: 2000 },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const run = runTicks(2);
    await run.done;

    expect(run.delivered.map(r => r.inbox.length)).toEqual([3, 0]);
    // И курсор реально уехал в запрос, а не только в память клиента.
    expect(seenSince).toEqual([null, 2000]);
  });

  it('первый тик идёт БЕЗ since — весь ящик, а не «с этого момента»', async () => {
    // Что красит: инициализация курсора нулём (`?since=0` — лишний параметр
    // в каждом запросе) или текущим временем (переписка «исчезла»: всё, что
    // пришло до открытия вкладки, не показывается никогда).
    const { fetchMock, seenSince } = fakeStore([
      { key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const run = runTicks(1);
    await run.done;

    expect(seenSince[0]).toBeNull();
    expect(run.delivered[0].inbox).toHaveLength(1);
  });

  it('мешок, пришедший В ТУ ЖЕ миллисекунду, что и последний виденный, не теряется и не задваивается', async () => {
    // Граница, ровно на числе. Сервер отдаёт `>= since` (нестрого), значит
    // на втором тике приезжает И уже виденный `b/2`, И новый `b/3` с тем же
    // штампом. Клиент обязан отдать наверх РОВНО один — новый.
    //
    // Что красит с двух сторон:
    //  - строгий курсор (`since = max + 1`) — второй тик отдаёт 0, мешок
    //    потерян НАВСЕГДА: его `uploadedAt` уже никогда не станет больше;
    //  - отсутствие дедупа на границе — второй тик отдаёт 2, и человек
    //    видит своё же сообщение дважды.
    const bags: FakeBag[] = [
      { key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 },
      { key: 'b/2', sender: BOB, size: 10, uploadedAt: 2000 },
    ];
    const { fetchMock, seenSince } = fakeStore(bags);
    vi.stubGlobal('fetch', fetchMock);

    const delivered: ListBagsResult[] = [];
    const slept: number[] = [];
    let handle!: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 1) bags.push({ key: 'b/3', sender: BOB, size: 10, uploadedAt: 2000 });
      if (slept.length >= 2) { handle.stop(); resolveDone(); }
    };
    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: (r) => { delivered.push(r); }, sleep,
    });
    await done;

    expect(seenSince).toEqual([null, 2000]);
    expect(delivered.map(r => r.inbox.length)).toEqual([2, 1]);
    expect(delivered[1].inbox[0].key).toBe('b/3');
  });

  it('дедуп на границе не копится: ключ, ушедший ниже курсора, из памяти выбрасывается', async () => {
    // Иначе разговор на тысячу сообщений держал бы тысячу ключей навсегда —
    // своя починка хуже исходного дефекта (вопрос «долбят нарочно»).
    // Замер косвенный, но однозначный: после того как курсор ушёл вперёд,
    // старый ключ, вернувшийся из-за отката времени сервера, снова считается
    // новым — то есть его в памяти границы больше нет.
    const bags: FakeBag[] = [{ key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 }];
    const { fetchMock } = fakeStore(bags);
    vi.stubGlobal('fetch', fetchMock);

    const delivered: ListBagsResult[] = [];
    const slept: number[] = [];
    let handle!: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 1) bags.push({ key: 'b/2', sender: BOB, size: 10, uploadedAt: 3000 });
      if (slept.length === 2) bags.push({ key: 'b/1-again', sender: BOB, size: 10, uploadedAt: 3000 });
      if (slept.length >= 3) { handle.stop(); resolveDone(); }
    };
    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: (r) => { delivered.push(r); }, sleep,
    });
    await done;

    // тик 1: b/1 (граница 1000) · тик 2: b/2 (граница уехала на 3000, b/1
    // забыт) · тик 3: b/1-again на той же границе 3000, b/2 отсеян как виденный.
    expect(delivered.map(r => r.inbox.map(b => b.key))).toEqual([['b/1'], ['b/2'], ['b/1-again']]);
  });

  it('начальная точка отсчёта из опций уважается ровно на первом тике, дальше курсор ведёт себя сам', async () => {
    const { fetchMock, seenSince } = fakeStore([
      { key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 },
      { key: 'b/2', sender: BOB, size: 10, uploadedAt: 4000 },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const run = runTicks(2, { since: 2000 });
    await run.done;

    expect(seenSince).toEqual([2000, 4000]);
    expect(run.delivered.map(r => r.inbox.length)).toEqual([1, 0]);
  });

  it('ПУСТОЙ ответ курсор НЕ двигает и НЕ откатывает', async () => {
    // Что красит: курсор, посчитанный как `Math.max(...[])` — это
    // `-Infinity`, и `?since=-Infinity` уходит на сервер строкой «-Infinity»,
    // которую он отвергает как негодную (`invalid_since`); либо сброшенный в
    // undefined — весь ящик приезжал бы заново после каждой паузы.
    //
    // ⚠️ Разговор начинается ПУСТЫМ намеренно. Первая версия этого теста
    // называлась так же, но пустого ответа не видела НИ РАЗУ: сервер отдаёт
    // `>= since` нестрого, поэтому склад с одним мешком возвращает его на
    // каждом тике, и «пустой» ответ в тесте был непустым. Мутация «убрать
    // защиту от пустого массива» проходила его зелёным. Ровно тот класс, что
    // в этом проекте уже ловили — тест НАЗЫВАЛСЯ «на оба слота», а накрывал
    // первый.
    const bags: FakeBag[] = [];
    const { fetchMock, seenSince } = fakeStore(bags);
    vi.stubGlobal('fetch', fetchMock);

    const delivered: ListBagsResult[] = [];
    const slept: number[] = [];
    let handle!: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 2) bags.push({ key: 'b/1', sender: BOB, size: 10, uploadedAt: 3000 });
      if (slept.length >= 4) { handle.stop(); resolveDone(); }
    };
    handle = pollBags({
      getPass: () => 'v1.p', isActive: () => true,
      onBags: (r) => { delivered.push(r); }, sleep,
    });
    await done;

    // Два пустых тика подряд — курсор всё ещё «нет курсора», запрос идёт без
    // since. Третий приносит мешок, четвёртый уже спрашивает от него.
    expect(seenSince).toEqual([null, null, null, 3000]);
    expect(delivered.map(r => r.inbox.length)).toEqual([0, 0, 1, 0]);
    // И ни один тик не был ошибкой: базовый интервал, без отступления.
    expect(slept).toEqual([5_000, 5_000, 5_000, 5_000]);
  });
});

/* ────────────────── форма настроек, сверенная с хуком ──────────────────── */

describe('onBags отдаёт весь ответ склада, а не одну треть', () => {
  it('замер: у потребителя на руках inbox, sent и peers одним тиком', async () => {
    // Что красит: сегодня `pollBags` отдаёт наверх ГОЛЫЙ массив inbox, а
    // `sent`/`peers` из того же ответа молча выбрасывает — галочка «дошло» и
    // список собеседников требовали бы второго запроса, которого нет.
    const body = {
      inbox: [{ key: 'b/1', sender: BOB, size: 10, uploadedAt: 1000 }],
      sent: [{ key: 'a/1', recipient: BOB, uploadedAt: 900, fetched: true }],
      peers: [{ address: BOB, lastActivityWithMeAt: 60_000 }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const run = runTicks(1);
    await run.done;

    const got = run.delivered[0];
    expect(got.inbox).toHaveLength(1);
    expect(got.sent).toEqual([{ key: 'a/1', recipient: BOB, uploadedAt: 900, fetched: true }]);
    expect(got.peers).toEqual([{ address: BOB, lastActivityWithMeAt: 60_000 }]);
  });
});

describe('боевые умолчания опроса, без подстановки своих чисел', () => {
  it('замер: 5000 мс при открытом чате, 30000 мс в фоне — и это те же числа, что в решении владельца', async () => {
    // ⚠️ `intervals` НЕ передаётся: правка ограничителя однажды прошла ревью
    // зелёной и не изменила ничего, потому что тесты подставляли свои
    // значения. Числа записаны руками, а не взяты из проверяемого модуля.
    expect(DEFAULT_BAG_POLL_INTERVALS.activeMs).toBe(5_000);
    expect(DEFAULT_BAG_POLL_INTERVALS.backgroundMs).toBe(30_000);

    const { fetchMock } = fakeStore([]);
    vi.stubGlobal('fetch', fetchMock);

    let active = true;
    const slept: number[] = [];
    let handle!: BagPollHandle;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const sleep = async (ms: number) => {
      slept.push(ms);
      if (slept.length === 1) active = false;
      if (slept.length >= 2) { handle.stop(); resolveDone(); }
    };
    handle = pollBags({ getPass: () => 'v1.p', isActive: () => active, onBags: () => {}, sleep });
    await done;

    expect(slept).toEqual([5_000, 30_000]);
  });
});

/* ──────────────────────── отмена: не только список ─────────────────────── */

describe('отмена касается скачивания и выкладывания, а не только перечисления', () => {
  it('fetchBag принимает AbortSignal и прерывается на нём', async () => {
    const ctrl = new AbortController();
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
      });
    }));

    const p = fetchBag('v1.p', 'b0b/1.bin', ctrl.signal);
    await Promise.resolve();
    expect(captured).toBe(ctrl.signal);

    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('putBag принимает AbortSignal и прерывается на нём', async () => {
    const ctrl = new AbortController();
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
      });
    }));

    const p = putBag('v1.p', BOB, new Uint8Array([1, 2, 3]), ctrl.signal);
    await Promise.resolve();
    expect(captured).toBe(ctrl.signal);

    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('замер: три запроса в полёте (список, скачивание, выкладывание) — после отмены незавершённых ноль', async () => {
    // Свойство 3 задачи, на уровне транспорта. Считаем ЧЕСТНО: запрос
    // считается незавершённым, пока его промис не разрешился и его сигнал не
    // получил `abort`. Сегодня два из трёх остались бы висеть — сигнала у них
    // нет вовсе.
    const ctrl = new AbortController();
    const inFlight = new Set<number>();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
      const id = ++n;
      inFlight.add(id);
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          inFlight.delete(id);
          rej(new DOMException('Aborted', 'AbortError'));
        });
      });
    }));

    const promises = [
      listBags('v1.p', undefined, ctrl.signal),
      fetchBag('v1.p', 'b0b/1.bin', ctrl.signal),
      putBag('v1.p', BOB, new Uint8Array([1]), ctrl.signal),
    ].map(p => p.catch(() => {}));

    await Promise.resolve();
    expect(inFlight.size).toBe(3);

    ctrl.abort();
    await Promise.all(promises);
    expect(inFlight.size).toBe(0);
    // Потолок больше умолчания vitest (5 с) намеренно: ДО правки два из трёх
    // промисов не разрешаются никогда, и красный приходит таймаутом — это и
    // есть точное описание дефекта («запрос висит в полёте после ухода со
    // страницы»), а не помеха замеру.
  }, 20_000);
});

/* ────────────────── тот же курсор, но на живом релеере ─────────────────── */

describe('курсор против настоящего сервера (стенд Задачи 1)', () => {
  it('замер: второй тик по настоящему складу не приносит того, что принёс первый', async () => {
    const stand = await startChatStand();
    try {
      process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
      vi.resetModules();
      const t = await import('./chatTransport');
      const [alice, bob] = stand.wallets;
      const aliceAddr = alice.address as `0x${string}`;
      const bobAddr = bob.address as `0x${string}`;

      const alicePass = await t.requestBagPass(m => alice.signMessage(m), aliceAddr);
      const bobPass = await t.requestBagPass(m => bob.signMessage(m), bobAddr);

      await t.putBag(alicePass.pass, bobAddr, new TextEncoder().encode('раз'));
      await t.putBag(alicePass.pass, bobAddr, new TextEncoder().encode('два'));

      const delivered: BagSummary[][] = [];
      const slept: number[] = [];
      let handle!: import('./chatTransport').BagPollHandle;
      let resolveDone!: () => void;
      const done = new Promise<void>(r => { resolveDone = r; });
      const sleep = async () => {
        slept.push(1);
        if (slept.length >= 3) { handle.stop(); resolveDone(); }
      };
      handle = t.pollBags({
        getPass: () => bobPass.pass, isActive: () => true,
        onBags: (r) => { delivered.push(r.inbox); }, sleep,
      });
      await done;

      // Первый тик — оба мешка, дальше ноль и ноль. Без движущегося курсора
      // это [2, 2, 2] на НАСТОЯЩЕМ сервере, а не только на подделке.
      expect(delivered.map(b => b.length)).toEqual([2, 0, 0]);
    } finally {
      await stand.stop();
      delete process.env.NEXT_PUBLIC_RELAYER_URL;
    }
    // Поднять настоящий релеер и выпустить два пропуска настоящими подписями
    // не укладывается в умолчание vitest (5 с) — это стоимость честного
    // сервера, а не медлительность замера.
  }, 30_000);
});

/* ────────── В-6: пропуск и перезагрузка страницы ────────── */

describe('пропуск склада переживает перезагрузку страницы', () => {
  // Независимая проверка, В-6: кэш пропуска жил в памяти МОДУЛЯ. Двенадцать
  // часов — срок годности самого пропуска, а не кэша. Значит окно подписи
  // приходило на КАЖДУЮ загрузку страницы и в КАЖДОЙ вкладке; докстринг при
  // этом обещал «максимум дважды в сутки». Замер ниже — обе стороны обещания.

  function fakeStorage() {
    const store = new Map<string, string>();
    return {
      store,
      api: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    };
  }

  it('ЗАМЕР: два «захода» на страницу — РОВНО одно окно подписи, а не два', async () => {
    const { api } = fakeStorage();
    vi.stubGlobal('localStorage', api);
    let signs = 0;
    const sign = async () => { signs++; return '0xsig'; };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 },
    )));

    vi.resetModules();
    const first = await import('./chatTransport');
    await first.requestBagPass(sign, '0xa1ce00000000000000000000000000000000cafe');
    expect(signs).toBe(1);

    // Перезагрузка страницы = новый экземпляр модуля, та же кладовая браузера.
    vi.resetModules();
    const second = await import('./chatTransport');
    const again = await second.requestBagPass(sign, '0xa1ce00000000000000000000000000000000cafe');

    expect(signs).toBe(1);
    expect(again.pass).toBe('v1.p');
  });

  it('истёкший пропуск из кладовой не берётся — окно будет, и это правильно', async () => {
    const { api } = fakeStorage();
    vi.stubGlobal('localStorage', api);
    let signs = 0;
    const sign = async () => { signs++; return '0xsig'; };
    // Первый ответ — уже почти истёкший (меньше запаса на дорогу).
    const responses = [
      { pass: 'v1.old', expiresAt: Math.floor(Date.now() / 1000) + 5 },
      { pass: 'v1.new', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    ];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responses[n++]), { status: 200 })));

    vi.resetModules();
    const first = await import('./chatTransport');
    await first.requestBagPass(sign, '0xa1ce00000000000000000000000000000000cafe');

    vi.resetModules();
    const second = await import('./chatTransport');
    const fresh = await second.requestBagPass(sign, '0xa1ce00000000000000000000000000000000cafe');

    expect(signs).toBe(2);
    expect(fresh.pass).toBe('v1.new');
  });

  it('401 выбрасывает пропуск и из кладовой тоже, не только из памяти', async () => {
    // Иначе мёртвый пропуск переживал бы перезагрузку — ровно та дыра (C1),
    // ради которой транспорт вообще научился выбрасывать кэш на 401, только
    // теперь она стала бы вечной.
    const { api, store } = fakeStorage();
    vi.stubGlobal('localStorage', api);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 },
    )));

    vi.resetModules();
    const t = await import('./chatTransport');
    await t.requestBagPass(async () => '0xsig', '0xa1ce00000000000000000000000000000000cafe');
    expect([...store.keys()].length).toBeGreaterThan(0);

    t.forgetBagPass('0xa1ce00000000000000000000000000000000cafe');
    expect([...store.keys()].length).toBe(0);
  });

  it('кладовой нет вовсе (серверный рендер) — работает как раньше, без падения', async () => {
    vi.stubGlobal('localStorage', undefined);
    let signs = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 },
    )));

    vi.resetModules();
    const t = await import('./chatTransport');
    const got = await t.requestBagPass(async () => { signs++; return '0xsig'; }, '0xa1ce00000000000000000000000000000000cafe');
    expect(got.pass).toBe('v1.p');
    expect(signs).toBe(1);
  });
});
