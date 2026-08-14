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
 *
 * ⚠️ РЕВЬЮ КРУГ 1. Фикстуры адресов — CHECKSUM-регистра (`viem.getAddress`),
 * не строчные. Замерено: строчные фикстуры делали `.toLowerCase()`-нормализацию
 * в `readOnce` (relayTarget.ts) МЁРТВЫМ замком (находка 2) — убери её, тесты не
 * заметят, потому что запись УЖЕ была строчной и совпадала без нормализации.
 * Checksum заставляет нормализацию реально что-то делать.
 *
 * ⚠️ РЕВЬЮ КРУГ 2, БЛОКЕР -> КРУГ 3, ИСПРАВЛЕНО. `checkRateLimit(from)`
 * (route.ts) ключуется строкой из тела запроса БЕЗ проверки формата —
 * нападающему не нужны ни кошелёк, ни подпись, только менять `from`. Опрос
 * круга 1 впервые сделал это дорогим. Круг 2 предложил три средства; круг 3
 * оставил ОДНО:
 *  1. бюджет опроса ВОЗВРАЩЁН к 9 (круг 2 временно сжимал до 4, ссылаясь на
 *     цифру из тестовой сцены «отстаёт», не на замер — отменено на круге 3;
 *     настоящий замер лага — `lib/walletLock.ts:166-172`, доктрина
 *     трёхкратного запаса, см. докстринг `RELAY_TARGET_POLL`);
 *  2. короткий отрицательный кэш УБРАН (заводился на круге 2, снят на круге
 *     3 — переносил неудачу первого спросившего на любого другого, включая
 *     контрагента по той же свежесозданной сделке);
 *  3. НАСТОЯЩИЙ ограничитель по IP — вот тут, в этом файле
 *     (`@/lib/rpcProxy`: `requestSourceIp`+`checkRpcRateLimit`,
 *     переиспользованы, не написаны заново) — единственное из трёх средств,
 *     пережившее круг 3. ⚠️ Каждый вызов `отправить()` ниже получает
 *     УНИКАЛЬНЫЙ IP по умолчанию — иначе файл упёрся бы в 429 от ЭТОГО ЖЕ
 *     лимитера на пробеге всех сцен, и это была бы не та причина.
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
  // Ревью круг 1, находка 1: сколько раз подряд ЛЮБОЙ адрес получает пустую
  // запись, прежде чем `запись()` начнёт отвечать по-настоящему — симуляция
  // реплики, ещё не увидевшей блок регистрации свежего Agreement.
  отстаётПопыток: 0,
  // Итоговое ревью ветки, правка 4: ПЕРВОЕ чтение разбирается и отдаёт пустую
  // запись («не наш» отставшей реплики), все последующие БРОСАЮТ — узел мигнул
  // ровно посреди опроса. Сцена 8 договора.
  замолкаетПослеПервого: false,
  попыткиПоАдресу: new Map<string, number>(),
  // Волна правок общего ревью, правка 1: что вернула симуляция форвардера.
  // `null` — внутренний вызов прошёл. Строка — он ОТКАЗАЛ, и это её `retdata`,
  // то есть ровно те байты, из которых маршрут обязан достать причину.
  внутреннийОтказ: null as string | null,
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
          const addr = String(args[0]).toLowerCase();
          if (цепь.замолкаетПослеПервого) {
            if (цепь.чтенийРеестра > 1) throw new Error('узел замолчал посреди опроса (test)');
            return { agreement: '0x0000000000000000000000000000000000000000', client: '0x0000000000000000000000000000000000000000', executor: '0x0000000000000000000000000000000000000000', amount: 0n, status: 0, createdAt: 0n, resolvedAt: 0n };
          }
          if (цепь.отстаётПопыток > 0) {
            const n = (цепь.попыткиПоАдресу.get(addr) ?? 0) + 1;
            цепь.попыткиПоАдресу.set(addr, n);
            if (n <= цепь.отстаётПопыток) {
              return { agreement: '0x0000000000000000000000000000000000000000', client: '0x0000000000000000000000000000000000000000', executor: '0x0000000000000000000000000000000000000000', amount: 0n, status: 0, createdAt: 0n, resolvedAt: 0n };
            }
          }
          return цепь.запись(addr);
        }
        throw new Error(`неожиданное чтение с цепи: ${functionName}`);
      },
      // ⚠️ `execute()` НЕ РЕВЕРТИТ на отказе внутреннего вызова — он отдаёт
      // `(false, retdata)`. Подделка обязана уметь и это, иначе сцена «кнопка
      // не сработала, и вот почему» на этом стенде НЕВОЗМОЖНА, а таблица
      // причин остаётся непроверенной в употреблении.
      simulateContract: async () => ({
        result: цепь.внутреннийОтказ === null ? [true, '0x'] : [false, цепь.внутреннийОтказ],
      }),
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
    }),
    createWalletClient: () => ({
      writeContract: async () => { цепь.записей += 1; return '0x' + 'de'.repeat(32); },
    }),
  };
});

const { POST } = await import('./route');
const {
  _resetRelayTargetCacheForTest, relayTargetVerdict, REGISTRY_RECORD_ABI,
  RELAY_TARGET_POLL, RELAY_TARGET_CACHE_MAX,
} = await import('@/lib/relayTarget');
const { CONTRACTS } = await import('@/config/contracts');
// Настоящий decodeFunctionResult viem — `vi.mock('viem', …)` выше подменяет
// только createPublicClient/createWalletClient, остальное идёт из `...actual`.
const { decodeFunctionResult, getAddress } = await import('viem');

// Бюджет опроса задан в lib/relayTarget.ts (attempts=9, intervalMs=750) —
// проверен self-check тестом ниже ДО того, как эта строка его меняет; здесь
// только убираем реальный сон, чтобы файл не ждал секунды на отказанных целях.
const БЮДЖЕТ_ПО_УМОЛЧАНИЮ = { ...RELAY_TARGET_POLL };
RELAY_TARGET_POLL.intervalMs = 0;

const ZERO      = '0x0000000000000000000000000000000000000000';
const DIAMOND   = CONTRACTS.diamond.toLowerCase();
const AGREEMENT = getAddress('0xa9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9');
// Настоящий чужой контракт: тестовый USDC Base Sepolia.
const FOREIGN   = getAddress('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
const EOA       = getAddress('0xee01ee01ee01ee01ee01ee01ee01ee01ee01ee01');
const CLIENT    = getAddress('0xc11e1700000000000000000000000000000000c1');
const EXECUTOR  = getAddress('0xe8ec0000000000000000000000000000000000e8');

const ДОГОВОР = JSON.parse(
  readFileSync(new URL('../../../../../shared/relay-target-scenes.json', import.meta.url), 'utf8'),
) as { сцены: Сцена[]; кэшРазмер: number };

interface Сцена {
  имя: string;
  цель: 'diamond' | 'agreement' | 'foreign' | 'eoa';
  цепь: 'отвечает' | 'молчит' | 'отстаёт' | 'замолкает';
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
  отстаётПопыток = 0,
  замолкаетПослеПервого = false,
  запись = (addr: string): unknown => (addr.toLowerCase() === AGREEMENT.toLowerCase() ? НАША : ПУСТАЯ),
} = {}) {
  цепь.чтенийРеестра = 0;
  цепь.проверокПодписи = 0;
  цепь.записей = 0;
  цепь.молчит = молчит;
  цепь.запись = запись;
  цепь.отстаётПопыток = отстаётПопыток;
  цепь.замолкаетПослеПервого = замолкаетПослеПервого;
  цепь.попыткиПоАдресу = new Map();
  цепь.внутреннийОтказ = null;
}

// Ограничитель маршрута — 10/мин ПО КОШЕЛЬКУ from (route.ts:166-177), карта
// живёт в модуле и между тестами не сбрасывается. Свой кошелёк на каждый
// запрос: иначе файл упёрся бы в 429 и покраснел не по той причине.
//
// Ревью круг 2: с этого круга ЕСТЬ и второй, IP-ограничитель (route.ts,
// RELAY_IP_RATE_MAX=30), с тем же свойством «карта не сбрасывается между
// тестами». Свой IP на каждый запрос по умолчанию — по той же причине, что и
// свой кошелёк; `ip` можно передать явно там, где ограничитель IP — то, что
// проверяется.
let счётчикКошельков = 0;
let счётчикIP = 0;
function отправить(to: string, extra: Record<string, unknown> = {}, ip?: string) {
  счётчикКошельков += 1;
  счётчикIP += 1;
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
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip ?? `198.51.100.${(счётчикIP % 65000) + 1}-${счётчикIP}`,
    },
    body: JSON.stringify(body),
  }) as never);
}

describe('Пункт 44 (Next, боевой путь): платим газ только за свои контракты', () => {
  beforeEach(() => {
    _resetRelayTargetCacheForTest();
    поднятьЦепь();
  });

  it('договор двух путей на месте, и в нём ровно восемь сцен', () => {
    // Число руками. Добавивший сцену обязан прийти сюда — и в
    // relayer/test/relayTargetGuard.test.js, на другую сторону шва.
    expect(Array.isArray(СЦЕНЫ)).toBe(true);
    expect(СЦЕНЫ.length).toBe(8);
  });

  it('потолок кэша сверен с договором двух путей — не две несверенные копии', () => {
    expect(RELAY_TARGET_CACHE_MAX).toBe(ДОГОВОР.кэшРазмер);
  });

  it('бюджет опроса — 9 попыток по 750 мс, то же число, что NONCE_POLL_ATTEMPTS (lib/walletLock.ts) — настоящий замер лага и доктрина трёхкратного запаса, не цифра из тестовой сцены', () => {
    expect(БЮДЖЕТ_ПО_УМОЛЧАНИЮ.attempts).toBe(9);
    expect(БЮДЖЕТ_ПО_УМОЛЧАНИЮ.intervalMs).toBe(750);
  });

  for (const сцена of СЦЕНЫ) {
    it(`шов: ${сцена.имя}`, async () => {
      поднятьЦепь({
        молчит: сцена.цепь === 'молчит',
        отстаётПопыток: сцена.цепь === 'отстаёт' ? сцена.чтенийРеестра - 1 : 0,
        замолкаетПослеПервого: сцена.цепь === 'замолкает',
      });

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

  it('мусор вместо записи реестра — 503 и ни одной транзакции, а не 500; ОДНО чтение, не опрос', async () => {
    // «Не смогли прочитать» — не гонка отставшей реплики, повтор её не лечит
    // (правило 1: сбой первой попытки — наружу без опроса).
    поднятьЦепь({ запись: () => 'нет' });

    const res = await отправить(AGREEMENT);

    expect(res.status).toBe(503);
    expect(цепь.записей).toBe(0);
    expect(цепь.чтенийРеестра).toBe(1);
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

  it('чужой адрес НЕ запоминается: оба раза 403 и оба раза полный опрос цепи', async () => {
    // Ревью круг 2 заводил короткий отрицательный кэш здесь — круг 3 его
    // убрал: он переносил неудачу ПЕРВОГО спросившего на ЛЮБОГО другого, кто
    // спросил про тот же адрес в течение TTL, включая контрагента по той же
    // самой свежесозданной сделке с собственным независимым шансом на опрос.
    // Кэшировать отказ нельзя и по старой причине (обоснование 5 исходного
    // плана): адрес станет нашим в ту секунду, когда acceptApplicant/
    // acceptRequest/deployAndFund создадут и зарегистрируют сделку.
    const первый = await отправить(FOREIGN);
    const второй = await отправить(FOREIGN);

    expect(первый.status).toBe(403);
    expect(второй.status).toBe(403);
    expect(цепь.чтенийРеестра).toBe(2 * RELAY_TARGET_POLL.attempts);
  });

  it('смешанный случай, где узел ОТВЕТИЛ хоть раз: «не наш» подтверждён живым узлом — 403, не 503', async () => {
    // Обратная сторона сцены 8, и без неё правка «замолчал → 503» была бы
    // соблазнительно широкой: одна моргнувшая проба посреди опроса НЕ делает
    // отказ неизвестностью — узел отвечал и подтвердил «не наш» восемь раз.
    let n = 0;
    поднятьЦепь({
      запись: () => {
        n += 1;
        if (n === 2) throw new Error('узел моргнул на второй пробе (test)');
        return ПУСТАЯ;
      },
    });

    const res = await отправить(FOREIGN);
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('target_not_ours');
    expect(цепь.записей).toBe(0);
    expect(цепь.чтенийРеестра).toBe(RELAY_TARGET_POLL.attempts);
  });

  it('отставшая реплика: два пустых чтения, третье видит запись — пускаем БЕЗ повторной отправки согласия', async () => {
    поднятьЦепь({ отстаётПопыток: 2 });

    const res = await отправить(AGREEMENT);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(цепь.чтенийРеестра).toBe(3);
    expect(цепь.записей).toBe(1);
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

  it('кэш ограничен размером: 1001-й адрес вытесняет РОВНО самый первый, не больше', async () => {
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

    // ⚠️ Пин точного потолка (ревью круг 1, мелочь): без этой строки тест
    // проходит при ЛЮБОМ потолке от 1 до 1000. Адрес 2 остаётся в кэше ТОЛЬКО
    // если потолок РОВНО 1000 — будь он меньше, адрес 2 вытеснился бы раньше.
    await relayTargetVerdict(адрес(2), DIAMOND, читалка);
    expect(чтений).toBe(1001);

    await relayTargetVerdict(адрес(1), DIAMOND, читалка);
    expect(чтений).toBe(1002);          // первый — вытеснен
  });

  // ── Ревью круг 1, находка 3: форма ABI на шве viem↔реестр ──────────────────
  //
  // Все сцены выше подменяют createPublicClient целиком — реальный декодер
  // viem не исполняется НИ РАЗУ, значит регрессия формы ABI (общий DIAMOND_ABI
  // вместо пришпиленного REGISTRY_RECORD_ABI, либо порча компонентов tuple)
  // прошла бы мимо них молча. Этот тест — единственный, что реально зовёт
  // decodeFunctionResult настоящего viem против ТОЧНО ТОЙ ЖЕ константы, что
  // использует маршрут (импортирована из lib/relayTarget.ts — route.ts её
  // только использует, Next запрещает route-файлам чужие экспорты).
  //
  // ⚠️ Тело encode'ится НЕ viem: viem.encodeFunctionResult у этой ABI даёт
  // InvalidAddressError даже под голым `node` (замерено — воспроизводится и
  // без vitest, значит это не мок и не тестовый раннер, а нечто внутри самого
  // viem/окружения на этом дереве). Продакшен-путь только ДЕКОДИРУЕТ ответ
  // цепи, никогда не кодирует его сам — значит decode-путь достаточен и
  // ближе к боевому употреблению. Байты собраны один раз через ethers
  // (relayer/app.js использует ту же библиотеку) и вписаны как есть.
  it('ABI записи реестра декодируется viem как ИМЕНОВАННЫЙ объект — иначе замок молча превращается в вечный 503', () => {
    const raw = ('0x' +
      '000000000000000000000000a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9' +
      '000000000000000000000000c11e1700000000000000000000000000000000c1' +
      '000000000000000000000000e8ec0000000000000000000000000000000000e8' +
      '00000000000000000000000000000000000000000000000000000000000f4240' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000000'
    ) as `0x${string}`;

    const decoded = decodeFunctionResult({
      abi: REGISTRY_RECORD_ABI, functionName: 'getRecord', data: raw,
    }) as { agreement?: unknown; client?: unknown };

    // Если бы tuple потерял имена компонентов, viem отдал бы МАССИВ:
    // Array.isArray(decoded) === true, а decoded.agreement === undefined —
    // ровно то, что readOnce читает как «не разбирается» → бросок → 503
    // chain_unavailable на каждый агриментный вызов денежного пути, хотя
    // цепь ответила прекрасно.
    expect(Array.isArray(decoded)).toBe(false);
    expect(typeof decoded.agreement).toBe('string');
    expect((decoded.agreement as string).toLowerCase()).toBe(AGREEMENT.toLowerCase());
  });

  // ── Ревью круг 2, блокер (пункт 3) — ЕДИНСТВЕННОЕ из трёх средств круга 2,
  // пережившее круг 3: ограничитель по IP ──────────────────────────────────
  describe('ограничитель по IP — настоящий, а не по строке, которую выбирает нападающий', () => {
    it('30 запросов с ОДНОГО IP проходят, 31-й получает 429 — ДАЖЕ с разными кошельками и БЕЗ единого чтения реестра', async () => {
      // Каждый запрос — свой `from` (как обычно даёт отправить()), но ОДИН и
      // тот же IP: это ровно сценарий находки — нападающему не нужен ни
      // кошелёк, ни подпись, только смена `from`. Если бы ограничивал только
      // checkRateLimit(from), все 31 прошли бы — каждый `from` свой.
      const ip = '203.0.113.7';
      const ответы: number[] = [];
      let последнееТело: { error?: string } | undefined;
      for (let i = 0; i < 31; i++) {
        const res = await отправить(FOREIGN, {}, ip);
        ответы.push(res.status);
        if (i === 30) последнееТело = await res.json();
      }

      const последний = ответы[ответы.length - 1];
      expect(последний).toBe(429);
      expect(ответы.slice(0, 30).every((s) => s === 403)).toBe(true); // цель чужая — но ограничитель их пропустил
      // Ревью круг 3, мелочь: текст отказа приведён к тому же виду, что у
      // существующего ограничителя по кошельку (checkRateLimit) — не
      // "(IP). Please slow down.", а тот же шаблон "Rate limit exceeded. Max
      // N requests per minute.".
      expect(последнееТело?.error).toBe('Rate limit exceeded. Max 30 requests per minute.');
      // eslint-disable-next-line no-console
      console.info(`[замер] с одного IP: 30 прошли до ограничителя цели, 31-й — 429 от лимитера`);
    });

    it('запрос сверх лимита IP не тратит НИ ОДНОГО чтения реестра — 429 раньше замка цели', async () => {
      const ip = '203.0.113.8';
      for (let i = 0; i < 30; i++) await отправить(AGREEMENT, {}, ip);
      цепь.чтенийРеестра = 0; // считаем только 31-й запрос
      цепь.записей = 0;

      const res = await отправить(AGREEMENT, {}, ip);

      expect(res.status).toBe(429);
      expect(цепь.чтенийРеестра).toBe(0);
      expect(цепь.записей).toBe(0);
    });

    it('РАЗНЫЕ IP не делят один бюджет — сосед не платит за нападающего', async () => {
      const нападающий = '203.0.113.9';
      for (let i = 0; i < 31; i++) await отправить(FOREIGN, {}, нападающий); // исчерпал свой лимит

      const сосед = await отправить(AGREEMENT, {}, '203.0.113.10');
      expect(сосед.status).toBe(200); // свежий IP, свой бюджет цел
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Волна правок общего ревью, правка 1: таблица причин отказа — УПОТРЕБЛЕНИЕ
//
// ⚠️ ЧЕГО ЗДЕСЬ НЕ БЫЛО. Состав таблицы `CUSTOM_ERRORS` сторожится
// (`lib/presentationDigestAbi.test.ts`: каждая ошибка фасета названа) — убрать
// запись даёт 1 красный. А вот что маршрут таблицей ПОЛЬЗУЕТСЯ, не сторожило
// ничто: замер общего ревью — обернуть обращение в `if (false && …)` даёт 0
// красных из 2751. В релеере та же мутация давала 1 (`test/relay.test.js`:
// «rejects without broadcasting…»), и асимметрия сидела ровно на том пути, по
// которому ходит браузер.
//
// Класс промаха — «замок ищет имя, а не употребление»: запись в таблице есть,
// а пользуется ей никто. Ровно так пять ошибок платного вызова арбитра
// (31 июля) полмесяца жили в релеере и не жили здесь, и человек вместо «спор
// уже взят» читал `Inner call reverted`.
//
// ⚠️ ПОЧЕМУ ЭТО ВООБЩЕ ВОЗМОЖНО МОЛЧА: `MinimalForwarder.execute()` на отказе
// внутреннего вызова НЕ ревертит — он отдаёт `(false, retdata)` и майнится
// успешно. Разобрать четыре байта обязан маршрут, и никто, кроме него.
// ═══════════════════════════════════════════════════════════════════════════

describe('причина отказа доезжает до человека словом, а не сырым хексом', () => {
  beforeEach(() => {
    _resetRelayTargetCacheForTest();
    поднятьЦепь();
  });

  /** Тело `Error(string)` — то же, что кладёт `require("...")` солидити. */
  const ошибкаСтрокой = (текст: string): string => {
    const hex = Buffer.from(текст, 'utf8').toString('hex');
    const words = Math.ceil(hex.length / 64) || 1;
    return '0x08c379a0'
      + (32).toString(16).padStart(64, '0')                       // смещение
      + Buffer.byteLength(текст, 'utf8').toString(16).padStart(64, '0')  // длина
      + hex.padEnd(words * 64, '0');
  };

  const отказать = async (retdata: string) => {
    цепь.внутреннийОтказ = retdata;
    const res = await отправить(AGREEMENT);
    return { res, json: await res.json() as { error?: string; errorCode?: string } };
  };

  // Взяты из РАЗНЫХ полос таблицы: одна из пяти отставших (31 июля), одна из
  // шести этой выкатки, одна из старого ядра Agreement.sol. Одна пара
  // доказывала бы только себя.
  const ПАРЫ: [string, string][] = [
    ['0xd3fc8f8a', 'DisputeAlreadyClaimed'],   // «спор уже взят» — та самая
    ['0x277093f8', 'TopUpNotNeeded'],          // «доплата не нужна» — та самая
    ['0x7c27222a', 'NoResponseTooEarly'],      // 4в-2 Выкатка 2
    ['0x5adf6387', 'AlreadyFunded'],           // ядро Agreement.sol
  ];

  for (const [селектор, имя] of ПАРЫ) {
    it(`${селектор} → «${имя}», а не «Inner call reverted»`, async () => {
      const { res, json } = await отказать(селектор);

      expect(res.status).toBe(400);
      expect(json.error, 'селектор не разобран — человек читает хекс').toBe(`Call failed: ${имя}`);
      // Машинная половина ответа — отдельная: по ней фронт ветвится.
      expect(json.errorCode).toBe(селектор);
      // И ни одной транзакции: обречённую не отправляем и газ за неё не платим.
      expect(цепь.записей).toBe(0);
    });
  }

  it('селектора нет в таблице — честное «Inner call reverted» и сам селектор рядом', async () => {
    // ⚠️ ОБРАТНАЯ СТОРОНА, И БЕЗ НЕЁ ПРОВЕРКИ ВЫШЕ ТАВТОЛОГИЧНЫ: если бы
    // маршрут отвечал именем ВСЕГДА, они прошли бы и при мёртвой таблице.
    // Здесь видно, что «Inner call reverted» — настоящий запасной ответ, то
    // есть ровно то, что человек и получал полмесяца по пяти ошибкам.
    const { res, json } = await отказать('0xdeadbeef');

    expect(res.status).toBe(400);
    expect(json.error).toBe('Call failed: Inner call reverted');
    expect(json.errorCode).toBe('0xdeadbeef');
  });

  it('старый добрый Error(string) разбирается в текст, а не в имя из таблицы', async () => {
    // Вторая дорога того же разбора: `revert("...")` живёт в USDC и в чужих
    // контрактах, до которых доезжает тот же форвардер.
    const { res, json } = await отказать(ошибкаСтрокой('ERC20: insufficient allowance'));

    expect(res.status).toBe(400);
    expect(json.error).toBe('Call failed: ERC20: insufficient allowance');
  });

  it('регистр селектора не решает: цепь вернула ВЕРХНИЙ, имя всё равно нашлось', async () => {
    // Шов «что приезжает»: `retdata` от чужого узла законно бывает в верхнем
    // регистре, а ключи таблицы — строчные. Без `.toLowerCase()` в маршруте
    // имя не нашлось бы, и промах был бы неотличим от отсутствия записи.
    const { json } = await отказать('0xD3FC8F8A');

    expect(json.error).toBe('Call failed: DisputeAlreadyClaimed');
  });
});
