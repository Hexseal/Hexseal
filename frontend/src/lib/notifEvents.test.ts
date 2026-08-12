/**
 * НАБОР СОБЫТИЙ ДЛЯ ОДНОГО ФИЛЬТРА — все рода на месте, с ОБЕИХ сторон.
 *
 * ЗАЧЕМ ЭТОТ ЗАМЕР СУЩЕСТВУЕТ. Тринадцать наблюдателей заменены одним фильтром
 * по набору событий. Если род не попал в набор — фильтр его не ловит, и
 * уведомление исчезает МОЛЧА: ни ошибки, ни красного, ни следа. Ровно тот класс
 * промаха, ради которого этот файл заведён.
 *
 * ⚠️ ЧИТАТЕЛЕЙ У ПРОВОДА ДВА, И СПИСКА ТОЖЕ ДВА. `NOTIF_EVENT_NAMES` — рода,
 * которые становятся уведомлениями; `WIRE_ONLY_EVENT_NAMES` — рода, которые
 * едут ради слежения за сменой арбитра и уведомлениями НЕ становятся.
 *
 * ⚠️ И ЧЕСТНО ПРО СИЛУ ЗДЕШНИХ ПРОВЕРОК, потому что легко принять одно за
 * другое. Набор фильтра СОБИРАЕТСЯ из двух списков, поэтому всякая сверка
 * «набор == объединение» ПРОИЗВОДНАЯ: она сторожит сборку, а не состав списков,
 * и по построению зелена. Состав держат только НЕЗАВИСИМЫЕ опоры, написанные
 * отдельной рукой:
 *   • колокольчик — ветки `switch` в самой разводке (сверка тут же ниже);
 *   • слежение — `ARBITER_CHANGE_EVENT_NAMES` в `disputeArbiter.test.ts`, и
 *     сразу в обе стороны: что слежение читает — обязано ехать, и что положено
 *     на провод «ради слежения» — обязано им читаться.
 *
 * Здесь же проверяется вторая ловушка: topic0 — хэш подписи события. Описание,
 * переписанное от руки (скажем, `uint256` вместо `uint128`), даёт другой topic0,
 * и фильтр перестаёт ловить, оставаясь внешне правильным. Поэтому описания
 * вынимаются из боевых ABI, и здесь сверяется, что вынутое совпадает с ABI
 * побайтно, а не «похоже».
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toEventSelector } from 'viem';
import { WIRE_EVENTS, WIRE_EVENT_NAMES, MISSING_WIRE_EVENTS } from './notifEvents';
import { NOTIF_EVENT_NAMES, WIRE_ONLY_EVENT_NAMES } from './notifRouter';
import { DIAMOND_ABI, SERVICE_BOARD_ABI, ARBITER_REGISTRY_ABI } from '@/config/contracts';

describe('набор событий для общего фильтра', () => {
  it('ни один род не потерялся при сборке набора', () => {
    expect(MISSING_WIRE_EVENTS, 'род объявлен, но не попал в фильтр — он исчезнет молча').toEqual([]);
    expect(WIRE_EVENTS).toHaveLength(WIRE_EVENT_NAMES.length);
  });

  /**
   * ⚠️ ЧЕСТНО ПРО ЭТУ ПРОВЕРКУ: она ПРОИЗВОДНАЯ и ловит ровно одно — правку
   * самой сборки `WIRE_EVENT_NAMES`. Ожидаемое считается тем же выражением над
   * теми же двумя списками, что и боевое значение, поэтому «набор равен
   * объединению» зелено ПО ПОСТРОЕНИЮ, пока сборку не трогают. Выдавать её за
   * замок на состав списков нельзя — это было бы «сверка модуля с самим собой».
   *
   * Настоящие, независимые опоры — ниже и в соседних файлах:
   *  • состав стороны колокольчика держит `switch` боевой разводки (тест ниже);
   *  • состав стороны слежения держит `ARBITER_CHANGE_EVENT_NAMES`
   *    (`disputeArbiter.test.ts`, обе стороны: род читается ⇒ едет, и едет ⇒
   *    читается).
   */
  it('набор равен сборке из двух списков (производная проверка сборки)', () => {
    const want = [...new Set<string>([...NOTIF_EVENT_NAMES, ...WIRE_ONLY_EVENT_NAMES])].sort();
    expect(WIRE_EVENTS.map((e) => e.name).sort()).toEqual(want);
  });

  /**
   * НЕЗАВИСИМАЯ ОПОРА СТОРОНЫ КОЛОКОЛЬЧИКА: ветки `switch` боевой разводки.
   *
   * Список `NOTIF_EVENT_NAMES` и ветки `case` пишутся РУКАМИ и порознь, поэтому
   * сверка между ними не тавтологична. Что она ловит, чего не ловил никто:
   *  • имя добавили в список, а ветку написать забыли — фильтр везёт род, его
   *    отбирают как «известный», и он не делает НИЧЕГО (тихая потеря);
   *  • ветку написали, а имя в список не внесли — до `switch` дело не дойдёт
   *    вовсе, потому что род отсеется по `!KNOWN` (мёртвый код).
   */
  it('сторона КОЛОКОЛЬЧИКА: ветки разводки и её список — одно и то же', () => {
    const ROUTER = readFileSync(new URL('./notifRouter.ts', import.meta.url), 'utf8');
    const body = ROUTER.slice(ROUTER.indexOf('switch (event as NotifEventName)'));
    const cases = [...body.matchAll(/^\s{6}case '([A-Za-z0-9_]+)':/gm)].map((m) => m[1]);
    expect(cases.length, 'ветки разводки не нашлись — разборщик сломан').toBeGreaterThan(0);
    expect([...new Set(cases)].sort()).toEqual([...NOTIF_EVENT_NAMES].sort());
  });

  it('сторона КОЛОКОЛЬЧИКА: каждый род разводки есть на проводе', () => {
    // Убрать род отсюда — значит потерять уведомление молча: фильтр перестанет
    // его ловить, а разводка так и будет ждать.
    const onWire = new Set(WIRE_EVENTS.map((e) => e.name));
    const lost = NOTIF_EVENT_NAMES.filter((n) => !onWire.has(n));
    expect(lost, 'род разводки не едет по проводу — уведомление исчезнет молча').toEqual([]);
  });

  it('сторона СЛЕЖЕНИЯ: каждый род «только на провод» есть на проводе', () => {
    // Убрать род отсюда — значит перестать замечать смену ключа арбитра: сторона
    // запечатает мешок на протухший ключ и не узнает об этом никогда.
    const onWire = new Set(WIRE_EVENTS.map((e) => e.name));
    const lost = WIRE_ONLY_EVENT_NAMES.filter((n) => !onWire.has(n));
    expect(lost, 'род слежения не едет по проводу — смена ключа перестанет замечаться').toEqual([]);
  });

  it('два списка не пересекаются по смыслу: «только на провод» НЕ уведомления', () => {
    // ⚠️ Иначе имя `WIRE_ONLY_EVENT_NAMES` врало бы: род из него попал бы в
    // разводку и стал бы колокольчиком человеку.
    const bell = new Set<string>(NOTIF_EVENT_NAMES);
    const both = WIRE_ONLY_EVENT_NAMES.filter((n) => bell.has(n));
    expect(both, '«только на провод» оказался и уведомлением — списки разъехались').toEqual([]);
  });

  it('у каждого рода свой topic0 — иначе один заслонял бы другой', () => {
    const selectors = WIRE_EVENTS.map((e) => toEventSelector(e));
    expect(new Set(selectors).size).toBe(WIRE_EVENTS.length);
  });

  it('описания взяты из боевых ABI побайтно, а не переписаны', () => {
    // Переписанное от руки описание с другим типом поля даёт другой topic0 —
    // фильтр перестаёт ловить, оставаясь внешне правильным.
    const all = [
      ...(DIAMOND_ABI as unknown[]),
      ...(SERVICE_BOARD_ABI as unknown[]),
      ...(ARBITER_REGISTRY_ABI as unknown[]),
    ].filter((i) => (i as { type?: string }).type === 'event');

    for (const ev of WIRE_EVENTS) {
      const inAbi = all.find((i) => (i as { name?: string }).name === ev.name);
      expect(inAbi, `${ev.name} нет ни в одном боевом ABI`).toBeDefined();
      expect(toEventSelector(ev), `${ev.name}: topic0 не совпадает с боевым ABI`)
        .toBe(toEventSelector(inAbi as never));
    }
  });

  it('у каждого события подпись строится без ошибки — иначе фильтр не соберётся', () => {
    for (const ev of WIRE_EVENTS) {
      expect(() => toEventSelector(ev)).not.toThrow();
      expect(toEventSelector(ev)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
