/**
 * НАБОР СОБЫТИЙ ДЛЯ ОДНОГО ФИЛЬТРА — все девять родов на месте.
 *
 * ЗАЧЕМ ЭТОТ ЗАМЕР СУЩЕСТВУЕТ. Тринадцать наблюдателей заменены одним фильтром
 * по набору событий. Если род не попал в набор — фильтр его не ловит, и
 * уведомление исчезает МОЛЧА: ни ошибки, ни красного, ни следа. Ровно тот класс
 * промаха, ради которого этот файл заведён.
 *
 * Здесь же проверяется вторая ловушка: topic0 — хэш подписи события. Описание,
 * переписанное от руки (скажем, `uint256` вместо `uint128`), даёт другой topic0,
 * и фильтр перестаёт ловить, оставаясь внешне правильным. Поэтому описания
 * вынимаются из боевых ABI, и здесь сверяется, что вынутое совпадает с ABI
 * побайтно, а не «похоже».
 */

import { describe, expect, it } from 'vitest';
import { toEventSelector } from 'viem';
import { NOTIF_EVENTS, MISSING_NOTIF_EVENTS } from './notifEvents';
import { NOTIF_EVENT_NAMES } from './notifRouter';
import { DIAMOND_ABI, SERVICE_BOARD_ABI, ARBITER_REGISTRY_ABI } from '@/config/contracts';

describe('набор событий для фильтра уведомлений', () => {
  it('ни один род не потерялся при сборке набора', () => {
    expect(MISSING_NOTIF_EVENTS, 'род есть в разводке, но не попал в фильтр — уведомление исчезнет молча').toEqual([]);
    expect(NOTIF_EVENTS).toHaveLength(NOTIF_EVENT_NAMES.length);
  });

  it('в наборе ровно те девять имён, что знает разводка', () => {
    expect(NOTIF_EVENTS.map((e) => e.name).sort()).toEqual([...NOTIF_EVENT_NAMES].sort());
  });

  it('у каждого рода свой topic0 — иначе один заслонял бы другой', () => {
    const selectors = NOTIF_EVENTS.map((e) => toEventSelector(e));
    expect(new Set(selectors).size).toBe(NOTIF_EVENTS.length);
  });

  it('описания взяты из боевых ABI побайтно, а не переписаны', () => {
    // Переписанное от руки описание с другим типом поля даёт другой topic0 —
    // фильтр перестаёт ловить, оставаясь внешне правильным.
    const all = [
      ...(DIAMOND_ABI as unknown[]),
      ...(SERVICE_BOARD_ABI as unknown[]),
      ...(ARBITER_REGISTRY_ABI as unknown[]),
    ].filter((i) => (i as { type?: string }).type === 'event');

    for (const ev of NOTIF_EVENTS) {
      const inAbi = all.find((i) => (i as { name?: string }).name === ev.name);
      expect(inAbi, `${ev.name} нет ни в одном боевом ABI`).toBeDefined();
      expect(toEventSelector(ev), `${ev.name}: topic0 не совпадает с боевым ABI`)
        .toBe(toEventSelector(inAbi as never));
    }
  });

  it('у каждого события подпись строится без ошибки — иначе фильтр не соберётся', () => {
    for (const ev of NOTIF_EVENTS) {
      expect(() => toEventSelector(ev)).not.toThrow();
      expect(toEventSelector(ev)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
