import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { toEventSelector } from 'viem';
import { ARBITER_REGISTRY_ABI } from '@/config/contracts';

/**
 * Замок против расхождения ЗАПИСЕЙ СОБЫТИЙ фронта с контрактом.
 *
 * ПОЧЕМУ ЭТИ ТРИ. У каждого после Задачи 5 есть настоящий читатель во фронте:
 * `DisputeClaimed` — разводка уведомлений (`notifRouter.ts:93`), счёт арбитров
 * (`arbiterTurn.ts`) и повод перечитать (`routeArbiterChangeLogs`);
 * `DisputeReleased` и `ArbiterChatKeySet` — тот же `routeArbiterChangeLogs`
 * (поводы `arbiter_left` и `key_changed`). Род без читателя сюда не берётся:
 * это был бы замок на текст. Список пополняется РУКАМИ — ровно как в
 * `claimAbiMatchesContract.test.ts`, новое событие сам замок не найдёт.
 *
 * ЗАВОДИТСЯ ВПЕРВЫЕ. `claimAbiMatchesContract.test.ts` сверяет три ФУНКЦИИ и
 * ни одного события. Существующий `notifEvents.test.ts` сверяет topic0 набора
 * с topic0 записи в ABI — но набор ВЫНУТ ИЗ ТОГО ЖЕ ABI, то есть сверяет ABI
 * сам с собой: обе стороны уезжают вместе и красного не бывает. Здесь впервые
 * появляется внешний авторитет — ИСХОДНИК .sol (не out/*.json: out/ в гите
 * нет, и замок на результат сборки покраснеет на чистой копии).
 *
 * Что исчезнет из поведения, если снять этот замок: возможность переименовать,
 * переставить или разындексировать поле события в контракте и узнать об этом
 * от человека, у которого счёт арбитров молча стал «первый», смена ключа
 * арбитра перестала замечаться, а уведомление о взятии спора уехало не тому.
 *
 * ⚠️ ЧЕГО ЭТОТ ЗАМОК НЕ ДЕЛАЕТ: он сверяет два ТЕКСТА (`contracts.ts` и
 * `.sol`) и не трогает разбор. Второй берег того же шва — три сцены в
 * `disputeArbiter.test.ts`, где сырой лог (топики + данные) прогоняется через
 * `decodeEventLog` с боевым ABI и попадает в `routeArbiterChangeLogs`.
 */

const FACET = readFileSync(
  new URL('../../../src/facets/ArbiterRegistryFacet.sol', import.meta.url),
  'utf8',
);

interface SolParam { type: string; indexed: boolean; name: string }

/**
 * Объявление события в .sol, ровно одно. Падает на двух — по той же причине,
 * по которой падает разбор функций: перегрузка молча подменяет то, с чем
 * сверяется замок.
 */
function solidityEventParams(source: string, name: string): SolParam[] {
  const re = new RegExp(`\\bevent\\s+${name}\\s*\\(([^)]*)\\)\\s*;`, 'mg');
  const matches = [...source.matchAll(re)];
  if (matches.length === 0) throw new Error(`объявление события ${name} не найдено в исходнике`);
  if (matches.length > 1) {
    throw new Error(
      `объявление события ${name} встречается ${matches.length} раза в исходнике — ` +
      `подпись неоднозначна, каноническую сверку сделать нельзя`,
    );
  }
  return matches[0][1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const words = p.split(/\s+/);
      return {
        type: words[0],
        indexed: words.includes('indexed'),
        name: words[words.length - 1],
      };
    });
}

const solSignature = (src: string, name: string): string =>
  `${name}(${solidityEventParams(src, name).map((p) => p.type).join(',')})`;
const solIndexedMask = (src: string, name: string): string =>
  solidityEventParams(src, name).map((p) => (p.indexed ? '1' : '0')).join(',');
const solParamNames = (src: string, name: string): string =>
  solidityEventParams(src, name).map((p) => p.name).join(',');

interface AbiParam { type?: unknown; name?: unknown; indexed?: unknown }

/** Запись события в ABI фронта, ровно одна. Две записи — это два разных ответа
 *  на один вопрос, и какой из них возьмёт viem, зависит от порядка в файле. */
function abiEventInputs(abi: readonly unknown[], name: string): AbiParam[] {
  const found = (abi as { type?: string; name?: string; inputs?: AbiParam[] }[])
    .filter((e) => e && e.type === 'event' && e.name === name);
  if (found.length === 0) throw new Error(`событие ${name} не найдено в ABI фронта`);
  if (found.length > 1) throw new Error(`событие ${name} объявлено в ABI фронта ${found.length} раза`);
  return found[0].inputs ?? [];
}

const abiSignature = (abi: readonly unknown[], name: string): string =>
  `${name}(${abiEventInputs(abi, name).map((i) => String(i.type)).join(',')})`;
const abiIndexedMask = (abi: readonly unknown[], name: string): string =>
  abiEventInputs(abi, name).map((i) => (i.indexed ? '1' : '0')).join(',');
const abiParamNames = (abi: readonly unknown[], name: string): string =>
  abiEventInputs(abi, name).map((i) => String(i.name)).join(',');

/**
 * topic0, ПОСЧИТАННЫЙ ВРУЧНУЮ и записанный сюда числом. Ожидаемое не берётся
 * из проверяемого модуля: иначе сверка была бы «ABI сам с собой».
 */
const TOPIC0: Record<string, `0x${string}`> = {
  // Посчитано `cast keccak "DisputeClaimed(address,address)"` и т.д. на этом
  // же дереве 11 августа; в тест числа перенесены руками.
  DisputeClaimed:    '0xddb7f803405e3496ac82186b869e0aa05ba7c6d74692f2b2dcbd8495aa666e62',
  DisputeReleased:   '0xdc372c6159683daab376fcd61febee3e661eaeca275b83d30fb2c68a971699be',
  ArbiterChatKeySet: '0xc372da3be92ddc7ef9e32cba6c85ccfa807129b98316a615419e67d87bfc2e09',
};

/**
 * Три рода с настоящими читателями во фронте: счёт арбитров и уведомление о
 * взятии спора (`DisputeClaimed`), поводы перечитать цепь (`DisputeReleased`,
 * `ArbiterChatKeySet`). Список пополняется РУКАМИ: новое событие сам замок не
 * найдёт — ровно как в `claimAbiMatchesContract.test.ts`. Брать сюда род, у
 * которого во фронте нет читателя, запрещено: это был бы замок на текст.
 *
 * ⚠️ Список написан ЗДЕСЬ второй раз, отдельно от `ARBITER_CHANGE_EVENT_NAMES`
 * боевого модуля, и сверяются они между собой в `disputeArbiter.test.ts`. Взять
 * его импортом было бы «сверкой модуля с самим собой».
 */
const WATCHED = ['DisputeClaimed', 'DisputeReleased', 'ArbiterChatKeySet'] as const;

for (const name of WATCHED) {
  describe(`событие ${name}: ABI фронта не разошёлся с контрактом`, () => {
    it(`${name}: типы полей совпадают с исходником`, () => {
      expect(abiSignature(ARBITER_REGISTRY_ABI as readonly unknown[], name))
        .toBe(solSignature(FACET, name));
    });

    it(`${name}: ИМЕНА полей совпадают с исходником, не только типы`, () => {
      // Оба поля DisputeClaimed — address, поэтому перестановка имён
      // agreement/arbiter не меняет ни подписи, ни topic0, ни маски indexed.
      // А countClaimsForAgreement берёт args.agreement ПО ИМЕНИ: после
      // перестановки он сверял бы адрес сделки с адресом арбитра — ноль
      // совпадений, «арбитр первый» всегда.
      expect(abiParamNames(ARBITER_REGISTRY_ABI as readonly unknown[], name))
        .toBe(solParamNames(FACET, name));
    });

    it(`${name}: маска indexed совпадает с исходником`, () => {
      // topic0 индексов НЕ содержит, поэтому сверка селектора эту ошибку не
      // ловит: фильтр по args молча исчезает, а лог доезжает с args:
      // undefined (strict: false) — и не считается вовсе.
      expect(abiIndexedMask(ARBITER_REGISTRY_ABI as readonly unknown[], name))
        .toBe(solIndexedMask(FACET, name));
    });

    it(`${name}: в исходнике контракта ровно одно объявление`, () => {
      const count = (FACET.match(new RegExp(`\\bevent\\s+${name}\\s*\\(`, 'g')) ?? []).length;
      expect(count).toBe(1);
    });

    it(`${name}: в ABI фронта ровно одна запись`, () => {
      const count = (ARBITER_REGISTRY_ABI as { type?: string; name?: string }[])
        .filter((e) => e && e.type === 'event' && e.name === name).length;
      expect(count).toBe(1);
    });

    it(`${name}: topic0 сходится с написанным руками`, () => {
      expect(toEventSelector(solSignature(FACET, name))).toBe(TOPIC0[name]);
      expect(toEventSelector(abiSignature(ARBITER_REGISTRY_ABI as readonly unknown[], name)))
        .toBe(TOPIC0[name]);
    });
  });
}

describe('сами разборщики падают там, где сверять нечего', () => {
  it('два объявления одного события в исходнике — отказ, а не первое совпадение', () => {
    const fake = `
      event DisputeClaimed(address indexed agreement, address indexed arbiter);
      event DisputeClaimed(address indexed agreement);
    `;
    expect(() => solidityEventParams(fake, 'DisputeClaimed')).toThrow();
  });

  it('события нет в исходнике — отказ, а не пустая подпись', () => {
    expect(() => solidityEventParams('contract X {}', 'DisputeClaimed')).toThrow();
  });

  it('две записи события в ABI — отказ, а не первая попавшаяся', () => {
    const fake = [
      { type: 'event', name: 'DisputeClaimed', inputs: [] },
      { type: 'event', name: 'DisputeClaimed', inputs: [] },
    ];
    expect(() => abiEventInputs(fake, 'DisputeClaimed')).toThrow();
  });
});
