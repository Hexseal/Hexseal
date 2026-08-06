/**
 * chatPanelCircumstances.test.tsx — что экран показывает в обстоятельствах, а
 * не в счастливом случае (Задача 7, вопросы про обстоятельства).
 *
 * Замок ставится на ровно один класс дефектов: экран, который МОЛЧИТ там, где
 * что-то не в порядке, и потому выглядит исправным. До этого файла было
 * измерено и найдено:
 *
 *   переписанная чужим ключом цепочка собеседника → движок отвергает ВСЕ
 *   звенья → у хука ноль сообщений и пустой `gapAfterSeq` → панель рисует
 *   «Сообщений пока нет».
 *
 * То есть собеседник писал, всё написанное отвергнуто проверкой подлинности,
 * а человеку сказано, что переписки просто не было. Это худший вид молчания:
 * он не «не сообщает о проблеме», он УТВЕРЖДАЕТ обратное.
 *
 * Рендер настоящий (`react-dom/server`), тексты — из настоящего `ru.json`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { troubleSummary, type ConversationTroubleLike } from '@/hooks/usePairChat';

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

const t = (k: string) => `${k}`;

beforeEach(() => { setState({}); });

describe('разбор претензий движка в то, что можно сказать человеку', () => {
  const trouble = (kind: string, seq = 0): ConversationTroubleLike =>
    ({ kind, key: `k${seq}`, seq, from: PEER.toLowerCase() } as ConversationTroubleLike);

  it('подделка подлинности — «не прошло проверку», и это НЕ «не открылось»', () => {
    for (const kind of ['bad_signature', 'body_mismatch', 'sender_mismatch',
      'signer_unexpected', 'signer_changed', 'duplicate_seq', 'malformed']) {
      const s = troubleSummary([trouble(kind)]);
      expect(s.chainUnverified, kind).toBe(true);
      expect(s.undecryptable, kind).toBe(false);
    }
  });

  it('невскрытый конверт — «не открылось», и это НЕ подделка', () => {
    const s = troubleSummary([trouble('undecryptable')]);
    expect(s.undecryptable).toBe(true);
    expect(s.chainUnverified).toBe(false);
  });

  it('претензий нет — оба признака молчат (замок, который горит всегда, — не замок)', () => {
    const s = troubleSummary([]);
    expect(s).toEqual({ chainUnverified: false, undecryptable: false });
  });

  it('оба рода разом — оба признака', () => {
    const s = troubleSummary([trouble('bad_signature', 1), trouble('undecryptable', 2)]);
    expect(s).toEqual({ chainUnverified: true, undecryptable: true });
  });
});

describe('экран не молчит, когда с цепочкой собеседника непорядок', () => {
  it('всё отвергнуто проверкой — экран НЕ говорит «сообщений пока нет»', async () => {
    // Ровно тот замер, ради которого файл написан: сообщений ноль не потому,
    // что их не было, а потому что мы им не поверили.
    setState({ messages: [], chainUnverified: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.chain_unverified'));
    expect(html).not.toContain(translate('chat.no_messages_yet'));
  });

  it('часть отвергнута, часть показана — сказано и то, и другое', async () => {
    setState({
      messages: [{
        id: `${PEER.toLowerCase()}-0`, from: PEER.toLowerCase(), seq: 0,
        text: 'уцелевшее', timestamp: Date.UTC(2026, 7, 6, 10), isFromMe: false, delivered: true,
      }],
      chainUnverified: true,
    });
    const html = await renderPanel();
    expect(html).toContain('уцелевшее');
    expect(html).toContain(translate('chat.chain_unverified'));
  });

  it('конверт не открылся нашим ключом — своя формулировка, не «подделка»', async () => {
    setState({ messages: [], undecryptable: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.undecryptable'));
    expect(html).not.toContain(translate('chat.chain_unverified'));
  });

  it('всё в порядке — ни одной из двух строк', async () => {
    setState({
      messages: [{
        id: `${PEER.toLowerCase()}-0`, from: PEER.toLowerCase(), seq: 0,
        text: 'нормальное', timestamp: Date.UTC(2026, 7, 6, 10), isFromMe: false, delivered: true,
      }],
    });
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.chain_unverified'));
    expect(html).not.toContain(translate('chat.undecryptable'));
  });
});

describe('К-5: своя половина не обвиняет своего же владельца', () => {
  it('своя цепочка не с нуля — на экране НИЧЕГО про скрытое', async () => {
    // Через семь дней старые мешки истекают, и своя уцелевшая цепочка
    // начинается не с нуля. Панель обязана молчать: свою историю мы знаем
    // локально, склад ей не источник истины.
    setState({
      messages: [
        { id: `${ME.toLowerCase()}-7`, from: ME.toLowerCase(), seq: 7, text: 'моё позднее',
          timestamp: Date.UTC(2026, 7, 6, 10), isFromMe: true, delivered: true },
      ],
      gapAfterSeq: [],   // своя дыра сюда не попадает (`chatConversation`, К-1)
    });
    const html = await renderPanel();
    expect(html).toContain('моё позднее');
    expect(html).not.toContain(translate('chat.chain_gap'));
    expect(html).not.toContain(translate('chat.chain_gap_start'));
    expect(html).not.toContain(translate('chat.chain_unverified'));
  });

  it('сбитая своя нумерация НЕ читается как «не прошло проверку подлинности»', () => {
    // `own_numbering_reset` — своя беда с известной причиной, и в разбор
    // претензий она попадать не должна ни одним из двух признаков.
    const s = troubleSummary([{ kind: 'own_numbering_reset' } as ConversationTroubleLike]);
    expect(s).toEqual({ chainUnverified: false, undecryptable: false });
    // А чужой повтор номера — по-прежнему признак подделки.
    const peer = troubleSummary([{ kind: 'duplicate_seq' } as ConversationTroubleLike]);
    expect(peer.chainUnverified).toBe(true);
  });
});

describe('тысяча сообщений на экране', () => {
  it('разметка тысячи сообщений собирается за разумное время', async () => {
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `${PEER.toLowerCase()}-${i}`,
      from: i % 2 === 0 ? PEER.toLowerCase() : ME.toLowerCase(),
      seq: i,
      text: `сообщение ${i}`,
      timestamp: Date.UTC(2026, 7, 6, 10) + i * 1000,
      isFromMe: i % 2 !== 0,
      delivered: true,
    }));
    setState({ messages, gapAfterSeq: [500] });
    const started = Date.now();
    const html = await renderPanel();
    const ms = Date.now() - started;
    console.log(`[замер] рендер 1000 сообщений: ${ms} мс, разметки ${html.length} байт`);
    expect(html).toContain('сообщение 999');
    expect(html).toContain(translate('chat.chain_gap'));
    // Потолок с большим запасом: замок здесь против ОБВАЛА (квадратичный
    // поиск разрывов, пересборка на каждое сообщение), а не против дрожания
    // машины. Число записано руками по замеру, не выведено формулой.
    expect(ms).toBeLessThan(3000);
  });
});
