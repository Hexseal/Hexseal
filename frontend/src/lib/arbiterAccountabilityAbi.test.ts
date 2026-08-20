import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ARBITER_ACCOUNTABILITY_ABI, ARBITER_REGISTRY_ABI } from '@/config/contracts';

/**
 * Замок на шов «ABI фронта ↔ исходник ArbiterAccountabilityFacet».
 *
 * ⚠️ ЗАЧЕМ ВООБЩЕ ЭТО ABI. Адрес у фасета тот же, что у всего даймонда, и какой
 * фасет отвечает за селектор, снаружи не видно — то есть маршрутизации ему не
 * нужно. Нужно другое: ПРЯМАЯ транзакция (не гейслесс) разбирает отказ по тому
 * ABI, которое ей дали, а не по таблице причин релеера. Ошибки, которой в ABI
 * нет, viem не назовёт — человек увидит сырой хекс ровно там, где ему надо
 * объяснить, почему кнопка не сработала. До 17 августа 2026 фронт не знал об
 * этом фасете вовсе, хотя половина арбитражной поверхности уехала туда ещё
 * коммитом a88a2200.
 *
 * ⚠️ ЧИТАЕМ ИСХОДНИК `.sol`, А НЕ `out/*.json`. `out/` в гите нет (.gitignore):
 * замок, зависящий от результата сборки, был бы зелёным на чистой копии
 * репозитория, то есть сторожил бы ровно ничего. Тот же довод и тот же приём,
 * что в `claimAbiMatchesContract.test.ts` и `presentationDigestAbi.test.ts`.
 *
 * ⚠️ СПИСОК ИМЁН БЕРЁТСЯ ИЗ ИСХОДНИКА, А НЕ ИЗ ABI — и это не то же самое, что
 * «сгенерировать список из проверяемого». Ожидаемое обязано браться с ДРУГОЙ
 * стороны шва: источник правды здесь контракт, забытая в ABI функция обнаружится
 * именно так. Собери список из ABI — и он сверялся бы сам с собой, а забыть тут
 * можно ровно то, о чём этот файл.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДОКАЗЫВАЕТ: что селекторы смонтированы в живой даймонд.
 * Это дело `test/ArbiterAccountabilityUpgrade.t.sol` (состав разреза) и
 * `test/DeployFullSelectors.t.sol` (полный деплой).
 */

const FACET_SRC = readFileSync(
  new URL('../../../src/facets/ArbiterAccountabilityFacet.sol', import.meta.url),
  'utf8',
);

/**
 * Enum контракта в ABI — это `uint8`. Карта написана руками намеренно и
 * НЕПОЛНОТА В НЕЙ ОБЯЗАНА ПАДАТЬ (см. `abiType` ниже): новый enum в подписи
 * иначе молча уехал бы в ABI своим именем, а фронт кодировал бы аргумент не тем
 * типом. Отказ громче тишины.
 */
const ENUM_TO_ABI: Record<string, string> = { Cause: 'uint8' };

/** Элементарные типы Solidity, которые в ABI пишутся как есть. */
const ELEMENTARY = /^(address|bool|string|bytes([1-9]|[12]\d|3[0-2])?|u?int(\d+)?)$/;

function abiType(solType: string): string {
  const array = solType.endsWith('[]');
  const base = array ? solType.slice(0, -2) : solType;
  if (ELEMENTARY.test(base)) return solType;
  const mapped = ENUM_TO_ABI[base];
  if (!mapped) {
    throw new Error(
      `тип "${base}" не элементарный и не описан в ENUM_TO_ABI — ` +
      `сверять ABI с ним нельзя, не угадав его представление`,
    );
  }
  return array ? `${mapped}[]` : mapped;
}

/** Расположение данных — не часть типа и не имя. */
const DATA_LOCATIONS = new Set(['memory', 'calldata', 'storage']);

type Param = { type: string; name: string };

/**
 * Разбор списка параметров Solidity в пары «тип, имя».
 *
 * Имя необязательно, и это не мелочь: `returns (bytes32[] memory)` даёт ДВА
 * слова, из которых второе — расположение данных. Наивное «имя = последнее
 * слово» назвало бы возврат именем `memory` и сверяло бы фронт с выдумкой.
 */
function parseParams(list: string): Param[] {
  return list
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const words = p.split(/\s+/).filter((w) => !DATA_LOCATIONS.has(w));
      return { type: abiType(words[0]), name: words.length > 1 ? words[words.length - 1] : '' };
    });
}

/**
 * Блок объявления функции: от `function <имя>(` до начала тела либо до `;`.
 * Падает на перегрузке — «подпись» тогда понятие неоднозначное, и сверять не с
 * чем.
 */
function declarationBlock(source: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)[\\s\\S]*?(?:\\{|;)`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление ${fnName} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `объявление ${fnName} встречается ${matches.length} раза — подпись неоднозначна`,
    );
  }
  return matches[0][0];
}

function solInputs(source: string, fnName: string): Param[] {
  const inside = /\(([^)]*)\)/.exec(declarationBlock(source, fnName));
  if (!inside) throw new Error(`не разобрать список аргументов ${fnName}`);
  return parseParams(inside[1]);
}

function solOutputs(source: string, fnName: string): Param[] {
  const returnsMatch = /returns\s*\(([^)]*)\)/.exec(declarationBlock(source, fnName));
  if (!returnsMatch) return [];
  return parseParams(returnsMatch[1]);
}

/**
 * Изменчивость: `pure` / `view` / `payable`, иначе `nonpayable`. Не для
 * красоты — `useReadContract` в wagmi принимает только чтения, а объявленная
 * `view` запись «читается» тишиной вместо транзакции.
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
  inputs?: { type: string; name: string; indexed?: boolean }[];
  outputs?: { type: string; name: string }[];
  stateMutability?: string;
};

const ABI = ARBITER_ACCOUNTABILITY_ABI as readonly unknown[] as AbiEntry[];

function abiEntry(kind: 'function' | 'event', name: string): AbiEntry {
  const found = ABI.filter((e) => e && e.type === kind && e.name === name);
  if (found.length === 0) throw new Error(`${kind} ${name} нет в ARBITER_ACCOUNTABILITY_ABI`);
  if (found.length > 1) throw new Error(`${kind} ${name} в ABI ${found.length} раза`);
  return found[0];
}

const shape = (params: Param[]) => params.map((p) => `${p.type} ${p.name}`).join(', ');

const abiParams = (list: { type: string; name: string }[] | undefined): Param[] =>
  (list ?? []).map((p) => ({ type: p.type, name: p.name ?? '' }));

/** Имена внешних функций фасета — с той стороны шва, из исходника. */
function solExternalFunctionNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/function\s+(\w+)\s*\(([^)]*)\)([^{;]*)/g)) {
    if (/\b(external|public)\b/.test(m[3])) names.push(m[1]);
  }
  return names;
}

/** Имена событий фасета — оттуда же. */
function solEventNames(source: string): string[] {
  return [...source.matchAll(/\bevent\s+(\w+)\s*\(/g)].map(([, name]) => name);
}

const SOL_FUNCTIONS = solExternalFunctionNames(FACET_SRC);
const SOL_EVENTS = solEventNames(FACET_SRC);

describe('состав ABI фасета ответственности совпадает с исходником', () => {
  it('в исходнике вообще нашлись функции — иначе сверка тавтологична', () => {
    // Поехавшая регулярка даёт пустой список, а пустой список совпадает с
    // пустым: замок, который ничего не проверяет, выглядит точно так же, как
    // замок, у которого всё хорошо.
    expect(SOL_FUNCTIONS.length).toBeGreaterThan(20);
    expect(SOL_EVENTS.length).toBeGreaterThan(3);
  });

  it('ни одна внешняя функция фасета не забыта в ABI', () => {
    const inAbi = new Set(ABI.filter((e) => e.type === 'function').map((e) => e.name));
    expect([...SOL_FUNCTIONS].filter((n) => !inAbi.has(n))).toEqual([]);
  });

  it('в ABI нет функций, которых в фасете нет', () => {
    // Обратная сторона: запись, пережившая переименование или переезд, читается
    // как рабочая, а вызов по ней проваливается в fallback даймонда.
    const inSol = new Set(SOL_FUNCTIONS);
    expect(ABI.filter((e) => e.type === 'function' && !inSol.has(e.name)).map((e) => e.name))
      .toEqual([]);
  });

  it('ни одно событие фасета не забыто и лишних нет', () => {
    const inAbi = ABI.filter((e) => e.type === 'event').map((e) => e.name).sort();
    expect(inAbi).toEqual([...SOL_EVENTS].sort());
  });
});

describe('подписи функций фасета ответственности не расходятся с исходником', () => {
  for (const fnName of SOL_FUNCTIONS) {
    it(`${fnName}: входы — типы и имена — совпадают с исходником`, () => {
      // Имена сверяются наравне с типами: у getPresentationDigestsPage два
      // подряд uint256 (offset, limit), и перестановка их местами по типам
      // НЕВИДИМА — а читатель получил бы окно не там, где просил.
      expect(shape(abiParams(abiEntry('function', fnName).inputs)))
        .toBe(shape(solInputs(FACET_SRC, fnName)));
    });

    it(`${fnName}: возвраты совпадают с исходником — здесь ошибка молчит`, () => {
      // Ошибка во ВХОДЕ ревертит вызов и видна сразу. Ошибка в ВЫХОДЕ не
      // ревертит ничего: readContract приводит результат типом, формы в
      // рантайме не сверяет никто. Четырнадцать полей getArbiterStanding и два
      // одинаковых bytes32 у getArbiterChatKeys — ровно та сцена. (Число тут
      // уже протухало: стояло «тринадцать», пока пункт 101 не вставил
      // `overturnedVerdicts` рядом с `cleanVerdicts`. Сверку оно не двигает —
      // та берёт форму из исходника, — но читателя вводило бы в заблуждение.)
      expect(shape(abiParams(abiEntry('function', fnName).outputs)))
        .toBe(shape(solOutputs(FACET_SRC, fnName)));
    });

    it(`${fnName}: изменчивость совпадает с исходником`, () => {
      expect(abiEntry('function', fnName).stateMutability)
        .toBe(solMutability(FACET_SRC, fnName));
    });
  }
});

/**
 * ⚠️ СОБЫТИЯ ОПАСНЕЕ ФУНКЦИЙ ОДНИМ: `indexed`. Тип и имя могут совпадать
 * полностью, а флаг — разойтись, и тогда viem ищет поле не там: `indexed`
 * уезжает в topics, остальное в data. Ошибка не ревертит ничего — фильтр по
 * арбитру молча не находит НИЧЕГО либо расшифровка выдаёт мусор в поле.
 */
type EventParam = { type: string; name: string; indexed: boolean };

function solEventParams(source: string, eventName: string): EventParam[] {
  const re = new RegExp(`event\\s+${eventName}\\s*\\(([^)]*)\\)\\s*;`, 'g');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление события ${eventName} не найдено`);
  if (matches.length > 1) throw new Error(`событие ${eventName} объявлено ${matches.length} раза`);
  return matches[0][1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const words = p.split(/\s+/);
      const indexed = words.includes('indexed');
      const rest = words.filter((w) => w !== 'indexed');
      return {
        type: abiType(rest[0]),
        name: rest.length > 1 ? rest[rest.length - 1] : '',
        indexed,
      };
    });
}

const eventShape = (params: EventParam[]) =>
  params.map((p) => `${p.type}${p.indexed ? ' indexed' : ''} ${p.name}`).join(', ');

describe('события фасета ответственности не расходятся с исходником', () => {
  for (const eventName of SOL_EVENTS) {
    it(`${eventName}: поля — типы, имена и indexed — совпадают с исходником`, () => {
      const fromConfig = (abiEntry('event', eventName).inputs ?? []).map((p) => ({
        type: p.type,
        name: p.name ?? '',
        indexed: p.indexed === true,
      }));
      expect(eventShape(fromConfig)).toBe(eventShape(solEventParams(FACET_SRC, eventName)));
    });
  }
});

/**
 * ⚠️ ВОСЕМЬ ЧТЕНИЙ ЛЕЖАТ В ДВУХ ЗАПИСЯХ СРАЗУ, И ЭТО НАМЕРЕННО.
 *
 * Они уехали в фасет ответственности коммитом a88a2200, но из
 * ARBITER_REGISTRY_ABI не убраны: по тем записям ходит живой код, а даймонд
 * отвечает по обеим одинаково. Опасность двух записей одна — разойтись; тогда
 * один и тот же вызов кодируется по-разному в зависимости от того, какое ABI
 * подвернулось вызывающему. Обе поэтому сверяются с ОДНИМ исходником, а не друг
 * с другом: совпадение двух неправд ничего не доказывает.
 */
const SHARED_WITH_REGISTRY = [
  'getArbiterReward',
  'getArbiterDeals',
  'getArbiterChatKeys',
  'getDisputeClaimedAt',
  'getNoResponseAt',
  'getPresentationDigests',
  'getPresentationDigestsPage',
  'getPresentationDigestCount',
] as const;

describe('две записи одного чтения не расходятся между собой', () => {
  const registry = ARBITER_REGISTRY_ABI as readonly unknown[] as AbiEntry[];

  for (const fnName of SHARED_WITH_REGISTRY) {
    it(`${fnName}: запись в реестровом ABI та же, что в ABI ответственности`, () => {
      const inRegistry = registry.filter((e) => e.type === 'function' && e.name === fnName);
      expect(inRegistry.length, `${fnName}: в ARBITER_REGISTRY_ABI записей ${inRegistry.length}`)
        .toBe(1);
      const fromSource = {
        inputs: shape(solInputs(FACET_SRC, fnName)),
        outputs: shape(solOutputs(FACET_SRC, fnName)),
        stateMutability: solMutability(FACET_SRC, fnName),
      };
      expect({
        inputs: shape(abiParams(inRegistry[0].inputs)),
        outputs: shape(abiParams(inRegistry[0].outputs)),
        stateMutability: inRegistry[0].stateMutability,
      }).toEqual(fromSource);
    });
  }

  it('список общих чтений не выдуман — все восемь есть в обоих ABI', () => {
    // Список написан руками, и опечатка в нём тихо выключила бы проверку выше:
    // несуществующее имя дало бы ноль записей... и упало бы. А вот имя,
    // случайно совпавшее с реестровым, но отсутствующее у ответственности,
    // прошло бы мимо — эта строка закрывает и такое.
    const accountability = new Set(ABI.filter((e) => e.type === 'function').map((e) => e.name));
    const registryNames = new Set(registry.filter((e) => e.type === 'function').map((e) => e.name));
    for (const fnName of SHARED_WITH_REGISTRY) {
      expect(accountability.has(fnName), `${fnName} нет в ARBITER_ACCOUNTABILITY_ABI`).toBe(true);
      expect(registryNames.has(fnName), `${fnName} нет в ARBITER_REGISTRY_ABI`).toBe(true);
    }
  });
});

describe('разбор сам по себе честен', () => {
  it('enum превращается в uint8, а не остаётся именем', () => {
    const fake = 'function f(Cause cause) external {';
    expect(solInputs(fake, 'f')).toEqual([{ type: 'uint8', name: 'cause' }]);
  });

  it('незнакомый неэлементарный тип падает, а не проезжает молча', () => {
    const fake = 'function f(SomeStruct s) external {';
    expect(() => solInputs(fake, 'f')).toThrow(/ENUM_TO_ABI/);
  });

  it('расположение данных не принимается за имя возврата', () => {
    const fake = 'function f(address a) external view returns (bytes32[] memory) {';
    expect(solOutputs(fake, 'f')).toEqual([{ type: 'bytes32[]', name: '' }]);
  });

  it('разбор падает на перегрузке — сверять было бы не с чем', () => {
    const fake = `
      function proposeRemoval(address arbiter) external {}
      function proposeRemoval(address arbiter, uint256 when) external {}
    `;
    expect(() => solInputs(fake, 'proposeRemoval')).toThrow();
  });

  it('изменчивость читается после списка аргументов, а не по всему объявлению', () => {
    expect(solMutability('function f(address viewer) external {', 'f')).toBe('nonpayable');
    expect(solMutability('function f() external pure returns (uint256) {', 'f')).toBe('pure');
  });

  it('indexed читается как флаг, а не как имя поля', () => {
    const fake = 'event E(address indexed arbiter, Cause indexed cause, uint256 at);';
    expect(solEventParams(fake, 'E')).toEqual([
      { type: 'address', name: 'arbiter', indexed: true },
      { type: 'uint8', name: 'cause', indexed: true },
      { type: 'uint256', name: 'at', indexed: false },
    ]);
  });

  it('приватные и внутренние функции во внешний список не попадают', () => {
    const fake = `
      function opened(address a) external view returns (bool) {}
      function _hidden(address a) private view returns (bool) {}
      function _also(address a) internal pure returns (bool) {}
    `;
    expect(solExternalFunctionNames(fake)).toEqual(['opened']);
  });
});
