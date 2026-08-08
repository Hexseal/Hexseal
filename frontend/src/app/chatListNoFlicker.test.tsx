/**
 * chatListNoFlicker.test.tsx — обновление списка НЕ разрушает то, что уже видно.
 *
 * ─── ЧТО СКАЗАЛ ВЛАДЕЛЕЦ ────────────────────────────────────────────────────
 *
 * Дословно: «сам список подгружает как инвалид, постоянно сам обновляет скидывая
 * весь фронт до скелетона, хотя ваще такой хуйни быть не должно, максимум +чат а
 * не ресет до скелетона и обратно. с такими прыжками надо дисклеймер вещать о
 * эпелепсии».
 *
 * ─── ПОЧЕМУ ЗАМЕР ИМЕННО РАЗМЕТКОЙ ──────────────────────────────────────────
 *
 * У фронта нет ни jsdom, ни testing-library (`vitest.config.mjs`, окружение
 * `node`), и «сколько раз перерисовалось» напрямую не спросить. Зато можно
 * спросить главное: ЧТО ЧЕЛОВЕК ВИДИТ на каждом шаге. Мигание — это когда
 * разметка на неизменных данных меняется; ноль различий за десять тиков и есть
 * «ничего не мигает», и это число, а не рассуждение.
 *
 * Второй замер — на ссылках строк — живёт в `lib/chatListRows.test.ts`: React
 * не перерисовывает то, что пришло тем же объектом, и это его гарантия, а не
 * наша надежда.
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

const ME    = '0x1111111111111111111111111111111111111111';
const PEER  = '0x2222222222222222222222222222222222222222';
const PEER2 = '0x3333333333333333333333333333333333333333';
const DEAL  = '0x4444444444444444444444444444444444444444';

/** Время в далёком прошлом: `formatTime` отдаёт дату, а не «now»/«1m», и
 *  разметка не меняется от того, что тест идёт секунду. */
const LONG_AGO = 1_700_000_000_000;

/* ─────────────────────── чем подменяем окружение ───────────────────────── */

const conv: Record<string, unknown> = {};
function setConv(patch: Record<string, unknown>): void {
  for (const k of Object.keys(conv)) delete conv[k];
  Object.assign(conv, {
    conversations: [], isLoading: false, isRefreshing: false, error: null,
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

/** Чтения цепи: пусто по умолчанию, сделка подставляется отдельным вызовом. */
const chain: { deals: unknown[] } = { deals: [] };
function setChainDeals(deals: unknown[]): void { chain.deals = deals; }

vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME, isConnected: true }),
  useReadContract: ({ functionName }: { functionName: string }) => ({
    data: functionName === 'getByClient' ? chain.deals : undefined,
  }),
  // Форма ответа та же, что у wagmi: массив исходов по числу вызовов. Пустой
  // набор вызовов у настоящего хука отключён (`query.enabled`), поэтому здесь
  // `undefined` — иначе замер врал бы про состояние «ещё не читали».
  useReadContracts: ({ contracts }: { contracts?: unknown[] }) => ({
    data: contracts && contracts.length > 0
      ? contracts.map(() => ({ status: 'success', result: { status_: 2, amount_: 1_000_000n } }))
      : undefined,
  }),
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

/** Строка списка в том виде, в каком её отдаёт хук. Новые объекты каждый раз —
 *  ровно как настоящий заход, который собирает их с нуля. */
function row(peer: string, text: string) {
  return { peerAddress: peer, lastText: text, lastAt: LONG_AGO, lastFromMe: false };
}

const SKELETON = 'animate-pulse';

beforeEach(() => { setConv({}); setSess({}); setAnn({}); setChainDeals([]); });

/* ═══════════════ 1. заготовки строк — только когда показывать нечего ═══════ */

describe('обновление непустого списка: ни одного скелетона', () => {
  it('строки уже на экране — заготовок нет даже пока тик в полёте', async () => {
    setConv({ conversations: [row(PEER, 'привет')], isLoading: true });
    const html = await renderList();
    expect(html).toContain('привет');
    expect(html, 'заготовки строк поверх уже показанного списка').not.toContain(SKELETON);
  });

  it('строки пришли ИЗ ЦЕПИ (сделка без мешков) — заготовок всё равно нет', async () => {
    // ⚠️ ЭТО И ЕСТЬ ЖИВОЙ СЛУЧАЙ. Признак загрузки смотрел на `conversations`
    // (мешки), а рисуются `allConversations` (мешки ПЛЮС собеседники по
    // сделкам). У кого переписка ещё не начата, но сделка есть, строки на
    // экране были, а заготовки лезли поверх них КАЖДЫЙ тик.
    setChainDeals([{
      agreement: DEAL, client: ME, executor: PEER,
      amount: 1_000_000n, status: 2, createdAt: 0n, resolvedAt: 0n,
    }]);
    setConv({ conversations: [], isLoading: true });
    const html = await renderList();
    expect(html, 'строка собеседника по сделке не нарисовалась — замер не про то')
      .toContain(PEER.slice(2, 6));
    expect(html, 'заготовки строк поверх строк из цепи').not.toContain(SKELETON);
  });

  it('десять тиков подряд — ноль скелетонов', async () => {
    let skeletons = 0;
    for (let i = 0; i < 10; i++) {
      // Тик как он есть: сначала «пошли за списком», потом «список тот же».
      setConv({ conversations: [row(PEER, 'привет'), row(PEER2, 'и тебе')], isLoading: true });
      if ((await renderList()).includes(SKELETON)) skeletons++;
      setConv({ conversations: [row(PEER, 'привет'), row(PEER2, 'и тебе')], isLoading: false });
      if ((await renderList()).includes(SKELETON)) skeletons++;
    }
    expect(skeletons, 'скелетон показан на обновлении непустого списка').toBe(0);
  });

  it('десять тиков со строками ИЗ ЦЕПИ — ноль скелетонов', async () => {
    // Замер до правки: 10 из 10 (заготовки поверх строк каждый тик).
    setChainDeals([{
      agreement: DEAL, client: ME, executor: PEER,
      amount: 1_000_000n, status: 2, createdAt: 0n, resolvedAt: 0n,
    }]);
    let skeletons = 0;
    for (let i = 0; i < 10; i++) {
      setConv({ conversations: [], isLoading: true });
      if ((await renderList()).includes(SKELETON)) skeletons++;
    }
    expect(skeletons, 'скелетон поверх строк из цепи').toBe(0);
  });

  it('показывать НЕЧЕГО — заготовки на месте (замок, который горит всегда, не замок)', async () => {
    setConv({ conversations: [], isLoading: true });
    const html = await renderList();
    expect(html).toContain(SKELETON);
  });
});

/* ═══════════════ 2. ничего не изменилось — ничего не мигает ════════════════ */

describe('тик без изменений не меняет ни пикселя', () => {
  it('десять тиков на тех же данных дают ОДНУ разметку', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      setConv({ conversations: [row(PEER, 'привет')], isLoading: true, isRefreshing: true });
      seen.add(await renderList());
      setConv({ conversations: [row(PEER, 'привет')], isLoading: false, isRefreshing: false });
      seen.add(await renderList());
    }
    expect(seen.size, 'разметка меняется на тиках, которые ничего не принесли').toBe(1);
  });

  it('пришло новое сообщение — разметка обязана измениться', async () => {
    // Обратная сторона: список, который не меняется НИКОГДА, — сломанный список.
    setConv({ conversations: [row(PEER, 'привет')] });
    const before = await renderList();
    setConv({ conversations: [row(PEER, 'ещё одно')] });
    expect(await renderList()).not.toBe(before);
  });
});

/* ═══════════════ 3. пустое превью объяснено словами ════════════════════════ */

describe('пустое превью не выдаётся за «сообщений нет»', () => {
  it('у каждой причины свои слова, и они на экране', async () => {
    setConv({ conversations: [
      { peerAddress: PEER,  lastText: '', lastAt: LONG_AGO, lastFromMe: true,  preview: 'from_me' },
      { peerAddress: PEER2, lastText: '', lastAt: LONG_AGO, lastFromMe: false, preview: 'pending' },
      { peerAddress: '0x5555555555555555555555555555555555555555', lastText: '', lastAt: LONG_AGO, lastFromMe: false, preview: 'unreadable' },
      { peerAddress: '0x6666666666666666666666666666666666666666', lastText: '', lastAt: LONG_AGO, lastFromMe: false, preview: 'none' },
    ] });
    const html = await renderList();
    expect(html, 'про своё последнее слово не сказано').toContain(translate('chat.preview_from_me'));
    expect(html, 'про нескачанный мешок не сказано').toContain(translate('chat.preview_pending'));
    expect(html, 'про нечитаемый мешок не сказано').toContain(translate('chat.preview_unreadable'));
    expect(html, 'честная пустота потеряла свои слова').toContain(translate('chat.no_messages_yet'));
  });

  it('«сообщений нет» стоит РОВНО ОДИН раз — у той строки, где это правда', async () => {
    // Иначе замок зелёный от того, что фраза где-то есть, а не от того, что она
    // стоит там, где надо.
    setConv({ conversations: [
      { peerAddress: PEER,  lastText: '', lastAt: LONG_AGO, lastFromMe: true,  preview: 'from_me' },
      { peerAddress: PEER2, lastText: '', lastAt: LONG_AGO, lastFromMe: false, preview: 'pending' },
      { peerAddress: '0x6666666666666666666666666666666666666666', lastText: '', lastAt: LONG_AGO, lastFromMe: false, preview: 'none' },
    ] });
    const html = await renderList();
    const phrase = translate('chat.no_messages_yet');
    expect(html.split(phrase).length - 1, 'пустота без причины снова выдаётся за «сообщений нет»').toBe(1);
  });
});

/* ═══════════════ 4. моргнувший отказ не сносит список ══════════════════════ */

describe('отказ одного тика не уносит переписки с экрана', () => {
  it('склад отказал — строки остались', async () => {
    // ⚠️ ТОТ ЖЕ КЛАСС, ЧТО УЖЕ ЧИНИЛИ В ПАНЕЛИ (`pairChatTransientError`):
    // «один моргнувший отказ прятал всю переписку». В панели починено, в списке
    // нет — строки рисовались под условием `!error`, то есть один `429` на
    // тик убирал ВЕСЬ список и возвращал его через полминуты.
    setConv({ conversations: [row(PEER, 'привет')], error: 'rate_limited', isLoading: false });
    const html = await renderList();
    expect(html, 'отказ склада убрал уже показанные переписки').toContain('привет');
  });

  it('отказ при этом НАЗВАН, а не проглочен', async () => {
    setConv({ conversations: [row(PEER, 'привет')], error: 'rate_limited', isLoading: false });
    const html = await renderList();
    expect(html).toContain(translate('chat.list_stale'));
  });

  it('показывать нечего и отказ — тогда экран отказа целиком', async () => {
    setConv({ conversations: [], error: 'rate_limited', isLoading: false });
    const html = await renderList();
    expect(html).toContain(translate('chat.could_not_connect'));
    expect(html).toContain(translate('chat.retry'));
  });
});
