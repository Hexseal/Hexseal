/**
 * СКРЫТАЯ СТРАНИЦА МОЛЧИТ, ВОЗВРАТ ДОГОНЯЕТ — замеры числом запросов.
 *
 * ЗАЧЕМ. Слежение за цепью шло всегда, независимо от того, смотрит человек на
 * страницу или нет: 135 запросов в минуту круглые сутки с каждой открытой
 * вкладки (пункт 38). Самый дешёвый выигрыш — не опрашивать, пока не смотрят.
 * Самая дорогая ошибка при этом — потерять событие, которое случилось, пока не
 * смотрели.
 *
 * ЧТО ЗДЕСЬ СЧИТАЕТСЯ. Каждый поход к цепи учитывается по отдельности:
 * `newFilter` (взвод слежения), `getFilterChanges` (такт опроса), `blockNumber`
 * и `getLogs` (догон). Числа в утверждениях — это счётчик, а не описание.
 *
 * ⚠️ ЧЕГО НЕ ПРОВЕРЯЕТ: что сами уведомления верны — это `notifRouter.test.ts`.
 * Здесь логи прозрачные: что пришло, то и доехало до `onLogs`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runChainWatch,
  planCatchUp,
  CATCHUP_MAX_BLOCKS,
  CATCHUP_CHUNK_BLOCKS,
  type ChainWatchIO,
  type VisibilityDoc,
} from './chainWatchGate';

// ── стенд ────────────────────────────────────────────────────────────────────

/** Поддельный `document`: видимость переключается вручную. */
function fakeDoc(initial: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial,
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.delete(fn); },
  };
  return {
    doc: doc as unknown as VisibilityDoc,
    listenerCount: () => listeners.size,
    set(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const fn of [...listeners]) fn();
    },
  };
}

interface Calls { newFilter: number; getFilterChanges: number; blockNumber: number; getLogs: number }

/**
 * Поддельная цепь: считает походы и умеет отдавать логи как «живьём» (через
 * такт опроса), так и по выборке диапазона.
 */
function fakeChain(opts: { head?: bigint; failGetLogs?: boolean; failWatch?: boolean } = {}) {
  const calls: Calls = { newFilter: 0, getFilterChanges: 0, blockNumber: 0, getLogs: 0 };
  let head = opts.head ?? BigInt(1000);
  /** Логи цепи: блок → логи. */
  const chain: { block: bigint; log: unknown }[] = [];
  let live: ((logs: unknown[]) => void) | null = null;
  let liveErr: ((e: unknown) => void) | null = null;
  let pollTimer: (() => void) | null = null;

  const io: ChainWatchIO = {
    watch(onLogs, onError) {
      calls.newFilter++;
      if (opts.failWatch) { onError(new Error('узел отказал')); return () => {}; }
      live = onLogs;
      liveErr = onError;
      pollTimer = () => { calls.getFilterChanges++; };
      return () => { live = null; liveErr = null; pollTimer = null; };
    },
    async blockNumber() { calls.blockNumber++; return head; },
    async getLogs(from, to) {
      calls.getLogs++;
      if (opts.failGetLogs) throw new Error('узел отказал на выборке');
      return chain.filter((e) => e.block >= from && e.block <= to).map((e) => e.log);
    },
  };

  return {
    io, calls,
    /** Прошло `n` тактов опроса живого слежения. */
    tick(n = 1) { for (let i = 0; i < n; i++) pollTimer?.(); },
    /** Старый лог в истории — голову НЕ двигает (иначе цепь «откатывается назад»). */
    seed(log: unknown, block: bigint) { chain.push({ block, log }); },
    /** Событие случилось в цепи. Живое слежение узнаёт о нём, если взведено. */
    emit(log: unknown, block?: bigint) {
      head = block ?? head + BigInt(1);
      chain.push({ block: head, log });
      if (live) { calls.getFilterChanges++; live([{ ...(log as object), blockNumber: head }]); }
    },
    /** Блоки прошли, событий не было. */
    advance(n: bigint) { head += n; },
    head: () => head,
    breakNode() { liveErr?.(new Error('узел отказал')); },
  };
}

/** Курсор в памяти — заменитель localStorage. */
function memCursor(initial: bigint | null = null) {
  let v = initial;
  return { read: () => v, write: (b: bigint) => { v = b; }, peek: () => v };
}

// ── planCatchUp: чистая арифметика диапазона ─────────────────────────────────

describe('planCatchUp — какой диапазон догонять и сколькими запросами', () => {
  it('курсора нет (первый запуск) → догонять нечего, историей не заливаем', () => {
    expect(planCatchUp(null, BigInt(1000))).toBeNull();
  });

  it('голова не ушла вперёд → догонять нечего', () => {
    expect(planCatchUp(BigInt(1000), BigInt(1000))).toBeNull();
    expect(planCatchUp(BigInt(1000), BigInt(999))).toBeNull();
  });

  it('короткий разрыв → ОДИН кусок, от следующего за курсором до головы', () => {
    const plan = planCatchUp(BigInt(1000), BigInt(1050))!;
    expect(plan.chunks).toEqual([{ fromBlock: BigInt(1001), toBlock: BigInt(1050) }]);
    expect(plan.truncated).toBe(false);
  });

  it('разрыв длиннее одного запроса → НЕСКОЛЬКО кусков, без дыр и без нахлёста', () => {
    // Провайдеры ограничивают диапазон `eth_getLogs`, поэтому длинный пропуск
    // добирается не одним запросом, а несколькими подряд. Раньше он просто
    // урезался — то есть вкладка, свёрнутая на ночь, теряла всё, кроме последних
    // двух часов.
    const cursor = BigInt(1000);
    const head = cursor + CATCHUP_CHUNK_BLOCKS * BigInt(3) + BigInt(7);
    const plan = planCatchUp(cursor, head)!;
    expect(plan.chunks.length).toBe(4);
    expect(plan.chunks[0].fromBlock).toBe(cursor + BigInt(1));
    expect(plan.chunks[plan.chunks.length - 1].toBlock).toBe(head);
    for (let i = 1; i < plan.chunks.length; i++) {
      expect(plan.chunks[i].fromBlock, 'между куском и предыдущим дыра или нахлёст')
        .toBe(plan.chunks[i - 1].toBlock + BigInt(1));
    }
    for (const c of plan.chunks) {
      expect(c.toBlock - c.fromBlock + BigInt(1)).toBeLessThanOrEqual(CATCHUP_CHUNK_BLOCKS);
    }
    expect(plan.truncated).toBe(false);
  });

  it('сутки отсутствия добираются целиком, и это считанное число запросов', () => {
    const head = BigInt(1_000_000);
    const dayOfBlocks = CATCHUP_MAX_BLOCKS; // ~сутки при блоке в 2 секунды
    const plan = planCatchUp(head - dayOfBlocks, head)!;
    expect(plan.truncated, 'сутки не должны урезаться').toBe(false);
    const total = plan.chunks.reduce((n, c) => n + (c.toBlock - c.fromBlock + BigInt(1)), BigInt(0));
    expect(total).toBe(dayOfBlocks);
    expect(plan.chunks.length, `запросов на сутки: ${plan.chunks.length}`).toBeLessThanOrEqual(12);
  });

  it('разрыв больше потолка → урезается, и об этом СКАЗАНО', () => {
    const head = BigInt(10_000_000);
    const plan = planCatchUp(BigInt(1), head)!;
    expect(plan.chunks[plan.chunks.length - 1].toBlock).toBe(head);
    const total = plan.chunks.reduce((n, c) => n + (c.toBlock - c.fromBlock + BigInt(1)), BigInt(0));
    expect(total).toBe(CATCHUP_MAX_BLOCKS);
    // Молча урезать значит соврать «догнали». Флаг обязан быть.
    expect(plan.truncated).toBe(true);
  });

  it('мусор вместо числа → null, а не падение', () => {
    expect(planCatchUp(BigInt(-5), BigInt(10))).toBeNull();
    // @ts-expect-error намеренно не bigint — так отдаёт сбойный узел
    expect(planCatchUp('нет', BigInt(10))).toBeNull();
    // @ts-expect-error намеренно не bigint
    expect(planCatchUp(BigInt(1), undefined)).toBeNull();
  });
});

// ── видимость ────────────────────────────────────────────────────────────────

describe('скрытая страница — сколько запросов', () => {
  it('старт на СКРЫТОЙ странице: ни одного похода к цепи', async () => {
    const v = fakeDoc('hidden');
    const c = fakeChain();
    const stop = runChainWatch({ io: c.io, cursor: memCursor(), doc: v.doc, onLogs: vi.fn() });
    await Promise.resolve();
    c.tick(100);
    expect(c.calls).toEqual({ newFilter: 0, getFilterChanges: 0, blockNumber: 0, getLogs: 0 });
    stop();
  });

  it('страницу спрятали: опрос прекращается — было столько, стало ноль', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain();
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    c.tick(10);
    const whileVisible = c.calls.getFilterChanges;
    expect(whileVisible, 'на видимой странице опрос обязан идти').toBe(10);

    v.set('hidden');
    await new Promise((r) => setTimeout(r, 0));
    const before = { ...c.calls };
    c.tick(1000);
    expect(c.calls.getFilterChanges - before.getFilterChanges,
      'скрытая страница просит у цепи').toBe(0);
    stop();
  });

  it('короткое сворачивание внутри отсрочки не стоит НИ ОДНОГО лишнего запроса', async () => {
    // Возня кошелька с фокусом (две подписи подряд) прячет вкладку дважды за
    // секунды. Прежняя починка на этом сгорела: защита сама воспроизводила
    // дефект, который чинила (docs/PROCESS.md). Отсрочка снятия закрывает это
    // тем, что слежение вообще не снимается.
    const v = fakeDoc('visible');
    const c = fakeChain();
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    const after = { ...c.calls };

    for (let i = 0; i < 20; i++) { v.set('hidden'); v.set('visible'); }
    await new Promise((r) => setTimeout(r, 0));

    expect(c.calls.newFilter - after.newFilter, 'мерцание перевзвело слежение').toBe(0);
    expect(c.calls.blockNumber - after.blockNumber, 'мерцание вызвало догон').toBe(0);
    expect(c.calls.getLogs - after.getLogs, 'мерцание вызвало выборку').toBe(0);
    stop();
  });
});

// ── догон ────────────────────────────────────────────────────────────────────

describe('возврат к вкладке догоняет пропущенное', () => {
  it('событие случилось на скрытой странице — после возврата человек о нём узнал', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain({ head: BigInt(1000) });
    const seen: unknown[] = [];
    const cursor = memCursor(BigInt(1000));
    const stop = runChainWatch({
      io: c.io, cursor, doc: v.doc, hideGraceMs: 0,
      onLogs: (logs) => { seen.push(...logs); },
    });
    await new Promise((r) => setTimeout(r, 0));

    v.set('hidden');
    await new Promise((r) => setTimeout(r, 0));

    // Пока не смотрели — контрагент оплатил сделку.
    c.emit({ eventName: 'AgreementRegistered', mark: 'пропущенное' }, BigInt(1007));
    expect(seen, 'на скрытой странице событие доехать НЕ должно').toEqual([]);

    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
    expect((seen[0] as { mark: string }).mark).toBe('пропущенное');
    // Одна выборка на весь пропуск, а не по запросу на событие.
    expect(c.calls.getLogs).toBe(1);
    stop();
  });

  it('догон стоит ровно два запроса: голова + выборка', async () => {
    const v = fakeDoc('hidden');
    const c = fakeChain({ head: BigInt(1000) });
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls.blockNumber).toBe(1);
    expect(c.calls.getLogs).toBe(1);
    expect(c.calls.newFilter).toBe(1);
    stop();
  });

  it('ПЕРЕЗАПУСК посреди: курсор в хранилище, пропущенное доезжает после старта', async () => {
    const cursorStore = memCursor(null);
    const c = fakeChain({ head: BigInt(1000) });

    // Первая жизнь страницы.
    const v1 = fakeDoc('visible');
    const seen1: unknown[] = [];
    const stop1 = runChainWatch({ io: c.io, cursor: cursorStore, doc: v1.doc, hideGraceMs: 0, onLogs: (l) => seen1.push(...l) });
    await new Promise((r) => setTimeout(r, 0));
    c.emit({ eventName: 'JobApplied', mark: 'до перезапуска' }, BigInt(1002));
    expect(seen1).toHaveLength(1);
    expect(cursorStore.peek(), 'курсор обязан продвинуться по живому логу').toBe(BigInt(1002));

    stop1(); // вкладку закрыли / приложение перезапустили

    // Пока никто не смотрел — случилось событие.
    c.emit({ eventName: 'JobApplied', mark: 'во время перезапуска' }, BigInt(1005));

    // Вторая жизнь: тот же курсор из хранилища.
    const v2 = fakeDoc('visible');
    const seen2: unknown[] = [];
    const stop2 = runChainWatch({ io: c.io, cursor: cursorStore, doc: v2.doc, hideGraceMs: 0, onLogs: (l) => seen2.push(...l) });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen2.map((l) => (l as { mark: string }).mark)).toEqual(['во время перезапуска']);
    stop2();
  });

  it('ПЕРВЫЙ В ЖИЗНИ запуск не заливает колокольчик историей', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain({ head: BigInt(5000) });
    c.seed({ eventName: 'JobApplied', mark: 'древнее' }, BigInt(10));
    const seen: unknown[] = [];
    const cursor = memCursor(null);
    const stop = runChainWatch({ io: c.io, cursor, doc: v.doc, hideGraceMs: 0, onLogs: (l) => seen.push(...l) });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen, 'история за всё время не должна ехать в колокольчик').toEqual([]);
    expect(c.calls.getLogs, 'выборки быть не должно вовсе').toBe(0);
    // Но курсор обязан встать на голову — иначе следующий догон потянет всё.
    expect(cursor.peek()).toBe(BigInt(5000));
    stop();
  });

  it('очень длинный пропуск урезается потолком и СООБЩАЕТСЯ как урезанный', async () => {
    const v = fakeDoc('hidden');
    const c = fakeChain({ head: BigInt(1_000_000) });
    const onTruncated = vi.fn();
    const stop = runChainWatch({
      io: c.io, cursor: memCursor(BigInt(1)), doc: v.doc, hideGraceMs: 0,
      onLogs: vi.fn(), onTruncated,
    });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(onTruncated).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('без курсора — только заглушка видимости, без догона', () => {
  // Страница сделки уже перечитывает всё при возврате во вкладку
  // (`VisibilityRefresher` в app/providers.tsx звёт `invalidateQueries()`), и
  // второй догон там был бы двумя запросами впустую.
  it('курсор не передан → ни blockNumber, ни getLogs, но слежение идёт', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain({ head: BigInt(1000) });
    c.seed({ eventName: 'Funded' }, BigInt(999));
    const seen: unknown[] = [];
    const stop = runChainWatch({ io: c.io, doc: v.doc, hideGraceMs: 0, onLogs: (l) => seen.push(...l) });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls.newFilter, 'слежение обязано идти и без курсора').toBe(1);
    expect(c.calls.blockNumber).toBe(0);
    expect(c.calls.getLogs).toBe(0);
    expect(seen, 'без курсора история доезжать не должна').toEqual([]);
    stop();
  });

  it('без курсора скрытая страница всё равно молчит', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain();
    const stop = runChainWatch({ io: c.io, doc: v.doc, hideGraceMs: 0, onLogs: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    c.tick(5);
    expect(c.calls.getFilterChanges).toBe(5);
    v.set('hidden');
    await new Promise((r) => setTimeout(r, 0));
    c.tick(500);
    expect(c.calls.getFilterChanges, 'скрытая страница без курсора опрашивает').toBe(5);
    stop();
  });

  it('без курсора живые логи доезжают как обычно', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain();
    const seen: unknown[] = [];
    const stop = runChainWatch({ io: c.io, doc: v.doc, hideGraceMs: 0, onLogs: (l) => seen.push(...l) });
    await new Promise((r) => setTimeout(r, 0));
    c.emit({ eventName: 'Activated' });
    expect(seen).toHaveLength(1);
    stop();
  });
});

describe('длинное отсутствие добирается кусками, прогресс не теряется', () => {
  it('вкладку свернули на «ночь» — события из НАЧАЛА пропуска тоже доехали', async () => {
    const v = fakeDoc('hidden');
    const start = BigInt(100_000);
    const c = fakeChain({ head: start });
    // Пропуск в три с лишним куска; событие в самом начале — то, что раньше терялось.
    c.seed({ eventName: 'JobApplied', mark: 'в начале пропуска' }, start + BigInt(5));
    c.seed({ eventName: 'JobApplied', mark: 'в конце пропуска' }, start + CATCHUP_CHUNK_BLOCKS * BigInt(3));
    c.advance(CATCHUP_CHUNK_BLOCKS * BigInt(3) + BigInt(10));

    const seen: unknown[] = [];
    const cursor = memCursor(start);
    const stop = runChainWatch({ io: c.io, cursor, doc: v.doc, hideGraceMs: 0, onLogs: (l) => seen.push(...l) });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));

    expect(seen.map((l) => (l as { mark: string }).mark).sort())
      .toEqual(['в конце пропуска', 'в начале пропуска']);
    expect(c.calls.getLogs, `запросов на догон: ${c.calls.getLogs}`).toBe(4);
    expect(cursor.peek()).toBe(c.head());
    stop();
  });

  it('узел отказал на ТРЕТЬЕМ куске: прогресс двух первых сохранён', async () => {
    const v = fakeDoc('hidden');
    const start = BigInt(200_000);
    let calls = 0;
    const ranges: [bigint, bigint][] = [];
    const io: ChainWatchIO = {
      watch: () => () => {},
      blockNumber: async () => start + CATCHUP_CHUNK_BLOCKS * BigInt(4),
      getLogs: async (from, to) => {
        calls++;
        ranges.push([from, to]);
        if (calls === 3) throw new Error('узел отказал на третьем куске');
        return [];
      },
    };
    const cursor = memCursor(start);
    const onError = vi.fn();
    const stop = runChainWatch({ io, cursor, doc: v.doc, hideGraceMs: 0, onLogs: vi.fn(), onError });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalled();
    expect(calls, 'после отказа догон обязан остановиться, а не долбить дальше').toBe(3);
    // Курсор стоит на конце ВТОРОГО куска: два первых добраны, и заново их
    // тянуть не надо; третий добёрётся следующей попыткой.
    expect(cursor.peek()).toBe(ranges[1][1]);
    stop();
  });
});

// ── обстоятельства ───────────────────────────────────────────────────────────

describe('обстоятельства', () => {
  it('УЗЕЛ ОТКАЗАЛ на догоне: курсор НЕ продвигается, следующий раз добирает тот же пропуск', async () => {
    const cursor = memCursor(BigInt(900));
    const bad = fakeChain({ head: BigInt(1000), failGetLogs: true });
    const v = fakeDoc('hidden');
    const onError = vi.fn();
    const stop = runChainWatch({ io: bad.io, cursor, doc: v.doc, hideGraceMs: 0, onLogs: vi.fn(), onError });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));

    expect(onError, 'отказ узла обязан быть заявлен, а не съеден').toHaveBeenCalled();
    expect(cursor.peek(), 'курсор продвинулся на неудавшемся догоне — пропуск потерян навсегда')
      .toBe(BigInt(900));
    // И живое слежение всё равно взведено: отказ выборки не обязан глушить всё.
    expect(bad.calls.newFilter).toBe(1);
    stop();
  });

  it('УЗЕЛ ОТКАЗАЛ на слежении: сказано, а не молча', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain({ failWatch: true });
    const onError = vi.fn();
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, hideGraceMs: 0, onLogs: vi.fn(), onError });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][1]).toBe('watch');
    stop();
  });

  it('МУСОР из цепи вместо логов: вердикт, а не падение', async () => {
    const v = fakeDoc('hidden');
    const io: ChainWatchIO = {
      watch: () => () => {},
      blockNumber: async () => BigInt(1000),
      // @ts-expect-error узел отдал не массив — так бывает у сбойного прокси
      getLogs: async () => ({ вовсе: 'не массив' }),
    };
    const seen: unknown[] = [];
    const onError = vi.fn();
    const cursor = memCursor(BigInt(900));
    const stop = runChainWatch({ io, cursor, doc: v.doc, hideGraceMs: 0, onLogs: (l) => seen.push(...l), onError });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
    // ⚠️ Главное здесь не «не упало», а что мусор НЕ выдан за успешный догон.
    // Замерено мутацией: без проверки на массив утверждение «seen пусто»
    // оставалось зелёным, потому что `undefined.length > 0` тоже ложь, — а курсор
    // при этом уезжал на голову и пропуск терялся навсегда.
    expect(onError, 'мусор из узла съеден молча').toHaveBeenCalled();
    expect(cursor.peek(), 'курсор уехал на мусорном ответе — пропуск потерян').toBe(BigInt(900));
    stop();
  });

  it('ЧЕЛОВЕК БРОСИЛ НА СЕРЕДИНЕ: снятие убирает и слушателя видимости, и слежение', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain();
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(v.listenerCount()).toBe(1);
    stop();
    await new Promise((r) => setTimeout(r, 0));
    const before = { ...c.calls };
    c.tick(100);
    v.set('visible');
    await new Promise((r) => setTimeout(r, 0));
    expect(v.listenerCount(), 'слушатель видимости пережил снятие').toBe(0);
    expect(c.calls, 'после снятия к цепи ходить не должны').toEqual(before);
  });

  it('ДОЛБЯТ НАРОЧНО: сто переключений видимости не дают сотни догонов', async () => {
    const v = fakeDoc('visible');
    const c = fakeChain({ head: BigInt(1000) });
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    const base = { ...c.calls };
    for (let i = 0; i < 100; i++) { v.set('hidden'); v.set('visible'); }
    await new Promise((r) => setTimeout(r, 0));
    const spent = (c.calls.blockNumber - base.blockNumber) + (c.calls.getLogs - base.getLogs) + (c.calls.newFilter - base.newFilter);
    expect(spent, `сто переключений стоили ${spent} запросов`).toBe(0);
    stop();
  });

  it('два догона разом не наслаиваются: второй ждёт первого', async () => {
    const v = fakeDoc('hidden');
    const c = fakeChain({ head: BigInt(1000) });
    const stop = runChainWatch({ io: c.io, cursor: memCursor(BigInt(900)), doc: v.doc, onLogs: vi.fn(), hideGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    v.set('visible'); v.set('hidden'); v.set('visible');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Ровно один: `<= 2` было зелёным и при снятом замке (замерено мутацией).
    expect(c.calls.getLogs, 'догон запустился дважды параллельно').toBe(1);
    stop();
  });
});
