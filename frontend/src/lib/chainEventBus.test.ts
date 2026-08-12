import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { publishChainLogs, subscribeChainLogs, chainLogSinkCount } from './chainEventBus';
import { handleChainLogsImpl } from '@/hooks/useNotifications';

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
 * Без этих замков удаление одной строки `publishChainLogs(logs)` из обработчика
 * не краснеет НИГДЕ: тесты раздатчика зовут раздачу сами, тесты слежения — тоже.
 * Слежение молча перестало бы получать что-либо вообще, а прогон остался бы
 * зелёным. Замерено: ноль красных без этого файла.
 *
 * ⚠️ ЗАМОК ЗДЕСЬ ПОВЕДЕНЧЕСКИЙ, А НЕ ТЕКСТОВЫЙ, И ЭТО ВАЖНО. Тело обработчика
 * вынесено из хука в `handleChainLogsImpl(logs, deps)` ровно затем, чтобы его
 * можно было позвать обычным node-тестом без jsdom. Сверка текста пропускала бы
 * целый класс порчи: `if (флаг) publishChainLogs(logs)` и `publishChainLogs([])`
 * оставили бы её зелёной, а слежение — слепым. Здесь меряется РАБОТА: пачка
 * доехала до подписчика или нет.
 */
describe('обработчик пачек обязан раздавать их — замер работой', () => {
  const DEPS = {
    isArbiter: false,
    deals: new Map(),
    jobIds: new Set<string>(),
    serviceIds: new Set<string>(),
    classifyRefund: async () => ({ kind: 'refund' as const }),
    push: () => {},
    refresh: () => {},
  };

  it('раздача случилась, ХОТЯ КОШЕЛЬКА НЕТ', async () => {
    // ⚠️ ГЛАВНАЯ СЦЕНА. Условия у читателей разные: колокольчику без кошелька
    // уведомлять некого и он выходит сразу, а слежению пачка нужна всё равно.
    // Поставь раздачу ниже отказа по кошельку — этот тест краснеет.
    const got: unknown[][] = [];
    const off = subscribeChainLogs((logs) => got.push(logs));
    await handleChainLogsImpl([{ eventName: 'ArbiterChatKeySet' }], { ...DEPS, me: undefined });
    expect(got, 'пачка не роздана — слежение слепо').toHaveLength(1);
    off();
  });

  it('раздаётся ВСЯ пачка, а не пустышка', async () => {
    // ⚠️ Против `publishChainLogs([])`: текстовый замок такого не видит.
    const got: unknown[][] = [];
    const off = subscribeChainLogs((logs) => got.push(logs));
    const pack = [{ eventName: 'DisputeReleased' }, { eventName: 'ArbiterChatKeySet' }];
    await handleChainLogsImpl(pack, { ...DEPS, me: undefined });
    expect(got[0]).toHaveLength(2);
    expect(got[0]).toEqual(pack);
    off();
  });

  it('раздача идёт и при ПОДКЛЮЧЁННОМ кошельке — не «или/или»', async () => {
    const got: unknown[][] = [];
    const off = subscribeChainLogs((logs) => got.push(logs));
    await handleChainLogsImpl([{ eventName: 'ArbiterChatKeySet' }], {
      ...DEPS, me: '0xAbCdEf1111111111111111111111111111111111',
    });
    expect(got).toHaveLength(1);
    off();
  });

});

/**
 * Второй слой — сверка ТЕКСТА. Оставлен намеренно и назван вслух: он ловит то,
 * чего не видит поведенческий замер выше — что вынесенная функция действительно
 * отдана общему слежению как `onLogs`, а не осталась в стороне. Позвать хук
 * по-настоящему нельзя (jsdom в проекте нет), поэтому здесь читается исходник.
 */
describe('вынесенный обработчик действительно подключён к общему слежению', () => {
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

  it('обработчик пачек раздаёт их — раздача внутри вынесенной функции', () => {
    const body = bodyOf(HOOK, 'export async function handleChainLogsImpl(');
    expect(body, 'вынесенная функция не раздаёт пачки').toMatch(/\bpublishChainLogs\s*\(/);
  });

  it('именно эта функция отдана общему слежению как onLogs', () => {
    // ⚠️ Половина, которой нет у поведенческого замера: без неё раздача могла бы
    // жить в функции, которую не зовёт никто.
    expect(HOOK).toMatch(/onLogs:\s*handleChainLogs\b/);
    expect(HOOK).toMatch(/handleChainLogsImpl\s*\(\s*logs\s*,/);
  });

  it('разборщик тела падает там, где разбирать нечего', () => {
    expect(() => bodyOf('const x = 1;', 'const нетТакого = (')).toThrow();
  });
});
