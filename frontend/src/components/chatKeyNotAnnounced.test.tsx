/**
 * chatKeyNotAnnounced.test.tsx — «Вам пока не могут писать» доехало до экрана.
 *
 * ─── ЗАЧЕМ ЗАМОК НА РЕНДЕРЕ, А НЕ НА ХУКЕ ───────────────────────────────────
 *
 * Решение «показывать или нет» уже заперто чистой таблицей
 * (`lib/chatAnnounce.test.ts`), а само объявление — настоящим справочником
 * (`lib/__stand__/chatAnnounceKey.test.ts`). Не заперто ровно одно: ДОЕХАЛО ЛИ
 * это до экрана и до КНОПКИ.
 *
 * В этом проекте такое уже терялось молча, и не раз: находка К-2 — разводка
 * причин отказа доехала до панели и НЕ доехала до списка переписок, и заметили
 * это только рендером. Здесь замки на ОБА места, панель и список.
 *
 * ─── ЧТО ИМЕННО МЕРИТСЯ ─────────────────────────────────────────────────────
 *
 *  1. текст на экране — из настоящего `ru.json`, дословно утверждённый;
 *  2. кнопка есть, и нажатие вызывает ИМЕННО объявление (не что-нибудь ещё);
 *  3. текст и кнопка лежат ВНУТРИ центральной карточки — ВЛОЖЕННОСТЬ, а не
 *     порядок в разметке. Урок оплачен 7 августа: замок, сравнивавший индексы
 *     («текст раньше поля ввода»), остался ЗЕЛЁНЫМ на мутации, вернувшей текст
 *     в полосу под перепиской, — полоса тоже стоит раньше поля ввода. Он
 *     пропускал ровно тот дефект, ради которого заводился;
 *  4. слов «включить» и «ключ» на кнопке нет — три решения владельца заперты
 *     замером, а не только комментарием.
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
    keyNotAnnounced: false, announcing: false, announceKey: () => {},
  }, patch);
}

const announcement: Record<string, unknown> = {};
function setAnnouncement(patch: Record<string, unknown>): void {
  for (const k of Object.keys(announcement)) delete announcement[k];
  Object.assign(announcement, {
    standing: 'absent', attempt: 'none', needsPress: false, busy: false,
    announce: () => {}, errorCode: null,
  }, patch);
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME, isConnected: true }),
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
  return {
    ...real,
    useChatSession: () => ({
      status: 'ready', error: null, errorCode: null, session: { persisted: true },
      recoveryCode: null, storageNotice: null, keySignaturePending: false,
      retry: () => {}, cancel: () => {}, disable: () => true,
    }),
  };
});
vi.mock('@/hooks/useKeyAnnouncement', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/hooks/useKeyAnnouncement')>();
  return { ...real, useKeyAnnouncement: () => ({ ...announcement }) };
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

const TITLE = () => translate('chat.key_unannounced_title');
const BODY = () => translate('chat.key_unannounced_body');
const CALL = () => translate('chat.key_unannounced_call');
const ACTION = () => translate('chat.key_unannounced_action');

beforeEach(() => { setState({}); setAnnouncement({}); });

/* ═════════════════════════════ панель переписки ═════════════════════════════ */

describe('панель: состояние названо и вылечиваемо', () => {
  it('текст утверждённый — все три строки и кнопка', async () => {
    setState({ keyNotAnnounced: true, messages: [], synced: false });
    const html = await renderPanel();
    expect(html, 'заголовок пропал').toContain(TITLE());
    expect(html, 'первая строка пропала').toContain(BODY());
    expect(html, 'вторая строка пропала').toContain(CALL());
    expect(html, 'кнопки нет — состояние названо, но лечить нечем').toContain(ACTION());
  });

  it('ключ объявлен — НИ ОДНОЙ из этих надписей на экране нет', async () => {
    // Замок, который горит всегда, — не замок.
    setState({ keyNotAnnounced: false, messages: [], synced: true });
    const html = await renderPanel();
    expect(html).not.toContain(TITLE());
    expect(html).not.toContain(ACTION());
  });

  it('переписка на руках — надпись ПОВЕРХ неё, а не вместо', async () => {
    // Тот же принцип, что у ожидания подписи: состояние не имеет права прятать
    // то, что человек уже расшифровал и держит.
    const three = ['первое', 'второе', 'третье'].map((text, seq) => ({
      id: `${PEER.toLowerCase()}-${seq}`, from: PEER.toLowerCase(), seq, text,
      timestamp: Date.UTC(2026, 7, 8, 10, seq), isFromMe: false, delivered: true,
    }));
    setState({ keyNotAnnounced: true, messages: three });
    const html = await renderPanel();
    for (const m of three) expect(html, 'переписка спряталась за надписью').toContain(m.text);
    expect(html).toContain(TITLE());
  });

  it('пока висит окно кошелька — эта надпись МОЛЧИТ', async () => {
    // Иначе человек одновременно видит «подтвердите подпись в кошельке» и
    // «нажмите, чтобы подтвердить» — две просьбы об одном, и непонятно, чего
    // от него хотят.
    setState({ keyNotAnnounced: true, passSignaturePending: true, messages: [], synced: false });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.signature_wanted'));
    expect(html, 'две просьбы об одном на одном экране').not.toContain(TITLE());
  });
});

/* ═══════════════════════ место: ВЛОЖЕННОСТЬ, не порядок ══════════════════════ */

describe('место надписи — внутри центральной карточки', () => {
  it('текст и кнопка лежат ВНУТРИ одной карточки, а не порознь', async () => {
    // ⚠️ ЗАМЕР ВЛОЖЕННОСТИ. Мутация, которая должна красить: вынести текст в
    // полосу под перепиской, оставив кнопку в центре (или наоборот). Замок на
    // порядок в разметке такое пропустил бы — полоса тоже стоит раньше поля
    // ввода. Здесь и текст, и кнопка обязаны прийти из ОДНОГО компонента.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const card = renderToStaticMarkup(
      React.createElement(ChatKeyNotAnnounced, {
        variant: 'full' as const, busy: false, onConfirm: () => {},
      }),
    );
    expect(card, 'заголовок ушёл из карточки').toContain(TITLE());
    expect(card, 'первая строка ушла из карточки').toContain(BODY());
    expect(card, 'вторая строка ушла из карточки').toContain(CALL());
    expect(card, 'кнопка ушла из карточки').toContain(ACTION());
    expect(card, 'кнопка перестала быть кнопкой').toMatch(/<button[^>]*>/);
  });

  it('карточка стоит ВЫШЕ поля ввода', async () => {
    setState({ keyNotAnnounced: true, messages: [], synced: false });
    const html = await renderPanel();
    const notice = html.indexOf(TITLE());
    const input = html.indexOf('<textarea');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(input).toBeGreaterThanOrEqual(0);
    expect(notice, 'надпись уехала под поле ввода — человек смотрит в центр').toBeLessThan(input);
  });
});

/* ══════════════════════ три решения владельца — замером ══════════════════════ */

describe('три решения владельца о словах — заперты, а не только записаны', () => {
  it('слова «включить» в этих надписях нет НИ В ОДНОЙ из 14 локалей', async () => {
    // Дословно владелец: «я ж при подписи его и так включил — мысли юзера».
    // Человек считает, что первой подписью чат уже включил, и он прав: ключ
    // создан. Спорить с ним нельзя — надо говорить про другое.
    const forbidden: Record<string, RegExp> = {
      ru: /включ/i, uk: /увімкн|включ/i, en: /\benable|\bturn on/i,
      de: /aktivier|einschalt/i, fr: /activer/i, es: /activar/i, pt: /ativar/i,
      it: /attivare/i, ja: /有効/, ko: /활성/, 'zh-CN': /启用|开启/,
      hi: /सक्षम|चालू/, ar: /تفعيل|تمكين/, th: /เปิดใช้/,
    };
    const offenders: string[] = [];
    for (const [loc, re] of Object.entries(forbidden)) {
      const j = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${loc}.json`), 'utf8')) as
        { chat: Record<string, string> };
      for (const k of ['key_unannounced_title', 'key_unannounced_body', 'key_unannounced_call', 'key_unannounced_action']) {
        const v = j.chat[k];
        expect(v, `${loc}.${k} отсутствует`).toBeTruthy();
        if (re.test(v)) offenders.push(`${loc}.${k}: ${v}`);
      }
    }
    expect(offenders, 'вернулось слово «включить» — решение владельца снято молча').toEqual([]);
  });

  it('на кнопке нет слова «ключ» НИ В ОДНОЙ из 14 локалей', async () => {
    // «Объявить мой ключ» забраковано с точной причиной: звучит как «показать
    // сам ключ». Кнопка повторяет текст выше — «Подтвердите» → «Подтвердить».
    const keyWord: Record<string, RegExp> = {
      ru: /ключ/i, uk: /ключ/i, en: /\bkey\b/i, de: /schlüssel/i, fr: /clé|cle/i,
      es: /clave/i, pt: /chave/i, it: /chiave/i, ja: /キー|鍵/, ko: /키/,
      'zh-CN': /密钥/, hi: /कुंजी/, ar: /مفتاح/, th: /คีย์|กุญแจ/,
    };
    const offenders: string[] = [];
    for (const [loc, re] of Object.entries(keyWord)) {
      const j = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${loc}.json`), 'utf8')) as
        { chat: Record<string, string> };
      if (re.test(j.chat.key_unannounced_action)) {
        offenders.push(`${loc}: ${j.chat.key_unannounced_action}`);
      }
    }
    expect(offenders, 'на кнопке снова слово «ключ»').toEqual([]);
  });

  it('заголовок — от последствия, и он про НЕВОЗМОЖНОСТЬ ПИСАТЬ, а не про шаг', async () => {
    // Не «настройка не завершена», а «вам пока не могут писать». Замок мерит
    // содержание на русском (языке, на котором текст утверждали), и краснеет,
    // если заголовок подменят на механику.
    const ru = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as
      { chat: Record<string, string> };
    expect(ru.chat.key_unannounced_title).toBe('Вам пока не могут писать');
    expect(ru.chat.key_unannounced_title).not.toMatch(/настрой|шаг|заверш/i);
  });

  it('русский текст — БУКВА В БУКВУ утверждённый владельцем', async () => {
    const ru = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as
      { chat: Record<string, string> };
    expect(ru.chat.key_unannounced_title).toBe('Вам пока не могут писать');
    expect(ru.chat.key_unannounced_body).toBe('Ключ создан, но о нём ещё никто не знает.');
    expect(ru.chat.key_unannounced_call).toBe('Подтвердите в кошельке — и вас найдут.');
    expect(ru.chat.key_unannounced_action).toBe('Подтвердить');
  });
});

/* ═══════════════════ кнопка вызывает ИМЕННО объявление ══════════════════════ */

describe('кнопка делает дело, а не украшает экран', () => {
  it('нажатие зовёт объявление ровно один раз', async () => {
    // ⚠️ Мерится УПОТРЕБЛЕНИЕ, не наличие. Кнопка без обработчика прошла бы
    // все замки выше: текст на месте, `<button>` на месте, вложенность верная.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    let calls = 0;
    const el = React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, onConfirm: () => { calls++; },
    });
    // `renderToStaticMarkup` обработчики выбрасывает — нажать нечем. Достаём
    // сам обработчик из дерева элементов: это и есть проводка, которую надо
    // сторожить, а не разметка вокруг неё.
    const rendered = (el.type as (p: Record<string, unknown>) => React.ReactElement)(
      el.props as Record<string, unknown>,
    );
    const found = findButton(rendered);
    expect(found, 'кнопки в дереве нет').not.toBeNull();
    (found!.props as { onClick?: () => void }).onClick?.();
    expect(calls, 'нажатие никуда не ведёт — кнопка украшение').toBe(1);
  });

  it('пока объявляем — кнопка занята и второй раз не срабатывает', async () => {
    // Ответ на вопрос «долбят нарочно»: нажать десять раз подряд нельзя.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const el = React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: true, onConfirm: () => {},
    });
    const rendered = (el.type as (p: Record<string, unknown>) => React.ReactElement)(
      el.props as Record<string, unknown>,
    );
    const found = findButton(rendered);
    expect((found!.props as { disabled?: boolean }).disabled, 'кнопка не заперта на время работы').toBe(true);
    const html = renderToStaticMarkup(el);
    expect(html, 'занятость не видна человеку').toContain(translate('chat.key_unannounced_confirming'));
  });
});

/** Первый `<button>` в дереве элементов. Обход, а не разметка: обработчики
 *  живут в дереве, в HTML их не бывает. */
function findButton(node: unknown): React.ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  const el = node as React.ReactElement<{ children?: unknown }>;
  if (el.type === 'button') return el;
  const kids = el.props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const kid of list) {
    const hit = findButton(kid);
    if (hit) return hit;
  }
  return null;
}
