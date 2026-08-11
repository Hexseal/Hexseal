/**
 * Пункт 44, БОЕВАЯ половина: Next-маршрут /api/relay.
 *
 * ⚠️ Это единственный путь, по которому гейслесс идёт СЕГОДНЯ. Релеерный
 * POST /relay помечен в самом коде как «unused until VPS migration»
 * (relayer/app.js:1913-1916). Значит замок, проверенный только там, в бою не
 * значит ничего — и наоборот: мутация «снять вызов из route.ts» обязана
 * краснеть здесь, иначе задача не сделана.
 *
 * Половина сцен взята из общего договора shared/relay-target-scenes.json —
 * того же, что читает relayer/test/relayTargetGuard.test.js. Шов между двумя
 * рантаймами не принадлежит никому, поэтому обе стороны отвечают на один
 * список сцен ПОВЕДЕНИЕМ: статус, код, число чтений реестра, отправлена ли
 * транзакция.
 *
 * ⚠️ Окружения отрисовки здесь нет и не нужно: это серверный обработчик,
 * зовётся напрямую как функция (тот же приём, что в src/app/api/push/route.test.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Ставится ДО импорта маршрута: без ключа он отвечает 503 «Gasless relay
// unavailable» ещё до всякого замка (route.ts:280).
process.env.RELAYER_PRIVATE_KEY = '0x' + '11'.repeat(32);
// Пустые — чтобы хвостовой поход за пушем (route.ts:620-631) не состоялся:
// он ходит в сеть, а к замку цели отношения не имеет.
process.env.RELAYER_INTERNAL_URL = '';
process.env.NEXT_PUBLIC_RELAYER_URL = '';
process.env.PUSH_SECRET = '';

// vi.hoisted — потому что vi.mock поднимается наверх файла, и обычная const
// оказалась бы в мёртвой зоне, если бы фабрика мока выполнилась раньше.
const цепь = vi.hoisted(() => ({
  чтенийРеестра: 0,
  проверокПодписи: 0,
  записей: 0,
  молчит: false,
  запись: (_addr: string): unknown => null,
}));

vi.mock('viem', async (importActual) => {
  const actual = await importActual<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBalance: async () => 10n ** 18n,
      readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'verify') { цепь.проверокПодписи += 1; return true; }
        if (functionName === 'getRecord') {
          цепь.чтенийРеестра += 1;
          if (цепь.молчит) throw new Error('узел молчит');
          return цепь.запись(String(args[0]));
        }
        throw new Error(`неожиданное чтение с цепи: ${functionName}`);
      },
      simulateContract: async () => ({ result: [true, '0x'] }),
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
    }),
    createWalletClient: () => ({
      writeContract: async () => { цепь.записей += 1; return '0x' + 'de'.repeat(32); },
    }),
  };
});

const { POST } = await import('./route');
const { _resetRelayTargetCacheForTest, relayTargetVerdict } = await import('@/lib/relayTarget');
const { CONTRACTS } = await import('@/config/contracts');

const ZERO      = '0x0000000000000000000000000000000000000000';
const DIAMOND   = CONTRACTS.diamond.toLowerCase();
const AGREEMENT = '0xa9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9';
// Настоящий чужой контракт: тестовый USDC Base Sepolia.
const FOREIGN   = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const EOA       = '0xee01ee01ee01ee01ee01ee01ee01ee01ee01ee01';
const CLIENT    = '0xc11e1700000000000000000000000000000000c1';
const EXECUTOR  = '0xe8ec0000000000000000000000000000000000e8';

const ДОГОВОР = JSON.parse(
  readFileSync(new URL('../../../../../shared/relay-target-scenes.json', import.meta.url), 'utf8'),
) as { сцены: Сцена[] };

interface Сцена {
  имя: string;
  цель: 'diamond' | 'agreement' | 'foreign' | 'eoa';
  цепь: 'отвечает' | 'молчит';
  исход: 'пропуск' | 'отказ';
  статус: number;
  код: string | null;
  чтенийРеестра: number;
}

const СЦЕНЫ = ДОГОВОР.сцены;
const ЦЕЛЬ: Record<Сцена['цель'], string> = {
  diamond: DIAMOND, agreement: AGREEMENT, foreign: FOREIGN, eoa: EOA,
};

// status: 0 — это ACTIVE в RegistryStorage.AgreementStatus, поэтому пустая
// запись незнакомого адреса выглядит «активной». Существование сверяется
// адресом (мутация 8).
const ПУСТАЯ = {
  agreement: ZERO, client: ZERO, executor: ZERO,
  amount: 0n, status: 0, createdAt: 0n, resolvedAt: 0n,
};
const НАША = {
  agreement: AGREEMENT, client: CLIENT, executor: EXECUTOR,
  amount: 1_000_000n, status: 0, createdAt: 1n, resolvedAt: 0n,
};

function поднятьЦепь({
  молчит = false,
  запись = (addr: string): unknown => (addr.toLowerCase() === AGREEMENT ? НАША : ПУСТАЯ),
} = {}) {
  цепь.чтенийРеестра = 0;
  цепь.проверокПодписи = 0;
  цепь.записей = 0;
  цепь.молчит = молчит;
  цепь.запись = запись;
}

// Ограничитель маршрута — 10/мин ПО КОШЕЛЬКУ from (route.ts:166-177), карта
// живёт в модуле и между тестами не сбрасывается. Свой кошелёк на каждый
// запрос: иначе файл упёрся бы в 429 и покраснел не по той причине.
let счётчикКошельков = 0;
function отправить(to: string, extra: Record<string, unknown> = {}) {
  счётчикКошельков += 1;
  const body = {
    from: `0x${String(счётчикКошельков).padStart(40, '0')}`,
    to,
    value: '0',
    gas: '100000',
    nonce: '0',
    data: '0xabcdef',
    signature: '0x' + '11'.repeat(65),
    ...extra,
  };
  return POST(new Request('http://localhost/api/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never);
}

describe('Пункт 44 (Next, боевой путь): платим газ только за свои контракты', () => {
  beforeEach(() => {
    _resetRelayTargetCacheForTest();
    поднятьЦепь();
  });

  it('договор двух путей на месте, и в нём ровно шесть сцен', () => {
    // Число руками. Добавивший сцену обязан прийти сюда — и в
    // relayer/test/relayTargetGuard.test.js, на другую сторону шва.
    expect(Array.isArray(СЦЕНЫ)).toBe(true);
    expect(СЦЕНЫ.length).toBe(6);
  });

  for (const сцена of СЦЕНЫ) {
    it(`шов: ${сцена.имя}`, async () => {
      поднятьЦепь({ молчит: сцена.цепь === 'молчит' });

      const res = await отправить(ЦЕЛЬ[сцена.цель]);
      const json = await res.json();

      expect(res.status).toBe(сцена.статус);
      if (сцена.исход === 'пропуск') {
        expect(json.success).toBe(true);
        expect(цепь.записей).toBe(1);
      } else {
        expect(json.code).toBe(сцена.код);
        expect(цепь.записей).toBe(0);
      }
      expect(цепь.чтенийРеестра).toBe(сцена.чтенийРеестра);
    });
  }

  it('чужая цель с permit-параметрами — USDC.permit НЕ отправлен', async () => {
    // Главная причина, почему замок стоит ДО permit: permit уходит отдельной
    // транзакцией с НАШЕГО кошелька (route.ts:345-359) ещё до форварда. Замок
    // ниже него оставил бы дыру «цель чужая, а за permit мы заплатили».
    const кошелёк = `0x${String(9001).padStart(40, '0')}`;
    const res = await отправить(FOREIGN, {
      from: кошелёк,
      permitOwner: кошелёк,
      permitSpender: FOREIGN,
      permitValue: '1000000',
      permitDeadline: '9999999999',
      permitV: 27,
      permitR: '0x' + '22'.repeat(32),
      permitS: '0x' + '33'.repeat(32),
    });

    expect(res.status).toBe(403);
    expect(цепь.записей).toBe(0);   // ни permit, ни execute
  });

  it('замок стоит ДО проверки подписи — у чужой цели её не спрашивали', async () => {
    const res = await отправить(FOREIGN);

    expect(res.status).toBe(403);
    expect(цепь.проверокПодписи).toBe(0);
    expect(цепь.записей).toBe(0);
  });

  it('мусор вместо записи реестра — 503 и ни одной транзакции, а не 500', async () => {
    поднятьЦепь({ запись: () => 'нет' });

    const res = await отправить(AGREEMENT);

    expect(res.status).toBe(503);
    expect(цепь.записей).toBe(0);
  });

  it('второй вызов к тому же агрименту цепи не спрашивает, а после перезапуска — спрашивает снова', async () => {
    await отправить(AGREEMENT);
    expect(цепь.чтенийРеестра).toBe(1);

    await отправить(AGREEMENT);
    expect(цепь.чтенийРеестра).toBe(1);

    _resetRelayTargetCacheForTest();
    const res = await отправить(AGREEMENT);
    expect(res.status).toBe(200);
    expect(цепь.чтенийРеестра).toBe(2);
  });

  it('чужой адрес НЕ запоминается: оба раза 403 и оба раза чтение цепи', async () => {
    const первый = await отправить(FOREIGN);
    const второй = await отправить(FOREIGN);

    expect(первый.status).toBe(403);
    expect(второй.status).toBe(403);
    expect(цепь.чтенийРеестра).toBe(2);
  });

  it('пятьдесят одновременных вопросов об одном агрименте — одно чтение цепи', async () => {
    // Прямой вызов модуля: пятьдесят HTTP-запросов померили бы ограничитель
    // 10/мин, а не склейку. Проводку в маршрут меряют сцены выше.
    let чтений = 0;
    const читалка = async (addr: `0x${string}`) => { чтений += 1; return НАША; };

    const ответы = await Promise.all(
      Array.from({ length: 50 }, () => relayTargetVerdict(AGREEMENT, DIAMOND, читалка)),
    );

    expect(ответы.every((v) => v.ok === true)).toBe(true);
    expect(чтений).toBe(1);
    // eslint-disable-next-line no-console
    console.info(`[замер] 50 одновременных вопросов → чтений цепи: ${чтений}`);
  });

  it('кэш ограничен размером: 1001-й адрес вытесняет самый первый', async () => {
    let чтений = 0;
    const читалка = async (addr: `0x${string}`) => {
      чтений += 1;
      return { ...НАША, agreement: String(addr).toLowerCase() };
    };
    const адрес = (i: number) => `0x${String(i).padStart(40, '0')}`;

    for (let i = 1; i <= 1001; i++) await relayTargetVerdict(адрес(i), DIAMOND, читалка);
    expect(чтений).toBe(1001);

    await relayTargetVerdict(адрес(1001), DIAMOND, читалка);
    expect(чтений).toBe(1001);          // свежий — из кэша

    await relayTargetVerdict(адрес(1), DIAMOND, читалка);
    expect(чтений).toBe(1002);          // первый — вытеснен
  });
});
