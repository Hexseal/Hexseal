/**
 * chatPanelBreathes.test.tsx — экран не держит человека на «Настройка шифрования».
 *
 * Живая выкатка 8 августа (пункт 35 `docs/OPEN-ITEMS.md`). Человек открыл чат и
 * ушёл: «я как юзер уже вышел и закрыл приложение потому что сразу не
 * подключился». Криптография при этом работала — в справочнике легли оба ключа
 * по 32 байта, ошибок в журнале ноль. Ушёл он не от поломки, а от ЭКРАНА.
 *
 * Что было: в центре крутился замок с «Подключение… / Настройка шифрования
 * сообщений», а объяснение — верное по смыслу и утверждённое —
 * `chat.pass_signature_hint` рисовалось мелким серым `text-xs text-white/45`
 * ВНИЗУ у поля ввода. Человек смотрит в центр.
 *
 * Четыре замера, все на настоящем рендере и настоящем `ru.json`:
 *
 *  1. ожидание подписи не прячет переписку — сообщения на экране есть;
 *  2. объяснение стоит ВЫШЕ поля ввода, а не под ним (измеряется положением в
 *     разметке, а не глазами: если кто-то вернёт его вниз, индекс перевернётся);
 *  3. «Собеседник не заходил» видно, пока подпись висит;
 *  4. «Сообщений пока нет» НЕ говорится, пока склад не спрошен, — иначе экран
 *     утверждает пустоту на первое мгновение каждого открытия.
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
    messages: [], gapAfterSeq: [], peerKnown: true, synced: true, error: null,
    isLoading: false, isInitialized: true, needsSetup: false, streamDead: false,
    passSignaturePending: false, storageNotice: null,
    chainUnverified: false, undecryptable: false,
    burnedSeqs: [], ownNumberingReset: false,
    pendingBags: 0, bagsFailed: false, pushOutcome: null,
  }, patch);
}

const session: Record<string, unknown> = {};
function setSession(patch: Record<string, unknown>): void {
  for (const k of Object.keys(session)) delete session[k];
  Object.assign(session, {
    status: 'ready', error: null, errorCode: null, session: null,
    recoveryCode: null, storageNotice: null, keySignaturePending: false,
    retry: () => {}, cancel: () => {}, disable: () => true,
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
vi.mock('@/hooks/useChatSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useChatSession')>();
  return { ...real, useChatSession: () => ({ ...session }) };
});
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

const THREE = ['первое слово', 'второе слово', 'третье слово'].map((text, seq) => ({
  id: `${PEER.toLowerCase()}-${seq}`, from: PEER.toLowerCase(), seq, text,
  timestamp: Date.UTC(2026, 7, 6, 10, seq), isFromMe: false, delivered: true,
}));

beforeEach(() => { setState({}); setSession({}); });

describe('ожидание подписи — состояние ПОВЕРХ переписки, а не вместо', () => {
  it('переписка на экране, пока висит окно кошелька', async () => {
    // Что красит: панель снова прячет сообщения за ожиданием подписи. Тогда
    // человек с тремя расшифрованными сообщениями на руках видит ноль.
    setState({ messages: THREE, passSignaturePending: true });
    const html = await renderPanel();
    for (const m of THREE) expect(html).toContain(m.text);
  });

  it('замок «Настройка шифрования» НЕ крутится, когда дело в подписи', async () => {
    // Что красит: возврат `ChatOpening` в состояние ожидания подписи. Именно эта
    // надпись — «Подключение… / Настройка шифрования сообщений» — стояла в
    // центре, пока человек ждал кошелёк, и именно с неё он ушёл.
    setState({ messages: [], synced: false, isLoading: true, passSignaturePending: true });
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.connecting_desc'));
    expect(html).toContain(translate('chat.signature_wanted'));
  });

  it('объяснение стоит ВЫШЕ поля ввода, а не мелким серым под ним', async () => {
    // Замер положения, не наличия. `chat.pass_signature_hint` был на экране и
    // ДО этой правки — внизу, у поля ввода, `text-xs text-white/45`. Человек
    // смотрит в центр. Если кто-то вернёт объяснение вниз, индексы
    // перевернутся и этот замок покраснеет.
    setState({ messages: [], synced: false, isLoading: true, passSignaturePending: true });
    const html = await renderPanel();
    const notice = html.indexOf(translate('chat.signature_wanted'));
    const input = html.indexOf('<textarea');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(input).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(input);
  });

  it('утверждённый длинный текст стоит ВЫШЕ поля ввода, а не под ним', async () => {
    // ⚠️ ЗАЧЕМ ЭТОТ ЗАМОК ОТДЕЛЬНО ОТ СОСЕДНЕГО. Ключевая дорога к пропуску
    // откачена решением владельца, значит окно кошелька вернулось, и
    // утверждённый текст `chat.pass_signature_hint` снова верен по смыслу («не
    // чаще раза в 12 часов»). Но главная беда 8 августа была НЕ в словах: текст
    // был верный и стоял мелким серым `text-xs text-white/45` внизу, у поля
    // ввода, пока в центре крутился замок «Настройка шифрования сообщений».
    // Человек смотрит в центр — и ушёл.
    //
    // Соседний замок мерит положение КОРОТКОЙ версии. Этот — положение самого
    // утверждённого текста: если кто-нибудь вернёт его вниз (а именно оттуда его
    // и убрали), индексы перевернутся и эта строка покраснеет.
    // ⚠️ ЗАМЕР — ВЛОЖЕННОСТЬ, А НЕ ПОРЯДОК В РАЗМЕТКЕ. Первая версия этого замка
    // сравнивала индексы «текст раньше поля ввода» и НЕ КРАСНЕЛА на мутации,
    // которая возвращала текст в полосу под перепиской: полоса тоже стоит раньше
    // поля ввода. То есть замок пропускал ровно тот дефект, ради которого
    // заводился. Здесь мерится другое: текст лежит ВНУТРИ центральной карточки
    // объяснения. А то, что сама карточка выше поля ввода, заперто соседним
    // замком — вместе это и есть «в центре».
    const { ChatSignatureWanted } = await import('@/components/ChatPanel');
    const card = renderToStaticMarkup(
      React.createElement(ChatSignatureWanted, { reason: 'pass' as const, variant: 'full' as const }),
    );
    expect(card, 'утверждённый текст ушёл из центральной карточки').toContain(
      translate('chat.pass_signature_hint'),
    );

    // И он же на экране целиком, а не только в карточке в отрыве от панели.
    setState({ messages: [], synced: false, isLoading: true, passSignaturePending: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.pass_signature_hint'));
  });

  it('сказано, ЗАЧЕМ подпись: у пропуска и у ключа причины разные', async () => {
    setState({ messages: [], synced: false, isLoading: true, passSignaturePending: true });
    expect(await renderPanel()).toContain(translate('chat.signature_wanted_pass'));

    // Первый вход: подпись выводит ключ переписки, сеанс ещё не открыт.
    setState({ messages: [], synced: false, isLoading: false, needsSetup: true });
    setSession({ status: 'loading', keySignaturePending: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.signature_wanted_key'));
    expect(html).not.toContain(translate('chat.signature_wanted_pass'));
  });
});

describe('«собеседник не заходил» — до единой подписи', () => {
  it('надпись на экране, пока окно кошелька висит', async () => {
    // Что красит: панель снова требует снятого ожидания, чтобы сказать про
    // собеседника. Тогда человек сначала проходит настройку шифрования и только
    // потом узнаёт, что писать некуда.
    setState({ peerKnown: false, synced: false, isLoading: true, passSignaturePending: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.recipient_no_messaging'));
    expect(html).toContain(translate('chat.share_invite_hint'));
  });
});

describe('«Сообщений пока нет» — только когда склад спрошен', () => {
  it('до ответа склада эта надпись НЕ говорится', async () => {
    // Что красит: снятие условия `synced`. Тогда экран утверждает пустоту в
    // первое мгновение каждого открытия — то есть врёт всем и всегда, ровно
    // один раз.
    setState({ messages: [], synced: false });
    expect(await renderPanel()).not.toContain(translate('chat.no_messages_yet'));
  });

  it('после ответа склада — говорится', async () => {
    // Замок, который горит всегда, — не замок.
    setState({ messages: [], synced: true });
    expect(await renderPanel()).toContain(translate('chat.no_messages_yet'));
  });
});
