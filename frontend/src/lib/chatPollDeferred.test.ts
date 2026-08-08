/**
 * chatPollDeferred.test.ts — «ждём нажатия» не считается неудачей входа.
 *
 * ─── ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ СТРОКА В СОСЕДНЕМ ───────────────────────────
 *
 * Это замер на КЛАСС «своя починка хуже дефекта», а не на новую возможность.
 *
 * `pollBags` считает ЛЮБОЙ отказ `getPass()` неудачей ВХОДА и на третьей подряд
 * останавливает опрос навсегда, зовя `onAuthFailed` (`DEFAULT_AUTH_FAILURE_LIMIT`).
 * Правило заведено против бесконечных окон кошелька и правильно.
 *
 * Но отсечка подписи (`chatSignatureGate.ts`) отказывает `getPass()` РОВНО ТАК
 * ЖЕ — а причина у неё обратная: она не «не смогли войти», она «ещё не время,
 * человек не нажал». Опрос активен раз в 5 секунд; значит нетронутый счётчик
 * убил бы чат за 15 секунд ожидания кнопки — то есть починка, заведённая против
 * мёртвого чата на телефоне, сама делала бы его мёртвым, и быстрее прежнего.
 *
 * Образец, как это надо делать, в файле уже есть: `BagBudgetError` — «свой
 * бюджет — не отказ склада», ни счётчика, ни отступления.
 *
 * ⚠️ ЧТО КРАСИТ ЭТОТ ЗАМОК: снятие исключения для `ChatSignatureDeferred` в
 * `pollBags`. Мутация замерена в отчёте.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollBags } from '@/lib/chatTransport';
import { ChatSignatureDeferred } from '@/lib/chatSignatureGate';

let sleeps: number[] = [];

/** Подделка сна: считает такты и отдаёт управление, чтобы цикл шёл быстро. */
function fakeSleep(): (ms: number) => Promise<void> {
  return async (ms: number) => { sleeps.push(ms); await Promise.resolve(); };
}

beforeEach(() => {
  sleeps = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ inbox: [], sent: [], peers: [] }), { status: 200 },
  )));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('ЗАМЕР: ожидание нажатия не убивает опрос', () => {
  it('отсечка отказывает на каждом тике — onAuthFailed НЕ зовётся ни разу', async () => {
    let authFailed = 0;
    let errors = 0;
    let getPassCalls = 0;

    const handle = pollBags({
      getPass: () => { getPassCalls++; throw new ChatSignatureDeferred('needs_press'); },
      isActive: () => true,
      onBags: () => {},
      onError: () => { errors++; },
      onAuthFailed: () => { authFailed++; },
      sleep: fakeSleep(),
    });

    // Тиков заведомо больше предела (3): если исключения нет, опрос обязан
    // умереть на третьем, и число ниже станет 1.
    for (let i = 0; i < 40 && getPassCalls < 12; i++) await Promise.resolve();
    handle.stop();

    expect(getPassCalls, 'опрос остановился, не дождавшись нажатия').toBeGreaterThanOrEqual(4);
    expect(authFailed, 'ожидание нажатия зачли за неудачу входа и убили чат').toBe(0);
    expect(errors, 'ожидание нажатия показано человеку как сбой').toBe(0);
  });

  it('после нажатия опрос продолжается тем же движком, без перезавода', async () => {
    // Главное следствие: пока человек не нажал, опрос ЖИВ и ждёт. Нажал —
    // следующий же тик проходит. Если бы отсечка убивала опрос, нажатие
    // требовало бы перезагрузки страницы, а не одного тика.
    let deferUntilPress = true;
    let ticks = 0;

    const handle = pollBags({
      getPass: () => {
        if (deferUntilPress) throw new ChatSignatureDeferred('needs_press');
        return 'v1.p';
      },
      isActive: () => true,
      onBags: () => { ticks++; },
      onAuthFailed: () => {},
      sleep: fakeSleep(),
    });

    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(ticks, 'опрос отдавал мешки, пока пропуска не было').toBe(0);

    deferUntilPress = false;
    for (let i = 0; i < 30 && ticks === 0; i++) await Promise.resolve();
    handle.stop();

    expect(ticks, 'после нажатия опрос не ожил — движок пришлось бы заводить заново').toBeGreaterThanOrEqual(1);
  });

  it('ожидание не разгоняет отступление — интервал остаётся обычным', async () => {
    // Отступление существует против ОТКАЗОВ. Ожидание нажатия отказом не
    // является: разогнав интервал до пяти минут, мы получили бы чат, который
    // после нажатия оживает через пять минут — то есть выглядит сломанным.
    let getPassCalls = 0;
    const handle = pollBags({
      getPass: () => { getPassCalls++; throw new ChatSignatureDeferred('page_hidden'); },
      isActive: () => true,
      onBags: () => {},
      onAuthFailed: () => {},
      sleep: fakeSleep(),
      intervals: { activeMs: 5_000, backgroundMs: 30_000, maxBackoffMs: 300_000 },
    });

    for (let i = 0; i < 40 && getPassCalls < 6; i++) await Promise.resolve();
    handle.stop();

    const grown = sleeps.filter(ms => ms > 5_000);
    expect(grown, `отступление разогналось: ${JSON.stringify(sleeps.slice(0, 6))}`).toEqual([]);
  });
});

describe('ЗАМЕР: список переписок — тот же счётчик, та же беда', () => {
  it('ожидание нажатия не останавливает загрузчик списка навсегда', async () => {
    // ⚠️ ВТОРОЙ счётчик неудач входа живёт в `createConversationLoader` — своя
    // копия того же правила, со своим пределом. Починив только `pollBags`, мы
    // получили бы список переписок, умирающий ровно там, где открытая переписка
    // уже выжила: половина беды исправлена, половина нет, и заметно это только
    // на списке — то есть в том месте, куда попадают чаще всего.
    const { createConversationLoader } = await import('@/hooks/usePairConversations');

    let authFailed = 0;
    let deferUntilPress = true;
    let rows = 0;

    const loader = createConversationLoader({
      getPass: () => {
        if (deferUntilPress) throw new ChatSignatureDeferred('not_announced');
        return 'v1.p';
      },
      loadWithPass: async () => { rows++; return []; },
      onRows: () => {},
      onAuthFailed: () => { authFailed++; },
    });

    // Заходов заведомо больше предела (3).
    for (let i = 0; i < 6; i++) await loader.run();

    expect(authFailed, 'ожидание зачли за неудачу входа и остановили список').toBe(0);
    expect(loader.stopped(), 'загрузчик остановлен — нажатие уже ничего не даст').toBe(false);

    deferUntilPress = false;
    await loader.run();
    expect(rows, 'после нажатия список так и не загрузился').toBe(1);
  });
});
