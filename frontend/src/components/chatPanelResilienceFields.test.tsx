/**
 * chatPanelResilienceFields.test.tsx — три поля стойкости ДОЕЗЖАЮТ до экрана.
 *
 * ⚠️ ЗАЧЕМ ЭТОТ ФАЙЛ, ЕСЛИ СЛОВА УЖЕ ЗАПЕРТЫ. `chatNotices.test.ts` запирает
 * ВЫБОР СЛОВ («ещё качаем» против «не смогли»), но не то, что панель их
 * вообще рисует. Ровно на этом различии здесь уже спотыкались дважды:
 * `listBurnedSeqs` считалась верно и не звалась никем, а `pendingBags`,
 * `bagsFailed` и `pushOutcome` считались верно и не читались панелью — и оба
 * раза докстринг уверял, что человеку сказано.
 *
 * Панель их читает с коммита `4dfd827`. Замка на это не было: связь могла
 * оборваться обратно, и ни один тест бы не покраснел, а докстринги продолжали
 * бы обещать. Здесь стоит замок ровно на «надпись есть на экране».
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

describe('три поля стойкости: надпись доезжает до экрана', () => {
  it('очередь невзятых мешков — надпись есть, и она ТИХАЯ', async () => {
    // Что красит: панель перестала рисовать `bagsNotice`. Числа хук считает
    // по-прежнему верно, и без этого замка никто бы не заметил.
    setState({ messages: THREE, pendingBags: 5 });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.bags_pending', { n: '5' }));
    expect(html).not.toContain(translate('chat.bags_failed'));
  });

  it('скачать не смогли — надпись ГРОМКАЯ и другая', async () => {
    setState({ messages: THREE, pendingBags: 2, bagsFailed: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.bags_failed', { n: '2' }));
    expect(html).not.toContain(translate('chat.bags_pending', { n: '2' }));
  });

  it('уведомление не ушло без сеанса чата — на экране своя причина', async () => {
    // Что красит: панель перестала рисовать `pushNoticeKey`. Человек отправил
    // сообщение, собеседнику не сообщили, и он об этом снова не узнаёт.
    setState({ messages: THREE, pushOutcome: 'no-pass' });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.push_no_pass'));
  });

  it('уведомление ушло — ни одной надписи про него', async () => {
    // Замок, который горит всегда, — не замок.
    setState({ messages: THREE, pushOutcome: 'ok' });
    const html = await renderPanel();
    for (const k of ['chat.push_no_pass', 'chat.push_rate_limited', 'chat.push_error']) {
      expect(html).not.toContain(translate(k));
    }
  });

  it('всё спокойно — ни одной из трёх надписей', async () => {
    setState({ messages: THREE });
    const html = await renderPanel();
    for (const k of ['chat.bags_failed', 'chat.push_no_pass']) {
      expect(html).not.toContain(translate(k));
    }
    expect(html).not.toContain(translate('chat.bags_pending', { n: '1' }));
  });
});
