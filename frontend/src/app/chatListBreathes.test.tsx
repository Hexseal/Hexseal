/**
 * chatListBreathes.test.tsx — СПИСОК переписок тоже не держит человека молча.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Владелец сказал «оба просят вечное
 * подключение/подпись» — оба, то есть и открытая переписка, и список. Панель
 * починена (`components/chatPanelBreathes.test.tsx`), а список рисовал три
 * пульсирующие заготовки строк, пока висело окно кошелька, и не говорил ни
 * слова о том, что от человека чего-то ждут. Ровно тот же дефект на соседнем
 * экране — в этой панели такое уже случалось раз (`ChatOffScreen`, находка К-2:
 * разводка причин доехала до панели и НЕ доехала до списка).
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

const ME = '0x1111111111111111111111111111111111111111';

const conv: Record<string, unknown> = {};
function setConv(patch: Record<string, unknown>): void {
  for (const k of Object.keys(conv)) delete conv[k];
  Object.assign(conv, {
    conversations: [], isLoading: true, error: null, reload: () => {},
    authFailed: false, passSignaturePending: false,
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
// ⚠️ React берётся ВНУТРИ фабрики: `vi.mock` поднимается выше импортов, и
// внешний `React` в её теле ещё не существует («React is not defined» —
// замерено, первая версия этого файла).
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

const ann: Record<string, unknown> = {};
function setAnn(patch: Record<string, unknown>): void {
  for (const k of Object.keys(ann)) delete ann[k];
  Object.assign(ann, {
    standing: 'mine', attempt: 'none', needsPress: false, busy: false,
    announce: () => {}, restoreFromCode: () => {}, errorCode: null,
  }, patch);
}
vi.mock('@/hooks/useKeyAnnouncement', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useKeyAnnouncement')>();
  return { ...real, useKeyAnnouncement: () => ({ ...ann }) };
});

async function renderList(): Promise<string> {
  const mod = await import('@/app/chat/page');
  return renderToStaticMarkup(React.createElement(mod.default));
}

beforeEach(() => { setConv({}); setSess({}); setAnn({}); });

describe('список переписок: ожидание подписи называет себя', () => {
  it('пока висит окно кошелька — на экране сказано, чего ждут', async () => {
    // Что красит: список снова рисует пульсирующие заготовки и молчит. Человек
    // видит «что-то грузится» минутами и уходит — дословно то, что и произошло.
    setConv({ passSignaturePending: true, isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html).toContain(translate('chat.signature_wanted'));
    expect(html).toContain(translate('chat.signature_wanted_pass'));
  });

  it('ждут подпись КЛЮЧА — слова другие', async () => {
    setConv({ isLoading: true, conversations: [] });
    setSess({ status: 'loading', keySignaturePending: true });
    const html = await renderList();
    expect(html).toContain(translate('chat.signature_wanted_key'));
    expect(html).not.toContain(translate('chat.signature_wanted_pass'));
  });

  it('подписи никто не ждёт — заготовки строк на месте, надписи нет', async () => {
    // Замок, который горит всегда, — не замок: обычная загрузка обязана
    // выглядеть как раньше.
    setConv({ passSignaturePending: false, isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain(translate('chat.signature_wanted'));
  });
});

/* ═════════════ «Вам пока не могут писать» — и в списке тоже ═════════════════ */

describe('список: «ключ есть, но не объявлен» назван и вылечиваем', () => {
  // ⚠️ ЭТОТ БЛОК ЕСТЬ РОВНО ПОТОМУ, ЧТО В ЭТОМ ПРОЕКТЕ ПАНЕЛЬ И СПИСОК УЖЕ
  // РАЗЪЕЗЖАЛИСЬ МОЛЧА (находка К-2). Панель заперта
  // `components/chatKeyNotAnnounced.test.tsx`; без замка здесь тихая поломка
  // осталась бы ровно там, куда попадают первым делом.
  it('состояние названо утверждёнными словами, и кнопка на экране', async () => {
    setAnn({ standing: 'absent', needsPress: true });
    setConv({ isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html, 'заголовок не доехал до списка').toContain(translate('chat.key_unannounced_title'));
    expect(html).toContain(translate('chat.key_unannounced_body'));
    expect(html).toContain(translate('chat.key_unannounced_call'));
    expect(html, 'кнопки в списке нет — лечить нечем').toContain(translate('chat.key_unannounced_action'));
  });

  it('вместо заготовок строк, а не рядом с ними', async () => {
    // Заготовки говорят «сейчас будет». Здесь ждут не сеть, а человека — и
    // пульсирующие полоски рядом с просьбой нажать кнопку означали бы, что
    // что-то всё-таки грузится само.
    setAnn({ standing: 'absent', needsPress: true });
    setConv({ isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html, 'заготовки строк остались рядом с просьбой нажать').not.toContain('animate-pulse');
  });

  it('ключ объявлен — надписи нет, заготовки на месте', async () => {
    // Замок, который горит всегда, — не замок.
    setAnn({ standing: 'mine', needsPress: false });
    setConv({ isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html).not.toContain(translate('chat.key_unannounced_title'));
    expect(html).toContain('animate-pulse');
  });

  it('пока висит окно кошелька — эта надпись молчит, ждут кошелёк', async () => {
    setAnn({ standing: 'absent', needsPress: true });
    setConv({ isLoading: true, conversations: [], passSignaturePending: true });
    const html = await renderList();
    expect(html).toContain(translate('chat.signature_wanted'));
    expect(html, 'две просьбы об одном на одном экране').not.toContain(translate('chat.key_unannounced_title'));
  });
});

describe('список: чужой ключ — свой текст и вход по коду', () => {
  // ⚠️ Тот же класс К-2: разводка доехала до панели и обязана доехать до списка.
  // Без этого замка ловушка с потерей данных осталась бы на экране, куда попадают
  // первым делом.
  it('показан текст про другое устройство, а не «вам пока не могут писать»', async () => {
    setAnn({ standing: 'other_key', needsPress: true });
    setConv({ isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html, 'до списка состояние чужого ключа не доехало')
      .toContain(translate('chat.key_elsewhere_title'));
    expect(html, 'в списке показан текст состояния «ключа нет»')
      .not.toContain(translate('chat.key_unannounced_title'));
  });

  it('код восстановления предложен, и предупреждение о цене замены на месте', async () => {
    setAnn({ standing: 'other_key', needsPress: true });
    setConv({ isLoading: true, conversations: [] });
    const html = await renderList();
    expect(html).toContain(translate('chat.key_elsewhere_restore_action'));
    expect(html, 'в списке о цене замены не предупредили')
      .toContain(translate('chat.key_elsewhere_switch_note'));
    const restore = html.indexOf(translate('chat.key_elsewhere_restore_action'));
    const swap = html.indexOf(translate('chat.key_elsewhere_switch_action'));
    expect(restore).toBeLessThan(swap);
  });
});
