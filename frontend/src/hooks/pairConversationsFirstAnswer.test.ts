/**
 * pairConversationsFirstAnswer.test.ts — «склада ещё не спрашивали» как ФАКТ.
 *
 * ─── ЧТО ИМЕННО СЛОМАНО ─────────────────────────────────────────────────────
 *
 * `loading` в состоянии списка отвечает на вопрос «заход В ПОЛЁТЕ прямо сейчас».
 * Это НЕ тот вопрос, который решает, что показать человеку. Заход снимается в
 * `finally` даже тогда, когда он не состоялся вовсе — порог подписи отложил его
 * молча (`ChatSignatureDeferred`, `chatSignatureGate.ts`), — и начальное
 * состояние списка становится буква-в-букву неотличимо от «склад ответил, у вас
 * ничего нет».
 *
 * Замер с живого телефона: двенадцать секунд «Переписок пока нет» про склад,
 * которого никто не спрашивал.
 *
 * ─── ЧТО ЗДЕСЬ ЗАПИРАЕТСЯ ───────────────────────────────────────────────────
 *
 * Третий факт: `everAnswered` — «склад отвечал хоть раз, строками или отказом».
 * Он ОДНОНАПРАВЛЕННЫЙ: false → true и никогда обратно (в пределах адреса и
 * вкладки). Отсюда и число, которое требует владелец: признак загрузки может
 * показаться РОВНО ОДИН РАЗ, и это по построению, а не по нашей аккуратности.
 * День назад чинили обратную беду — заготовки на каждом перечитывании, — и
 * вернуть её нельзя ни одной строкой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EMPTY_LIST_STATE, listStarted, listRows, listFailed, listSettled, listForAddress,
  listForKnownAddress, loadPairConversations, _resetPreviewCacheForTest,
  type ConversationListState, type PairConversation,
} from '@/hooks/usePairConversations';
import { listPhase } from '@/lib/chatListPhase';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import type { ChatSession } from '@/lib/chatSession';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

async function makeSession(): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(sig('a1')),
    address: '0xA1cE00000000000000000000000000000000CAfE',
    origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
}

function fromServer(): PairConversation[] {
  return [
    { peerAddress: A, lastText: 'привет', lastAt: 1000, lastFromMe: false, preview: 'text' },
    { peerAddress: B, lastText: 'и тебе', lastAt: 900, lastFromMe: true, preview: 'text' },
  ];
}

function manyRows(n: number): PairConversation[] {
  const out: PairConversation[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      peerAddress: '0x' + (i + 256).toString(16).padStart(40, '0'),
      lastText: `сообщение ${i}`, lastAt: 1_700_000_000_000 - i, lastFromMe: false, preview: 'text',
    });
  }
  return out;
}

/** Что видит человек при этом состоянии списка. Остальные признаки — здоровые:
 *  окна кошелька нет, ключ объявлен, сеанс открыт. */
function seen(state: ConversationListState): string {
  return listPhase({
    hasRows: state.rows.length > 0,
    everAnswered: state.everAnswered,
    signatureReason: null,
    keyNotAnnounced: false,
    sessionStatus: 'ready',
    error: state.error,
  });
}

/** Один заход целиком, как его делает хук: началось → исход → кончилось. */
function tick(
  state: ConversationListState,
  outcome: { rows?: PairConversation[]; error?: string },
): ConversationListState {
  let s = listStarted(state);
  if (outcome.rows) s = listRows(s, outcome.rows);
  if (outcome.error) s = listFailed(s, outcome.error);
  return listSettled(s);
}

/**
 * Сколько раз человек УВИДИТ признак загрузки на этой дороге. Переходы, а не
 * кадры: мелькание — это появление.
 */
function loadingFlashes(states: ConversationListState[]): number {
  let flashes = 0;
  let was = false;
  for (const s of states) {
    const now = seen(s) === 'skeleton';
    if (now && !was) flashes++;
    was = now;
  }
  return flashes;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetBagPassCacheForTest();
  _resetPreviewCacheForTest();
});

/* ═══════════════ три состояния вместо двух ════════════════════════════════ */

describe('склада ещё не спрашивали — это отдельное состояние', () => {
  it('начальное состояние: ответа не было, и человек видит загрузку', () => {
    // Замер до правки: `seen` = 'empty', то есть «Переписок пока нет».
    expect(EMPTY_LIST_STATE.everAnswered, 'начальное состояние выдаёт себя за ответ склада').toBe(false);
    expect(seen(EMPTY_LIST_STATE)).toBe('skeleton');
  });

  it('заход ОТЛОЖЕН порогом подписи — всё равно загрузка, а не «переписок нет»', () => {
    // Живая дорога с телефона: `getPass` бросает `ChatSignatureDeferred`,
    // загрузчик молчит (ни `onRows`, ни `onError`), `finally` снимает «в полёте».
    // Ответа не было — значит утверждать о пустоте нечем.
    const state = listSettled(listStarted(EMPTY_LIST_STATE));
    expect(state.loading, 'признак «в полёте» не снялся — замер не про то').toBe(false);
    expect(state.everAnswered, 'молчаливая отсрочка сошла за ответ склада').toBe(false);
    expect(seen(state), 'человек читает «переписок нет» про склад, которого не спрашивали').toBe('skeleton');
  });

  it('ответ ПУСТОЙ — вот теперь «переписок пока нет»', () => {
    // ⚠️ САМЫЙ ХРУПКИЙ ПЕРЕХОД. Пустой ответ на пустые строки не меняет НИ ОДНОЙ
    // строки, и сшиватель честно отдаёт прежний массив. Если факт ответа
    // записывать только вместе со строками, он не запишется никогда, и человек
    // останется с вечными заготовками — исправная работа притворится поломкой.
    const state = tick(EMPTY_LIST_STATE, { rows: [] });
    expect(state.everAnswered, 'пустой ответ не считается ответом').toBe(true);
    expect(seen(state)).toBe('empty');
  });

  it('ответ со строками — строки', () => {
    const state = tick(EMPTY_LIST_STATE, { rows: fromServer() });
    expect(state.everAnswered).toBe(true);
    expect(seen(state)).toBe('rows');
  });

  it('ОТКАЗ — это тоже ответ: экран отказа, не заготовки и не пустота', () => {
    const state = tick(EMPTY_LIST_STATE, { error: 'rate_limited' });
    expect(state.everAnswered, 'отказ склада не считается ответом — впереди вечная загрузка').toBe(true);
    expect(seen(state)).toBe('error');
  });
});

/* ═══════════════ ровно один раз за десять тиков ════════════════════════════ */

describe('признак загрузки за десять тиков', () => {
  it('со строками — показан РОВНО ОДИН РАЗ', () => {
    const path: ConversationListState[] = [EMPTY_LIST_STATE];
    let state = EMPTY_LIST_STATE;
    state = listStarted(state); path.push(state);
    state = listRows(state, fromServer()); path.push(state);
    state = listSettled(state); path.push(state);
    for (let i = 0; i < 10; i++) {
      state = listStarted(state); path.push(state);
      state = listRows(state, fromServer()); path.push(state);
      state = listSettled(state); path.push(state);
    }
    expect(loadingFlashes(path), 'загрузка мелькает больше одного раза — вернулось мигание').toBe(1);
  });

  it('ответ ПУСТОЙ — тоже ровно один раз, хотя «в полёте» поднимается каждый тик', () => {
    // ⚠️ ЗДЕСЬ И ЖИВЁТ РИСК ВЕРНУТЬ МИГАНИЕ. `listStarted` при пустых строках
    // поднимает `loading` на КАЖДОМ заходе — это верно как факт и обязано быть
    // невидимым: склад уже ответил, и его ответ «ничего нет».
    const path: ConversationListState[] = [EMPTY_LIST_STATE];
    let state = tick(EMPTY_LIST_STATE, { rows: [] });
    path.push(state);
    let raised = 0;
    for (let i = 0; i < 10; i++) {
      state = listStarted(state);
      if (state.loading) raised++;
      path.push(state);
      state = listRows(state, []); path.push(state);
      state = listSettled(state); path.push(state);
    }
    expect(raised, 'замер не про то: «в полёте» на пустом списке не поднимается').toBe(10);
    expect(loadingFlashes(path), 'пустой список мигает заготовками каждый тик').toBe(1);
  });

  it('лежащий склад — загрузка не мелькает ни разу после первого ответа', () => {
    const path: ConversationListState[] = [];
    let state = tick(EMPTY_LIST_STATE, { error: 'rate_limited' });
    path.push(state);
    for (let i = 0; i < 10; i++) {
      state = listStarted(state); path.push(state);
      state = listFailed(state, 'rate_limited'); path.push(state);
      state = listSettled(state); path.push(state);
    }
    expect(loadingFlashes(path), 'повторные попытки прячут отказ за заготовками').toBe(0);
  });
});

/* ═══════════════ память вкладки: второй заход на страницу ══════════════════ */

describe('вернулись на страницу списка в той же вкладке', () => {
  it('склад отвечал ПУСТЫМ — заготовок больше нет, сразу слова о пустоте', () => {
    // Память списка (`_convCache`) пишется на КАЖДОМ успешном ответе, включая
    // пустой. Наличие записи и есть «этому адресу склад отвечал».
    const state = listForAddress([], A);
    expect(state.everAnswered, 'память об ответе потеряна на новом монтировании').toBe(true);
    expect(seen(state)).toBe('empty');
  });

  it('памяти нет — заготовки, и это верно', () => {
    // Замок, который горит всегда, — не замок.
    const state = listForAddress(undefined, A);
    expect(state.everAnswered).toBe(false);
    expect(seen(state)).toBe('skeleton');
  });

  it('строки из памяти — сразу строки, без заготовок', () => {
    const state = listForAddress(fromServer(), A);
    expect(state.everAnswered).toBe(true);
    expect(seen(state)).toBe('rows');
  });

  it('смена аккаунта: у нового адреса склада не спрашивали — заготовки', () => {
    const mine = listRows(listForAddress(fromServer(), A), fromServer());
    const other = listForKnownAddress(mine, B, () => undefined);
    expect(other.everAnswered, 'чужой ответ склада зачтён новому адресу').toBe(false);
    expect(seen(other)).toBe('skeleton');
  });
});

/* ═════════ пять вопросов про обстоятельства ════════════════════════════════ */

/* 1. перезапустили посреди первого запроса */
describe('перезапустили посреди первого запроса', () => {
  it('память вкладки ушла — заготовки, а не «переписок нет»', () => {
    // Перезагрузка уносит и `_convCache`, и состояние. Честный ответ: мы правда
    // ещё не спрашивали.
    let state = listStarted(listForAddress(undefined, A));
    expect(seen(state)).toBe('skeleton');
    state = listSettled(state);
    expect(seen(state), 'после обрыва человек читает утверждение о пустоте').toBe('skeleton');
  });

  it('оборванный заход не оставляет ложного «ответ был»', () => {
    const state = listSettled(listStarted(EMPTY_LIST_STATE));
    expect(state.everAnswered).toBe(false);
  });
});

/* 2. склад отказал на первом запросе, потом ответил */
describe('отказал на первом запросе, потом ответил', () => {
  it('отказ → повтор → строки: загрузка мелькнула ОДИН раз, отказ был назван', () => {
    const path: ConversationListState[] = [EMPTY_LIST_STATE];
    let state = tick(EMPTY_LIST_STATE, { error: 'rate_limited' });
    path.push(state);
    expect(seen(state), 'первый отказ выдан за пустоту').toBe('error');
    state = tick(state, { rows: fromServer() });
    path.push(state);
    expect(state.error, 'успех не снял отказ').toBe(null);
    expect(seen(state)).toBe('rows');
    expect(loadingFlashes(path), 'дорога «отказ → успех» мигнула заготовками не раз').toBe(1);
  });
});

/* 3. две вкладки, обе первый раз */
describe('две вкладки, обе первый раз', () => {
  it('у каждой свой первый раз — ответ одной не зачитывается другой', () => {
    const tabA = tick(listForAddress(undefined, A), { rows: fromServer() });
    const tabB = listForAddress(undefined, A);
    expect(tabA.everAnswered).toBe(true);
    expect(tabB.everAnswered, 'состояние одной вкладки протекло в другую').toBe(false);
    expect(seen(tabB)).toBe('skeleton');
  });

  it('каждая покажет загрузку РОВНО ОДИН раз — двух вкладок на две вспышки', () => {
    const paths = [[] as ConversationListState[], [] as ConversationListState[]];
    for (const path of paths) {
      let s = listForAddress(undefined, A);
      path.push(s);
      for (let i = 0; i < 10; i++) {
        s = listStarted(s); path.push(s);
        s = listRows(s, fromServer()); path.push(s);
        s = listSettled(s); path.push(s);
      }
    }
    expect(paths.map(loadingFlashes)).toEqual([1, 1]);
  });
});

/* 4. пришёл мусор вместо ответа */
describe('пришёл мусор вместо ответа', () => {
  it('мусор — вердикт, и это ОТВЕТ: экран отказа, не вечные заготовки', async () => {
    const session = await makeSession();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('не json вовсе', { status: 200 })));
    let thrown: unknown = null;
    try { await loadPairConversations(session, 'v1.p'); } catch (err) { thrown = err; }
    expect(thrown, 'мусор прошёл за нормальный ответ').toBeInstanceOf(Error);
    const state = tick(EMPTY_LIST_STATE, { error: 'malformed' });
    expect(state.everAnswered).toBe(true);
    expect(seen(state)).toBe('error');
  }, 20_000);
});

/* 5. тысяча переписок — сколько раз мелькнёт загрузка */
describe('тысяча переписок', () => {
  it('десять тиков на тысяче строк — загрузка мелькает ОДИН раз', () => {
    const path: ConversationListState[] = [EMPTY_LIST_STATE];
    let state = EMPTY_LIST_STATE;
    for (let i = 0; i < 10; i++) {
      state = listStarted(state); path.push(state);
      state = listRows(state, manyRows(1000)); path.push(state);
      state = listSettled(state); path.push(state);
    }
    expect(state.rows.length).toBe(1000);
    expect(loadingFlashes(path), 'тысяча строк мигает заготовками').toBe(1);
  });
});
