import { describe, expect, it, vi } from 'vitest';
import {
  AbiFunctionNotFoundError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  encodeAbiParameters,
  encodeEventTopics,
  type Log,
  type PublicClient,
} from 'viem';
import { DISPUTE_SPLIT_EVENT } from '@/config/contracts';
import {
  classifySettledRefund,
  findSplitInLogs,
  refundNotifCopy,
  type SettledRefund,
} from './settledRefund';

/**
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * Таймаут спора, за который никто не взялся, ДЕЛИТ эскроу и приносит в реестр
 * тот же REFUNDED(2), что настоящий возврат — перечисление статусов расширять
 * нельзя, оно повторяет замороженный `enum Status` агримента. До задачи 7c лента
 * уведомлений на этом статусе говорила обеим сторонам «сделка отменена, деньги
 * вернулись клиенту», включая исполнителя, которому только что пришла половина
 * котла.
 *
 * Релеерная половина фикса покрыта `relayer/test/disputeSplitPush.test.js`.
 * Здесь — фронтовая: `lib/settledRefund`. Три вещи, ошибка в каждой снова
 * называет пользователю не ту сумму или не то событие:
 *
 *  1. `findSplitInLogs` — признак дележа и СУММЫ, взятые из события;
 *  2. `classifySettledRefund` — два источника признака (чек / состояние) и
 *     порядок между ними;
 *  3. `refundNotifCopy` — текст на обе роли в обоих исходах.
 *
 * ЧЕМ ЗАПУСКАТЬ. `npm test` в `frontend/`; раннер берётся из
 * `../relayer/node_modules` (см. шапку `frontend/vitest.config.mjs` — там же
 * причина, почему у фронта нет своего). Этому файлу конфиг нужен обязательно:
 * `settledRefund.ts` импортирует `@/config/contracts`, а тот бросает на загрузке
 * модуля, если в окружении нет адресов.
 */

const AGREEMENT = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as `0x${string}`;
const SOMEONE_ELSE = '0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb' as `0x${string}`;
const DIAMOND = '0xcCCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const ARBITER = '0x1111111111111111111111111111111111111111';

const TX = ('0x' + '11'.repeat(32)) as `0x${string}`;

/**
 * Лог ровно той формы, в какой `DisputeSplitNoVerdict` приходит из чека: оба
 * аргумента не indexed, поэтому topic один, а суммы лежат в `data`. Кодируется
 * настоящей машинерией viem — тем же кодом, который потом это и разбирает.
 */
function splitLog(address: string, toClient: bigint, toExecutor: bigint): Log {
  return {
    address: address.toLowerCase() as `0x${string}`,
    topics: encodeEventTopics({
      abi: [DISPUTE_SPLIT_EVENT],
      eventName: 'DisputeSplitNoVerdict',
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [toClient, toExecutor],
    ),
    blockHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
    blockNumber: 44_613_049n,
    logIndex: 0,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

/**
 * Диамондовый `AgreementStatusUpdated` — не событие агримента, и в чеке дележа
 * он лежит рядом. Служит здесь наполнителем: чек с логами, среди которых дележа
 * НЕТ, отличается от пустого чека.
 */
const statusLog: Log = {
  address: DIAMOND,
  topics: [
    encodeEventTopics({
      abi: [
        {
          type: 'event',
          name: 'AgreementStatusUpdated',
          inputs: [
            { indexed: true, name: 'agreement', type: 'address' },
            { indexed: false, name: 'newStatus', type: 'uint8' },
          ],
        },
      ],
      eventName: 'AgreementStatusUpdated',
    })[0],
    ('0x' + '00'.repeat(12) + AGREEMENT.slice(2).toLowerCase()) as `0x${string}`,
  ],
  data: encodeAbiParameters([{ type: 'uint8' }], [2]),
  blockHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
  blockNumber: 44_613_049n,
  logIndex: 1,
  transactionHash: TX,
  transactionIndex: 0,
  removed: false,
} as Log;

// ─── findSplitInLogs ─────────────────────────────────────────────────────────

describe('findSplitInLogs', () => {
  it('находит дележ и обе суммы среди прочих логов чека', () => {
    expect(
      findSplitInLogs([statusLog, splitLog(AGREEMENT, 100_000_001n, 100_000_000n)], AGREEMENT),
    ).toEqual({ toClient: 100_000_001n, toExecutor: 100_000_000n });
  });

  it('сверяет адрес без учёта регистра', () => {
    expect(findSplitInLogs([splitLog(AGREEMENT, 17n, 16n)], AGREEMENT.toLowerCase())).toEqual({
      toClient: 17n,
      toExecutor: 16n,
    });
  });

  // Один агримент не вправе решать, как читается уведомление про сделку другого.
  // Форвардер сегодня делает один внутренний вызов, но чек — это транзакция, а не
  // вызов: чужой лог в нём появляется от любого батчинга сверху.
  it('игнорирует дележ, который в том же чеке выпустил ДРУГОЙ агримент', () => {
    expect(findSplitInLogs([splitLog(SOMEONE_ELSE, 17n, 16n)], AGREEMENT)).toBeNull();
  });

  it('настоящий возврат такого события не выпускает вовсе — null', () => {
    expect(findSplitInLogs([statusLog], AGREEMENT)).toBeNull();
    expect(findSplitInLogs([], AGREEMENT)).toBeNull();
  });

  // ── Клетка, которая держит весь смысл функции ────────────────────────────
  //
  // Суммы обязаны приходить ИЗ СОБЫТИЯ, а не считаться из котла. Ветка
  // заблокированного исполнителя (`src/Agreement.sol`, `triggerArbiterTimeout`):
  // мягкий перевод исполнителю не прошёл — USDC его в чёрном списке, — и
  // контракт отдаёт его половину клиенту, доводя транзакцию до конца. Событие
  // несёт то, что реально переведено: `toExecutor = 0`.
  //
  // Расчётный `pot/2` соврал бы исполнителю про половину, которой он не
  // получил, и соврал бы клиенту в обратную сторону — при этом сумма
  // `toClient + toExecutor` осталась бы верной, так что подмену не видно
  // ниоткуда, кроме такого теста.
  it('исполнитель в чёрном списке USDC: обе суммы из события, нулевая половина не «пополам»', () => {
    const found = findSplitInLogs([splitLog(AGREEMENT, 200_000_000n, 0n)], AGREEMENT);
    expect(found).toEqual({ toClient: 200_000_000n, toExecutor: 0n });
    // Явно: котёл тот же 200 USDC, и половина от него — НЕ то, что здесь ждут.
    expect(found?.toExecutor).not.toBe(100_000_000n);
  });
});

// ─── classifySettledRefund ───────────────────────────────────────────────────

type ReadName = 'getDetails' | 'disputeFee' | 'totalPayout' | 'DISPUTE_WINDOW';

/** `getDetails()` в том виде, в каком его отдаёт viem: позиционный кортеж. */
function details({ arbiter, disputedAt }: { arbiter: string; disputedAt: bigint }) {
  return [
    AGREEMENT,            // 0 client_
    SOMEONE_ELSE,         // 1 executor_
    arbiter,              // 2 arbiter_
    200_000_000n,         // 3 amount_
    'terms',              // 4 terms_
    7n,                   // 5 deadlineDays_
    1n,                   // 6 fundedAt_
    2n,                   // 7 activatedAt_
    0n,                   // 8 markedDoneAt_
    disputedAt,           // 9 disputedAt_
    0n,                   // 10 resolvedAt_
    2,                    // 11 status_ (REFUNDED)
  ] as const;
}

/**
 * `readContract` у старого клона, у которого нет селектора `disputeFee`: у
 * `Agreement` нет fallback, поэтому ответ пустой и viem поднимает
 * `ContractFunctionZeroDataError`. `classifyReadFailure` относит его к
 * 'contract' — то есть «цепь ответила, и ответ отрицательный».
 */
const noSuchSelector = () => {
  throw new ContractFunctionZeroDataError({ functionName: 'disputeFee' });
};

/** Сеть отвалилась: про контракт мы не узнали ничего. */
const transportDown = () => {
  throw new HttpRequestError({ url: 'https://example-rpc.invalid' });
};

function fakeClient(opts: {
  receipt?: () => { logs: Log[] };
  reads?: Partial<Record<ReadName, () => unknown>>;
}) {
  const receipt = opts.receipt ? vi.fn(opts.receipt) : vi.fn(() => {
    throw new Error('getTransactionReceipt should not have been called');
  });
  const readContract = vi.fn(async ({ functionName }: { functionName: ReadName }) => {
    const impl = opts.reads?.[functionName];
    if (!impl) throw new Error(`unexpected read: ${functionName}`);
    return impl();
  });
  const client = {
    getTransactionReceipt: vi.fn(async () => receipt()),
    readContract,
  } as unknown as PublicClient;
  return { client, receipt, readContract };
}

describe('classifySettledRefund — путь через чек (точный)', () => {
  it('дележ в чеке: суммы из события, состояние читать не надо', async () => {
    const { client, readContract } = fakeClient({
      receipt: () => ({ logs: [statusLog, splitLog(AGREEMENT, 100_000_001n, 100_000_000n)] }),
    });
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({
      kind: 'split',
      toClient: 100_000_001n,
      toExecutor: 100_000_000n,
    });
    // Ни одного чтения с цепи: чек — точный ответ, и второй источник тут лишний.
    expect(readContract).not.toHaveBeenCalled();
  });

  // Та же ветка, что в findSplitInLogs, но проведённая через всю функцию: если
  // суммы где-то по дороге начнут считаться, исполнителю пообещают половину.
  it('заблокированный исполнитель: через всю функцию доходит toExecutor = 0', async () => {
    const { client } = fakeClient({
      receipt: () => ({ logs: [splitLog(AGREEMENT, 200_000_000n, 0n)] }),
    });
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({
      kind: 'split',
      toClient: 200_000_000n,
      toExecutor: 0n,
    });
  });

  it('чужой дележ в чеке не подменяет исход нашей сделки — падаем в состояние', async () => {
    const { client, readContract } = fakeClient({
      receipt: () => ({ logs: [splitLog(SOMEONE_ELSE, 17n, 16n)] }),
      reads: { getDetails: () => details({ arbiter: ZERO, disputedAt: 0n }) },
    });
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({ kind: 'refund' });
    expect(readContract).toHaveBeenCalled();
  });

  // `updateStatus` мог упасть при завершении (RegistrySyncFailed), и тогда статус
  // в реестр приносит отдельная транзакция `syncRegistry()` — в её чеке дележа
  // нет по построению. Ответить «возврат» по отсутствию события значило бы
  // вернуть ровно то враньё, которое эта задача убирает, только по умолчанию.
  it('чек без дележа НЕ считается возвратом: исход берётся из состояния', async () => {
    const { client, readContract } = fakeClient({
      receipt: () => ({ logs: [statusLog] }),
      reads: {
        getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
        disputeFee: () => 990_000n,
        totalPayout: () => 33n,
        DISPUTE_WINDOW: () => 345_600n,
      },
    });
    // Дележ — да; кому сколько — нет: суммы бывают только из события.
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({
      kind: 'split-amounts-unknown',
    });
    expect(readContract).toHaveBeenCalled();
  });

  it('пустой чек — тоже не возврат сам по себе', async () => {
    const { client, readContract } = fakeClient({
      receipt: () => ({ logs: [] }),
      reads: { getDetails: transportDown },
    });
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({ kind: 'unknown' });
    expect(readContract).toHaveBeenCalled();
  });

  it('чек ещё не проиндексирован — вторая попытка по состоянию', async () => {
    const { client, receipt } = fakeClient({
      receipt: () => {
        throw new Error('transaction receipt not found');
      },
      reads: { getDetails: () => details({ arbiter: ARBITER, disputedAt: 1_700_000_000n }) },
    });
    await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({ kind: 'refund' });
    expect(receipt).toHaveBeenCalled();
  });
});

describe('classifySettledRefund — путь по состоянию (холодный старт, хэша нет)', () => {
  it('без клиента — «не знаем», а не «возврат»', async () => {
    await expect(classifySettledRefund(undefined, AGREEMENT, TX)).resolves.toEqual({
      kind: 'unknown',
    });
  });

  it('спора не было вовсе: REFUNDED означает ровно возврат, дальше читать нечего', async () => {
    const { client, readContract } = fakeClient({
      reads: { getDetails: () => details({ arbiter: ZERO, disputedAt: 0n }) },
    });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'refund' });
    expect(readContract).toHaveBeenCalledTimes(1); // только getDetails
  });

  it('за спор брались: весь котёл клиенту в любой реализации', async () => {
    const { client, readContract } = fakeClient({
      reads: { getDetails: () => details({ arbiter: ARBITER, disputedAt: 1_700_000_000n }) },
    });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'refund' });
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it('никто не взялся, все три чтения дошли: дележ — но без сумм', async () => {
    const { client } = fakeClient({
      reads: {
        getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
        disputeFee: () => 990_000n,
        totalPayout: () => 33n,
        DISPUTE_WINDOW: () => 345_600n,
      },
    });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({
      kind: 'split-amounts-unknown',
    });
  });

  it('старый клон (нет селектора disputeFee, но окно дочиталось): возврат', async () => {
    const { client } = fakeClient({
      reads: {
        getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
        disputeFee: noSuchSelector,
        totalPayout: () => 200_000_000n,
        DISPUTE_WINDOW: () => 345_600n,
      },
    });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'refund' });
  });

  it('сеть отвалилась на всех трёх чтениях: «не знаем», а не «возврат»', async () => {
    const { client } = fakeClient({
      reads: {
        getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
        disputeFee: transportDown,
        totalPayout: transportDown,
        DISPUTE_WINDOW: transportDown,
      },
    });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'unknown' });
  });

  it('getDetails не прочитался — «не знаем»', async () => {
    const { client } = fakeClient({ reads: { getDetails: transportDown } });
    await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'unknown' });
  });
});

// ─── Клетка, которая держит правило ──────────────────────────────────────────
//
// НИ ПРИ КАКОМ котле путь по состоянию не называет сумму по стороне. Суммы там
// могут быть только расчётными (`splitPot(totalPayout())`), а расчёт не знает
// про ветку заблокированного исполнителя: мягкий перевод не прошёл, его
// половина ушла клиенту, и контракт заплатил не по правилу. Обещать в этот
// момент «16.00 USDC тебе» тому, кто не получил ничего, — ровно то враньё,
// которое эта задача убирает.
//
// Тест намеренно смотрит НА ФОРМУ РЕЗУЛЬТАТА, а не на конкретный `kind`:
// вернуть расчётные суммы — это дописать в объект поля, и любое такое
// возвращение здесь и провалится, как бы ни назвали вид.
describe('путь по состоянию НИКОГДА не называет сумму по стороне', () => {
  const POTS = [
    0n,                       // пустой котёл
    1n,                       // неделимый юнит: floor(1/2) = 0
    33n,                      // нечётный: расчёт дал бы 16 / 17
    200_000_000n,             // ровно 200 USDC — та самая ветка из чека
    123_456_789_012_345_678n, // крупный
  ];

  for (const pot of POTS) {
    it(`котёл ${pot}: ни toClient, ни toExecutor в ответе, ни одной суммы в тексте`, async () => {
      const { client } = fakeClient({
        reads: {
          getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
          disputeFee: () => 990_000n,
          totalPayout: () => pot,
          DISPUTE_WINDOW: () => 345_600n,
        },
      });
      const outcome = await classifySettledRefund(client, AGREEMENT);

      // Дележ распознан — иначе тест проверял бы не ту ветку.
      expect(outcome.kind).toBe('split-amounts-unknown');
      // Ни одного поля с суммой, как бы оно ни называлось.
      expect(Object.keys(outcome)).toEqual(['kind']);
      expect(Object.values(outcome).some((v) => typeof v === 'bigint')).toBe(false);

      // И до пользователя ни одна сумма не доезжает.
      for (const role of ['client', 'executor'] as const) {
        const { body } = refundNotifCopy(outcome, role);
        expect(body).not.toMatch(/USDC/);
        expect(body).not.toMatch(/\d/);
      }
    });
  }
});

// ─── Баг в коде не должен выглядеть как отвалившаяся сеть ────────────────────
//
// Все три `catch` здесь возвращают «не знаем», и для настоящего сбоя RPC это
// правильно: сеть падает буднично, лента из-за этого падать не должна. Но тот
// же `catch` глотает и опечатку — и обе стороны прочитают её как «RPC
// недоступен», а разработчик не прочитает вовсе. Возвращаемое значение остаётся
// прежним; отличает случаи запись в консоль.
describe('classifySettledRefund — ошибка программиста видна, сетевая молчит', () => {
  function spyOnConsoleError() {
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  it('сетевой сбой не шумит: «не знаем» и ни строчки в консоль', async () => {
    const spy = spyOnConsoleError();
    try {
      const { client } = fakeClient({ reads: { getDetails: transportDown } });
      await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({
        kind: 'unknown',
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('старый клон (реверт селектора) тоже не шумит — это нормальный ответ цепи', async () => {
    const spy = spyOnConsoleError();
    try {
      const { client } = fakeClient({
        reads: {
          getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
          disputeFee: noSuchSelector,
          totalPayout: () => 200_000_000n,
          DISPUTE_WINDOW: () => 345_600n,
        },
      });
      await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({ kind: 'refund' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Самый частый вид опечатки: позвали метод, которого у объекта нет. Раньше
  // это было неотличимо от «RPC недоступен» — тот же 'unknown', та же тишина.
  it('опечатка в имени метода клиента: «не знаем», но в консоли — про баг', async () => {
    const spy = spyOnConsoleError();
    try {
      const broken = {} as unknown as PublicClient; // нет ни readContract, ни чего-либо ещё
      await expect(classifySettledRefund(broken, AGREEMENT)).resolves.toEqual({
        kind: 'unknown',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [message, error] = spy.mock.calls[0];
      expect(String(message)).toContain('[settledRefund]');
      expect(String(message)).toMatch(/programmer error/i);
      // Адрес сделки в сообщении обязателен: без него в ленте, которая обходит
      // все сделки разом, непонятно, о какой из них речь.
      expect(String(message)).toContain(AGREEMENT);
      expect(error).toBeInstanceOf(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  // Опечатка в имени КОНТРАКТНОЙ функции. Её viem бросает как
  // AbiFunctionNotFoundError — наследника BaseError, то есть по классу-предку
  // неотличимого от сетевой ошибки; отсюда отдельная проверка.
  it('имя функции, которого нет в ABI: тоже баг, а не сеть', async () => {
    const spy = spyOnConsoleError();
    try {
      const { client } = fakeClient({
        reads: {
          getDetails: () => {
            throw new AbiFunctionNotFoundError('getDetailz');
          },
        },
      });
      await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({
        kind: 'unknown',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toMatch(/programmer error/i);
    } finally {
      spy.mockRestore();
    }
  });

  // Путь через чек глотал ошибки своим собственным catch — и падал в состояние,
  // где всё выглядело штатно. Опечатка там оставалась невидимой вдвойне.
  it('баг на пути через чек виден, хотя исход дочитался по состоянию', async () => {
    const spy = spyOnConsoleError();
    try {
      const { client } = fakeClient({
        receipt: () => {
          throw new TypeError('receipt.logz is not iterable');
        },
        reads: { getDetails: () => details({ arbiter: ARBITER, disputedAt: 1_700_000_000n }) },
      });
      // Внешнее поведение прежнее: исход всё равно дочитан по состоянию.
      await expect(classifySettledRefund(client, AGREEMENT, TX)).resolves.toEqual({
        kind: 'refund',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('receipt path');
    } finally {
      spy.mockRestore();
    }
  });

  // Три чтения после getDetails свои ошибки не бросают, а возвращают — их
  // классифицирует decideArbiterTimeout, и опечатка снова читается как 'transport'.
  it('баг в одном из трёх чтений тоже виден', async () => {
    const spy = spyOnConsoleError();
    try {
      const { client } = fakeClient({
        reads: {
          getDetails: () => details({ arbiter: ZERO, disputedAt: 1_700_000_000n }),
          disputeFee: () => {
            throw new TypeError('abi.filtr is not a function');
          },
          totalPayout: () => 200_000_000n,
          DISPUTE_WINDOW: () => 345_600n,
        },
      });
      await expect(classifySettledRefund(client, AGREEMENT)).resolves.toEqual({
        kind: 'unknown',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('disputeFee()');
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── refundNotifCopy ─────────────────────────────────────────────────────────

/** Нечётный котёл 33 юнита: 16 исполнителю, 17 клиенту — суммы РАЗНЫЕ. */
const ODD_SPLIT: SettledRefund = { kind: 'split', toClient: 17n, toExecutor: 16n };

describe('refundNotifCopy — дележ', () => {
  it('клиенту: его сумма как «вам», сумма исполнителя как «исполнителю»', () => {
    const { title, body } = refundNotifCopy(ODD_SPLIT, 'client');
    expect(title).toBe('Escrow Split');
    expect(body).toContain('0.000017 USDC to you');
    expect(body).toContain('0.000016 USDC to the executor');
  });

  it('исполнителю: те же две суммы, но роли наоборот', () => {
    const { title, body } = refundNotifCopy(ODD_SPLIT, 'executor');
    expect(title).toBe('Escrow Split');
    expect(body).toContain('0.000016 USDC to you');
    expect(body).toContain('0.000017 USDC to the client');
  });

  it('ни одной стороне не говорит про отмену или возврат', () => {
    for (const role of ['client', 'executor'] as const) {
      const { body } = refundNotifCopy(ODD_SPLIT, role);
      expect(body).not.toMatch(/refund/i);
      expect(body).not.toMatch(/cancel/i);
    }
  });

  // Та самая ветка: половина исполнителя не доехала и ушла клиенту. Ему нельзя
  // сказать «0.000016 USDC to you» — он не получил ничего.
  it('заблокированный исполнитель видит свой ноль, клиент — весь котёл', () => {
    const blocked: SettledRefund = { kind: 'split', toClient: 200_000_000n, toExecutor: 0n };
    expect(refundNotifCopy(blocked, 'executor').body).toContain('0.00 USDC to you');
    expect(refundNotifCopy(blocked, 'client').body).toContain('200.00 USDC to you');
    expect(refundNotifCopy(blocked, 'client').body).toContain('0.00 USDC to the executor');
  });
});

describe('refundNotifCopy — дележ без сумм', () => {
  const BLIND: SettledRefund = { kind: 'split-amounts-unknown' };

  it('говорит, что дележ был и судить было некому', () => {
    const { title, body } = refundNotifCopy(BLIND, 'client');
    expect(title).toBe('Escrow Split');
    expect(body).toContain('Nobody took the dispute');
    expect(body).toContain('the escrow was split');
  });

  it('отправляет за суммой в кошелёк и не называет ни одной сам', () => {
    for (const role of ['client', 'executor'] as const) {
      const { body } = refundNotifCopy(BLIND, role);
      expect(body).toContain('check your wallet');
      expect(body).not.toMatch(/USDC/);
      expect(body).not.toMatch(/\d/);
    }
  });

  // «Половина» здесь была бы догадкой того же сорта, что и число: в ветке
  // заблокированного исполнителя половин не было — весь котёл ушёл клиенту.
  it('не обещает половину ни словом, ни числом, и не зовёт это возвратом', () => {
    for (const role of ['client', 'executor'] as const) {
      const { body } = refundNotifCopy(BLIND, role);
      expect(body).not.toMatch(/\bhalf\b/i);
      expect(body).not.toMatch(/refund/i);
      expect(body).not.toMatch(/cancel/i);
    }
  });

  // Роль не участвует намеренно: сказать «твоя доля» нельзя ни одной стороне.
  it('обеим сторонам одно и то же', () => {
    expect(refundNotifCopy(BLIND, 'client')).toEqual(refundNotifCopy(BLIND, 'executor'));
  });

  // Заголовок общий с точным дележом намеренно: событие одно и то же, разная
  // только полнота сведений о нём.
  it('заголовок тот же, что у дележа с суммами', () => {
    expect(refundNotifCopy(BLIND, 'client').title)
      .toBe(refundNotifCopy(ODD_SPLIT, 'client').title);
    // ...но текст — другой: точный называет суммы, этот нет.
    expect(refundNotifCopy(BLIND, 'client').body)
      .not.toBe(refundNotifCopy(ODD_SPLIT, 'client').body);
  });

  // Это не «не знаем»: там неизвестен САМ исход, здесь — только суммы.
  it('не тот же текст, что у полностью непрочитанного исхода', () => {
    expect(refundNotifCopy(BLIND, 'client').title)
      .not.toBe(refundNotifCopy({ kind: 'unknown' }, 'client').title);
  });
});

describe('refundNotifCopy — возврат и «не знаем»', () => {
  it('клиенту деньги вернулись', () => {
    expect(refundNotifCopy({ kind: 'refund' }, 'client')).toEqual({
      title: 'Deal Refunded',
      body: 'Funds returned to your wallet.',
    });
  });

  it('исполнителю — что вернулись клиенту, а не ему', () => {
    const { title, body } = refundNotifCopy({ kind: 'refund' }, 'executor');
    expect(title).toBe('Deal Refunded');
    expect(body).toBe('The deal was refunded to the client.');
    expect(body).not.toMatch(/your wallet/i);
  });

  it('исход не прочитан: не называет ни возврат, ни дележ и ни одной суммы', () => {
    for (const role of ['client', 'executor'] as const) {
      const { title, body } = refundNotifCopy({ kind: 'unknown' }, role);
      expect(title).toBe('Deal Closed');
      expect(body).toContain("couldn't read how the escrow was settled");
      expect(body).not.toMatch(/USDC/);
    }
  });
});
