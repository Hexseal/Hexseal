/**
 * chatScreen.test.tsx — сквозной стенд ЧЕРЕЗ НАСТОЯЩИЙ ЭКРАН (Задача 7).
 *
 * Главная проверка задачи, и она держится на том, что здесь НИЧЕГО не
 * подделано на пути «два человека — сервер — экран»:
 *
 *   настоящий релеер (`relayer/app.js` на свободном порту, свой склад на
 *   диске) → настоящий пропуск и справочник ключей → настоящий движок
 *   переписки (`startPairChat` из `usePairChat.ts`, тот самый, что работает
 *   в браузере) → настоящая `ChatPanel` (`react-dom/server`).
 *
 * Подделаны ровно две вещи, и обе — то, чего в `node` не существует:
 * React-обёртки чужих пакетов (wagmi, next-intl, react-query) и склейка
 * хука с React. Сам компонент, его ветвления и тексты — настоящие.
 *
 * ВЫРЕЗАНИЕ СООБЩЕНИЯ — НАСТОЯЩЕЕ, СЕРВЕРНОЕ: файл мешка удаляется из
 * каталога склада стенда. Опись мешка при этом на месте — то есть склад
 * по-прежнему утверждает, что мешок был. Это и есть та картина, ради
 * которой существует цепочка: «что-то было, а нам не отдали».
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveChatKeypair } from '../chatCrypto';
import type { ChatSession } from '../chatSession';
import type { ChainLink } from '../chatChain';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    RU,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => params[n] ?? `{${n}}`) : value;
}

/** Состояние, которое панель получит: заполняется НАСТОЯЩИМ движком. */
let panelState: Record<string, unknown> = {};
let myAddress = '0x0000000000000000000000000000000000000001';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: myAddress }),
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
  // ⚠️ Оригинал грузится НАСТОЯЩИЙ: движок (`startPairChat`) в тесте
  // используется как есть, подменяется только React-обёртка `usePairChat`,
  // которую в `node` нечем отрисовать.
  const real = await importOriginal<typeof import('@/hooks/usePairChat')>();
  return {
    ...real,
    usePairChat: () => ({
      sendMessage: async () => {}, sendFile: async () => {},
      uploadProgress: null, reconnect: () => {},
      isLoading: false, isInitialized: true, needsSetup: false,
      streamDead: false, error: null, peerKnown: true,
      messages: [], gapAfterSeq: [],
      ...panelState,
    }),
  };
});

function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function makeSession(marker: string, address: `0x${string}`): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(signatureOf(marker)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}

async function renderPanel(peer: string): Promise<string> {
  const { ChatPanel } = await import('@/components/ChatPanel');
  return renderToStaticMarkup(React.createElement(ChatPanel, { recipientAddress: peer }));
}

describe('два человека, вырезанное сообщение и настоящий экран', () => {
  let stand: import('./chatStand').ChatStand;

  beforeAll(async () => {
    const { startChatStand } = await import('./chatStand');
    stand = await startChatStand();
    process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
    vi.resetModules();
  }, 60_000);

  afterAll(async () => {
    await stand?.stop();
    delete process.env.NEXT_PUBLIC_RELAYER_URL;
  });

  it('целая переписка доезжает до экрана без единого разрыва, вырезанная — с разрывом', async () => {
    const transport = await import('../chatTransport');
    const conv = await import('../chatConversation');
    const session = await import('../../hooks/useChatSession');
    const pair = await import('../../hooks/usePairChat');

    const [aliceWallet, bobWallet] = stand.wallets;
    const aliceAddr = aliceWallet.address as `0x${string}`;
    const bobAddr = bobWallet.address as `0x${string}`;
    const aliceSession = await makeSession('a1ce', aliceAddr);
    const bobSession = await makeSession('b0b7', bobAddr);

    const alicePass = await transport.requestBagPass(m => aliceWallet.signMessage(m), aliceAddr);
    const bobPass = await transport.requestBagPass(m => bobWallet.signMessage(m), bobAddr);

    // Оба заводятся в справочнике — иначе движок Алисы не найдёт подписной
    // ключ Боба и не сможет пинить цепочку.
    await session.publishChatKeys(alicePass.pass, aliceSession);
    await session.publishChatKeys(bobPass.pass, bobSession);

    // ─── Боб пишет пять сообщений настоящим проводом ───
    let prev: ChainLink | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sent = await conv.sendMessage(
        bobSession, aliceAddr, aliceSession.keypair.publicKey,
        { text: `сообщение ${i}` }, prev, { pass: bobPass.pass },
      );
      keys.push(sent.key);
      prev = sent.link;
    }

    myAddress = aliceAddr;

    /** Один заход Алисы: свежий движок, первое состояние, стоп. */
    const aliceOpensChat = () => new Promise<{ messages: unknown[]; gapAfterSeq: number[] }>(
      (resolve, reject) => {
        const engine = pair.startPairChat({
          session: aliceSession,
          peer: bobAddr,
          getPass: async () => alicePass.pass,
          onState: (s) => { engine.stop(); resolve(s as never); },
          onError: (e) => { engine.stop(); reject(e); },
        });
      },
    );

    // ─── Фаза 1: ничего не тронуто ───
    // Обязательна ПЕРВОЙ: замок, который красит и целую переписку тоже, —
    // не замок, а всегда-красный значок.
    const whole = await aliceOpensChat();
    expect((whole.messages as { text: string }[]).map(m => m.text))
      .toEqual(['сообщение 0', 'сообщение 1', 'сообщение 2', 'сообщение 3', 'сообщение 4']);
    expect(whole.gapAfterSeq).toEqual([]);

    panelState = { messages: whole.messages, gapAfterSeq: whole.gapAfterSeq };
    const wholeHtml = await renderPanel(bobAddr);
    for (let i = 0; i < 5; i++) expect(wholeHtml).toContain(`сообщение ${i}`);
    expect(wholeHtml).not.toContain(translate('chat.chain_gap'));
    expect(wholeHtml).not.toContain(translate('chat.chain_gap_start'));
    // Бейдж на месте, и третья строка — тоже.
    expect(wholeHtml).toContain(translate('chat.privacy_badge_title'));
    expect(wholeHtml).toContain(
      translate('chat.privacy_badge_dispute').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    );

    // ─── Фаза 2: кто-то вырезает третье — файл мешка удаляется со склада ───
    const cutPath = path.join(stand.storageDir, 'bags', keys[2]);
    expect(fs.existsSync(cutPath)).toBe(true);
    fs.unlinkSync(cutPath);

    const cut = await aliceOpensChat();
    expect((cut.messages as { text: string }[]).map(m => m.text))
      .toEqual(['сообщение 0', 'сообщение 1', 'сообщение 3', 'сообщение 4']);
    expect(cut.gapAfterSeq).toEqual([1]);

    panelState = { messages: cut.messages, gapAfterSeq: cut.gapAfterSeq };
    const cutHtml = await renderPanel(bobAddr);
    for (const text of ['сообщение 0', 'сообщение 1', 'сообщение 3', 'сообщение 4']) {
      expect(cutHtml).toContain(text);
    }
    expect(cutHtml).not.toContain('сообщение 2');

    const gapText = translate('chat.chain_gap');
    expect(cutHtml).toContain(gapText);
    expect(cutHtml.indexOf('сообщение 1')).toBeLessThan(cutHtml.indexOf(gapText));
    expect(cutHtml.indexOf(gapText)).toBeLessThan(cutHtml.indexOf('сообщение 3'));
  }, 180_000);
});
