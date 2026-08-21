import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { facetPresence } from './facetPresence';

/**
 * Замок на разбор «эта часть уже есть в цепи или ещё нет».
 *
 * ⚠️ ЗАЧЕМ. Разрез не сделан: сегодня КАЖДАЯ функция арбитражного фасета
 * отсутствует в даймонде, и вызов уходит в его fallback. Без разбора экран
 * сыпал бы непонятными отказами, и владелец полез бы искать поломку, которой
 * нет.
 *
 * ⚠️ И ГЛАВНОЕ СВОЙСТВО — РАЗЛИЧЕНИЕ ДВУХ ОТКАЗОВ. «Фасета ещё нет» лечится
 * разрезом, «сеть не ответила» — обновлением. Слей их в одно состояние, и
 * человеку с отвалившимся RPC посоветуют ждать разреза, который ему ничем не
 * поможет.
 */

describe('несмонтированный фасет отличается от молчащей сети', () => {
  it('отказ даймонда на несмонтированном селекторе читается как «ещё нет в цепи»', () => {
    expect(facetPresence({
      data: undefined, isLoading: false,
      // Дословная строка из `DiamondProxy.fallback`.
      error: { message: 'execution reverted: Diamond: function not found' },
    })).toBe('absent');
  });

  it('вызов, вернувший пустоту, — тот же случай', () => {
    expect(facetPresence({
      data: undefined, isLoading: false,
      error: { message: 'The contract function "getRemovalDelay" returned no data ("0x")' },
    })).toBe('absent');
  });

  it('любой другой отказ — это сеть, и совет другой', () => {
    expect(facetPresence({
      data: undefined, isLoading: false,
      error: { message: 'HTTP request failed. Status: 502' },
    })).toBe('unreachable');
  });

  it('ответ пришёл — работаем', () => {
    expect(facetPresence({ data: 172800n, isLoading: false, error: null })).toBe('ready');
  });

  it('ноль — это ответ, а не пустота', () => {
    // `0n` ложно по значению; спутай его с «не ответили», и экран замрёт на
    // «спрашиваем…» навсегда там, где цепь честно вернула ноль.
    expect(facetPresence({ data: 0n, isLoading: false, error: null })).toBe('ready');
  });

  it('ни данных, ни отказа — ещё не знаем', () => {
    expect(facetPresence({ data: undefined, isLoading: true, error: null })).toBe('checking');
  });

  /**
   * ⚠️ ЭТОТ СЛУЧАЙ ЛОВИТ РЕАЛЬНОЕ ПОВЕДЕНИЕ WAGMI, А НЕ ВЫДУМАННОЕ: при повторе
   * крючок поднимает `isLoading` обратно, не убирая `error`. Проверь разбор
   * загрузку первой — и «этой части ещё нет в цепи» мигало бы «спрашиваем…»
   * каждые несколько секунд.
   */
  it('повторный запрос поверх отказа не стирает новость', () => {
    expect(facetPresence({
      data: undefined, isLoading: true,
      error: { message: 'Diamond: function not found' },
    })).toBe('absent');
  });

  it('отказ без текста не выдаётся за «ещё нет в цепи»', () => {
    expect(facetPresence({ data: undefined, isLoading: false, error: {} })).toBe('unreachable');
  });

  /**
   * ⚠️ ЗАМЕР РЕВЬЮЕРА, КРУГ ПРАВОК 1. Ответ уже прочитан, очередной ПЕРЕЗАПРОС
   * сорвался — и прежний разбор уводил весь экран в `unreachable`: одна
   * неудачная сетевая попытка гасила числа и кнопки на ВСЕХ карточках списка.
   * Правила цепи при этом не могли устареть — все пять геттеров `pure`.
   */
  it('сорвавшийся перезапрос поверх УЖЕ ПРОЧИТАННЫХ данных ничего не гасит', () => {
    expect(facetPresence({
      data: 172800n, isLoading: false,
      error: { message: 'HTTP request failed. Status: 502' },
    })).toBe('ready');
  });

  it('и даже отказ «нет такой функции» не спорит с уже прочитанным ответом', () => {
    // Такого в жизни не бывает — но если бы случилось, данные на руках всё
    // равно честнее домысла про разрез.
    expect(facetPresence({
      data: 172800n, isLoading: false,
      error: { message: 'Diamond: function not found' },
    })).toBe('ready');
  });
});

/**
 * ⚠️ ШОВ С КОНТРАКТОМ. Строка, по которой мы узнаём отказ, живёт в
 * `DiamondProxy.sol`. Перепиши её там — и разбор выше замолчит, а экран снова
 * начнёт пугать владельца непонятным отказом. Ожидаемое здесь — литерал,
 * записанный руками, и исходник контракта; ни то, ни другое не выведено из
 * `facetPresence.ts`.
 */
describe('строка отказа взята у самого даймонда', () => {
  it('DiamondProxy всё ещё ревертит именно этими словами', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/DiamondProxy.sol', import.meta.url)), 'utf8',
    );
    expect(source).toContain('Diamond: function not found');
  });
});
