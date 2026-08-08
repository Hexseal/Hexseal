/**
 * chatListRows.test.ts — сколько строк перерисуется, если ничего не изменилось.
 *
 * ─── ПОЧЕМУ ЭТО ЗАМЕР, А НЕ ОПИСАНИЕ НАМЕРЕНИЯ ──────────────────────────────
 *
 * React не перерисовывает состояние, которое пришло ТЕМ ЖЕ объектом
 * (`Object.is` — его собственное правило выхода из обновления), а строка списка
 * обёрнута в `memo`. Значит «сколько строк перерисуется» ровно равно «сколько
 * новых ссылок отдал этот сшиватель» — и это число здесь считается.
 *
 * До правки сшивателя не было вовсе: каждый заход собирал строки с нуля, то есть
 * НОВУЮ ссылку на каждую, и весь список перерисовывался целиком каждые тридцать
 * секунд — даже когда склад отвечал ровно тем же.
 */
import { describe, it, expect } from 'vitest';
import { mergeConversationRows } from '@/lib/chatListRows';
import type { PairConversation } from '@/hooks/usePairConversations';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Свежий набор строк — как его собирает `loadPairConversations`: новые объекты
 *  каждый раз, ни одной прежней ссылки. */
function fresh(): PairConversation[] {
  return [
    { peerAddress: A, lastText: 'привет', lastAt: 1000, lastFromMe: false },
    { peerAddress: B, lastText: 'и тебе', lastAt: 900, lastFromMe: true },
  ];
}

describe('тик не принёс изменений', () => {
  it('десять тиков — ноль новых ссылок на список и на строки', async () => {
    let rows = fresh();
    const first = rows;
    let newLists = 0;
    let newRows = 0;
    for (let i = 0; i < 10; i++) {
      const next = mergeConversationRows(rows, fresh());
      if (next !== rows) newLists++;
      newRows += next.filter((r, j) => r !== rows[j]).length;
      rows = next;
    }
    expect(newLists, 'список пересобран на тике без изменений').toBe(0);
    expect(newRows, 'строки пересобраны на тике без изменений').toBe(0);
    expect(rows, 'ссылка на первый набор потеряна').toBe(first);
  });
});

describe('тик принёс изменения — но только там, где они есть', () => {
  it('изменилась ОДНА строка — вторая приходит прежней ссылкой', async () => {
    const rows = fresh();
    const next = mergeConversationRows(rows, [
      { peerAddress: A, lastText: 'новое слово', lastAt: 1100, lastFromMe: false },
      { peerAddress: B, lastText: 'и тебе', lastAt: 900, lastFromMe: true },
    ]);
    expect(next, 'список не пересобрался, хотя строка изменилась').not.toBe(rows);
    expect(next[0], 'изменившаяся строка пришла прежней ссылкой').not.toBe(rows[0]);
    expect(next[1], 'неизменившаяся строка пересобрана зря').toBe(rows[1]);
    const redrawn = next.filter((r, i) => r !== rows[i]).length;
    expect(redrawn, 'перерисуется больше строк, чем изменилось').toBe(1);
  });

  it('добавилась переписка — прежние строки остаются прежними ссылками', async () => {
    const rows = fresh();
    const next = mergeConversationRows(rows, [
      ...fresh(),
      { peerAddress: '0xcccccccccccccccccccccccccccccccccccccccc', lastText: 'третий', lastAt: 800, lastFromMe: false },
    ]);
    expect(next).not.toBe(rows);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]).toBe(rows[1]);
    expect(next.length).toBe(3);
  });

  it('порядок поменялся — это изменение, а не тишина', async () => {
    const rows = fresh();
    const swapped = [fresh()[1], fresh()[0]];
    const next = mergeConversationRows(rows, swapped);
    expect(next).not.toBe(rows);
    expect(next.map(r => r.peerAddress)).toEqual([B, A]);
  });

  it('переписка исчезла со склада — список пересобран', async () => {
    const rows = fresh();
    const next = mergeConversationRows(rows, [fresh()[0]]);
    expect(next).not.toBe(rows);
    expect(next.length).toBe(1);
    expect(next[0], 'уцелевшая строка пересобрана зря').toBe(rows[0]);
  });

  it('пустой список остаётся ТЕМ ЖЕ пустым — иначе мигает и он', async () => {
    const empty: PairConversation[] = [];
    expect(mergeConversationRows(empty, [])).toBe(empty);
  });

  it('причина пустого превью сменилась — это изменение: она видна словами', async () => {
    // «Ещё не загружено» → мешок доехал и не вскрылся. Текст пуст в обоих
    // случаях, а на экране РАЗНЫЕ слова: сшиватель обязан это заметить.
    const rows: PairConversation[] = [
      { peerAddress: A, lastText: '', lastAt: 1000, lastFromMe: false, preview: 'pending' },
    ];
    const next = mergeConversationRows(rows, [
      { peerAddress: A, lastText: '', lastAt: 1000, lastFromMe: false, preview: 'unreadable' },
    ]);
    expect(next, 'смена причины пустого превью проигнорирована').not.toBe(rows);
    expect(next[0].preview).toBe('unreadable');
  });
});
