import { describe, it, expect } from 'vitest';
import {
  resolveApplied, withOverride, pruneSettledOverrides,
  type AppliedOverrides,
} from './optimisticApplied';

const set = (...ids: string[]) => new Set(ids);
const overrides = (entries: Array<[string, boolean]> = []): AppliedOverrides => new Map(entries);

describe('resolveApplied', () => {
  it('без своей пометки верит сабграфу', () => {
    expect(resolveApplied('7', set('7'), overrides())).toBe(true);
    expect(resolveApplied('7', set(),    overrides())).toBe(false);
  });

  // Ровно жалоба владельца: отклик уже в блоке, сабграф ещё не проиндексировал,
  // и без пометки кнопка «Откликнуться» оставалась доступной.
  it('свой отклик перебивает ещё не догнавший сабграф', () => {
    expect(resolveApplied('7', set(), overrides([['7', true]]))).toBe(true);
  });

  it('свой отзыв перебивает ещё не догнавший сабграф', () => {
    expect(resolveApplied('7', set('7'), overrides([['7', false]]))).toBe(false);
  });

  it('пометка по одному заказу не задевает остальные', () => {
    const ov = overrides([['7', true]]);
    expect(resolveApplied('8', set(), ov)).toBe(false);
    expect(resolveApplied('9', set('9'), ov)).toBe(true);
  });
});

describe('withOverride', () => {
  it('ставит пометку, не трогая исходную карту', () => {
    const before = overrides();
    const after = withOverride(before, '7', true);
    expect(after.get('7')).toBe(true);
    expect(before.size).toBe(0);
  });

  it('перезаписывает собственную предыдущую пометку (откликнулся → отозвал)', () => {
    const after = withOverride(withOverride(overrides(), '7', true), '7', false);
    expect(after.get('7')).toBe(false);
  });
});

describe('pruneSettledOverrides', () => {
  it('снимает пометку, когда сабграф с ней согласился', () => {
    const pruned = pruneSettledOverrides(overrides([['7', true]]), set('7'), set('7'));
    expect(pruned.size).toBe(0);
  });

  it('держит пометку, пока сабграф ещё не согласился', () => {
    const ov = overrides([['7', true]]);
    expect(pruneSettledOverrides(ov, set(), set('7'))).toBe(ov);
  });

  it('держит пометку по заказу, которого нет в текущей выдаче', () => {
    // Другой фильтр/страница: подтвердить пометку нечем, снимать её нельзя —
    // иначе при возврате к тому же заказу кнопка снова стала бы доступной.
    const ov = overrides([['7', true]]);
    expect(pruneSettledOverrides(ov, set(), set('1', '2'))).toBe(ov);
  });

  it('снимает подтверждённый отзыв', () => {
    const pruned = pruneSettledOverrides(overrides([['7', false]]), set(), set('7'));
    expect(pruned.size).toBe(0);
  });

  it('снимает только подтверждённые, остальные оставляет', () => {
    const pruned = pruneSettledOverrides(
      overrides([['7', true], ['8', true]]),
      set('7'),
      set('7', '8'),
    );
    expect([...pruned.keys()]).toEqual(['8']);
  });

  it('возвращает ТУ ЖЕ ссылку, если снимать нечего', () => {
    // Результат кладётся в useState — новая ссылка на каждом рендере вызывала
    // бы бесконечный цикл обновлений.
    const ov = overrides([['7', true]]);
    expect(pruneSettledOverrides(ov, set(), set())).toBe(ov);
    expect(pruneSettledOverrides(overrides(), set('1'), set('1'))).toEqual(new Map());
  });

  it('весь цикл: отклик → сабграф догнал → пометка снята, ответ не изменился', () => {
    let ov: AppliedOverrides = withOverride(overrides(), '7', true);
    expect(resolveApplied('7', set(), ov)).toBe(true);      // сабграф отстаёт
    ov = pruneSettledOverrides(ov, set(), set('7'));
    expect(ov.size).toBe(1);                                 // ещё держим
    ov = pruneSettledOverrides(ov, set('7'), set('7'));      // сабграф догнал
    expect(ov.size).toBe(0);
    expect(resolveApplied('7', set('7'), ov)).toBe(true);    // ответ тот же
  });
});
