import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { decodeEventLog, pad, toEventSelector, type Abi, type AbiEvent } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import type { ChainWatchIO, VisibilityDoc } from './chainWatchGate';
import { NOTIF_POLL_MS } from './notifEvents';
import { ZERO_KEY, toBoxKey } from './arbiterChatKey';
import { arbiterBoxKeyBytes } from './presentation';
import {
  ARBITER_CHANGE_EVENTS,
  ARBITER_CHANGE_EVENT_NAMES,
  MISSING_ARBITER_CHANGE_EVENTS,
  ZERO_ADDRESS,
  arbiterChangeWatchIO,
  comparePresentedWith,
  disputeArbiterOf,
  readDisputeArbiterKey,
  routeArbiterChangeLogs,
  watchDisputeArbiter,
  type DisputeArbiterKey,
  type PresentedTo,
} from './disputeArbiter';

const DEAL  = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as Address;
const OTHER = '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as Address;
const ARB_A = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as Address;
const ARB_B = '0x4C3E4AFd5707Aee625F01B0042D8dA9dd1Ac689C' as Address;
const BOX_A = ('0x' + 'aa'.repeat(32)) as Hex;
const BOX_B = ('0x' + 'bb'.repeat(32)) as Hex;
const SIGN_A = ('0x' + '11'.repeat(32)) as Hex;

interface Stand {
  claimer?: Address;
  verdict?: { arbiter: Address; submittedAt: bigint };
  keys?: Record<string, [Hex, Hex]>;
  registered?: Record<string, boolean>;
  fail?: Set<string>;
}

function fakeChain(stand: Stand) {
  const asked: string[] = [];
  const client = {
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      asked.push(functionName);
      if (stand.fail?.has(functionName)) throw new Error(`узел отказал: ${functionName}`);
      const who = String(args?.[0] ?? '').toLowerCase();
      switch (functionName) {
        case 'getDisputeClaimer':  return stand.claimer ?? ZERO_ADDRESS;
        case 'getPendingVerdict':  return stand.verdict
          ?? { arbiter: ZERO_ADDRESS, submittedAt: BigInt(0) };
        case 'getArbiterChatKeys': return stand.keys?.[who] ?? [ZERO_KEY, ZERO_KEY];
        case 'isRegisteredArbiter': return stand.registered?.[who] ?? false;
        default: throw new Error(`стенд не знает ${functionName}`);
      }
    },
  } as unknown as PublicClient;
  return { client, asked };
}

const withKey = (arb: Address, box: Hex = BOX_A): Record<string, [Hex, Hex]> =>
  ({ [arb.toLowerCase()]: [box, SIGN_A] });

// ═══ кто ведёт спор сейчас ═══════════════════════════════════════════════

describe('disputeArbiterOf — то же правило, что у релеера', () => {
  it('живой заявитель — он и ведёт спор', async () => {
    const { client } = fakeChain({ claimer: ARB_A });
    expect(await disputeArbiterOf(client, DEAL)).toBe(ARB_A);
  });

  it('клейм стёрт, вердикт подан — ведёт подавший вердикт', async () => {
    // clearDisputeClaim стирает disputeClaims, но pendingVerdicts остаётся.
    // Возьми фронт только getDisputeClaimer — он сказал бы «арбитра нет» там,
    // где релеер по тому же адресу отдаёт ящик спора.
    const { client } = fakeChain({
      verdict: { arbiter: ARB_B, submittedAt: BigInt(1_760_000_000) },
    });
    expect(await disputeArbiterOf(client, DEAL)).toBe(ARB_B);
  });

  it('ни клейма, ни вердикта — null', async () => {
    const { client } = fakeChain({});
    expect(await disputeArbiterOf(client, DEAL)).toBeNull();
  });

  it('вердикт с submittedAt = 0 не считается вердиктом', async () => {
    // Нулевая структура декодируется в arbiter = 0x0 И submittedAt = 0;
    // фасет сам считает признаком «вердикта нет» именно submittedAt.
    const { client } = fakeChain({
      verdict: { arbiter: ARB_B, submittedAt: BigInt(0) },
    });
    expect(await disputeArbiterOf(client, DEAL)).toBeNull();
  });

  it('узел молчит — БРОСАЕТ, а не отдаёт null', async () => {
    // ⚠️ Самая дорогая склейка этого шва: «арбитра нет» и «мы не спросили»
    // выглядели бы с экрана одинаково.
    const { client } = fakeChain({ fail: new Set(['getDisputeClaimer']) });
    await expect(disputeArbiterOf(client, DEAL)).rejects.toThrow();
  });
});

// ═══ ключ арбитра по адресу сделки ═══════════════════════════════════════

describe('readDisputeArbiterKey — четыре разных исхода, а не один', () => {
  it('арбитр и ключ есть — ready, байты печати выведены из ключа ПЕЧАТИ', async () => {
    const { client } = fakeChain({
      claimer: ARB_A, keys: withKey(ARB_A), registered: { [ARB_A.toLowerCase()]: true },
    });
    const got = await readDisputeArbiterKey(client, DEAL);
    expect(got.state).toBe('ready');
    if (got.state !== 'ready') return;
    expect(got.arbiter).toBe(ARB_A);
    expect(got.boxKey).toBe(BOX_A);
    expect(got.registered).toBe(true);
    expect(got.boxKeyBytes).toBeInstanceOf(Uint8Array);
    expect(got.boxKeyBytes.length).toBe(32);
    // Байты сверяются с ключом ПЕЧАТИ, а не с ключом подписи: перепутать их
    // — значит запечатать нечитаемое.
    expect([...got.boxKeyBytes].every((b) => b === 0xaa)).toBe(true);
  });

  it('арбитра нет — no_arbiter, и в ответе НЕТ ни ключа, ни адреса', async () => {
    const { client } = fakeChain({});
    const got = await readDisputeArbiterKey(client, DEAL);
    expect(got).toEqual({ state: 'no_arbiter' });
    expect(Object.keys(got)).toEqual(['state']);
  });

  it('арбитр есть, ключа в цепи нет — no_key, арбитр назван', async () => {
    const { client } = fakeChain({ claimer: ARB_A, registered: { [ARB_A.toLowerCase()]: true } });
    expect(await readDisputeArbiterKey(client, DEAL))
      .toEqual({ state: 'no_key', arbiter: ARB_A, registered: true });
  });

  it('чтение не удалось — unreadable, и это НЕ «ключа нет»', async () => {
    const { client } = fakeChain({ fail: new Set(['getDisputeClaimer']) });
    const got = await readDisputeArbiterKey(client, DEAL);
    expect(got.state).toBe('unreadable');
    if (got.state !== 'unreadable') return;
    expect(String((got.error as Error)?.message)).toContain('getDisputeClaimer');
  });

  it('отказ на ключах — тоже unreadable, а не пустой ключ', async () => {
    const { client } = fakeChain({ claimer: ARB_A, fail: new Set(['getArbiterChatKeys']) });
    expect((await readDisputeArbiterKey(client, DEAL)).state).toBe('unreadable');
  });

  it('статус СНЯТ, ключ есть — всё равно ready, но registered: false', async () => {
    // ⚠️ Снятый арбитр — по-прежнему тот, кто вынесет вердикт: submitVerdict
    // гейтится клеймом, не статусом, а removeArbiter клейм не снимает.
    // Отказать здесь значило бы отнять у стороны единственный способ быть
    // услышанной тем, кто решает.
    const { client } = fakeChain({
      claimer: ARB_A, keys: withKey(ARB_A), registered: { [ARB_A.toLowerCase()]: false },
    });
    const got = await readDisputeArbiterKey(client, DEAL);
    expect(got.state).toBe('ready');
    if (got.state !== 'ready') return;
    expect(got.registered).toBe(false);
  });

  it('статус прочитать не удалось — registered: null, а не false', async () => {
    // false означало бы «мы проверили, он снят». Это разные утверждения.
    const { client } = fakeChain({
      claimer: ARB_A, keys: withKey(ARB_A), fail: new Set(['isRegisteredArbiter']),
    });
    const got = await readDisputeArbiterKey(client, DEAL);
    expect(got.state).toBe('ready');
    if (got.state !== 'ready') return;
    expect(got.registered).toBeNull();
  });

  it('статус спрашивается ОТДЕЛЬНЫМ чтением, а не выводится из ключа', async () => {
    const { client, asked } = fakeChain({
      claimer: ARB_A, keys: withKey(ARB_A), registered: { [ARB_A.toLowerCase()]: true },
    });
    await readDisputeArbiterKey(client, DEAL);
    expect(asked).toContain('isRegisteredArbiter');
    expect(asked).toContain('getArbiterChatKeys');
  });
});

// ═══ авторитетная сверка: снимок против того, кто ведёт спор сейчас ══════

describe('comparePresentedWith — отправлять ли или спрашивать согласие заново', () => {
  // ⚠️ Байты в фикстуре — НАСТОЯЩИЕ, из `arbiterBoxKeyBytes`: снимок с
  // фальшивыми байтами сделал бы зелёной сцену, в которой печатать нечем.
  const ready = (arb: Address, box: Hex): DisputeArbiterKey =>
    ({ state: 'ready', arbiter: arb, boxKey: toBoxKey(box),
       boxKeyBytes: arbiterBoxKeyBytes(toBoxKey(box)), registered: true });
  /** Снимок согласия — ДВА поля, как в договоре: адрес и ключ. */
  const presented = (arb: Address, box: Hex): PresentedTo =>
    ({ arbiter: arb, boxKey: toBoxKey(box) });

  it('снимка нет — просить нечего', () => {
    expect(comparePresentedWith(null, ready(ARB_A, BOX_A))).toBeNull();
  });

  it('тот же арбитр, тот же ключ — молчим, мешок едет', () => {
    expect(comparePresentedWith(presented(ARB_A, BOX_A), ready(ARB_A, BOX_A))).toBeNull();
  });

  it('другой арбитр — отказ arbiter_changed, а не тихая отправка другому', () => {
    expect(comparePresentedWith(presented(ARB_A, BOX_A), ready(ARB_B, BOX_B)))
      .toEqual({ reason: 'arbiter_changed', arbiter: ARB_B });
  });

  it('ТОТ ЖЕ арбитр, другой ключ — отказ key_changed', () => {
    // ⚠️ Ради этой сцены `PresentedTo` несёт boxKey, а не один адрес: арбитр
    // повернул ключ чата между согласием и нажатием «Отправить». Сверка по
    // адресу пропустила бы — мешок уехал бы на протухший ключ, склад принял
    // бы его, сторона увидела бы «положено в ящик», а арбитр — нечитаемое.
    expect(comparePresentedWith(presented(ARB_A, BOX_A), ready(ARB_A, BOX_B)))
      .toEqual({ reason: 'key_changed', arbiter: ARB_A });
  });

  it('регистр адреса и ключа — не повод дёргать человека', () => {
    // ⚠️ Цепь отдаёт адреса с контрольной суммой, снимок мог сохранить
    // нижним регистром. Строгое сравнение просило бы согласие заново на
    // каждом нажатии.
    // ⚠️ Верхний регистр — только у ТЕЛА ключа: `arbiterBoxKeyBytes` требует
    // приставку строчной (`/^0x[0-9a-fA-F]{64}$/`), и `BOX_A.toUpperCase()`
    // сломал бы её в `0X` — бросок вместо сверки.
    const UPPER = ('0x' + BOX_A.slice(2).toUpperCase()) as Hex;
    expect(comparePresentedWith(
      presented(ARB_A.toLowerCase() as Address, UPPER),
      ready(ARB_A, BOX_A),
    )).toBeNull();
  });

  it('арбитра больше нет — отдельный повод, с прежним арбитром', () => {
    expect(comparePresentedWith(presented(ARB_A, BOX_A), { state: 'no_arbiter' }))
      .toEqual({ reason: 'arbiter_left', prevArbiter: ARB_A });
  });

  it('арбитр тот же, но ключа в цепи больше нет — key_changed', () => {
    expect(comparePresentedWith(
      presented(ARB_A, BOX_A),
      { state: 'no_key', arbiter: ARB_A, registered: true },
    )).toEqual({ reason: 'key_changed', arbiter: ARB_A });
  });

  it('не смогли прочитать — молчим, а не выдумываем', () => {
    // ⚠️ НАЗВАНО ВСЛУХ: null здесь означает «просьбы нет», а не «всё в
    // порядке». Показать состояние «не смогли прочитать» обязана Задача 6 —
    // у неё на руках сам DisputeArbiterKey со state: 'unreadable'.
    expect(comparePresentedWith(
      presented(ARB_A, BOX_A),
      { state: 'unreadable', error: new Error('узел молчит') },
    )).toBeNull();
  });
});

// ═══ набор родов: вынут из боевого ABI, сверен с замком ══════════════════

/**
 * Список сторожимых родов у замка ABI написан руками ВТОРОЙ раз
 * (`arbiterEventAbiMatchesContract.test.ts`, `WATCHED`). Читаем ЕГО, а не
 * импортируем: иначе модуль сверялся бы сам с собой, и «стали следить за
 * родом, который замок не сторожит» осталось бы незамеченным.
 */
const LOCK_SRC = readFileSync(
  new URL('./arbiterEventAbiMatchesContract.test.ts', import.meta.url), 'utf8',
);

function watchedInLock(src: string): string[] {
  const m = src.match(/const WATCHED = \[([^\]]*)\] as const;/);
  if (!m) throw new Error('список WATCHED не найден в замке ABI');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('ARBITER_CHANGE_EVENTS — три рода, вынутые из боевого ABI', () => {
  it('ни один род не потерялся по дороге из ABI', () => {
    // ⚠️ Потерянный род — это не «меньше поводов», а целая беда, которую
    // перестают замечать: например, смена ключа арбитра.
    expect(MISSING_ARBITER_CHANGE_EVENTS).toEqual([]);
    expect(ARBITER_CHANGE_EVENTS).toHaveLength(3);
  });

  it('topic0 набора — те самые три, посчитанные от подписей руками', () => {
    // Подписи написаны здесь, а не взяты из записи ABI: иначе сверялись бы
    // две стороны одной и той же записи.
    const got = ARBITER_CHANGE_EVENTS.map((e) => toEventSelector(e as AbiEvent)).sort();
    expect(got).toEqual([
      toEventSelector('DisputeClaimed(address,address)'),
      toEventSelector('DisputeReleased(address,address)'),
      toEventSelector('ArbiterChatKeySet(address,bytes32,bytes32)'),
    ].sort());
  });

  it('модуль следит РОВНО за тем, что сторожит замок ABI', () => {
    expect([...ARBITER_CHANGE_EVENT_NAMES]).toEqual(watchedInLock(LOCK_SRC));
  });

  it('списка в замке нет — отказ, а не пустое совпадение', () => {
    // Без этого разборщик, промахнувшийся мимо изменённого замка, вернул бы
    // пустой список, и сверка выше зеленела бы на двух пустотах.
    expect(() => watchedInLock('const WATCHED = что-то другое;')).toThrow();
  });
});

// ═══ логи → поводы перечитать ════════════════════════════════════════════

const claimed = (agreement: string, arbiter: string): unknown =>
  ({ eventName: 'DisputeClaimed', args: { agreement, arbiter }, blockNumber: BigInt(7) });
const released = (agreement: string, prevArbiter: string): unknown =>
  ({ eventName: 'DisputeReleased', args: { agreement, prevArbiter }, blockNumber: BigInt(8) });
const keySet = (arbiter: string): unknown =>
  ({ eventName: 'ArbiterChatKeySet',
     args: { arbiter, boxKey: BOX_B, signKey: SIGN_A }, blockNumber: BigInt(9) });

describe('routeArbiterChangeLogs — повод перечитать, а не приговор', () => {
  it('заявка по нашей сделке — arbiter_changed с новым лицом', () => {
    expect(routeArbiterChangeLogs([claimed(DEAL, ARB_B)],
      { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'arbiter_changed', arbiter: ARB_B }]);
  });

  it('заявка по ЧУЖОЙ сделке — не наш повод', () => {
    // Фильтр по адресу сделки в топиках не стоит (набор родов ставит только
    // topics[0]), значит в пачку приезжают споры всей биржи. Свой отсев тут
    // не украшение: без него каждая чужая заявка стоила бы нам чтения цепи.
    expect(routeArbiterChangeLogs([claimed(OTHER, ARB_B)],
      { agreement: DEAL, presentedTo: ARB_A })).toEqual([]);
  });

  it('освобождение по нашей сделке — arbiter_left, с ПРЕЖНИМ арбитром', () => {
    expect(routeArbiterChangeLogs([released(DEAL, ARB_A)],
      { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'arbiter_left', prevArbiter: ARB_A }]);
  });

  it('поворот ключа НАШЕГО арбитра — key_changed', () => {
    expect(routeArbiterChangeLogs([keySet(ARB_A)],
      { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'key_changed', arbiter: ARB_A }]);
  });

  it('поворот ключа ЧУЖОГО арбитра — молчим', () => {
    // ⚠️ У ArbiterChatKeySet адреса сделки в логе НЕТ вовсе (индексирован по
    // арбитру), поэтому «наш ли это поворот» решается только сверкой с тем,
    // кого показали человеку.
    expect(routeArbiterChangeLogs([keySet(ARB_B)],
      { agreement: DEAL, presentedTo: ARB_A })).toEqual([]);
  });

  it('снимка ещё нет — повороты ключа отбрасываются, заявки по сделке остаются', () => {
    expect(routeArbiterChangeLogs([keySet(ARB_A), claimed(DEAL, ARB_B)],
      { agreement: DEAL, presentedTo: null }))
      .toEqual([{ reason: 'arbiter_changed', arbiter: ARB_B }]);
  });

  it('регистр адресов не мешает — цепь отдаёт с контрольной суммой', () => {
    expect(routeArbiterChangeLogs([keySet(ARB_A.toLowerCase())],
      { agreement: DEAL.toLowerCase() as Address, presentedTo: ARB_A }))
      .toEqual([{ reason: 'key_changed', arbiter: ARB_A.toLowerCase() }]);
  });

  it('мусор, чужой род и args: undefined — ни падения, ни повода', () => {
    // `strict: false` у фильтра viem: лог с неподошедшей раскладкой доезжает
    // с args: undefined. Падение здесь стоило бы всей пачки.
    expect(routeArbiterChangeLogs([
      null, undefined, 5, 'лог', [],
      { eventName: 'VerdictSubmitted', args: { agreement: DEAL } },
      { eventName: 'DisputeClaimed' },
      { eventName: 'DisputeClaimed', args: { agreement: 42 } },
      { eventName: 'ArbiterChatKeySet', args: {} },
    ] as unknown[], { agreement: DEAL, presentedTo: ARB_A })).toEqual([]);
    expect(routeArbiterChangeLogs('не массив' as unknown as unknown[],
      { agreement: DEAL, presentedTo: ARB_A })).toEqual([]);
  });

  it('пачка — все поводы, в порядке логов', () => {
    // Порядок нужен `watchDisputeArbiter`: она берёт ПОСЛЕДНИЙ, то есть
    // самый свежий. Перевернётся порядок — человеку покажут позавчерашнее.
    expect(routeArbiterChangeLogs(
      [released(DEAL, ARB_A), claimed(DEAL, ARB_B), keySet(ARB_A)],
      { agreement: DEAL, presentedTo: ARB_A },
    )).toEqual([
      { reason: 'arbiter_left', prevArbiter: ARB_A },
      { reason: 'arbiter_changed', arbiter: ARB_B },
      { reason: 'key_changed', arbiter: ARB_A },
    ]);
  });
});

// ═══ ШОВ: сырой лог с цепи → боевая запись ABI → разбор ══════════════════

/**
 * ⚠️ ЭТО ДРУГОЙ БЕРЕГ, ЧЕМ У ЗАМКА ABI. Тот сверяет два текста
 * (`contracts.ts` и `.sol`) и до разбора не доходит. Здесь лог собирается
 * ТОПИКАМИ И ДАННЫМИ, как его отдаёт узел, разбирается боевым
 * `ARBITER_REGISTRY_ABI` и только потом попадает в `routeArbiterChangeLogs`.
 * Замерено (viem 2.34): перестановка имён в записи даёт разбор, у которого
 * `args.agreement` — адрес АРБИТРА (поводов ноль); снятый `indexed` —
 * `DecodeLogDataMismatch`; подменённый тип — `AbiEventSignatureNotFoundError`.
 */
function fromChain(topics: `0x${string}`[], data: `0x${string}` = '0x'): unknown {
  const decoded = decodeEventLog({ abi: ARBITER_REGISTRY_ABI as Abi, data, topics });
  return { ...decoded, blockNumber: BigInt(11) };
}

describe('сырой лог, разобранный боевой записью ABI, доезжает до разбора', () => {
  it('DisputeClaimed: топики цепи → повод arbiter_changed', () => {
    const log = fromChain([
      toEventSelector('DisputeClaimed(address,address)'),
      pad(DEAL.toLowerCase() as `0x${string}`),
      pad(ARB_B.toLowerCase() as `0x${string}`),
    ]);
    expect(routeArbiterChangeLogs([log], { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'arbiter_changed', arbiter: ARB_B }]);
  });

  it('DisputeReleased: топики цепи → повод arbiter_left', () => {
    const log = fromChain([
      toEventSelector('DisputeReleased(address,address)'),
      pad(DEAL.toLowerCase() as `0x${string}`),
      pad(ARB_A.toLowerCase() as `0x${string}`),
    ]);
    expect(routeArbiterChangeLogs([log], { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'arbiter_left', prevArbiter: ARB_A }]);
  });

  it('ArbiterChatKeySet: топик + ДАННЫЕ цепи → повод key_changed', () => {
    // Ключи едут в данных (не индексированы) — значит разбор проверяет и
    // маску indexed: обещай запись три поля в data, и viem бросит.
    const log = fromChain(
      [toEventSelector('ArbiterChatKeySet(address,bytes32,bytes32)'),
       pad(ARB_A.toLowerCase() as `0x${string}`)],
      ('0x' + 'bb'.repeat(32) + '11'.repeat(32)) as `0x${string}`,
    );
    expect(routeArbiterChangeLogs([log], { agreement: DEAL, presentedTo: ARB_A }))
      .toEqual([{ reason: 'key_changed', arbiter: ARB_A }]);
  });
});

// ═══ слежение ════════════════════════════════════════════════════════════

/** Поддельный `document` — тот же приём, что в `chainWatchGate.test.ts:31`. */
function fakeDoc(initial: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial,
    addEventListener: (t: string, fn: () => void) => { if (t === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (t: string, fn: () => void) => { if (t === 'visibilitychange') listeners.delete(fn); },
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

/** Поддельная цепь для следящего: считает походы, отдаёт логи по требованию. */
function fakeWatchIO() {
  const calls = { watch: 0, unwatch: 0, blockNumber: 0, getLogs: 0 };
  let deliver: ((logs: unknown[]) => void) | null = null;
  let boom: ((e: unknown) => void) | null = null;
  const io: ChainWatchIO = {
    watch(onLogs, onError) {
      calls.watch++; deliver = onLogs; boom = onError;
      return () => { calls.unwatch++; deliver = null; boom = null; };
    },
    async blockNumber() { calls.blockNumber++; return BigInt(1_000); },
    async getLogs() { calls.getLogs++; return []; },
  };
  return {
    io, calls,
    emit: (logs: unknown[]) => deliver?.(logs),
    fail: (e: unknown) => boom?.(e),
    alive: () => deliver !== null,
  };
}

describe('watchDisputeArbiter — повод доезжает один раз и только наш', () => {
  it('видимая вкладка — слежение взведено, и ровно один раз', () => {
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange: vi.fn(),
    });
    expect(chain.calls.watch).toBe(1);
    stop();
  });

  it('наш лог — один onChange с поводом', () => {
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onChange = vi.fn();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange,
    });
    chain.emit([keySet(ARB_A)]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ reason: 'key_changed', arbiter: ARB_A });
    stop();
  });

  it('пачка из трёх поводов — ОДИН onChange, и с последним', () => {
    // ⚠️ ЗАМЕР ЦЕНЫ: на каждый повод Задача 6 делает свежее чтение цепи.
    // «Сигнал на лог» стоил бы три чтения подряд с одинаковым ответом.
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onChange = vi.fn();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange,
    });
    chain.emit([released(DEAL, ARB_A), claimed(DEAL, ARB_B), keySet(ARB_A)]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ reason: 'key_changed', arbiter: ARB_A });
    stop();
  });

  it('чужие логи — onChange не зовётся ни разу', () => {
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onChange = vi.fn();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange,
    });
    chain.emit([claimed(OTHER, ARB_B), keySet(ARB_B), { eventName: 'ArbiterAdded' }]);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('«кому предъявляли» спрашивается на КАЖДОЙ пачке, а не при взводе', () => {
    // ⚠️ Ради этого `presentedTo` — функция. Замкнись мы на значение момента
    // взвода, следили бы за ключом ПРЕДШЕСТВЕННИКА до перезагрузки страницы.
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onChange = vi.fn();
    let who: Address | null = null;
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => who, onChange,
    });
    chain.emit([keySet(ARB_A)]);          // снимка ещё нет — не наш повод
    expect(onChange).not.toHaveBeenCalled();
    who = ARB_A;                           // человек увидел арбитра и согласился
    chain.emit([keySet(ARB_A)]);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('снятие снимает слежение, и после него поводов больше нет', () => {
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onChange = vi.fn();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange,
    });
    stop();
    expect(chain.calls.unwatch).toBe(1);
    expect(chain.alive()).toBe(false);
    expect(doc.listenerCount()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ДОГОНА НЕТ: ни blockNumber, ни getLogs не позваны ни разу', () => {
    // ⚠️ Курсор не передаётся намеренно (см. шапку задачи). Числа здесь —
    // доказательство, что «догона нет» это про поведение, а не про намерение:
    // возврат во вкладку не стоит ни одного запроса истории.
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange: vi.fn(), hideGraceMs: 0,
    });
    doc.set('hidden');
    doc.set('visible');
    expect(chain.calls.blockNumber).toBe(0);
    expect(chain.calls.getLogs).toBe(0);
    expect(chain.calls.watch).toBe(2);     // снято и взведено заново
    stop();
  });

  it('отказ узла доезжает в onError с фазой watch, а не молчит', () => {
    const doc = fakeDoc('visible');
    const chain = fakeWatchIO();
    const onError = vi.fn();
    const stop = watchDisputeArbiter({
      io: chain.io, doc: doc.doc, agreement: DEAL,
      presentedTo: () => ARB_A, onChange: vi.fn(), onError,
    });
    chain.fail(new Error('узел отказал'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe('watch');
    stop();
  });
});

// ═══ цепь для следящего ══════════════════════════════════════════════════

describe('arbiterChangeWatchIO — один фильтр на три рода, на нашем диамонде', () => {
  function fakePublicClient() {
    const seen: Record<string, unknown> = {};
    const client = {
      watchEvent(args: Record<string, unknown>) { seen.watch = args; return () => { seen.unwatched = true; }; },
      async getLogs(args: Record<string, unknown>) { seen.getLogs = args; return [claimed(DEAL, ARB_A)]; },
      async getBlockNumber() { return BigInt(44_700_000); },
    } as unknown as PublicClient;
    return { client, seen };
  }

  it('фильтр ставится на диамонд, тремя родами, с тактом извещений', () => {
    const { client, seen } = fakePublicClient();
    const io = arbiterChangeWatchIO(client);
    const off = io.watch(() => {}, () => {});
    const args = seen.watch as { address: string; events: unknown[]; pollingInterval: number };
    expect(args.address).toBe(CONTRACTS.diamond);
    expect(args.events).toHaveLength(3);
    expect(args.pollingInterval).toBe(NOTIF_POLL_MS);
    off();
    expect(seen.unwatched).toBe(true);
  });

  it('getLogs просит те же три рода и заданный диапазон — а не заглушка', () => {
    // ⚠️ Заглушка `async () => []` ждала бы ровно того дня, когда сюда
    // передадут курсор, и в этот день молча вернула бы пустой догон.
    const { client, seen } = fakePublicClient();
    const io = arbiterChangeWatchIO(client);
    return io.getLogs(BigInt(10), BigInt(20)).then((logs) => {
      const args = seen.getLogs as { address: string; events: unknown[];
                                     fromBlock: bigint; toBlock: bigint };
      expect(args.address).toBe(CONTRACTS.diamond);
      expect(args.events).toHaveLength(3);
      expect(args.fromBlock).toBe(BigInt(10));
      expect(args.toBlock).toBe(BigInt(20));
      expect(logs).toHaveLength(1);
    });
  });

  it('такт можно задать снаружи, умолчание — не выдумка, а NOTIF_POLL_MS', async () => {
    const { client, seen } = fakePublicClient();
    arbiterChangeWatchIO(client, 5_000).watch(() => {}, () => {});
    expect((seen.watch as { pollingInterval: number }).pollingInterval).toBe(5_000);
    expect(await arbiterChangeWatchIO(client).blockNumber()).toBe(BigInt(44_700_000));
  });
});
