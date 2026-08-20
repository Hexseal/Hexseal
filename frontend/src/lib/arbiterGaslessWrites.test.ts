/**
 * arbiterGaslessWrites.test.ts — четыре арбитрских входа идут ЧЕРЕЗ РЕЛЕЕР.
 *
 * Правило владельца о трёх родах: арбитр — пользователь, и гейслесс-путь ему
 * обязателен. До 17 августа 2026 вынесение вердикта, финализация и получение
 * награды шли прямой транзакцией, то есть требовали эфира; ответ снятого не был
 * заведён вовсе.
 *
 * ⚠️ ЧТО ИМЕННО ЗАМЕРЯЕТСЯ ЗДЕСЬ, А НЕ РЯДОМ. Не «в файле есть слово Gasless» и
 * не «обёртка экспортируется»: обёртка зовётся целиком, с поддельным кошельком и
 * поддельным `fetch`, и проверяется, что запрос УШЁЛ НА `/api/relay`, что
 * подписан ForwardRequest, и что в кошелёк при этом НЕ ушло ни одной прямой
 * отправки. Сломай обёртку (пусти вызов мимо релеера) — краснеет ровно тот тест,
 * который про релеер, а не сосед про газ.
 *
 * ⚠️ КАЛДАТА ОЖИДАЕТСЯ С ДРУГОЙ СТОРОНЫ ШВА. Ожидаемые байты собираются здесь
 * своей `parseAbi`-строкой, а не импортом того же `ARBITER_REGISTRY_ABI`,
 * которым их собирает `relay.ts`: сверка записи самой с собой не доказывает
 * ничего. Что эти подписи совпадают с КОНТРАКТОМ — отдельный замок
 * (`presentationDigestAbi.test.ts` для реестра, `arbiterAccountabilityAbi.test.ts`
 * для фасета ответственности), и он читает `.sol`, а не ABI фронта.
 *
 * ⚠️ АДРЕСА КОШЕЛЬКОВ У ТЕСТОВ РАЗНЫЕ, И ЭТО НЕ КОСМЕТИКА — та же причина, что в
 * соседнем `fallbackGas.test.ts`: `relay.ts` запоминает израсходованный nonce
 * форвардера, и повтор тем же адресом уходит ждать свежести (9 проб по 750 мс).
 * Поддельное чтение вдобавок отдаёт РАСТУЩИЙ счётчик.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  submitVerdictGasless, finalizeVerdictGasless, withdrawArbiterRewardGasless,
  respondToRemovalGasless,
} from './relay';
import { CONTRACTS } from '@/config/contracts';

const AGREEMENT = '0x00000000000000000000000000000000000000aa' as `0x${string}`;
const DIGEST = ('0x' + '7b'.repeat(32)) as `0x${string}`;

/** Ожидаемые подписи — руками, не импортом из проверяемого модуля. */
const EXPECTED_ABI = parseAbi([
  'function submitVerdict(address agreement, bool clientWins)',
  'function finalizeVerdict(address agreement)',
  'function withdrawArbiterReward()',
  'function respondToRemoval(bytes32 replyDigest)',
]);

/** Ожидаемые потолки — руками, не из `GAS_DEFAULTS`. */
const CEILINGS = {
  submitVerdict:         160_000n,
  finalizeVerdict:       780_000n,
  withdrawArbiterReward: 100_000n,
  // Поднят с 80 000 19 августа 2026: цепь стала принимать ответ во время
  // паузы, и на этой ветке добавился один холодный слот (+2 324, замерено).
  // Число здесь ставится РУКАМИ и не импортируется — в этом весь смысл замка.
  respondToRemoval:       90_000n,
} as const;

type Call = Record<string, unknown>;

/** Счётчик нонсов растёт — см. шапку про шесть секунд. */
let nonceSeq = 0n;

function stand(who: string, estimate: bigint | 'throw' = 100_000n) {
  const sent: Call[] = [];
  const signed: Call[] = [];
  /** Каждое чтение цепи с этого стенда — сюда. Пустой список сверх nonce и есть
   *  доказательство, что путь ничего лишнего у цепи не спрашивает. */
  const reads: Call[] = [];
  const walletClient = {
    account: { address: who as `0x${string}` },
    chain: { id: 84532 },
    async signTypedData(args: Call) { signed.push(args); return ('0x' + 'ab'.repeat(65)) as `0x${string}`; },
    async sendTransaction(args: Call) { sent.push(args); return ('0x' + 'cd'.repeat(32)) as `0x${string}`; },
    async writeContract(args: Call) { sent.push(args); return ('0x' + 'ef'.repeat(32)) as `0x${string}`; },
  };
  const publicClient = {
    async readContract(args: Call) { reads.push(args); return nonceSeq++; },
    async estimateGas() {
      if (estimate === 'throw') throw new Error('execution reverted');
      return estimate;
    },
    async waitForTransactionReceipt() { return { status: 'success' as const }; },
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return { wallet: walletClient as any, node: publicClient as any, sent, signed, reads };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const realFetch = globalThis.fetch;
const posted: Call[] = [];

/** Релеер отвечает как настоящий: `{ txHash }` и `ok`. */
function relayUp(): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    posted.push({ url: _url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ txHash: '0x' + '99'.repeat(32) }) };
  }) as unknown as typeof fetch;
}
/** Ровно тот отказ, который ловит `isRelayDown`. */
function relayDown(): void {
  globalThis.fetch = (async () => { throw new Error('Failed to fetch'); }) as typeof fetch;
}
/** Отказ КОНТРАКТА, а не релеера: 400 с причиной. Фолбэка быть не должно. */
function relayRejects(): void {
  globalThis.fetch = (async () => ({
    ok: false, status: 400, json: async () => ({ error: 'Call failed: NotTheClaimer' }),
  })) as unknown as typeof fetch;
}

beforeEach(() => { globalThis.fetch = realFetch; posted.length = 0; });
afterAll(() => { globalThis.fetch = realFetch; });

/** Тело последнего запроса к релееру. */
function lastPost(): { url: string; body: Record<string, string> } {
  expect(posted.length, 'запрос к релееру не уходил вовсе').toBe(1);
  return posted[0] as { url: string; body: Record<string, string> };
}

describe('вынесение вердикта идёт через релеер', () => {
  it('R1 relay up — запрос ушёл на /api/relay нужной калдатой, прямой отправки нет', async () => {
    const { wallet, node, sent, signed } = stand('0x0000000000000000000000000000000000000101');
    relayUp();
    const out = await submitVerdictGasless(wallet, node, AGREEMENT, true);

    expect(out.fallbackUsed).toBeUndefined();
    expect(sent.length, 'кошелёк отправил транзакцию сам — гейслесса нет').toBe(0);
    expect(signed.length, 'ForwardRequest не подписан').toBe(1);

    const { url, body } = lastPost();
    expect(url).toBe('/api/relay');
    expect(body.to).toBe(CONTRACTS.diamond);
    expect(body.data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'submitVerdict', args: [AGREEMENT, true],
    }));
    // Аргумент доезжает, а не теряется: второй исход даёт другие байты.
    expect(body.data).not.toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'submitVerdict', args: [AGREEMENT, false],
    }));
  });

  it('R2 relay down — прямая транзакция ТОЙ ЖЕ калдатой, потолок из таблицы', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000102', 'throw');
    relayDown();
    const out = await submitVerdictGasless(wallet, node, AGREEMENT, false);

    expect(out.fallbackUsed).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(CONTRACTS.diamond);
    expect(sent[0].data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'submitVerdict', args: [AGREEMENT, false],
    }));
    expect(sent[0].gas).toBe(CEILINGS.submitVerdict);
    expect(CEILINGS.submitVerdict).toBe(160_000n);
  });

  it('R3 отказ КОНТРАКТА фолбэком не переигрывается — иначе платили бы дважды за один отказ', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000103');
    relayRejects();
    await expect(submitVerdictGasless(wallet, node, AGREEMENT, true)).rejects.toThrow(/NotTheClaimer/);
    expect(sent.length, 'после отказа контракта ушла прямая транзакция').toBe(0);
  });
});

describe('финализация вердикта идёт через релеер', () => {
  it('R4 relay up — запрос ушёл на /api/relay, прямой отправки нет', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000104');
    relayUp();
    await finalizeVerdictGasless(wallet, node, AGREEMENT);

    expect(sent.length).toBe(0);
    const { body } = lastPost();
    expect(body.to).toBe(CONTRACTS.diamond);
    expect(body.data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'finalizeVerdict', args: [AGREEMENT],
    }));
  });

  it('R5 узел не оценил — уходит 780 000, а не общее умолчание 500 000', async () => {
    // Ровно тот случай, ради которого запись в таблице и заведена: `resolveDispute`
    // на первой сделке пары начисляет XP обеим сторонам в холодные слоты, и
    // умолчания не хватило бы — транзакция сгорела бы по out of gas.
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000105', 'throw');
    relayDown();
    await finalizeVerdictGasless(wallet, node, AGREEMENT);
    expect(sent[0].gas).toBe(CEILINGS.finalizeVerdict);
    expect(CEILINGS.finalizeVerdict).toBe(780_000n);
    expect(CEILINGS.finalizeVerdict).toBeGreaterThan(500_000n);
  });

  it('R6 узел оценил — уходит оценка с запасом 30%, а не потолок', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000106', 400_000n);
    relayDown();
    await finalizeVerdictGasless(wallet, node, AGREEMENT);
    expect(sent[0].gas).toBe(520_000n);
  });
});

describe('получение награды идёт через релеер', () => {
  it('R7 relay up — запрос ушёл на /api/relay, прямой отправки нет', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000107');
    relayUp();
    await withdrawArbiterRewardGasless(wallet, node);

    expect(sent.length).toBe(0);
    const { body } = lastPost();
    expect(body.to).toBe(CONTRACTS.diamond);
    expect(body.data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'withdrawArbiterReward',
    }));
  });

  it('R8 сумма нигде не передаётся — калдата это голый селектор', async () => {
    // Второй копии арифметики выплаты во фронте нет по конструкции: контракт
    // отдаёт весь остаток и обнуляет счёт. Появись здесь аргумент — он был бы
    // вторым мнением о том, сколько человеку причитается.
    const { wallet, node } = stand('0x0000000000000000000000000000000000000108');
    relayUp();
    await withdrawArbiterRewardGasless(wallet, node);
    expect(lastPost().body.data).toHaveLength(10);
  });

  it('R9 relay down — прямая транзакция с потолком таблицы', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000109', 'throw');
    relayDown();
    const out = await withdrawArbiterRewardGasless(wallet, node);
    expect(out.fallbackUsed).toBe(true);
    expect(sent[0].gas).toBe(CEILINGS.withdrawArbiterReward);
    expect(CEILINGS.withdrawArbiterReward).toBe(100_000n);
  });
});

describe('ответ обвинённого арбитра идёт через релеер', () => {
  it('R10 relay up — запрос ушёл на /api/relay нужной калдатой', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000110');
    relayUp();
    await respondToRemovalGasless(wallet, node, DIGEST);

    expect(sent.length).toBe(0);
    const { body } = lastPost();
    expect(body.to).toBe(CONTRACTS.diamond);
    expect(body.data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'respondToRemoval', args: [DIGEST],
    }));
  });

  it('R11 ОТВЕЧАЮТ ДВОЕ РАЗНЫХ: путь не спрашивает роль ни у кого', async () => {
    // Главное обстоятельство этой обёртки. Отвечают ДВОЕ: снятый, у которого
    // статуса уже нет, и — с 19 августа 2026 — обвинённый, у которого статус
    // ещё есть и работа идёт. Любая проверка «а он арбитр?» по дороге закрыла
    // бы дверь перед одним из них, а «а он НЕ арбитр?» — перед другим.
    // Прежнее имя этого теста утверждало «ОТВЕЧАЕТ ТОТ, КТО УЖЕ НЕ АРБИТР» и
    // стало неправдой в тот же день. Замеряется не текстом, а составом
    // обращений к цепи: единственное законное чтение на пути через релеер —
    // счётчик форвардера.
    const { wallet, node, reads } = stand('0x0000000000000000000000000000000000000111');
    relayUp();
    await respondToRemovalGasless(wallet, node, DIGEST);

    expect(reads.map((r) => r.functionName)).toEqual(['getNonce']);
    expect(reads[0].address).toBe(CONTRACTS.forwarder);
  });

  it('R12 relay down — прямая транзакция ТОЙ ЖЕ калдатой и с потолком таблицы', async () => {
    const { wallet, node, sent } = stand('0x0000000000000000000000000000000000000112', 'throw');
    relayDown();
    const out = await respondToRemovalGasless(wallet, node, DIGEST);
    expect(out.fallbackUsed).toBe(true);
    expect(sent[0].to).toBe(CONTRACTS.diamond);
    expect(sent[0].data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'respondToRemoval', args: [DIGEST],
    }));
    expect(sent[0].gas).toBe(CEILINGS.respondToRemoval);
    expect(CEILINGS.respondToRemoval).toBe(90_000n);
  });

  it('R13 отпечаток доезжает целиком — другой отпечаток даёт другие байты', async () => {
    const other = ('0x' + '1c'.repeat(32)) as `0x${string}`;
    const { wallet, node } = stand('0x0000000000000000000000000000000000000113');
    relayUp();
    await respondToRemovalGasless(wallet, node, other);
    expect(lastPost().body.data).toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'respondToRemoval', args: [other],
    }));
    expect(lastPost().body.data).not.toBe(encodeFunctionData({
      abi: EXPECTED_ABI, functionName: 'respondToRemoval', args: [DIGEST],
    }));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  И ВТОРАЯ ПОЛОВИНА ШВА: ОБЁРТКОЙ НАДО ЕЩЁ И ПОЛЬЗОВАТЬСЯ
 *
 *  Всё выше доказывает, что обёртки ходят через релеер. Ничто выше не
 *  доказывает, что их зовут ЭКРАНЫ: страница могла бы завтра вернуться к
 *  `writeContractAsync`, и замки остались бы зелёными, защищая код, которым
 *  никто не пользуется. Ровно этот класс уже ловили в этом дереве
 *  (`arbiterClaimGateStructure.test.ts`, третий слой).
 *
 *  ⚠️ ЭТО ПРОВЕРКА ПО ТЕКСТУ, и так и написано. Рендерить страницу нечем — у
 *  фронта нет jsdom, окружение `node`. Текст здесь и есть предмет: прямой
 *  `writeContract` в обход обёртки МЕНЯЕТ поведение (кошелёк платит газ сам),
 *  а не «убирает строчку».
 * ═══════════════════════════════════════════════════════════════════════════ */

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/**
 * ⚠️ `lib/relay.ts` ИЗ ОБХОДА ИСКЛЮЧЁН НАМЕРЕННО, а не по недосмотру: прямая
 * отправка живёт там законно — это второй шлюз на молчащий релеер, и он обязан
 * существовать. Запрет касается всех ОСТАЛЬНЫХ мест.
 */
const RELAY_MODULE = 'lib/relay.ts';

/** Арбитрские записи, которым гейслесс обязателен по правилу трёх родов. */
const USER_ARBITER_WRITES = new Set([
  'submitVerdict', 'finalizeVerdict', 'withdrawArbiterReward', 'respondToRemoval',
  'claimDispute', 'commitDisputeClaim', 'releaseDisputeClaim', 'setArbiterChatKey',
  'recordNoResponse', 'recordPresentationDigest', 'fundDispute', 'withdrawDisputeBounty',
  'applyAsArbiter',
]);

/**
 * Названные исключения — «прямой вызов пока остаётся, и вот почему». Список
 * существует, чтобы дыра лежала в коде на виду, а не пряталась за тем, что имя
 * не внесли в запрет.
 *
 * `applyAsArbiter` — четвёртое арбитрское письмо, найденное этой работой и
 * НЕ переведённое. Причины названы замером, а не мнением:
 *   • кнопка гейтится `daoActive === true` (`useWalletAccountData.ts`), а цепь
 *     на 17 августа отвечает `isDaoActive() = false` — путь недостижим;
 *   • заявка тянет залог через `transferFrom`, а разрешения в этом пути нет
 *     вовсе (ни `approve`, ни `permit` — грепом по файлу ноль), то есть вызов
 *     отвергается ещё до всякого газа;
 *   • гейслесс ей нужен ВМЕСТЕ с ногой permit — это форма подписи и решение о
 *     ней, а не побочный эффект правки соседних кнопок.
 */
const KNOWN_DIRECT: Record<string, string> = {
  applyAsArbiter: 'hooks/useWalletAccountData.ts',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Комментарии снимаются до разбора: разбор этой самой ловушки записан
 *  комментарием внутри тех файлов, что она сторожит. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Как в этом файле зовут писателя. По умолчанию `writeContract`/
 * `writeContractAsync`, но крючок отдаётся деструктуризацией и его законно
 * переименовывают: `const { writeContractAsync: applyAsArbiterWrite } =
 * useWriteContract()`.
 *
 * ⚠️ ЭТО НЕ ПЕДАНТИЗМ, А ЗАМЕР. Первая редакция этого замка искала только два
 * имени и не увидела ЕДИНСТВЕННЫЙ живой прямой вызов арбитрской функции во всём
 * дереве — `applyAsArbiter` в `hooks/useWalletAccountData.ts`, переименованный
 * ровно так. То есть запрет был зелёным при нарушении прямо в дереве, и
 * обойти его дальше можно было бы одной строкой переименования.
 */
function writerNames(source: string): string[] {
  const names = new Set(['writeContract', 'writeContractAsync']);
  for (const [, inside] of source.matchAll(/\{([^}]*)\}\s*=\s*useWriteContract\s*\(/g)) {
    for (const [, alias] of inside.matchAll(/writeContract(?:Async)?\s*:\s*(\w+)/g)) {
      names.add(alias);
    }
  }
  return [...names];
}

/** Имена функций из аргументов каждого вызова писателя. */
function writtenFunctionNames(source: string): string[] {
  const names: string[] = [];
  const re = new RegExp(`\\b(?:${writerNames(source).join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(re)) {
    const open = source.indexOf('{', match.index! + match[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw new Error('незакрытый объект аргументов writeContract — разбор ненадёжен');
    const name = /functionName\s*:\s*['"](\w+)['"]/.exec(source.slice(open, end + 1))?.[1];
    if (name) names.push(name);
  }
  return names;
}

const DIRECT_WRITES = sourceFiles(SRC_DIR)
  .map((file) => ({ path: file.slice(SRC_DIR.length).split(/[\\/]/).join('/'), file }))
  .filter(({ path }) => path !== RELAY_MODULE)
  .flatMap(({ path, file }) =>
    writtenFunctionNames(stripComments(readFileSync(file, 'utf8')))
      .map((functionName) => ({ path, functionName })));

describe('арбитрские действия зовутся через обёртки, а не мимо них', () => {
  it('разбор вообще что-то нашёл — иначе проверка ниже тавтологична', () => {
    // Замок, переставший находить вызовы (сменилось имя крючка, поехал счёт
    // скобок, сузился обход), выглядит ровно как чистый код.
    expect(DIRECT_WRITES.length, `найдено прямых вызовов: ${DIRECT_WRITES.length}`)
      .toBeGreaterThanOrEqual(5);
  });

  it('ни одно пользовательское арбитрское письмо не идёт прямой транзакцией мимо relay.ts', () => {
    const offenders = DIRECT_WRITES
      .filter(({ functionName }) => USER_ARBITER_WRITES.has(functionName))
      .filter(({ path, functionName }) => KNOWN_DIRECT[functionName] !== path)
      .map(({ path, functionName }) => `${path}: ${functionName}`);
    expect(offenders).toEqual([]);
  });

  it('названные исключения ещё существуют — протухший список прикрывал бы новую дыру', () => {
    for (const [functionName, path] of Object.entries(KNOWN_DIRECT)) {
      expect(
        DIRECT_WRITES.some((w) => w.functionName === functionName && w.path === path),
        `исключение ${functionName} в ${path} больше не найдено — либо починено (убрать отсюда), либо переехало`,
      ).toBe(true);
    }
  });

  it('переименованный писатель виден разбору — иначе запрет обходится одной строкой', () => {
    const fake = `
      const { writeContractAsync: sneaky } = useWriteContract();
      await sneaky({ abi: A, functionName: 'submitVerdict', args: [] });
    `;
    expect(writerNames(fake)).toContain('sneaky');
    expect(writtenFunctionNames(stripComments(fake))).toEqual(['submitVerdict']);
  });

  it('панель управления корпусом под правило не подпадает — там жмёт админ-роль', () => {
    // Посадка и снятие арбитра — не пользовательские действия: их делает
    // владелец или директор, и по правилу трёх родов эфир у них обязан быть.
    // Проверяется явно, чтобы «зелено» не означало «этих вызовов не нашли».
    const admin = DIRECT_WRITES
      .filter(({ functionName }) => ['addArbiter', 'removeArbiter', 'setChiefArbiter'].includes(functionName));
    expect(admin.length).toBeGreaterThanOrEqual(3);
  });
});

describe('кошелёк без адреса не проходит ни один из четырёх', () => {
  it('R14 «Wallet not connected» — до подписи и до релеера', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const empty = { chain: { id: 84532 } } as any;
    const { node } = stand('0x0000000000000000000000000000000000000114');
    /* eslint-enable @typescript-eslint/no-explicit-any */
    relayUp();
    await expect(submitVerdictGasless(empty, node, AGREEMENT, true)).rejects.toThrow(/not connected/i);
    await expect(finalizeVerdictGasless(empty, node, AGREEMENT)).rejects.toThrow(/not connected/i);
    await expect(withdrawArbiterRewardGasless(empty, node)).rejects.toThrow(/not connected/i);
    await expect(respondToRemovalGasless(empty, node, DIGEST)).rejects.toThrow(/not connected/i);
    expect(posted.length).toBe(0);
  });
});
