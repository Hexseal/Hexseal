/**
 * chatListFirstLoad.test.tsx — что человек видит ДО первого ответа склада.
 *
 * ─── ЗАМЕР С ЖИВОГО ТЕЛЕФОНА (9 августа, Redmi, установленное приложение) ────
 *
 *     0 с   «Переписок пока нет. Начните чат из сделки или нажмите кнопку +»
 *    12 с   0xd091…4f9f  57m  «сообщение исчезает из миниатюры…»
 *
 * Двенадцать секунд человек читает УТВЕРЖДЕНИЕ о том, что переписок нет. Оно
 * формально верно — в состоянии их правда ещё нет, — но читается как «пусто,
 * ничего не подгрузилось», и владелец на этом ушёл со страницы в первый раз.
 *
 * ─── ПОЧЕМУ ЭТО НЕ «ДОБАВИТЬ ЗАГРУЗКУ», А ТРЕТЬЕ СОСТОЯНИЕ ──────────────────
 *
 * Состояний обязано быть ТРИ, а слито их два:
 *
 *   | склада ещё не спрашивали      | признак загрузки       |
 *   | спросили, ответ пустой        | «Переписок пока нет…»  |
 *   | спросили, есть строки         | строки                 |
 *
 * `isLoading` отвечает на другой вопрос — «заход В ПОЛЁТЕ прямо сейчас», и он
 * снимается в `finally` даже тогда, когда заход не состоялся вовсе (порог
 * подписи отложил его молча — `chatSignatureGate.ts`). Живой путь на телефоне
 * именно такой: ключ на устройстве есть, значит `status === 'ready'` с первого
 * рендера; стояние ключа ещё `unknown`, значит `mailboxWorthPollingFor` даёт
 * `ChatSignatureDeferred('not_announced')`; заход тихо кончается, `isLoading`
 * падает в `false`, и колонка честно докладывает «переписок нет» — про склад,
 * которого никто не спрашивал.
 *
 * ─── И ГЛАВНОЕ: НЕ ВЕРНУТЬ МИГАНИЕ, КОТОРОЕ ТОЛЬКО ЧТО УБРАЛИ ───────────────
 *
 * День назад в этом же файле чинилось ровно обратное: признак загрузки
 * поднимался на КАЖДОМ перечитывании. Владелец про это: на такие прыжки
 * невозможно смотреть. Поэтому здесь не только «загрузка
 * показана», но и ЧИСЛОМ: показана РОВНО ОДИН РАЗ за десять тиков. Замеры на
 * непустом списке (`chatListNoFlicker.test.tsx`) остаются в силе и не
 * ослабляются ни одной строкой.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), RU);
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`)) : value;
}

const ME   = '0x1111111111111111111111111111111111111111';
const PEER = '0x2222222222222222222222222222222222222222';

/** Далёкое прошлое: `formatTime` отдаёт дату, а не «now», и разметка не зависит
 *  от того, сколько тест шёл. */
const LONG_AGO = 1_700_000_000_000;

/* ─────────────────────── чем подменяем окружение ───────────────────────── */

const conv: Record<string, unknown> = {};
/**
 * Умолчание — РОВНО МОМЕНТ НОЛЬ: склада ещё не спрашивали.
 *
 * `everAnswered: false` и `isLoading: false` вместе — не выдумка теста, а живое
 * состояние: заход отложен порогом подписи, `finally` уже снял «в полёте», а
 * ответа не было ни одного.
 */
function setConv(patch: Record<string, unknown>): void {
  for (const k of Object.keys(conv)) delete conv[k];
  Object.assign(conv, {
    conversations: [], isLoading: false, everAnswered: false, error: null,
    reload: () => {}, authFailed: false, passSignaturePending: false,
  }, patch);
}

const sess: Record<string, unknown> = {};
function setSess(patch: Record<string, unknown>): void {
  for (const k of Object.keys(sess)) delete sess[k];
  Object.assign(sess, {
    status: 'ready', error: null, errorCode: null, session: null, recoveryCode: null,
    storageNotice: null, keySignaturePending: false,
    retry: () => {}, cancel: () => {}, disable: () => true,
  }, patch);
}

const ann: Record<string, unknown> = {};
function setAnn(patch: Record<string, unknown>): void {
  for (const k of Object.keys(ann)) delete ann[k];
  Object.assign(ann, {
    standing: 'mine', attempt: 'none', needsPress: false, busy: false,
    announce: () => {}, restoreFromCode: () => {}, errorCode: null,
  }, patch);
}

vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME, isConnected: true }),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined }),
  usePublicClient: () => null,
  useWalletClient: () => ({ data: null }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
  useSignTypedData: () => ({ signTypedDataAsync: async () => '0x' }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
}));
vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ children }: { children?: unknown }) =>
      react.createElement('a', null, children as never),
  };
});
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ displayName: null, avatarUrl: null }) }));
vi.mock('@/components/ChatPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ChatPanel')>();
  return { ...real, ChatPanel: () => null };
});
vi.mock('@/hooks/useChatSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useChatSession')>();
  return { ...real, useChatSession: () => ({ ...sess }) };
});
vi.mock('@/hooks/usePairConversations', () => ({
  usePairConversations: () => ({ ...conv }),
}));
vi.mock('@/hooks/useKeyAnnouncement', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useKeyAnnouncement')>();
  return { ...real, useKeyAnnouncement: () => ({ ...ann }) };
});

async function renderList(): Promise<string> {
  const mod = await import('@/app/chat/page');
  return renderToStaticMarkup(React.createElement(mod.default));
}

function row(peer: string, text: string) {
  return { peerAddress: peer, lastText: text, lastAt: LONG_AGO, lastFromMe: false, preview: 'text' as const };
}

const SKELETON = 'animate-pulse';
const EMPTY_WORDS = translate('chat.no_conversations');

beforeEach(() => { setConv({}); setSess({}); setAnn({}); });

/* ═════════ 1. до первого ответа склада — загрузка, а не «переписок нет» ═════ */

describe('момент ноль: склада ещё не спрашивали', () => {
  it('в разметке признак загрузки, а НЕ «Переписок пока нет»', async () => {
    // Замер до правки: `animate-pulse` отсутствует, на экране «Переписок пока
    // нет» — то самое, что человек читает двенадцать секунд.
    const html = await renderList();
    expect(html, 'признака загрузки нет — человек видит утверждение о пустоте').toContain(SKELETON);
    expect(html, '«переписок нет» сказано про склад, которого не спрашивали').not.toContain(EMPTY_WORDS);
  });

  it('заход в полёте — то же самое, разметка не дрогнула', async () => {
    // «Не спрашивали» и «спрашиваем прямо сейчас» человеку неотличимы и должны
    // быть неотличимы: иначе снятие `isLoading` в `finally` мигало бы.
    const before = await renderList();
    setConv({ isLoading: true });
    expect(await renderList(), 'разметка меняется от одного лишь начала захода').toBe(before);
  });
});

/* ═════════ 2. ответ пришёл пустым — вот теперь «переписок нет» ══════════════ */

describe('склад ответил, и ответ пустой', () => {
  it('«Переписок пока нет» и подсказка — на экране, загрузки нет', async () => {
    setConv({ everAnswered: true, conversations: [] });
    const html = await renderList();
    expect(html, 'утверждение о пустоте потерялось').toContain(EMPTY_WORDS);
    expect(html).toContain(translate('chat.start_hint'));
    expect(html, 'загрузка осталась после ответа — вечные заготовки').not.toContain(SKELETON);
  });
});

/* ═════════ 3. ответ пришёл со строками — строки ═════════════════════════════ */

describe('склад ответил строками', () => {
  it('строки на экране, ни загрузки, ни «переписок нет»', async () => {
    setConv({ everAnswered: true, conversations: [row(PEER, 'первое слово')] });
    const html = await renderList();
    expect(html).toContain('первое слово');
    expect(html).not.toContain(SKELETON);
    expect(html).not.toContain(EMPTY_WORDS);
  });
});

/* ═════════ 4. загрузка мелькает РОВНО ОДИН РАЗ ══════════════════════════════ */

/** Сколько раз разметка ПЕРЕШЛА из «без загрузки» в «с загрузкой». Именно
 *  переходы, а не кадры: мигание — это появление, а не длительность. */
async function countLoadingFlashes(steps: Array<Record<string, unknown>>): Promise<number> {
  let flashes = 0;
  let wasLoading = false;
  for (const patch of steps) {
    setConv(patch);
    const now = (await renderList()).includes(SKELETON);
    if (now && !wasLoading) flashes++;
    wasLoading = now;
  }
  return flashes;
}

describe('десять тиков жизни вкладки', () => {
  it('со строками: загрузка показана РОВНО ОДИН РАЗ', async () => {
    const rows = [row(PEER, 'первое слово')];
    const steps: Array<Record<string, unknown>> = [
      {},                                              // момент ноль
      { isLoading: true },                             // первый заход пошёл
      { everAnswered: true, conversations: rows },      // ответ
    ];
    // Десять фоновых тиков. `isLoading` при непустом списке не поднимается по
    // построению (`listStarted`), и это тоже часть замера.
    for (let i = 0; i < 10; i++) {
      steps.push({ everAnswered: true, conversations: rows, isLoading: true });
      steps.push({ everAnswered: true, conversations: rows, isLoading: false });
    }
    expect(await countLoadingFlashes(steps), 'загрузка мелькает не один раз — вернулось мигание').toBe(1);
  });

  it('ответ ПУСТОЙ: тоже ровно один раз, дальше только слова о пустоте', async () => {
    // Пустой список — самый опасный случай для этой правки: `listStarted` при
    // пустых строках «загружаем» поднимает, и без памяти об ответе загрузка
    // мелькала бы КАЖДЫЙ тик — ровно то мигание, что чинили день назад.
    const steps: Array<Record<string, unknown>> = [{}, { isLoading: true }, { everAnswered: true }];
    for (let i = 0; i < 10; i++) {
      steps.push({ everAnswered: true, isLoading: true });
      steps.push({ everAnswered: true, isLoading: false });
    }
    expect(await countLoadingFlashes(steps), 'пустой список мигает загрузкой каждый тик').toBe(1);
  });
});

/* ═════════ 5. отказ склада на ПЕРВОМ же запросе ═════════════════════════════ */

describe('первый же запрос отказал', () => {
  it('сказано «не смогли», предложено повторить — не «переписок нет» и не вечная загрузка', async () => {
    setConv({ everAnswered: true, error: 'rate_limited' });
    const html = await renderList();
    expect(html, 'об отказе не сказано').toContain(translate('chat.could_not_connect'));
    expect(html, 'повторить нечем').toContain(translate('chat.retry'));
    expect(html, 'отказ выдан за пустоту').not.toContain(EMPTY_WORDS);
    expect(html, 'отказ спрятан за вечной загрузкой').not.toContain(SKELETON);
  });

  it('отказ виден ДАЖЕ пока идёт повторная попытка — экран не мигает в заготовки', async () => {
    // Человек нажал «Повторить»: заход в полёте, строк нет. Показать в этот миг
    // заготовки значило бы спрятать единственное, что объясняет происходящее.
    setConv({ everAnswered: true, error: 'rate_limited', isLoading: true });
    const html = await renderList();
    expect(html).toContain(translate('chat.could_not_connect'));
    expect(html, 'повторная попытка накрыла отказ заготовками').not.toContain(SKELETON);
  });
});

/* ═════════ 5-бис. вечной загрузки не бывает ═════════════════════════════════ */

describe('загрузка обязана кончаться — чем-нибудь', () => {
  // ⚠️ ЭТО ОБРАТНАЯ СТОРОНА ВСЕЙ ПРАВКИ, и без неё она была бы своей починкой
  // хуже дефекта. «Показывать загрузку, пока склад не ответил» звучит безобидно
  // ровно до состояния, в котором склад НЕ БУДЕТ спрошен НИКОГДА: тогда человек
  // получает вечную пульсацию вместо объяснения — то есть ту же тихую поломку,
  // только красивее одетую.
  it('сеанс чата не открылся — экран сеанса с кнопкой, а не вечные заготовки', async () => {
    // Спрашивать склад нечем: без сеанса нет пропуска. Ответа не будет никогда.
    setSess({ status: 'error', errorCode: null });
    const html = await renderList();
    expect(html, 'вечная загрузка вместо объяснения').not.toContain(SKELETON);
    expect(html, 'про закрытый чат не сказано').toContain(translate('chat.messaging_off'));
    expect(html, 'включить чат нечем').toContain(translate('chat.enable_messaging'));
  });

  it('склад отказал, а человек в это время заводит сеанс заново — отказ виден', async () => {
    // Дорога: `429` → человек нажал «включить чат» → `status` снова 'loading'.
    // Заготовки в этот миг накрыли бы и отказ, и кнопку повтора.
    setConv({ everAnswered: true, error: 'rate_limited' });
    setSess({ status: 'loading' });
    const html = await renderList();
    expect(html, 'отказ спрятан за заготовками на время повторного входа')
      .toContain(translate('chat.could_not_connect'));
  });
});

/* ═════════ 6. возврат к вкладке не показывает загрузку заново ═══════════════ */

describe('вернулись к вкладке', () => {
  it('строки уже есть — загрузки нет ни на возврате, ни на заходе после него', async () => {
    // Возврат зовёт заход (`focus`), и это правильно. Неправильно было бы
    // показать при этом признак загрузки: человек уже смотрит на список.
    const rows = [row(PEER, 'первое слово')];
    const steps = [
      { everAnswered: true, conversations: rows },                    // смотрим список
      { everAnswered: true, conversations: rows, isLoading: true },   // вернулись, заход пошёл
      { everAnswered: true, conversations: rows },                    // тот же ответ
    ];
    expect(await countLoadingFlashes(steps), 'возврат к вкладке показал загрузку поверх строк').toBe(0);
  });

  it('строк нет, но склад отвечал — «переписок нет» остаётся, загрузки нет', async () => {
    const steps = [
      { everAnswered: true },
      { everAnswered: true, isLoading: true },
      { everAnswered: true },
    ];
    expect(await countLoadingFlashes(steps), 'возврат к пустому списку мигнул загрузкой').toBe(0);
    setConv({ everAnswered: true, isLoading: true });
    expect(await renderList(), 'на возврате пропали слова о пустоте').toContain(EMPTY_WORDS);
  });
});
