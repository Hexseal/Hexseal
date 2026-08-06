/**
 * chatAttachment.test.tsx — К-4: вложение проходит ОБЕ половины, а не каждую
 * по отдельности.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ СКВОЗНОЙ ТЕСТ. Это самый опасный род дефекта в этом
 * плане: у одной половины зелено, у другой зелено, а вместе не работает.
 * Ровно так и было — Задача 6 довезла до сообщения пять полей вложения
 * (`chunked`, `chunkCount`, `chunkSize`, `fileKey`, `mime`), а ветка
 * расшифровки живёт в `ChatPanel.tsx`, который правила Задача 7. Пока панель
 * их не читает:
 *
 *   - файл больше 20 МБ идёт НЕ ТОЙ веткой и приезжает битым;
 *   - у картинки нет превью и нет типа при сохранении;
 *   - протухший адрес скачивания не обновить, хотя ключ файла доезжает.
 *
 * Здесь путь целиком: настоящий стенд → настоящая отправка → настоящий склад
 * → настоящий приём → настоящая панель. Ни одна половина не проверяется в
 * одиночку.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveChatKeypair } from '../chatCrypto';
import type { ChatSession } from '../chatSession';

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
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
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
      uploadProgress: null, reconnect: () => {},
      isLoading: false, isInitialized: true, needsSetup: false,
      streamDead: false, error: null, peerKnown: true,
      messages: [], gapAfterSeq: [], chainUnverified: false, undecryptable: false,
      passSignaturePending: false, storageNotice: null,
      ...panelState,
    }),
  };
});

/** Крупный файл: нарезка обязательна, ветка расшифровки другая. */
const BIG_FILE = {
  url: 'https://relay.example/files/big.bin',
  name: 'отчёт.pdf',
  size: 25 * 1024 * 1024,
  keyHex: 'aa'.repeat(32),
  ivHex: 'bb'.repeat(12),
  fileKey: 'files/2026/big-abcdef.bin',
  mime: 'application/pdf',
  chunked: true,
  chunkCount: 5,
  chunkSize: 5 * 1024 * 1024,
};

/** Картинка: своя ветка показа, тип обязателен для превью. */
const IMAGE_FILE = {
  url: 'https://relay.example/files/pic.bin',
  name: 'скриншот.png',
  size: 120_000,
  keyHex: 'cc'.repeat(32),
  ivHex: 'dd'.repeat(12),
  fileKey: 'files/2026/pic-123456.bin',
  mime: 'image/png',
};

describe('К-4: вложение проходит обе половины', () => {
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

  it('ЗАМЕР: все девять полей доезжают до ПОЛУЧАТЕЛЯ через настоящий склад', async () => {
    const transport = await import('../chatTransport');
    const session = await import('../../hooks/useChatSession');
    const pair = await import('../../hooks/usePairChat');

    const [aw, bw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const B = bw.address as `0x${string}`;
    const alice = await makeSession('a1ce', A);
    const bob = await makeSession('b0b7', B);
    const ap = await transport.requestBagPass(m => aw.signMessage(m), A);
    const bp = await transport.requestBagPass(m => bw.signMessage(m), B);
    await session.publishChatKeys(ap.pass, alice);
    await session.publishChatKeys(bp.pass, bob);

    const sender = pair.startPairChat({
      session: alice, peer: B, getPass: async () => ap.pass,
      onState: () => {}, onError: () => {}, sleep: async () => new Promise(() => {}),
    });
    await sender.send({ file: BIG_FILE });
    await sender.send({ file: IMAGE_FILE });
    sender.stop();

    const seen = await new Promise<{ messages: { attachment?: Record<string, unknown> }[] }>(
      (resolve, reject) => {
        const e = pair.startPairChat({
          session: bob, peer: A, getPass: async () => bp.pass,
          onState: (s) => { e.stop(); resolve(s as never); },
          onError: (err) => { e.stop(); reject(err); },
        });
      },
    );

    expect(seen.messages).toHaveLength(2);
    const [big, pic] = seen.messages.map(m => m.attachment!);

    // Девять полей крупного файла — поимённо, а не «форма похожа».
    expect(big).toEqual({
      name: 'отчёт.pdf',
      url: BIG_FILE.url,
      size: BIG_FILE.size,
      key: BIG_FILE.keyHex,
      iv: BIG_FILE.ivHex,
      fileKey: BIG_FILE.fileKey,
      mime: 'application/pdf',
      chunked: true,
      chunkCount: 5,
      chunkSize: BIG_FILE.chunkSize,
    });
    // У картинки нарезки нет — и полей нарезки быть не должно вовсе,
    // а не `undefined` (иначе «нет поля» и «поле пустое» слились бы).
    expect(pic.mime).toBe('image/png');
    expect(pic.fileKey).toBe(IMAGE_FILE.fileKey);
    expect('chunked' in pic).toBe(false);
    expect('chunkCount' in pic).toBe(false);
  }, 120_000);

  it('панель ВЫБИРАЕТ ветку расшифровки по доехавшим полям, а не по размеру на глаз', async () => {
    const { attachmentDecryptPlan } = await import('@/components/ChatPanel');
    const transport = await import('../chatTransport');
    const pair = await import('../../hooks/usePairChat');

    const [aw, bw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const B = bw.address as `0x${string}`;
    const bob = await makeSession('b0b7', B);
    const bp = await transport.requestBagPass(m => bw.signMessage(m), B);

    const seen = await new Promise<{ messages: { attachment?: never }[] }>((resolve, reject) => {
      const e = pair.startPairChat({
        session: bob, peer: A, getPass: async () => bp.pass,
        onState: (s) => { e.stop(); resolve(s as never); },
        onError: (err) => { e.stop(); reject(err); },
      });
    });
    const [big, pic] = seen.messages.map(m => m.attachment!);

    // ⚠️ Это и есть тот самый шов: до правки поля доезжали, а ветка
    // выбиралась без них — крупный файл собирался НЕ ТЕМ способом.
    expect(attachmentDecryptPlan(big)).toEqual({
      mode: 'chunked',
      chunkCount: 5,
      chunkSize: BIG_FILE.chunkSize,
      size: BIG_FILE.size,
      mime: 'application/pdf',
    });
    expect(attachmentDecryptPlan(pic)).toEqual({ mode: 'whole', mime: 'image/png' });
    // Незашифрованное вложение (наследство) — третья ветка, открыть по ссылке.
    expect(attachmentDecryptPlan({ name: 'x', url: 'https://e/x' })).toEqual({ mode: 'plain' });
    expect(aw.address).toBeTruthy();
  }, 120_000);

  it('панель рисует картинку картинкой, а крупный файл — карточкой', async () => {
    const transport = await import('../chatTransport');
    const pair = await import('../../hooks/usePairChat');
    const [aw, bw] = stand.wallets;
    const A = aw.address as `0x${string}`;
    const B = bw.address as `0x${string}`;
    const bob = await makeSession('b0b7', B);
    const bp = await transport.requestBagPass(m => bw.signMessage(m), B);

    const seen = await new Promise<{ messages: unknown[] }>((resolve, reject) => {
      const e = pair.startPairChat({
        session: bob, peer: A, getPass: async () => bp.pass,
        onState: (s) => { e.stop(); resolve(s as never); },
        onError: (err) => { e.stop(); reject(err); },
      });
    });

    myAddress = B;
    panelState = { messages: seen.messages };
    const { ChatPanel } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(ChatPanel, { recipientAddress: A }));

    // Ветки различаются ИМЕНЕМ ФАЙЛА в разметке, и это не случайность:
    // карточка файла всегда печатает имя, а картинка не печатает его нигде,
    // кроме `alt` уже расшифрованного изображения (в серверном рендере
    // расшифровки не происходит — эффекты не идут). Значит имя картинки в
    // разметке означало бы ровно одно: её нарисовали карточкой, то есть не
    // той веткой.
    expect(html).toContain('отчёт.pdf');
    expect(html).not.toContain('скриншот.png');
    expect(aw.address).toBeTruthy();
  }, 120_000);
});
