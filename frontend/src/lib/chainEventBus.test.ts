import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { publishChainLogs, subscribeChainLogs, chainLogSinkCount } from './chainEventBus';

/**
 * Раздатчик пачек с общего фильтра цепи.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Фильтр на диамонде один (`hooks/useNotifications.ts`), а
 * читателей два: разводка уведомлений и слежение за сменой арбитра. Второй
 * фильтр рядом пробил бы бюджет опроса — замерено 3 цикла и 11 запросов в минуту
 * при потолке в 2 и 8 (`hooks/chainPollBudget.test.ts`).
 */

describe('раздатчик пачек — доставка и отписка', () => {
  it('пачка доходит до всех подписанных', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeChainLogs(a);
    const offB = subscribeChainLogs(b);
    publishChainLogs([{ eventName: 'DisputeClaimed' }]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA(); offB();
  });

  it('отписавшийся больше ничего не получает', () => {
    const a = vi.fn();
    const off = subscribeChainLogs(a);
    off();
    publishChainLogs([{ eventName: 'DisputeClaimed' }]);
    expect(a).not.toHaveBeenCalled();
  });

  it('пустая пачка никого не будит', () => {
    // Иначе каждый такт опроса без событий стоил бы читателю работы впустую.
    const a = vi.fn();
    const off = subscribeChainLogs(a);
    publishChainLogs([]);
    expect(a).not.toHaveBeenCalled();
    off();
  });

  it('мусор вместо пачки — не падение', () => {
    const a = vi.fn();
    const off = subscribeChainLogs(a);
    expect(() => publishChainLogs(null as unknown as unknown[])).not.toThrow();
    expect(a).not.toHaveBeenCalled();
    off();
  });

  it('бросок одного получателя не отменяет соседа и не роняет звавшего', () => {
    // ⚠️ Иначе одна сломанная подписка утащила бы за собой уведомления, которые
    // к ней отношения не имеют: раздача идёт из обработчика колокольчика.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = vi.fn(() => { throw new Error('получатель сломался'); });
    const ok = vi.fn();
    const off1 = subscribeChainLogs(boom);
    const off2 = subscribeChainLogs(ok);
    expect(() => publishChainLogs([{ eventName: 'X' }])).not.toThrow();
    expect(ok, 'сосед не получил пачку из-за чужого броска').toHaveBeenCalledTimes(1);
    off1(); off2(); warn.mockRestore();
  });

  it('отписка ПРЯМО В ОБРАБОТЧИКЕ не теряет соседа', () => {
    // ⚠️ Сцена настоящая: `runChainWatch` снимает слежение по видимости, и это
    // может случиться внутри разбора пачки. Обход по живому набору потерял бы
    // следующего получателя.
    const seen: string[] = [];
    let offSelf: (() => void) | null = null;
    offSelf = subscribeChainLogs(() => { seen.push('первый'); offSelf?.(); });
    const off2 = subscribeChainLogs(() => { seen.push('второй'); });
    publishChainLogs([{ eventName: 'X' }]);
    expect(seen).toEqual(['первый', 'второй']);
    off2();
  });

  it('подписавшийся ВО ВРЕМЯ раздачи эту же пачку не получает', () => {
    // ⚠️ РАДИ ЭТОЙ СЦЕНЫ РАЗДАЧА ИДЁТ ПО КОПИИ НАБОРА. По живому набору новый
    // получатель попал бы в текущий обход и увидел пачку, приехавшую ДО его
    // подписки, — то есть шапка раздатчика («подписавшийся позже пропущенного
    // не получит») стала бы неправдой, а слежение получило бы повод из чужого
    // прошлого.
    // ⚠️ Замерено: без этой сцены порча «копия → живой набор» не краснеет нигде
    // (удаление своей подписки прямо в обработчике Set переживает штатно).
    const late = vi.fn();
    let offLate: (() => void) | null = null;
    const off1 = subscribeChainLogs(() => { offLate = subscribeChainLogs(late); });
    publishChainLogs([{ eventName: 'X' }]);
    expect(late, 'подписавшийся во время раздачи получил чужую пачку').not.toHaveBeenCalled();
    publishChainLogs([{ eventName: 'Y' }]);
    expect(late, 'следующую пачку новый получатель уже обязан получить').toHaveBeenCalledTimes(1);
    off1(); offLate?.();
  });

  it('счётчик получателей честный — им меряют утечки подписки', () => {
    const before = chainLogSinkCount();
    const off = subscribeChainLogs(() => {});
    expect(chainLogSinkCount()).toBe(before + 1);
    off();
    expect(chainLogSinkCount()).toBe(before);
    off(); // повторная отписка не уводит счётчик в минус
    expect(chainLogSinkCount()).toBe(before);
  });
});

/**
 * ШОВ, У КОТОРОГО НЕТ ДРУГОГО СТОРОЖА: кто-то обязан РАЗДАВАТЬ.
 *
 * ⚠️ ЧЕСТНО ПРО ПРИРОДУ ЭТОГО ЗАМКА. Он читает исходник, а не исполняет код:
 * `useNotifications` — реактовский хук, а окружения отрисовки в проекте нет
 * (`environment: 'node'`, ни jsdom, ни testing-library), поэтому позвать его
 * по-настоящему нельзя. Это тот самый «замок на текст», к которому проект
 * относится с подозрением, и он назван таковым вслух.
 *
 * ПОЧЕМУ ОН ВСЁ РАВНО ЗАВЕДЁН. Без него удаление одной строки
 * `publishChainLogs(logs)` из хука не краснеет НИГДЕ: тесты раздатчика зовут
 * раздачу сами, тесты слежения — тоже. То есть слежение молча перестало бы
 * получать что-либо вообще, а весь прогон остался бы зелёным. Замерено:
 * убрать строку — ноль красных без этого файла.
 *
 * ЧТО ОН ПРОВЕРЯЕТ ТОЧНО: что раздача стоит в ТОЙ ЖЕ функции, которая отдана
 * общему слежению как `onLogs`, — а не просто встречается где-то в файле.
 * Значит и живые пачки, и добранные догоном проходят через раздачу.
 */
describe('общий фильтр обязан раздавать пачки — иначе слежение слепо', () => {
  const HOOK = readFileSync(
    new URL('../hooks/useNotifications.ts', import.meta.url), 'utf8',
  );

  /** Тело функции по её объявлению, по парности фигурных скобок. */
  function bodyOf(src: string, decl: string): string {
    const at = src.indexOf(decl);
    if (at < 0) throw new Error(`объявление не найдено: ${decl}`);
    const open = src.indexOf('{', at + decl.length - 1);
    if (open < 0) throw new Error(`тело не найдено: ${decl}`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    throw new Error(`тело не закрылось: ${decl}`);
  }

  it('раздача стоит внутри обработчика пачек, а не «где-то в файле»', () => {
    const body = bodyOf(HOOK, 'const handleChainLogs = useCallback(');
    expect(body, 'обработчик пачек не раздаёт их — слежение не получит ничего')
      .toMatch(/\bpublishChainLogs\s*\(/);
  });

  it('именно этот обработчик отдан общему слежению как onLogs', () => {
    // Без этой половины раздача могла бы сидеть в функции, которую никто не зовёт.
    expect(HOOK).toMatch(/onLogs:\s*handleChainLogs\b/);
  });

  it('раздача идёт ДО отказа по неподключённому кошельку', () => {
    // ⚠️ Условия у читателей разные: колокольчику без кошелька уведомлять
    // некого, а слежению пачка нужна. Поставь раздачу ниже — и читатель молча
    // остался бы без неё в чужом случае.
    const body = bodyOf(HOOK, 'const handleChainLogs = useCallback(');
    const publishAt = body.search(/\bpublishChainLogs\s*\(/);
    const bailAt = body.search(/if\s*\(!me\)\s*return;/);
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(bailAt).toBeGreaterThanOrEqual(0);
    expect(publishAt, 'раздача стоит ниже отказа по кошельку').toBeLessThan(bailAt);
  });

  it('разборщик тела падает там, где разбирать нечего', () => {
    expect(() => bodyOf('const x = 1;', 'const нетТакого = (')).toThrow();
  });
});
