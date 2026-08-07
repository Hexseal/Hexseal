/**
 * chatOffScreens.test.tsx — экраны «чат не открылся» проверяются РАЗМЕТКОЙ,
 * а не чистой функцией.
 *
 * ⚠️ ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. Разведение шести причин (К-2) было заперто
 * только тестом чистой функции `offScreenFor`. Сквозная проверка назвала
 * цену прямо: панель может игнорировать её целиком, и тест этого не увидит.
 * Так и вышло на соседнем экране — страница СПИСКА переписок рисовала
 * «Мессенджер выключен» на все семь причин, то есть ровно тот обвиняющий
 * экран, который К-2 убирала, жил нетронутым там, куда человек попадает
 * чаще всего.
 *
 * Здесь отрисовываются НАСТОЯЩИЕ компоненты (`react-dom/server`) с настоящим
 * `messages/ru.json`, по одной причине за раз, и проверяется текст на экране.
 * Снятие разводки красит эти тесты — в отличие от прежних.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatSession } from '@/lib/chatSession';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

function translate(key: string, params?: Record<string, string | number>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), RU);
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params ? value.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? `{${n}}`)) : value;
}

/** Состояние сеанса, которое увидят оба экрана в этом рендере. */
const sessionState: {
  status: string; errorCode: string | null; session: ChatSession | null;
} = { status: 'error', errorCode: null, session: null };

/** Состояние переписки для панели. */
const pairState: Record<string, unknown> = {};

const ME = '0x1111111111111111111111111111111111111111';
const PEER = '0x2222222222222222222222222222222222222222';

vi.mock('next-intl', () => ({ useTranslations: () => translate }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME }),
  usePublicClient: () => null,
  useWalletClient: () => ({ data: null }),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
  useSignTypedData: () => ({ signTypedDataAsync: async () => '0x' }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }));
vi.mock('react-hot-toast', () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {} }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ displayName: null, avatarUrl: null }) }));
vi.mock('@/hooks/usePreDealBar', () => ({ usePreDealBar: () => null }));
vi.mock('@/hooks/useFeeConfig', () => ({ useFeeConfig: () => ({ feeBps: 500, feeFloor: 1_000_000n, isLoading: false }) }));
vi.mock('@/components/DealActionBar', () => ({ DealActionBar: () => null }));
vi.mock('@/hooks/useChatSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useChatSession')>();
  return {
    ...real,
    useChatSession: () => ({
      status: sessionState.status,
      error: null,
      errorCode: sessionState.errorCode,
      retry: () => {}, cancel: () => {}, disable: () => false,
      session: sessionState.session,
      recoveryCode: null,
      storageNotice: null,
    }),
  };
});
vi.mock('@/hooks/usePairChat', () => ({
  usePairChat: () => ({
    messages: [], gapAfterSeq: [], peerKnown: true, error: null,
    isLoading: false, isInitialized: true, needsSetup: true, streamDead: false,
    sendMessage: async () => {}, sendFile: async () => {},
    uploadProgress: null, reconnect: () => {},
    ...pairState,
  }),
}));

function contractSession(): ChatSession {
  return {
    keypair: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
    address: ME as `0x${string}`, origin: 'recovery', walletKind: 'contract',
    restored: true, persisted: false,
  } as ChatSession;
}

async function renderPanel(): Promise<string> {
  const { ChatPanel } = await import('@/components/ChatPanel');
  return renderToStaticMarkup(React.createElement(ChatPanel, { recipientAddress: PEER }));
}

beforeEach(() => {
  sessionState.status = 'error';
  sessionState.errorCode = null;
  sessionState.session = null;
  for (const k of Object.keys(pairState)) delete pairState[k];
});

/* ─────────── панель: разводка доезжает до РАЗМЕТКИ ──────────────────── */

describe('панель показывает слова ПО ПРИЧИНЕ, а не одни и те же', () => {
  const CASES: Array<[string, string]> = [
    ['storage_blocked', 'chat.key_not_saved_blocked'],
    ['storage_open_timeout', 'chat.restore_err_storage_slow'],
    ['storage_version_unknown', 'chat.off_version_unknown'],
    ['storage_read_failed', 'chat.restore_err_storage_read'],
    ['signature_malformed', 'chat.restore_err_signature'],
  ];

  it.each(CASES)('причина «%s» — на экране её собственная надпись', async (code, key) => {
    // ⚠️ Красит: панель, игнорирующая `offScreenFor` (замерено — прежний
    // тест этого не видел). И красит подмену надписи на общую.
    sessionState.errorCode = code;
    const html = await renderPanel();
    expect(html).toContain(translate(key));
    expect(html).not.toContain(translate('chat.messaging_off_hint'));
  });

  it('человек выключил сам — вот тогда «мессенджер выключен»', async () => {
    sessionState.errorCode = null;
    const html = await renderPanel();
    expect(html).toContain(translate('chat.messaging_off'));
  });

  /** Сколько раз надпись встречается в разметке. Полоса под полем ввода
   *  («включить мессенджер») живёт своей жизнью и есть всегда — поэтому
   *  считаются ВХОЖДЕНИЯ, а не факт наличия: центральный экран добавляет
   *  второе, и разница видна числом. */
  const times = (html: string, key: string) =>
    html.split(translate(key)).length - 1;

  it('⚠️ у незнакомой версии записи ЦЕНТРАЛЬНАЯ кнопка действия не появляется', async () => {
    // Действия у человека нет, и рисовать кнопку значило бы врать. Замер:
    // одно вхождение — это полоса под полем ввода; два было бы центром.
    sessionState.errorCode = 'storage_version_unknown';
    const html = await renderPanel();
    expect(times(html, 'chat.enable_messaging')).toBe(1);
    expect(times(html, 'chat.off_close_tabs')).toBe(0);
  });

  it('заблокированное хранилище зовёт закрыть вкладки, а не «повторить»', async () => {
    sessionState.errorCode = 'storage_blocked';
    const html = await renderPanel();
    expect(times(html, 'chat.off_close_tabs')).toBe(1);
    // И центральной «включить» при этом нет — только полоса внизу.
    expect(times(html, 'chat.enable_messaging')).toBe(1);
  });

  it('обычная причина ДАЁТ центральную кнопку — два вхождения, а не одно', async () => {
    // Обратная сторона счёта: без неё оба теста выше проходили бы на
    // компоненте, который вообще не рисует центральный экран.
    sessionState.errorCode = 'storage_open_timeout';
    const html = await renderPanel();
    expect(times(html, 'chat.enable_messaging')).toBe(2);
  });
});

/* ─────────── вход в восстановление виден, когда он нужен ─────────────── */

describe('дверь к коду восстановления видна именно тогда, когда сеанса нет', () => {
  it.each([
    ['session_absent'], ['storage_read_failed'], ['storage_blocked'],
    ['storage_open_timeout'], ['storage_version_unknown'], ['signature_malformed'],
  ])('причина «%s» — вход по коду на экране есть', async (code) => {
    // ⚠️ Находка сквозной проверки: вход показывался только там, где сеанс
    // УЖЕ был (`hasRecoveryCode(session)`), то есть ровно там, где он не
    // нужен. Человек, сменивший устройство, двери не видел — а мы перед этим
    // заставили его доказать, что код записан.
    sessionState.errorCode = code;
    const html = await renderPanel();
    expect(html).toContain(translate('chat.restore_menu'));
  });

  it('человек выключил сам — дверь тоже на месте', async () => {
    sessionState.errorCode = null;
    const html = await renderPanel();
    expect(html).toContain(translate('chat.restore_menu'));
  });

  /* ⚠️ И ОТДЕЛЬНО — САМ ОБЩИЙ ЭКРАН, БЕЗ ПАНЕЛИ ВОКРУГ.
     Замер: без этих тестов удаление двери из `ChatOffScreen` не красило
     НИЧЕГО (мутация М-67) — её заслоняла своя кнопка полосы под полем
     ввода. Проверки выше меряли панель целиком и потому ничего не
     сторожили. Шестой случай этой болезни за задачу. */
  async function renderShared(errorCode: string | null): Promise<string> {
    const { ChatOffScreen } = await import('@/components/ChatOffScreen');
    return renderToStaticMarkup(React.createElement(ChatOffScreen, {
      errorCode, onRetry: () => {}, variant: 'full',
    }));
  }

  it.each([
    ['session_absent'], ['storage_read_failed'], ['storage_blocked'],
    ['storage_open_timeout'], ['storage_version_unknown'], ['signature_malformed'],
    ['address_malformed'],
  ])('ОБЩИЙ ЭКРАН сам по себе: причина «%s» — дверь по коду на нём есть', async (code) => {
    expect(await renderShared(code)).toContain(translate('chat.restore_menu'));
  });

  it('ОБЩИЙ ЭКРАН сам по себе: человек выключил сам — дверь есть', async () => {
    expect(await renderShared(null)).toContain(translate('chat.restore_menu'));
  });

  it('дверь на общем экране одна, а не две', async () => {
    // У причины «не смогли прочитать» восстановление — ГЛАВНОЕ действие.
    // Красит: вторая, тихая дверь рядом с той же главной.
    const html = await renderShared('storage_read_failed');
    expect(html.split(translate('chat.restore_menu')).length - 1).toBe(1);
  });
});

/* ─────────── «ключ не сохранился» разведён — в РАЗМЕТКЕ ──────────────── */

describe('несохранённый ключ: кошельку-контракту другие слова', () => {
  it('⚠️ кошелёк-контракт видит про ПОТЕРЮ ЛИЧНОСТИ', async () => {
    // Красит: панель, показывающая общую надпись. Прежний замок стоял на
    // имени ключа в файле и обходился.
    sessionState.status = 'ready';
    sessionState.session = contractSession();
    pairState.needsSetup = false;
    pairState.storageNotice = { persisted: false, code: null, actionable: false };
    const html = await renderPanel();
    expect(html).toContain(translate('chat.key_not_saved_contract'));
    expect(html).not.toContain(translate('chat.key_not_saved'));
  });

  it('обычный кошелёк видит прежнюю надпись', async () => {
    sessionState.status = 'ready';
    sessionState.session = { ...contractSession(), origin: 'signature', walletKind: 'eoa' } as ChatSession;
    pairState.needsSetup = false;
    pairState.storageNotice = { persisted: false, code: null, actionable: false };
    const html = await renderPanel();
    expect(html).toContain(translate('chat.key_not_saved'));
    expect(html).not.toContain(translate('chat.key_not_saved_contract'));
  });
});

/* ─────────── ОДИН экран на оба места, а не две копии ────────────────── */

describe('панель и список рисуют ОДИН и тот же экран', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('⚠️ оба места ОТРИСОВЫВАЮТ общий компонент, а не свою копию', () => {
    // Сверяется разметка, а не упоминание: импорт без отрисовки — та самая
    // болезнь, на которой в этой задаче уже попадались пять раз.
    for (const rel of ['components/ChatPanel.tsx', 'app/chat/page.tsx']) {
      expect(read(rel), rel).toMatch(/<ChatOffScreen\b/);
    }
  });

  it('⚠️ ни одно из мест не рисует «мессенджер выключен» СВОИМИ руками', () => {
    // Главный замок находки: своя копия в списке обвиняла человека на всех
    // семи причинах. Красит возврат любой копии.
    for (const rel of ['components/ChatPanel.tsx', 'app/chat/page.tsx']) {
      expect(read(rel), rel).not.toMatch(/t\(\s*["']chat\.messaging_off["']\s*\)/);
    }
  });

  it('слова и действие выбирает общий экран, а не место вызова', () => {
    const shared = read('components/ChatOffScreen.tsx');
    expect(shared).toContain('offScreenFor');
    // И дверь к коду там же — она нужна на ЛЮБОМ из этих экранов.
    expect(shared).toContain('RESTORE_RECOVERY_EVENT');
  });
});
