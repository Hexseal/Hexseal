import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { Address, PublicClient } from 'viem';
import {
  DIAMOND_DEPLOY_BLOCK,
  TURN_CHUNK_BLOCKS,
  TURN_MAX_CHUNKS,
  arbiterTurnOf,
  countClaimsForAgreement,
  estimateBlockAt,
  planTurnScan,
  type ArbiterTurn,
} from './arbiterTurn';

const DEAL  = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as Address;
const OTHER = '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as Address;
const ARB_A = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as Address;
const ARB_B = '0x4C3E4AFd5707Aee625F01B0042D8dA9dd1Ac689C' as Address;

/** Лог `DisputeClaimed` в том виде, в каком его отдаёт viem: `eventName`+`args`. */
function claimLog(agreement: string, arbiter: string, block: bigint, id = ''): unknown {
  return {
    eventName: 'DisputeClaimed',
    args: { agreement, arbiter },
    blockNumber: block,
    transactionHash: id ? `0x${id.padEnd(64, '0')}` : undefined,
    logIndex: id ? 0 : undefined,
  };
}

// ═══ чистая арифметика: план обхода ═══════════════════════════════════════

describe('planTurnScan — куски без дыр, нахлёста и молчаливого урезания', () => {
  it('диапазон короче куска — один кусок ровно по краям', () => {
    expect(planTurnScan(BigInt(100), BigInt(150), BigInt(1000), 10))
      .toEqual([{ fromBlock: BigInt(100), toBlock: BigInt(150) }]);
  });

  it('куски идут по порядку, без дыр и без нахлёста', () => {
    const plan = planTurnScan(BigInt(0), BigInt(9), BigInt(4), 10)!;
    expect(plan).toEqual([
      { fromBlock: BigInt(0), toBlock: BigInt(3) },
      { fromBlock: BigInt(4), toBlock: BigInt(7) },
      { fromBlock: BigInt(8), toBlock: BigInt(9) },
    ]);
  });

  it('хвост обрезан концом диапазона, а не куском', () => {
    const plan = planTurnScan(BigInt(0), BigInt(5), BigInt(4), 10)!;
    expect(plan[plan.length - 1].toBlock).toBe(BigInt(5));
  });

  it('кусков нужно больше потолка — null, а НЕ урезанный план', () => {
    // ⚠️ Урезанный план дал бы недосчёт с уверенным лицом: «арбитр первый»
    // вместо «мы не смогли посчитать». Здесь именно null, и вызывающий
    // обязан превратить его в { known: false }.
    expect(planTurnScan(BigInt(0), BigInt(1_000_000), BigInt(10), 5)).toBeNull();
  });

  it('мусор и вывернутый диапазон — null, а не падение', () => {
    expect(planTurnScan(BigInt(10), BigInt(5), BigInt(4), 10)).toBeNull();
    expect(planTurnScan(BigInt(-1), BigInt(5), BigInt(4), 10)).toBeNull();
    expect(planTurnScan(BigInt(0), BigInt(5), BigInt(0), 10)).toBeNull();
    expect(planTurnScan(BigInt(0), BigInt(5), BigInt(4), 0)).toBeNull();
  });

  it('умолчания — те самые, что объявлены', () => {
    // Числа написаны руками, а не взяты из модуля: иначе замер сверял бы
    // модуль сам с собой. ⚠️ DIAMOND_DEPLOY_BLOCK здесь НАМЕРЕННО нет: у него
    // есть хозяин вне фронта, и сверяется он с ним — describe ниже.
    expect(TURN_CHUNK_BLOCKS).toBe(BigInt(3600));
    expect(TURN_MAX_CHUNKS).toBe(64);
  });
});

// ═══ блок деплоя: вторая копия сверяется С ХОЗЯИНОМ ══════════════════════

/**
 * Хозяин числа — `subgraph/subgraph.yaml` (`startBlock`). Читаем ЕГО, как
 * `claimAbiMatchesContract.test.ts` читает `.sol`.
 *
 * Что исчезнет из поведения, если снять этот замок: способ узнать о замене
 * диамонда иначе, чем по молчаливо исчезнувшему счёту арбитров. Сабграф при
 * переразвёртывании обновят обязательно (без него он пуст), фронт — нет, и
 * `arbiterTurnOf` пойдёт считать логи от блока СТАРОГО диамонда: либо упрётся
 * в TURN_MAX_CHUNKS и отдаст честное `{ known: false }`, либо посчитает чужое.
 * Тест `expect(DIAMOND_DEPLOY_BLOCK).toBe(44_613_049n)` этого не ловит НИКОГДА:
 * он сверяет константу с её же копией.
 */
const SUBGRAPH_YAML = readFileSync(
  new URL('../../../subgraph/subgraph.yaml', import.meta.url),
  'utf8',
);

/** `startBlock` из манифеста сабграфа, ровно один. Две записи — отказ: какая
 *  из них про диамонд, из текста не следует. */
function subgraphStartBlock(yaml: string): bigint {
  const found = [...yaml.matchAll(/^\s*startBlock:\s*(\d+)\s*$/gm)];
  if (found.length === 0) throw new Error('startBlock не найден в subgraph.yaml');
  if (found.length > 1) {
    throw new Error(`startBlock в subgraph.yaml встречается ${found.length} раза — какой из них про диамонд, неизвестно`);
  }
  return BigInt(found[0][1]);
}

describe('блок деплоя диамонда: копия во фронте сверяется с хозяином', () => {
  it('DIAMOND_DEPLOY_BLOCK равен startBlock из subgraph.yaml', () => {
    expect(DIAMOND_DEPLOY_BLOCK).toBe(subgraphStartBlock(SUBGRAPH_YAML));
  });

  it('разборщик достал ЧИСЛО, а не мусор — но не сверяет его значение', () => {
    // ⚠️ ЗДЕСЬ НАМЕРЕННО ДИАПАЗОН, А НЕ РАВЕНСТВО. Третий рукописный экземпляр
    // `44_613_049` означал бы, что при ЗАКОННОЙ замене диамонда этот тест
    // краснеет, а починка выглядит как «поправить число в тесте» — то есть
    // замок учит себя игнорировать. Расхождение сторон ловит тест выше; здесь
    // проверяется только, что из yaml вынули правдоподобный номер блока Base,
    // а не ноль, не строку и не длину файла.
    const got = subgraphStartBlock(SUBGRAPH_YAML);
    expect(got).toBeGreaterThan(BigInt(1_000_000));
    expect(got).toBeLessThan(BigInt(1_000_000_000));
  });

  it('startBlock не найден — отказ, а не тихий ноль', () => {
    expect(() => subgraphStartBlock('dataSources:\n  - kind: ethereum\n')).toThrow();
  });

  it('два startBlock в манифесте — отказ, а не первый попавшийся', () => {
    expect(() => subgraphStartBlock('      startBlock: 1\n      startBlock: 2\n')).toThrow();
  });
});

// ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ЛОВИТ, названо вслух: что фронт и сабграф смотрят на
// ОДИН диамонд. Адрес фронта приезжает из окружения (CONTRACTS.diamond ←
// NEXT_PUBLIC_DIAMOND_ADDRESS), а под тестами это заглушка 0x…0d1a из
// vitest.config.mjs — сверять с адресом в yaml нечего.

// ═══ чистая арифметика: оценка блока по времени ═══════════════════════════

describe('estimateBlockAt — только оценка, настоящий край проверяется чтением', () => {
  it('цель равна времени головы — сама голова', () => {
    expect(estimateBlockAt(BigInt(100_000), BigInt(10_000), BigInt(10_000))).toBe(BigInt(100_000));
  });

  it('час назад при двух секундах на блок — 1800 блоков назад', () => {
    expect(estimateBlockAt(BigInt(100_000), BigInt(10_000), BigInt(10_000 - 3600)))
      .toBe(BigInt(98_200));
  });

  it('цель в будущем — голова, а не отрицательный шаг', () => {
    expect(estimateBlockAt(BigInt(100_000), BigInt(10_000), BigInt(20_000))).toBe(BigInt(100_000));
  });

  it('уход глубже нуля упирается в ноль, пол деплоя ставит вызывающий', () => {
    expect(estimateBlockAt(BigInt(10), BigInt(10_000), BigInt(0))).toBe(BigInt(0));
  });
});

// ═══ счёт по логам ═══════════════════════════════════════════════════════

describe('countClaimsForAgreement — считаем своё, чужому верим на слово никогда', () => {
  it('три заявки по нашей сделке — три', () => {
    expect(countClaimsForAgreement([
      claimLog(DEAL, ARB_A, BigInt(1), 'a'),
      claimLog(DEAL, ARB_B, BigInt(2), 'b'),
      claimLog(DEAL, ARB_A, BigInt(3), 'c'),
    ], DEAL)).toBe(3);
  });

  it('чужая сделка в пачке не считается — узел фильтрует, но он не наш', () => {
    // ⚠️ Фильтр по args ставится и на узле. Здесь проверяется, что мы не
    // полагаемся на его добросовестность: свой отсев обязан быть.
    expect(countClaimsForAgreement([
      claimLog(DEAL, ARB_A, BigInt(1), 'a'),
      claimLog(OTHER, ARB_B, BigInt(2), 'b'),
    ], DEAL)).toBe(1);
  });

  it('регистр адреса не мешает — цепь отдаёт с контрольной суммой', () => {
    expect(countClaimsForAgreement(
      [claimLog(DEAL.toLowerCase(), ARB_A, BigInt(1), 'a')],
      DEAL,
    )).toBe(1);
    expect(countClaimsForAgreement(
      [claimLog(DEAL, ARB_A, BigInt(1), 'a')],
      DEAL.toLowerCase() as Address,
    )).toBe(1);
  });

  it('тот же лог дважды считается один раз', () => {
    expect(countClaimsForAgreement([
      claimLog(DEAL, ARB_A, BigInt(1), 'a'),
      claimLog(DEAL, ARB_A, BigInt(1), 'a'),
    ], DEAL)).toBe(1);
  });

  it('чужой род события и мусор — не считаются и не роняют', () => {
    expect(countClaimsForAgreement([
      { eventName: 'DisputeReleased', args: { agreement: DEAL, prevArbiter: ARB_A } },
      null, undefined, 5, 'лог', [],
      { eventName: 'DisputeClaimed' },
      { eventName: 'DisputeClaimed', args: { agreement: 42 } },
      claimLog(DEAL, ARB_A, BigInt(1), 'a'),
    ] as unknown[], DEAL)).toBe(1);
    expect(countClaimsForAgreement([], DEAL)).toBe(0);
    expect(countClaimsForAgreement('не массив' as unknown as unknown[], DEAL)).toBe(0);
  });
});

// ═══ стенд цепи ══════════════════════════════════════════════════════════

interface Stand {
  head: bigint;
  headTs: bigint;
  /** Логи по блокам. */
  logs: { block: bigint; log: unknown }[];
  /** Наибольший принимаемый диапазон одного getLogs; больше — узел отказывает. */
  maxRange?: bigint;
  disputedAt?: bigint;
  disputeWindow?: bigint;
  /** Кто ведёт спор. `undefined` — никто (спор поднят, арбитр не взялся). */
  arbiter?: Address;
  fail?: Set<string>;
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function fakeChain(stand: Stand) {
  const calls = { blockNumber: 0, getBlock: 0, getLogs: 0, readContract: 0 };
  const client = {
    async getBlockNumber() {
      calls.blockNumber++;
      if (stand.fail?.has('getBlockNumber')) throw new Error('узел отказал: голова');
      return stand.head;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      calls.getBlock++;
      if (stand.fail?.has('getBlock')) throw new Error('узел отказал: блок');
      // Время блока: ровно две секунды на блок от головы назад.
      return { number: blockNumber, timestamp: stand.headTs - (stand.head - blockNumber) * BigInt(2) };
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs++;
      if (stand.fail?.has('getLogs')) throw new Error('узел отказал: логи');
      if (stand.maxRange !== undefined && toBlock - fromBlock > stand.maxRange) {
        throw new Error('узел отказал: диапазон слишком широк');
      }
      return stand.logs.filter((e) => e.block >= fromBlock && e.block <= toBlock).map((e) => e.log);
    },
    async readContract({ functionName }: { functionName: string }) {
      calls.readContract++;
      if (stand.fail?.has(functionName)) throw new Error(`узел отказал: ${functionName}`);
      if (functionName === 'disputedAt') return stand.disputedAt ?? BigInt(0);
      if (functionName === 'DISPUTE_WINDOW') return stand.disputeWindow ?? BigInt(4 * 86400);
      // «Кто ведёт спор» — этим `settle` подтверждает честный ноль: спора без
      // заявки не бывает, поэтому ноль заявок законен только без арбитра.
      if (functionName === 'getDisputeClaimer') return stand.arbiter ?? ZERO;
      if (functionName === 'getPendingVerdict') return { arbiter: ZERO, submittedAt: BigInt(0) };
      throw new Error(`стенд не знает ${functionName}`);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

const HEAD = BigInt(44_700_000);
const HEAD_TS = BigInt(1_760_000_000);

// ═══ склейка ═════════════════════════════════════════════════════════════

describe('arbiterTurnOf — факт цепи либо честное «не знаю»', () => {
  it('три заявки по сделке — { known: true, turn: 3 }', async () => {
    const { client, calls } = fakeChain({
      head: HEAD, headTs: HEAD_TS,
      logs: [
        { block: HEAD - BigInt(3000), log: claimLog(DEAL, ARB_A, HEAD - BigInt(3000), 'a') },
        { block: HEAD - BigInt(2000), log: claimLog(DEAL, ARB_B, HEAD - BigInt(2000), 'b') },
        { block: HEAD - BigInt(1000), log: claimLog(DEAL, ARB_A, HEAD - BigInt(1000), 'c') },
      ],
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 3 });
    // Широкий запрос прошёл — значит ровно один поход за логами.
    expect(calls.getLogs).toBe(1);
  });

  it('заявок нет — { known: true, turn: 0 }, а НЕ { known: false }', async () => {
    // ⚠️ Ноль здесь ИЗМЕРЕН. Слить его с «не смогли посчитать» значило бы
    // сказать стороне «арбитр первый» там, где мы этого не знаем.
    const { client } = fakeChain({ head: HEAD, headTs: HEAD_TS, logs: [] });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 0 });
  });

  it('голова не читается — { known: false }, и ни одного лишнего похода', async () => {
    const { client, calls } = fakeChain({
      head: HEAD, headTs: HEAD_TS, logs: [], fail: new Set(['getBlockNumber']),
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: false });
    expect(calls.getLogs).toBe(0);
  });

  it('узел молчит на логах целиком — { known: false }, а не ноль', async () => {
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS, logs: [], fail: new Set(['getLogs']),
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: false });
  });

  it('широкий запрос отказал — считаем кусками по окну спора', async () => {
    const stand: Stand = {
      head: HEAD, headTs: HEAD_TS,
      maxRange: BigInt(10_000),
      disputedAt: HEAD_TS - BigInt(7200),      // спор поднят два часа назад
      disputeWindow: BigInt(4 * 86400),
      logs: [
        { block: HEAD - BigInt(3000), log: claimLog(DEAL, ARB_A, HEAD - BigInt(3000), 'a') },
        { block: HEAD - BigInt(500),  log: claimLog(DEAL, ARB_B, HEAD - BigInt(500),  'b') },
      ],
    };
    const { client, calls } = fakeChain(stand);
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 2 });
    // ЗАМЕР: сколько стоит счёт, когда широкий запрос не прошёл.
    // eslint-disable-next-line no-console
    console.info(`[замер] счёт арбитров кусками: getLogs=${calls.getLogs}, `
      + `getBlock=${calls.getBlock}, readContract=${calls.readContract}, `
      + `blockNumber=${calls.blockNumber}`);
    expect(calls.getLogs).toBeLessThanOrEqual(TURN_MAX_CHUNKS + 1);
  });

  it('окно спора не читается — сужения нет, идём от блока деплоя', async () => {
    // Голова близко к блоку деплоя, поэтому широкая дорога умещается в потолок
    // кусков. Это и есть проверяемое утверждение: неудача сужения удорожает
    // счёт, но НЕ превращает его в неправду.
    const head = DIAMOND_DEPLOY_BLOCK + BigInt(5000);
    const { client } = fakeChain({
      head, headTs: HEAD_TS,
      maxRange: BigInt(4000),
      fail: new Set(['disputedAt']),
      logs: [{ block: head - BigInt(10), log: claimLog(DEAL, ARB_A, head - BigInt(10), 'a') }],
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 1 });
  });

  it('кусков нужно больше потолка — { known: false }, а не недосчёт', async () => {
    // Широкий отказал, сузиться нечем, до головы от блока деплоя — сотни тысяч
    // блоков. Здесь честное незнание дешевле уверенной неправды.
    const { client } = fakeChain({
      head: DIAMOND_DEPLOY_BLOCK + BigInt(900_000), headTs: HEAD_TS,
      maxRange: BigInt(4000),
      fail: new Set(['disputedAt']),
      logs: [],
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: false });
  });

  it('отказ на середине кусков — { known: false }, а не половина счёта', async () => {
    // ⚠️ Самый опасный исход: часть кусков доехала, часть нет. Сложить
    // доехавшее и назвать это счётом — соврать числом.
    const stand: Stand = {
      head: HEAD, headTs: HEAD_TS,
      maxRange: BigInt(10_000),
      disputedAt: HEAD_TS - BigInt(7200),
      disputeWindow: BigInt(4 * 86400),
      logs: [{ block: HEAD - BigInt(3000), log: claimLog(DEAL, ARB_A, HEAD - BigInt(3000), 'a') }],
    };
    const { client } = fakeChain(stand);
    let seen = 0;
    const wrapped = {
      ...(client as unknown as Record<string, unknown>),
      getLogs: async (arg: { fromBlock: bigint; toBlock: bigint }) => {
        seen++;
        // первый (широкий) отказывает по диапазону, второй проходит, третий рвётся
        if (seen >= 3) throw new Error('узел отказал на середине');
        return (client as unknown as { getLogs: (a: unknown) => Promise<unknown[]> }).getLogs(arg);
      },
    } as unknown as PublicClient;
    expect(await arbiterTurnOf(wrapped, DEAL)).toEqual({ known: false });
  });

  it('АРБИТР ЕСТЬ, а логов ноль — { known: false }, а НЕ «первый»', async () => {
    // ⚠️ САМАЯ ДОРОГАЯ ЛОЖЬ ИЗ ВОЗМОЖНЫХ, и она не бросает. Провайдер вправе
    // ответить на слишком широкий eth_getLogs пустым (или усечённым) массивом
    // вместо ошибки — тогда все проверки на отказ проходят мимо, и наружу
    // выходит уверенное «арбитр первый». Сторона показала бы ТРЕТЬЕМУ арбитру
    // переписку целиком, считая его первым, и не узнала бы об этом никогда.
    // Спора без заявки не бывает: есть арбитр — значит был `DisputeClaimed`.
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS, logs: [], arbiter: ARB_A,
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: false });
  });

  it('арбитра нет и логов нет — вот тут ноль ЧЕСТНЫЙ', async () => {
    // Обратная половина: спор поднят, никто не взялся. Ноль здесь — факт, и
    // слить его с «не знаю» было бы такой же неправдой, только в другую сторону.
    const { client } = fakeChain({ head: HEAD, headTs: HEAD_TS, logs: [] });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 0 });
  });

  it('ноль при НЕЧИТАЕМОМ арбитре — тоже незнание', async () => {
    // Подтвердить ноль нечем — значит его нет.
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS, logs: [], fail: new Set(['getDisputeClaimer']),
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: false });
  });

  it('при ненулевом счёте «кто ведёт спор» не спрашивается — лишних чтений нет', async () => {
    // ЗАМЕР ЦЕНЫ: проверка стоит ровно там, где подозрительно, и ни разу больше.
    const { client, calls } = fakeChain({
      head: HEAD, headTs: HEAD_TS,
      logs: [{ block: HEAD - BigInt(10), log: claimLog(DEAL, ARB_A, HEAD - BigInt(10), 'a') }],
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 1 });
    expect(calls.readContract, 'счёт сходил в цепь без нужды').toBe(0);
  });

  it('чужие логи в ответе узла в счёт не идут', async () => {
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS,
      logs: [
        { block: HEAD - BigInt(10), log: claimLog(DEAL, ARB_A, HEAD - BigInt(10), 'a') },
        { block: HEAD - BigInt(9),  log: claimLog(OTHER, ARB_B, HEAD - BigInt(9), 'b') },
      ],
    });
    expect(await arbiterTurnOf(client, DEAL)).toEqual({ known: true, turn: 1 });
  });
});

// ═══ форма ответа ════════════════════════════════════════════════════════

describe('форма ответа: незнание и ноль — разные вещи', () => {
  it('«не знаю» С БОЕВОГО ПУТИ не несёт числа', async () => {
    // ⚠️ ЗНАЧЕНИЕ БЕРЁТСЯ ИЗ `arbiterTurnOf`, А НЕ СОЧИНЯЕТСЯ ЗДЕСЬ. Прежняя
    // редакция строила литерал `{ known: false }` сама и проверяла его ключи —
    // такой тест не мог покраснеть НИКОГДА, что бы ни делал модуль, и при этом
    // назывался «рантайм-половиной замка». Теперь он меряет то, что боевой код
    // действительно отдаёт.
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS, logs: [], fail: new Set(['getBlockNumber']),
    });
    const unknownTurn: ArbiterTurn = await arbiterTurnOf(client, DEAL);
    expect(unknownTurn.known).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(unknownTurn, 'turn')).toBe(false);
    expect(Object.keys(unknownTurn)).toEqual(['known']);
  });

  it('«знаю» с боевого пути несёт РОВНО два поля', async () => {
    // Обратная половина: чтобы предыдущий тест не зеленел на пустом объекте.
    const { client } = fakeChain({
      head: HEAD, headTs: HEAD_TS,
      logs: [{ block: HEAD - BigInt(10), log: claimLog(DEAL, ARB_A, HEAD - BigInt(10), 'a') }],
    });
    expect(Object.keys(await arbiterTurnOf(client, DEAL)).sort()).toEqual(['known', 'turn']);
  });
});
