/**
 * chatPanelTransientError.test.tsx — моргнувший отказ склада не должен уносить
 * переписку с экрана.
 *
 * ЧТО НАШЛА СКВОЗНАЯ ПРОВЕРКА. Склад ответил отказом ОДИН раз — и работающая
 * переписка заменяется экраном «не удалось подключиться», а уже расшифрованные
 * сообщения ПРЯЧУТСЯ. Человек видит ошибку вместо того, что у него уже есть на
 * руках.
 *
 * Цена этих двух состояний несимметрична, и в этом вся суть:
 *  - показать имеющееся стоит НИЧЕГО (сообщения уже в памяти, уже вскрыты);
 *  - спрятать имеющееся стоит ВСЕГО (человек не может ни прочитать, ни
 *    предъявить, ни даже понять, что переписка цела).
 * А сеть моргает часто. Значит отказ обязан быть НАДПИСЬЮ ПОВЕРХ переписки, а
 * не экраном ВМЕСТО неё.
 *
 * Рендер настоящий (`react-dom/server`), тексты — из настоящего `ru.json`; тот
 * же приём, что в `chatPanelCircumstances.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    RU,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => params[n] ?? `{${n}}`) : value;
}

const ME = '0x1111111111111111111111111111111111111111';
const PEER = '0x2222222222222222222222222222222222222222';

const state: Record<string, unknown> = {};
function setState(patch: Record<string, unknown>): void {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    messages: [], gapAfterSeq: [], peerKnown: true, error: null,
    isLoading: false, isInitialized: true, needsSetup: false, streamDead: false,
    passSignaturePending: false, storageNotice: null,
    chainUnverified: false, undecryptable: false,
    burnedSeqs: [], ownNumberingReset: false,
    pendingBags: 0, bagsFailed: false, pushOutcome: null,
  }, patch);
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME }),
  usePublicClient: () => null,
  useWalletClient: () => ({ data: null }),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
  useSignTypedData: () => ({ signTypedDataAsync: async () => '0x' }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }));
vi.mock('react-hot-toast', () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {} }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ displayName: null, avatarUrl: null }) }));
vi.mock('@/hooks/usePreDealBar', () => ({ usePreDealBar: () => null }));
vi.mock('@/hooks/useFeeConfig', () => ({ useFeeConfig: () => ({ feeBps: 500, feeFloor: 1_000_000n, isLoading: false }) }));
vi.mock('@/components/DealActionBar', () => ({ DealActionBar: () => null }));
vi.mock('@/hooks/usePairChat', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/usePairChat')>();
  return {
    ...real,
    usePairChat: () => ({
      sendMessage: async () => {}, sendFile: async () => {},
      uploadProgress: null, reconnect: () => {}, ...state,
    }),
  };
});

async function renderPanel(): Promise<string> {
  const { ChatPanel } = await import('@/components/ChatPanel');
  return renderToStaticMarkup(React.createElement(ChatPanel, { recipientAddress: PEER }));
}

/** Три уже расшифрованных сообщения — то, что у человека УЖЕ на руках. */
const THREE = ['первое слово', 'второе слово', 'третье слово'].map((text, seq) => ({
  id: `${PEER.toLowerCase()}-${seq}`, from: PEER.toLowerCase(), seq, text,
  timestamp: Date.UTC(2026, 7, 6, 10, seq), isFromMe: false, delivered: true,
}));

beforeEach(() => { setState({}); });

describe('моргнувший отказ склада: надпись поверх, а не экран вместо', () => {
  it('ЗАМЕР: три расшифрованных сообщения при отказе склада — видно все три', async () => {
    // Что красит: возврат условия `!error` на список сообщений. Тогда все три
    // строки исчезают с экрана, и человек видит только «не удалось
    // подключиться» — при том, что переписка цела и лежит в памяти вкладки.
    setState({ messages: THREE, error: 'rate_limited' });
    const html = await renderPanel();

    const shown = THREE.filter(m => html.includes(m.text));
    console.log(
      `[блокер замер] сообщений на руках: ${THREE.length}; видно на экране при отказе склада: ${shown.length}`,
    );
    expect(shown).toHaveLength(THREE.length);
  });

  it('и об отказе при этом СКАЗАНО — переписка не притворяется исправной', async () => {
    // Обратная половина: показать сообщения и промолчать про отказ значило бы
    // уверять, что всё в порядке, пока новые сообщения не приходят.
    setState({ messages: THREE, error: 'rate_limited' });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.could_not_connect'));
  });

  it('код отказа человеку по-прежнему НЕ показывается', async () => {
    // `rate_limited` — слово для журнала, а не для экрана. Действие у всех
    // этих причин одно: подождать и повторить.
    setState({ messages: THREE, error: 'rate_limited' });
    const html = await renderPanel();
    expect(html).not.toContain('rate_limited');
  });

  it('показывать нечего — остаётся прежний экран с кнопкой «повторить»', async () => {
    // Граница правки: когда переписки на руках НЕТ, крупный экран с кнопкой
    // полезен и убирать его не за что. Замок против починки, которая чинит
    // один случай и ломает соседний.
    setState({ messages: [], error: 'rate_limited' });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.could_not_connect'));
    expect(html).toContain(translate('chat.retry'));
    // И «сообщений пока нет» при этом НЕ утверждается: мы не знаем, пусто там
    // или просто не доехало.
    expect(html).not.toContain(translate('chat.no_messages_yet'));
  });

  it('отказа нет — ни одной строки про него', async () => {
    // Замок, который горит всегда, — не замок.
    setState({ messages: THREE, error: null });
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.could_not_connect'));
    expect(THREE.every(m => html.includes(m.text))).toBe(true);
  });
});
