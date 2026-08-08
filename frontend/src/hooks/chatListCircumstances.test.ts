/**
 * chatListCircumstances.test.ts — пять вопросов про обстоятельства, ответ числом.
 *
 * Правило владельца от 4 августа (`docs/PROCESS.md`): к каждой правке —
 * перезапустили посреди работы, отказал склад, два процесса разом, пришёл мусор,
 * долбят нарочно. Здесь эти пять заданы НОВОМУ коду списка переписок: сшивателю
 * строк, состоянию списка, исходу колонки и одному заходу за списком.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EMPTY_LIST_STATE, listStarted, listRows, listFailed, listSettled,
  createConversationLoader, loadPairConversations, _resetPreviewCacheForTest,
  PREVIEW_BUDGET_PER_LOAD,
  type ConversationListState, type PairConversation,
} from '@/hooks/usePairConversations';
import { mergeConversationRows } from '@/lib/chatListRows';
import { listPhase, listNotice } from '@/lib/chatListPhase';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import type { ChatSession } from '@/lib/chatSession';

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

const ALICE = '0xA1cE00000000000000000000000000000000CAfE' as const;

async function makeSession(): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig('a1')),
    address: ALICE, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

function rows(n: number, textPrefix = 'сообщение'): PairConversation[] {
  const out: PairConversation[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      peerAddress: '0x' + (i + 256).toString(16).padStart(40, '0'),
      lastText: `${textPrefix} ${i}`, lastAt: 1_700_000_000_000 - i, lastFromMe: false, preview: 'text',
    });
  }
  return out;
}

const BASE_PHASE = {
  hasRows: false, loading: false, signatureReason: null as null,
  keyNotAnnounced: false, sessionStatus: 'ready' as const, error: null as string | null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
  _resetPreviewCacheForTest();
});

/* ═════════ 1. перезапустили посреди работы — что уцелело ═══════════════════ */

describe('человек ушёл посреди захода и вернулся', () => {
  it('заход не доиграл — строки на экране целы, заготовок нет', () => {
    // Уход со страницы обрывает заход на середине: `onRows` не позовётся вовсе.
    let state = listRows(EMPTY_LIST_STATE, rows(3));
    const before = state.rows;
    state = listStarted(state);          // пошли за списком
    // …и здесь человек ушёл. Возврат: заход начинается заново.
    state = listStarted(state);
    expect(state.rows, 'оборванный заход потерял строки').toBe(before);
    expect(state.loading, 'заготовки поверх целого списка').toBe(false);
    expect(listPhase({ ...BASE_PHASE, hasRows: true, loading: state.loading })).toBe('rows');
  });

  it('запоздавший заход принёс ТО ЖЕ — ни одной смены состояния', () => {
    // Два захода в полёте (интервал плюс возврат во вкладку) садятся друг за
    // другом. Второй ответ такой же — значит на экране не должно дрогнуть ничто.
    let state = listRows(EMPTY_LIST_STATE, rows(3));
    let changes = 0;
    for (const answer of [rows(3), rows(3)]) {
      const next = listRows(state, answer);
      if (next !== state) changes++;
      state = next;
    }
    expect(changes).toBe(0);
  });

  it('перезапуск вкладки: памяти нет — заготовки на месте, и это верно', () => {
    // Память списка живёт в модуле, перезагрузка её уносит. Показывать нечего —
    // значит заготовки честны: ждём сеть, а не человека.
    const state = listStarted(EMPTY_LIST_STATE);
    expect(state.loading).toBe(true);
    expect(listPhase({ ...BASE_PHASE, hasRows: false, loading: true })).toBe('skeleton');
  });
});

/* ═════════ 2. склад отказал — прежнее или пустота ═════════════════════════ */

describe('склад отказывает', () => {
  it('десять отказов подряд — строки целы, смен состояния НОЛЬ после первого', () => {
    let state = listRows(EMPTY_LIST_STATE, rows(5));
    const before = state.rows;
    state = listFailed(state, 'rate_limited');
    let changes = 0;
    for (let i = 0; i < 10; i++) {
      const a = listStarted(state);
      const b = listFailed(a, 'rate_limited');
      const c = listSettled(b);
      if (a !== state || b !== a || c !== b) changes++;
      state = c;
    }
    expect(changes, 'лежащий склад перерисовывает список каждый тик').toBe(0);
    expect(state.rows, 'отказ склада уносит строки').toBe(before);
    expect(listPhase({ ...BASE_PHASE, hasRows: true, error: 'rate_limited' })).toBe('rows');
    expect(listNotice({ ...BASE_PHASE, hasRows: true, error: 'rate_limited' })).toBe('stale');
  });

  it('показывать нечего и склад отказал — экран отказа, а не вечные заготовки', () => {
    expect(listPhase({ ...BASE_PHASE, hasRows: false, error: 'rate_limited' })).toBe('error');
  });
});

/* ═════════ 3. два процесса разом ══════════════════════════════════════════ */

describe('два захода разом', () => {
  it('пять зовов одного загрузчика — ОДИН заход, а не пять', async () => {
    // ⚠️ Заходов у списка три источника: интервал 30 с, возврат во вкладку и
    // новое сообщение в открытой переписке. Они накладываются, и без склейки
    // каждый стоил бы своего перечисления, своего пропуска и своих скачиваний —
    // из общего бюджета чтения, который делится с открытой перепиской.
    let started = 0;
    let release: (() => void) | null = null;
    const loader = createConversationLoader({
      getPass: async () => 'v1.p',
      loadWithPass: async () => {
        started++;
        await new Promise<void>(r => { release = r; });
        return rows(2);
      },
      onRows: () => {},
    });
    const all = [loader.run(), loader.run(), loader.run(), loader.run(), loader.run()];
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started, 'пять зовов дали пять заходов').toBe(1);
    release?.();
    await Promise.all(all);
    expect(started).toBe(1);
    // Склейка не запирает НАВСЕГДА: следующий зов — новый заход.
    release = null;
    const again = loader.run();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(started).toBe(2);
    release?.();
    await again;
  });

  it('две вкладки: у каждой свой список, и они не портят друг другу строки', () => {
    // Состояние списка — своё у вкладки, общей мутируемой памяти между ними нет.
    // Замер против случайной «оптимизации» через общий массив.
    const tabA = listRows(EMPTY_LIST_STATE, rows(3));
    const tabB = listRows(EMPTY_LIST_STATE, rows(2));
    expect(tabA.rows.length).toBe(3);
    expect(tabB.rows.length).toBe(2);
    const tabB2 = listFailed(tabB, 'rate_limited');
    expect(tabA.error, 'отказ в одной вкладке испортил другую').toBe(null);
    expect(tabB2.error).toBe('rate_limited');
  });
});

/* ═════════ 4. пришёл мусор ════════════════════════════════════════════════ */

describe('пришёл мусор', () => {
  it('мусор вместо перечисления — вердикт, а не падение; строки целы', async () => {
    const session = await makeSession();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('не json вовсе', { status: 200 })));
    await expect(loadPairConversations(session, 'v1.p')).rejects.toBeInstanceOf(Error);
    // И это идёт в отказ захода, а не в пустой список: строки остаются.
    let state = listRows(EMPTY_LIST_STATE, rows(2));
    const before = state.rows;
    state = listFailed(state, 'malformed');
    expect(state.rows).toBe(before);
  }, 20_000);

  it('мусорная строка от склада (адрес не адрес) — заход отказывает целиком', async () => {
    const session = await makeSession();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({
          inbox: [], sent: [],
          peers: [{ address: 'не-адрес', lastActivityWithMeAt: 1 }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));
    await expect(loadPairConversations(session, 'v1.p')).rejects.toBeInstanceOf(Error);
  }, 20_000);

  it('битая строка в сшивателе (тот же адрес дважды) — не роняет и не теряет', () => {
    // Склад в теории может отдать одного собеседника двумя строками. Сшиватель
    // обязан отдать столько строк, сколько пришло, а не упасть на ключе.
    const dup: PairConversation[] = [
      { peerAddress: '0xaa', lastText: 'раз', lastAt: 2, lastFromMe: false },
      { peerAddress: '0xaa', lastText: 'два', lastAt: 1, lastFromMe: false },
    ];
    const merged = mergeConversationRows([], dup);
    expect(merged.length).toBe(2);
    expect(mergeConversationRows(merged, dup), 'повтор того же мусора всё равно тот же').toBe(merged);
  });
});

/* ═════════ 5. долбят нарочно ══════════════════════════════════════════════ */

describe('тысяча переписок', () => {
  it('второй тик на тысяче строк — НОЛЬ новых ссылок и ноль смен состояния', () => {
    const first = rows(1000);
    let state = listRows(EMPTY_LIST_STATE, first);
    const before = state.rows;
    let changes = 0;
    for (let i = 0; i < 10; i++) {
      // Новые объекты каждый заход — как в жизни: склад собирает ответ заново.
      const next = listRows(state, rows(1000));
      if (next !== state) changes++;
      state = next;
    }
    expect(changes, 'тысяча строк перерисовывается на каждом тике').toBe(0);
    expect(state.rows).toBe(before);
  });

  it('изменилась ОДНА строка из тысячи — перерисуется одна', () => {
    const state = listRows(EMPTY_LIST_STATE, rows(1000));
    const next = rows(1000);
    next[500] = { ...next[500], lastText: 'новое слово', lastAt: next[500].lastAt + 1 };
    const merged = mergeConversationRows(state.rows, next);
    const redrawn = merged.filter((r, i) => r !== state.rows[i]).length;
    expect(redrawn, 'перерисуется больше строк, чем изменилось').toBe(1);
  });

  it('тысяча посторонних — скачиваний не больше бюджета за заход', async () => {
    // Мешок в чужой ящик кладёт кто угодно, кто знает адрес. Замер здесь ради
    // одного: потолок стоит на дороге, а не в комментарии.
    const session = await makeSession();
    let downloads = 0;
    const peers: { address: string; lastActivityWithMeAt: number }[] = [];
    const inbox: { key: string; sender: string; size: number; uploadedAt: number }[] = [];
    for (let i = 0; i < 1000; i++) {
      const addr = '0x' + (i + 4096).toString(16).padStart(40, '0');
      peers.push({ address: addr, lastActivityWithMeAt: 1_700_000_000_000 + i });
      inbox.push({ key: `${addr}/${i}.bin`, sender: addr, size: 100, uploadedAt: 1_700_000_000_000 + i });
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags') {
        return new Response(JSON.stringify({ inbox, sent: [], peers }), { status: 200 });
      }
      downloads++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }));
    const list = await loadPairConversations(session, 'v1.p');
    expect(list.length).toBe(1000);
    expect(downloads, 'потолок скачиваний за заход не держит').toBeLessThanOrEqual(PREVIEW_BUDGET_PER_LOAD);
    // И ни одна из тысячи строк не врёт «сообщений пока нет»: мешок у каждой есть.
    expect(list.every(r => r.preview !== 'none')).toBe(true);
  }, 40_000);
});
