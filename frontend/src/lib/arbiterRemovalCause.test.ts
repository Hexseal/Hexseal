import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  decodeRemovalCause, CAUSE_NAMES, CHAIN_VERIFIABLE_CAUSES, DEMOTION_PATHS,
  REMOVAL_CAUSE_SHIFT, AUTO_REMOVAL_BASE,
} from './arbiterRemovalCause';

/**
 * Замок на шов «кодировка повода сноса»: у неё хозяин в контракте, а копия во
 * фронте, и геттера, которым копию можно было бы заменить чтением, НЕТ —
 * `REMOVAL_CAUSE_SHIFT` и `AUTO_REMOVAL_BASE` объявлены `internal` в библиотеке
 * `ArbiterRegistryStorage`.
 *
 * ⚠️ ЧТО ЗДЕСЬ СВЕРЯЕТСЯ С ЧЕМ. Ожидаемое берётся С ДРУГОЙ СТОРОНЫ ШВА —
 * разбором `.sol`, — а не из проверяемого модуля. Сверка таблицы самой с собой
 * зелена всегда, и ровно этим она опасна: расхождение с контрактом здесь
 * означает не отказ вызова (расшифровка ничего не вызывает), а СПОКОЙНОЕ
 * ВРАНЬЁ на экране — «снят за сговор» вместо «снят за таймауты», или, что хуже
 * всего, «цепь проверила» там, где цепь ничего не проверяла.
 *
 * ⚠️ ЧИТАЕМ ИСХОДНИК `.sol`, А НЕ `out/*.json`: `out/` в гите нет, и замок,
 * зависящий от сборки, был бы зелёным на чистой копии репозитория. Тот же
 * приём, что в `presentationDigestAbi.test.ts` и `arbiterAccountabilityAbi.test.ts`.
 */

const FACETS = new URL('../../../src/facets/', import.meta.url);
const ACCOUNTABILITY_SRC = readFileSync(new URL('ArbiterAccountabilityFacet.sol', FACETS), 'utf8');
const REGISTRY_SRC = readFileSync(new URL('ArbiterRegistryFacet.sol', FACETS), 'utf8');

/** Комментарии снимаются до разбора — в этих перечислениях они у каждой строки. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Члены перечисления Solidity, В ПОРЯДКЕ ОБЪЯВЛЕНИЯ. Порядок и есть значение:
 * `Cause.Silence` — это число 2, и переставленные местами имена дали бы
 * расшифровку, которая не ревертит ничего и врёт на каждой карточке.
 *
 * Падает на отсутствии и на двойном объявлении: и то и другое означает, что
 * сверять не с чем, а молчаливый пустой список совпал бы с пустым.
 */
function enumMembers(source: string, name: string): string[] {
  const matches = [...stripComments(source).matchAll(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`, 'g'))];
  if (matches.length === 0) throw new Error(`перечисление ${name} не найдено в исходнике`);
  if (matches.length > 1) throw new Error(`перечисление ${name} объявлено ${matches.length} раза`);
  return matches[0][1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** Значение `uint8 internal constant <name> = N;` из исходника. */
function uint8Constant(source: string, name: string): number {
  const matches = [...stripComments(source).matchAll(new RegExp(`constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'g'))];
  if (matches.length === 0) throw new Error(`константа ${name} не найдена в исходнике`);
  if (matches.length > 1) throw new Error(`константа ${name} объявлена ${matches.length} раза`);
  return Number(matches[0][1]);
}

/**
 * Поводы, которые контракт считает проверяемыми цепью, — из тела
 * `_isChainVerifiable`.
 *
 * ⚠️ РАЗБОР ТЕЛА ИДЁТ ДО ПЕРВОЙ `}`, то есть держится ровно на том, что тело
 * плоское (одно `return`, одна `;`). Это проверяется ЯВНО: перепиши функцию с
 * ветвлением — разбор упадёт с внятной ошибкой, а не отдаст молча половину
 * списка. Половина списка здесь была бы худшим из исходов: недостающий повод
 * читался бы как «цепь его не проверяет», то есть замок сам сочинил бы
 * осторожную ложь и остался зелёным.
 */
function chainVerifiableFromSource(source: string): string[] {
  const body = /function\s+_isChainVerifiable\s*\([^)]*\)[^{]*\{([^}]*)\}/.exec(stripComments(source))?.[1];
  if (body === undefined) throw new Error('_isChainVerifiable не найдена в исходнике');
  const returns = (body.match(/\breturn\b/g) ?? []).length;
  const statements = (body.match(/;/g) ?? []).length;
  // Вложенная `{` — отдельная проверка, и она нужна: с ветвлением вида
  // `if (…) { return true; } return false;` разбор до первой `}` обрывается
  // ВНУТРИ ветки, и счёт `return`/`;` выходит ровно по единице — то есть без
  // этой строки замок принял бы обрубок за всё тело. Замерено на подделке в
  // конце файла.
  if (returns !== 1 || statements !== 1 || body.includes('{')) {
    throw new Error(
      `тело _isChainVerifiable перестало быть плоским (return×${returns}, ;×${statements}` +
      `${body.includes('{') ? ', вложенная {' : ''}) — ` +
      'разбор до первой } больше не надёжен, сверять нечем',
    );
  }
  return [...body.matchAll(/Cause\.(\w+)/g)].map(([, name]) => name);
}

const SOL_CAUSES = enumMembers(ACCOUNTABILITY_SRC, 'Cause');
const SOL_PATHS = enumMembers(REGISTRY_SRC, 'DemotionPath');
const SOL_VERIFIABLE = chainVerifiableFromSource(ACCOUNTABILITY_SRC);
const SOL_SHIFT = uint8Constant(REGISTRY_SRC, 'REMOVAL_CAUSE_SHIFT');
const SOL_BASE = uint8Constant(REGISTRY_SRC, 'AUTO_REMOVAL_BASE');

describe('копия кодировки во фронте не разошлась с контрактом', () => {
  it('перечисление Cause — тот же состав и тот же порядок', () => {
    expect([...CAUSE_NAMES]).toEqual(SOL_CAUSES);
  });

  it('перечисление DemotionPath — тот же состав и тот же порядок', () => {
    expect([...DEMOTION_PATHS]).toEqual(SOL_PATHS);
  });

  it('сдвиг и база — те, что в библиотеке хранилища', () => {
    expect(REMOVAL_CAUSE_SHIFT).toBe(SOL_SHIFT);
    expect(AUTO_REMOVAL_BASE).toBe(SOL_BASE);
  });

  it('проверяемые цепью поводы — ровно те, что перечисляет _isChainVerifiable', () => {
    expect([...CHAIN_VERIFIABLE_CAUSES].sort()).toEqual([...SOL_VERIFIABLE].sort());
  });

  it('проверяемых строго меньше, чем всех — иначе метка ничего не различает', () => {
    // Признак, который у всех одинаковый, — это не признак. Если однажды
    // проверяемыми окажутся все поводы, показывать метку станет незачем, и
    // узнать об этом надо здесь, а не по пустеющему экрану.
    expect(SOL_VERIFIABLE.length).toBeGreaterThan(0);
    expect(SOL_VERIFIABLE.length).toBeLessThan(SOL_CAUSES.length);
  });
});

describe('расшифровка отвечает то же, что решил бы контракт', () => {
  it('для КАЖДОГО повода из исходника — своё имя и свой признак проверенности', () => {
    // Самая сильная проверка файла: и индекс, и ожидаемый ответ берутся из
    // ИСХОДНИКА. Ошибись фронт в порядке имён, в сдвиге или в наборе
    // проверяемых — покраснеет здесь, а не на живой карточке.
    SOL_CAUSES.forEach((name, index) => {
      const decoded = decodeRemovalCause(index + SOL_SHIFT);
      expect(decoded.kind, `код ${index + SOL_SHIFT} (${name})`).toBe('declared');
      expect(decoded.kind === 'declared' && decoded.cause).toBe(name);
      expect(decoded.verifiedByChain, `проверенность ${name}`).toBe(SOL_VERIFIABLE.includes(name));
    });
  });

  it('ноль — «не снимали ни разу», а не повод номер ноль', () => {
    // Ради этого различия сдвиг и существует: без него самый частый
    // проверяемый повод был бы неотличим от пустоты.
    expect(decodeRemovalCause(0)).toEqual({ kind: 'never', raw: 0, verifiedByChain: null });
  });

  it('автодемоушен: каждый путь из исходника узнаётся, и все они проверены цепью', () => {
    SOL_PATHS.forEach((path, index) => {
      const decoded = decodeRemovalCause(SOL_BASE + index);
      expect(decoded.kind, `код ${SOL_BASE + index} (${path})`).toBe('automatic');
      expect(decoded.kind === 'automatic' && decoded.path).toBe(path);
      // Обвинителя у автомата нет вовсе: статус снял сам контракт по своему же
      // счётчику. Это строго сильнее, чем заверяемый повод.
      expect(decoded.verifiedByChain).toBe(true);
    });
  });

  it('незнакомый код не выдаётся ни за проверенный, ни за непроверенный', () => {
    // Умолчание в любую сторону было бы утверждением о том, чего мы не знаем.
    // `false` («цепь не проверяла») звучит осторожно, но это такая же выдумка,
    // как `true`: про седьмой повод из будущего контракта нам не известно ничего.
    for (const raw of [SOL_CAUSES.length + SOL_SHIFT, 100, SOL_BASE - 1]) {
      const decoded = decodeRemovalCause(raw);
      expect(decoded.kind, `код ${raw}`).toBe('unknown');
      expect(decoded.verifiedByChain).toBeNull();
    }
  });

  it('сырое число доезжает до читателя в каждой ветке', () => {
    for (const raw of [0, 1, 6, 100, SOL_BASE, 255]) {
      expect(decodeRemovalCause(raw).raw).toBe(raw);
    }
  });
});

describe('разбор исходника сам по себе честен', () => {
  it('перечисление читается по порядку, а комментарии не принимаются за имена', () => {
    const fake = 'enum E {\n  A, // первый\n  B  /* второй */\n}';
    expect(enumMembers(fake, 'E')).toEqual(['A', 'B']);
  });

  it('разбор падает на пропавшем и на удвоенном перечислении', () => {
    expect(() => enumMembers('contract C {}', 'Cause')).toThrow();
    expect(() => enumMembers('enum E { A }\nenum E { B }', 'E')).toThrow();
  });

  it('список проверяемых берётся из тела, а не сочиняется', () => {
    const fake = 'function _isChainVerifiable(Cause c) private pure returns (bool) { return c == Cause.Foo || c == Cause.Bar; }';
    expect(chainVerifiableFromSource(fake)).toEqual(['Foo', 'Bar']);
  });

  it('ветвление в теле роняет разбор, а не отдаёт половину списка', () => {
    const fake = 'function _isChainVerifiable(Cause c) private pure returns (bool) { if (c == Cause.Foo) { return true; } return false; }';
    expect(() => chainVerifiableFromSource(fake)).toThrow(/плоским/);
  });

  it('константа читается числом и падает на пропаже', () => {
    expect(uint8Constant('uint8 internal constant X = 42;', 'X')).toBe(42);
    expect(() => uint8Constant('uint8 internal constant Y = 1;', 'X')).toThrow();
  });
});
