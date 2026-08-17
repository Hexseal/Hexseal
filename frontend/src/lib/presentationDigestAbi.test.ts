import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { ARBITER_REGISTRY_ABI } from '@/config/contracts';

/**
 * Замок против расхождения ABI фронта с контрактом — восемь входов 4в-2 Выкатки 2.
 *
 * ⚠️ ЗАЧЕМ. Тот же класс, ради которого заведён соседний
 * `claimAbiMatchesContract.test.ts`: 9 августа подпись `claimDispute` сменилась, и
 * единственным, что связывало фронт с контрактом, было внимание человека. Селектор
 * едет вместе с подписью — старого входа в даймонде не остаётся, и вызов по нему
 * читается снаружи как «арбитраж сломался». Здесь входов сразу восемь, и половина из
 * них — чтения с ВОЗВРАТОМ, где ошибка молчит вдвойне: `readContract` приводит
 * результат типом, формы в рантайме не сверяет никто.
 *
 * ⚠️ ЧИТАЕМ ИСХОДНИК `.sol`, А НЕ `out/*.json`. `out/` в гите нет (.gitignore), и
 * замок, зависящий от результата сборки, был бы зелёным на несобранном дереве — то
 * есть на чистой копии репозитория. Прецеденты: `claimAbiMatchesContract.test.ts`,
 * `disputeBounty.test.ts`, `relayer/test/agreementStatusEnum.test.js`.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДОКАЗЫВАЕТ: что запись смонтирована в живой даймонд. Это
 * дело `test/PresentationRecordUpgrade.t.sol` (состав разреза против ABI) и
 * `test/DeployFullSelectors.t.sol` (полный деплой). Здесь сверяется только шов
 * «фронт ↔ исходник контракта».
 */

/**
 * ⚠️ ИСХОДНИК — ВСЕ АРБИТРАЖНЫЕ ФАСЕТЫ СРАЗУ, А НЕ ОДИН ФАЙЛ.
 *
 * До 17 августа 2026 здесь стоял единственный путь — `ArbiterRegistryFacet.sol`.
 * Реестр упёрся в потолок EIP-170, и четырнадцать чтений уехали в
 * `ArbiterAccountabilityFacet.sol` (коммит a88a2200); пять из них — ровно те,
 * что сверяются ниже. Замок покраснел не потому, что ABI фронта разошёлся с
 * цепью (он не разошёлся: даймонд отвечает по одному адресу, каким фасетом
 * смонтирован селектор — снаружи не видно), а потому что был прибит к ФАЙЛУ.
 *
 * Правится поэтому замок, а не ABI: сторона правды — арбитражная поверхность
 * даймонда целиком, и собирается она с диска, а не из литерала. Третий фасет
 * попадёт под сверку сам, без правки этого файла.
 *
 * Про то, что селектор реально смонтирован, отвечают тесты разреза (см. выше) —
 * здесь по-прежнему только шов «фронт ↔ исходник контракта».
 */
const FACETS_DIR = new URL('../../../src/facets/', import.meta.url);

const FACET_FILES = readdirSync(FACETS_DIR)
  .filter((f) => /^Arbiter.*\.sol$/.test(f))
  .sort();

/**
 * Склейка исходников. Склеивать безопасно ровно потому, что дальше каждая
 * сверка требует РОВНО ОДНО объявление искомого имени: если одна и та же
 * функция объявится в двух фасетах разом, разбор упадёт, а не выберет первую
 * попавшуюся. Единственное общее имя на сегодня — приватная `_msgSender`,
 * которую здесь не ищет никто.
 */
const FACET_SRC = FACET_FILES.map((f) => readFileSync(new URL(f, FACETS_DIR), 'utf8')).join('\n');

describe('сверка читает всю арбитражную поверхность, а не один файл', () => {
  it('арбитражных фасетов найдено больше одного', () => {
    // Именно так замок ослеп бы обратно: путь сузили до одного файла, всё
    // зелено, половина поверхности не сторожится ничем. Число 2 — не «столько
    // бывает», а «меньше двух означает, что читается не вся поверхность».
    expect(FACET_FILES.length, `найдено: ${FACET_FILES.join(', ') || '(ничего)'}`)
      .toBeGreaterThanOrEqual(2);
  });
});

/**
 * Блок объявления функции: от `function <имя>(` до начала тела (`{`) либо до `;`.
 *
 * Падает, если объявлений больше одного: перегрузка означает, что «подпись» —
 * понятие неоднозначное, и сверять с ABI нечего. Ровно этим ревью Задачи 1
 * показало, что сверка без такой проверки берёт первое попавшееся совпадение.
 */
function declarationBlock(source: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)[\\s\\S]*?(?:\\{|;)`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление ${fnName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `объявление ${fnName} встречается ${matches.length} раза в исходнике — ` +
      `подпись неоднозначна, каноническую сверку сделать нельзя`,
    );
  }
  return matches[0][0];
}

/** Расположение данных — не часть типа и не имя. Снимается до разбора. */
const DATA_LOCATIONS = new Set(['memory', 'calldata', 'storage']);

type Param = { type: string; name: string };

/**
 * Разбор списка параметров Solidity в пары «тип, имя».
 *
 * ⚠️ Имя тут именно необязательно, и это не мелочь: `returns (bytes32[] memory)`
 * даёт ДВА слова, из которых второе — расположение данных, а не имя. Наивное
 * «имя = последнее слово» назвало бы возврат `getPresentationDigests` именем
 * `memory` и сверяло бы фронт с выдумкой. Пустое имя здесь — законный ответ, и в
 * ABI ему соответствует `name: ''`.
 */
function parseParams(list: string): Param[] {
  return list
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const words = p.split(/\s+/).filter((w) => !DATA_LOCATIONS.has(w));
      return { type: words[0], name: words.length > 1 ? words[words.length - 1] : '' };
    });
}

/** Входы из объявления в `.sol`. */
function solInputs(source: string, fnName: string): Param[] {
  const decl = declarationBlock(source, fnName);
  const inside = /\(([^)]*)\)/.exec(decl);
  if (!inside) throw new Error(`не разобрать список аргументов ${fnName}`);
  return parseParams(inside[1]);
}

/** Возвраты из `returns (...)`. Пустой массив — функция ничего не возвращает. */
function solOutputs(source: string, fnName: string): Param[] {
  const decl = declarationBlock(source, fnName);
  const returnsMatch = /returns\s*\(([^)]*)\)/.exec(decl);
  if (!returnsMatch) return [];
  return parseParams(returnsMatch[1]);
}

/**
 * Изменчивость из объявления: `pure` / `view` / `payable`, иначе `nonpayable`.
 *
 * Нужна не для красоты. `useReadContract` в wagmi принимает только чтения: объяви
 * во фронте `getNoResponseFloor` как `nonpayable` — и крючок пола перестанет
 * собираться типами; объяви `recordNoResponse` как `view` — и запись в цепь можно
 * будет «прочитать», получив тишину вместо транзакции.
 */
function solMutability(source: string, fnName: string): string {
  const decl = declarationBlock(source, fnName);
  const afterArgs = decl.slice(decl.indexOf(')'));
  if (/\bpure\b/.test(afterArgs)) return 'pure';
  if (/\bview\b/.test(afterArgs)) return 'view';
  if (/\bpayable\b/.test(afterArgs)) return 'payable';
  return 'nonpayable';
}

type AbiEntry = {
  type: string;
  name: string;
  inputs?: { type: string; name: string }[];
  outputs?: { type: string; name: string }[];
  stateMutability?: string;
};

function abiEntry(abi: readonly unknown[], fnName: string): AbiEntry {
  const found = (abi as AbiEntry[]).filter((e) => e && e.type === 'function' && e.name === fnName);
  if (found.length === 0) throw new Error(`${fnName} нет в ABI фронта`);
  if (found.length > 1) throw new Error(`${fnName} в ABI фронта ${found.length} раза`);
  return found[0];
}

const shape = (params: Param[]) => params.map((p) => `${p.type} ${p.name}`).join(', ');

const abiParams = (list: { type: string; name: string }[] | undefined): Param[] =>
  (list ?? []).map((p) => ({ type: p.type, name: p.name ?? '' }));

/**
 * Восемь входов, приехавших разрезом 4в-2 Выкатки 2. Список написан РУКАМИ и
 * намеренно: сгенерируй его из самого ABI — и забытая запись сверялась бы сама с
 * собой, а забыть тут ровно то, о чём этот файл.
 */
const NEW_FUNCTIONS = [
  'getDisputeClaimedAt',
  'recordNoResponse',
  'getNoResponseAt',
  'getNoResponseFloor',
  'recordPresentationDigest',
  'getPresentationDigests',
  'getPresentationDigestsPage',
  'getPresentationDigestCount',
] as const;

describe('ABI записи о молчании и отпечатка не расходится с контрактом', () => {
  for (const fnName of NEW_FUNCTIONS) {
    it(`${fnName}: входы — типы и имена — совпадают с исходником`, () => {
      // Имена сверяются наравне с типами, и это не педантизм: у
      // getPresentationDigestsPage два подряд uint256 (offset, limit), и
      // перестановка их местами по типам НЕВИДИМА — а читатель получил бы
      // окно не там, где просил.
      expect(shape(abiParams(abiEntry(ARBITER_REGISTRY_ABI, fnName).inputs)))
        .toBe(shape(solInputs(FACET_SRC, fnName)));
    });

    it(`${fnName}: возвраты совпадают с исходником — здесь ошибка молчит`, () => {
      expect(shape(abiParams(abiEntry(ARBITER_REGISTRY_ABI, fnName).outputs)))
        .toBe(shape(solOutputs(FACET_SRC, fnName)));
    });

    it(`${fnName}: изменчивость совпадает с исходником`, () => {
      expect(abiEntry(ARBITER_REGISTRY_ABI, fnName).stateMutability)
        .toBe(solMutability(FACET_SRC, fnName));
    });

    it(`${fnName}: в исходнике ровно одно объявление`, () => {
      const count = (FACET_SRC.match(new RegExp(`function\\s+${fnName}\\s*\\(`, 'g')) ?? []).length;
      expect(count).toBe(1);
    });
  }
});

/**
 * ⚠️ СОБЫТИЯ — ЭТО НЕ ДУБЛЬ ГЕТТЕРОВ, И ЗАМОК ИМ НУЖЕН ОТДЕЛЬНЫЙ.
 *
 * Геттеры отдают `bytes32[]` и число — то есть «сколько и какие». А спор решается
 * вопросом «что было раньше»: отпечаток лёг на блоке N, запись арбитра «просил,
 * ответа нет» — на блоке M. Номера блока у геттера нет ни у одного, взять порядок
 * можно только из ленты. Значит без этих двух записей экран арбитра (Задача 7) либо
 * встанет, либо соврёт.
 *
 * ⚠️ И ГЛАВНОЕ, ЧЕМ СОБЫТИЕ ОПАСНЕЕ ФУНКЦИИ: `indexed`. Тип и имя могут совпадать
 * полностью, а флаг — разойтись, и тогда viem ищет поле не там: `indexed` уезжает в
 * topics, остальное в data. Ошибка не ревертит ничего — фильтр по сделке молча не
 * находит НИЧЕГО, либо расшифровка выдаёт мусор в поле. Поэтому флаг сверяется
 * наравне с типом и именем.
 */
type EventParam = { type: string; name: string; indexed: boolean };

/** Параметры события из объявления в `.sol`. Объявление может быть многострочным. */
function solEventParams(source: string, eventName: string): EventParam[] {
  const re = new RegExp(`event\\s+${eventName}\\s*\\(([^)]*)\\)\\s*;`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление события ${eventName} не найдено`);
  if (matches.length > 1) {
    throw new Error(`событие ${eventName} объявлено ${matches.length} раза — сверять не с чем`);
  }
  return matches[0][1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const words = p.split(/\s+/);
      const indexed = words.includes('indexed');
      const rest = words.filter((w) => w !== 'indexed');
      return { type: rest[0], name: rest.length > 1 ? rest[rest.length - 1] : '', indexed };
    });
}

function abiEventEntry(abi: readonly unknown[], eventName: string) {
  const found = (abi as AbiEntry[]).filter((e) => e && e.type === 'event' && e.name === eventName);
  if (found.length === 0) throw new Error(`события ${eventName} нет в ABI фронта`);
  if (found.length > 1) throw new Error(`событие ${eventName} в ABI фронта ${found.length} раза`);
  return found[0] as AbiEntry & { inputs?: { type: string; name: string; indexed?: boolean }[] };
}

const eventShape = (params: EventParam[]) =>
  params.map((p) => `${p.type}${p.indexed ? ' indexed' : ''} ${p.name}`).join(', ');

/**
 * Два события 4в-2 Выкатки 2. Список руками, по той же причине, что и список
 * функций: собранный из самого ABI, он сверял бы забытую запись саму с собой.
 */
const NEW_EVENTS = ['DisputeNoResponseRecorded', 'PresentationDigestRecorded'] as const;

describe('ABI событий ленты не расходится с контрактом', () => {
  for (const eventName of NEW_EVENTS) {
    it(`${eventName}: поля — типы, имена и indexed — совпадают с исходником`, () => {
      const fromContract = solEventParams(FACET_SRC, eventName);
      const fromConfig = (abiEventEntry(ARBITER_REGISTRY_ABI, eventName).inputs ?? []).map((p) => ({
        type: p.type,
        name: p.name ?? '',
        indexed: p.indexed === true,
      }));
      expect(eventShape(fromConfig)).toBe(eventShape(fromContract));
    });

    it(`${eventName}: в исходнике ровно одно объявление`, () => {
      const count = (FACET_SRC.match(new RegExp(`event\\s+${eventName}\\s*\\(`, 'g')) ?? []).length;
      expect(count).toBe(1);
    });
  }

  it('оба события в ABI помечены как event, а не как функция', () => {
    // Мелочь, которая ломает молча: `type: 'function'` у записи события не мешает
    // ничему до первой попытки разобрать лог — там она просто не найдётся.
    for (const eventName of NEW_EVENTS) {
      expect(abiEventEntry(ARBITER_REGISTRY_ABI, eventName).type).toBe('event');
    }
  });
});

describe('разбор объявлений сам по себе честен', () => {
  it('indexed читается как флаг, а не как имя поля', () => {
    const fake = 'event E(address indexed agreement, uint256 at);';
    expect(solEventParams(fake, 'E')).toEqual([
      { type: 'address', name: 'agreement', indexed: true },
      { type: 'uint256', name: 'at', indexed: false },
    ]);
  });

  it('многострочное объявление события разбирается целиком', () => {
    const fake = 'event E(\n  address indexed a, bytes32 digest,\n  uint256 index\n);';
    expect(solEventParams(fake, 'E').map((p) => p.name)).toEqual(['a', 'digest', 'index']);
  });

  it('разбор события падает на двойном объявлении', () => {
    const fake = 'event E(address a);\nevent E(bytes32 a);';
    expect(() => solEventParams(fake, 'E')).toThrow();
  });

  it('расположение данных не принимается за имя возврата', () => {
    const fake = 'function f(address a) external view returns (bytes32[] memory) {';
    expect(solOutputs(fake, 'f')).toEqual([{ type: 'bytes32[]', name: '' }]);
  });

  it('именованный возврат с расположением данных разбирается на тип и имя', () => {
    const fake = 'function f() external view returns (bytes32[] memory digests) {';
    expect(solOutputs(fake, 'f')).toEqual([{ type: 'bytes32[]', name: 'digests' }]);
  });

  it('разбор падает на перегрузке — сверять было бы не с чем', () => {
    const fake = `
      function recordNoResponse(address agreement) external {}
      function recordNoResponse(address agreement, uint256 when) external {}
    `;
    expect(() => solInputs(fake, 'recordNoResponse')).toThrow();
  });

  it('изменчивость читается после списка аргументов, а не по всему объявлению', () => {
    // `view` в имени параметра или в комментарии не должно превращать запись в чтение.
    expect(solMutability('function f(address viewer) external {', 'f')).toBe('nonpayable');
    expect(solMutability('function f() external pure returns (uint256) {', 'f')).toBe('pure');
  });
});

/**
 * ⚠️ ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ ШВА: ОШИБКИ, А НЕ ФУНКЦИИ.
 *
 * Все новые вызовы идут гейслесс, а гейслесс на фронте идёт через
 * `app/api/relay/route.ts`: тот сначала СИМУЛИРУЕТ `MinimalForwarder.execute()` и,
 * если внутренний вызов отвергнут, разбирает `retdata` по таблице селекторов
 * `CUSTOM_ERRORS`. Селектора нет в таблице — человек получает «Inner call
 * reverted», то есть сырой хекс вместо причины. Ровно этим 4в-1 уже болел: два
 * арбитра гонятся за один спор, проигравшему не сказано ничего.
 *
 * ⚠️ ПОЧЕМУ ТАБЛИЦА ЧИТАЕТСЯ ТЕКСТОМ, А НЕ ИМПОРТОМ. `route.ts` — обработчик
 * маршрута Next: экспортировать из него что-либо кроме HTTP-методов нельзя,
 * `next build` проверяет состав экспортов и падает. Таблица — литерал внутри
 * функции, и достать её иначе, чем разбором исходника, нечем. Сторожится при этом
 * не «есть такая строчка», а СОСТАВ таблицы против объявлений контракта: добавь
 * ошибку в фасет и не впиши сюда — красный.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДОКАЗЫВАЕТ — и это НЕ отговорка, а разделение труда:
 * что маршрут таблицей ПОЛЬЗУЕТСЯ. Проводка «таблица → текст причины» жила без
 * замка вовсе, и общее ревью ветки это замерило: обернуть обращение в
 * `if (false && …)` давало 0 красных из 2751 при зелёном составе. Теперь
 * употребление меряется поведением в `app/api/relay/route.test.ts` («причина
 * отказа доезжает до человека словом, а не сырым хексом»): подделка форвардера
 * отдаёт `(false, retdata)`, и проверяется ОТВЕТ маршрута. Та же мутация —
 * 5 красных.
 */
const RELAY_ROUTE_SRC = readFileSync(
  new URL('../app/api/relay/route.ts', import.meta.url),
  'utf8',
);

/** Все `error Имя(типы);` фасета — по порядку объявления. */
function solidityErrorSignatures(source: string): string[] {
  return [...source.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, args]) => {
    const types = args
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => a.split(/\s+/)[0]);
    return `${name}(${types.join(',')})`;
  });
}

/** Пары «селектор → имя» из литерала таблицы `CUSTOM_ERRORS` в `route.ts`. */
function relayRouteErrorTable(source: string): Record<string, string> {
  const block = /const CUSTOM_ERRORS: Record<string, string> = \{([\s\S]*?)\n\s*\};/.exec(source);
  if (!block) throw new Error('таблица CUSTOM_ERRORS не найдена в app/api/relay/route.ts');
  const table: Record<string, string> = {};
  for (const [, selector, name] of block[1].matchAll(/'(0x[0-9a-fA-F]{8})':\s*'(\w+)'/g)) {
    table[selector.toLowerCase()] = name;
  }
  if (Object.keys(table).length === 0) throw new Error('таблица CUSTOM_ERRORS пуста');
  return table;
}

describe('фронт умеет назвать любую ошибку арбитражных фасетов', () => {
  const table = relayRouteErrorTable(RELAY_ROUTE_SRC);
  // Без дедупликации пять имён, объявленных в обоих фасетах с одинаковой
  // подписью (NotOwner, NotOwnerOrChief, NotAnArbiter, ArbiterZeroAddress,
  // ZeroDigest), дали бы по два одноимённых теста — селектор у них один, и
  // запись в таблице тоже одна.
  const signatures = [...new Set(solidityErrorSignatures(FACET_SRC))];

  it('в фасетах вообще есть объявленные ошибки — иначе сверка тавтологична', () => {
    expect(signatures.length).toBeGreaterThan(40);
  });

  for (const signature of signatures) {
    const name = signature.slice(0, signature.indexOf('('));
    it(`${signature} разбирается в имя, а не в сырой хекс`, () => {
      // Селектор считается ТУТ ЖЕ из подписи, а не берётся из таблицы: иначе
      // таблица сверялась бы сама с собой — тот самый класс, из-за которого
      // пол вынесен в цепь (замысел 5.2).
      const selector = keccakSelector(signature);
      expect(table[selector], `${signature} (${selector}) нет в таблице route.ts`).toBe(name);
    });
  }
});

/** Первые 4 байта keccak256 подписи — селектор ошибки, тем же счётом, что у цепи. */
function keccakSelector(signature: string): string {
  return keccak256(toBytes(signature)).slice(0, 10).toLowerCase();
}
