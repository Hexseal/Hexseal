import { describe, it, expect } from 'vitest';
import { decideNoKeyNotice, ZERO_KEY } from './arbiterChatKey';
import type { Hex } from 'viem';

const KEY = ('0x' + 'aa'.repeat(32)) as Hex;

/**
 * ⚠️ Замок против противоречия, которое уже один раз проскочило в задание
 * этого же плана: «отказ чтения» и «ключа нет» — РАЗНЫЕ вещи. До разреза
 * даймонда функции getArbiterChatKeys там нет вовсе, чтение ревертит, и если
 * это читать как «ключа нет» — дисклеймер увидят ВСЕ арбитры и получат
 * кнопку, которая тоже не может сработать (setArbiterChatKey в даймонде ещё
 * тоже нет). Разметка обязана звать decideNoKeyNotice, а не повторять
 * условие руками — иначе замок сторожит функцию, которой никто не пользуется.
 */
describe('дисклеймер про отсутствующий ключ', () => {
  it('ключа правда нет — показываем', () => {
    expect(decideNoKeyNotice({ keys: [ZERO_KEY, ZERO_KEY], error: null })).toBe(true);
  });

  it('ключ есть — не показываем', () => {
    expect(decideNoKeyNotice({ keys: [KEY, KEY], error: null })).toBe(false);
  });

  it('ЧТЕНИЕ ОТКАЗАЛО — МОЛЧИМ, а не показываем', () => {
    // До разреза даймонда функции там нет и чтение ревертит. Показать дисклеймер
    // значило бы предложить всем кнопку, которая не может сработать.
    expect(decideNoKeyNotice({ keys: undefined, error: new Error('reverted') })).toBe(false);
  });

  it('ещё не прочитали — тоже молчим', () => {
    expect(decideNoKeyNotice({ keys: undefined, error: null })).toBe(false);
  });

  it('только половина ключа нулевая — тоже показываем (ключ битый наполовину)', () => {
    expect(decideNoKeyNotice({ keys: [ZERO_KEY, KEY], error: null })).toBe(true);
    expect(decideNoKeyNotice({ keys: [KEY, ZERO_KEY], error: null })).toBe(true);
  });
});
