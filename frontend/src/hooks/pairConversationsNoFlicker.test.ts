/**
 * pairConversationsNoFlicker.test.ts — сколько обновлений состояния стоит тик.
 *
 * ─── ЗАЧЕМ ЭТО ЧИСЛО ────────────────────────────────────────────────────────
 *
 * «Сколько раз перерисовалось» у фронта не спросить: нет ни jsdom, ни
 * testing-library. Зато можно спросить ровно то, из чего перерисовка берётся:
 * СКОЛЬКО РАЗ СМЕНИЛОСЬ СОСТОЯНИЕ. `setState` с тем же объектом React гасит сам
 * (`Object.is` — его собственное правило), поэтому «ноль новых объектов за
 * десять тиков» и означает «ноль перерисовок», а не «дешёвые перерисовки».
 *
 * Замер до правки: три состояния (`conversations`, `isLoading`, `error`)
 * обновлялись по отдельности, и каждый фоновый заход стоил ТРЁХ обновлений, из
 * них два — с поднятым «загружаем». Разметка читала его как «рисуй заготовки
 * строк», и владелец видел это каждые тридцать секунд.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_LIST_STATE, listStarted, listRows, listFailed, listSettled, listForAddress,
  type ConversationListState, type PairConversation,
} from '@/hooks/usePairConversations';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Свежий ответ склада: новые объекты каждый заход, как в жизни. */
function fromServer(): PairConversation[] {
  return [
    { peerAddress: A, lastText: 'привет', lastAt: 1000, lastFromMe: false },
    { peerAddress: B, lastText: 'и тебе', lastAt: 900, lastFromMe: true },
  ];
}

/** Один заход целиком, как его делает хук. Считает СМЕНЫ состояния. */
function tick(
  state: ConversationListState,
  outcome: { rows?: PairConversation[]; error?: string },
): { state: ConversationListState; changes: number } {
  let changes = 0;
  const step = (next: ConversationListState) => {
    if (next !== state) { changes++; state = next; }
  };
  step(listStarted(state));
  if (outcome.rows) step(listRows(state, outcome.rows));
  if (outcome.error) step(listFailed(state, outcome.error));
  step(listSettled(state));
  return { state, changes };
}

describe('фоновый заход, который ничего не принёс', () => {
  it('десять тиков — НОЛЬ смен состояния', () => {
    // Начинаем с непустого списка: ровно то, что видит человек, у которого
    // переписки уже загрузились.
    let state = listRows(EMPTY_LIST_STATE, fromServer());
    const rowsBefore = state.rows;

    let changes = 0;
    for (let i = 0; i < 10; i++) {
      const r = tick(state, { rows: fromServer() });
      state = r.state;
      changes += r.changes;
    }

    expect(changes, 'тик без изменений всё ещё обновляет состояние').toBe(0);
    expect(state.rows, 'ссылка на строки потеряна — значит список перерисован').toBe(rowsBefore);
    expect(state.loading, '«загружаем» поднялось при непустом списке').toBe(false);
  });

  it('«загружаем» не поднимается при непустом списке НИ ОДНОГО РАЗА', () => {
    let state = listRows(EMPTY_LIST_STATE, fromServer());
    let raised = 0;
    for (let i = 0; i < 10; i++) {
      state = listStarted(state);
      if (state.loading) raised++;
      state = listRows(state, fromServer());
      state = listSettled(state);
    }
    expect(raised, 'заготовки строк поверх непустого списка').toBe(0);
  });
});

describe('первый заход — заготовки строк обязаны быть', () => {
  it('показывать нечего — «загружаем» поднято, потом снято строками', () => {
    // Замок, который горит всегда, — не замок: обычная первая загрузка должна
    // выглядеть как раньше.
    let state = listStarted(EMPTY_LIST_STATE);
    expect(state.loading, 'первый заход не показывает заготовок').toBe(true);
    state = listRows(state, fromServer());
    state = listSettled(state);
    expect(state.loading).toBe(false);
    expect(state.rows.length).toBe(2);
  });

  it('успешный заход с ПУСТЫМ списком тоже снимает «загружаем»', () => {
    // Урок прежней версии файла: исправная работа не должна притворяться
    // поломкой и оставлять заготовки навсегда.
    let state = listStarted(EMPTY_LIST_STATE);
    state = listRows(state, []);
    state = listSettled(state);
    expect(state.loading).toBe(false);
    expect(state.rows).toEqual([]);
  });
});

describe('отказ склада не уносит строки', () => {
  it('строки на месте, код отказа рядом', () => {
    let state = listRows(EMPTY_LIST_STATE, fromServer());
    const rows = state.rows;
    const r = tick(state, { error: 'rate_limited' });
    state = r.state;
    expect(state.rows, 'отказ уничтожил уже показанные строки').toBe(rows);
    expect(state.error).toBe('rate_limited');
  });

  it('отказ снимается УСПЕХОМ, а не началом следующего захода', () => {
    // ⚠️ Раньше `setError(null)` стоял в начале каждого захода: отказ мигал
    // «есть — нет — есть» каждые тридцать секунд, и это половина мигания.
    let state = listFailed(listRows(EMPTY_LIST_STATE, fromServer()), 'rate_limited');
    state = listStarted(state);
    expect(state.error, 'отказ погас от одного лишь начала захода').toBe('rate_limited');
    state = listRows(state, fromServer());
    expect(state.error, 'успешный заход не снял отказ').toBe(null);
  });

  it('тот же отказ второй раз — НОЛЬ смен состояния', () => {
    // Склад лежит: тики идут, отказ один и тот же. Мигать нечему.
    let state = listFailed(listRows(EMPTY_LIST_STATE, fromServer()), 'rate_limited');
    let changes = 0;
    for (let i = 0; i < 10; i++) {
      const r = tick(state, { error: 'rate_limited' });
      state = r.state;
      changes += r.changes;
    }
    expect(changes, 'лежащий склад перерисовывает список каждые полминуты').toBe(0);
  });
});

describe('смена адреса гасит список сразу', () => {
  it('чужих переписок на экране не остаётся', () => {
    const mine = listRows(EMPTY_LIST_STATE, fromServer());
    const other = listForAddress(undefined);
    expect(other.rows).toEqual([]);
    expect(other.error).toBe(null);
    expect(mine.rows.length, 'состояние прежнего адреса испорчено').toBe(2);
  });

  it('у нового адреса есть память — строки берутся из неё, без заготовок', () => {
    const cached = fromServer();
    const state = listForAddress(cached);
    expect(state.rows).toBe(cached);
    expect(state.loading, 'заготовки поверх строк из памяти').toBe(false);
  });
});
