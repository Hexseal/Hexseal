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
    // ⚠️ Полей объявления в `usePairChat` БОЛЬШЕ НЕТ — панель зовёт
    // `useKeyAnnouncement()` сама (разбор в её докстринге). Здесь их не
    // подставляем: подставив, замок мерил бы то, чего в дороге нет.
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
    setAnnouncement({ standing: 'absent', needsPress: true });
    setState({ messages: [], synced: false });
    const html = await renderPanel();
    expect(html, 'заголовок пропал').toContain(TITLE());
    expect(html, 'первая строка пропала').toContain(BODY());
    expect(html, 'вторая строка пропала').toContain(CALL());
    expect(html, 'кнопки нет — состояние названо, но лечить нечем').toContain(ACTION());
  });

  it('ключ объявлен — НИ ОДНОЙ из этих надписей на экране нет', async () => {
    // Замок, который горит всегда, — не замок.
    setAnnouncement({ standing: 'mine', needsPress: false });
    setState({ messages: [], synced: true });
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
    setAnnouncement({ standing: 'absent', needsPress: true });
    setState({ messages: three });
    const html = await renderPanel();
    for (const m of three) expect(html, 'переписка спряталась за надписью').toContain(m.text);
    expect(html).toContain(TITLE());
  });

  it('пока висит окно кошелька — эта надпись МОЛЧИТ', async () => {
    // Иначе человек одновременно видит «подтвердите подпись в кошельке» и
    // «нажмите, чтобы подтвердить» — две просьбы об одном, и непонятно, чего
    // от него хотят.
    setAnnouncement({ standing: 'absent', needsPress: true });
    setState({ passSignaturePending: true, messages: [], synced: false });
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
        variant: 'full' as const, busy: false, standing: 'absent' as const,
        onConfirm: () => {}, onRestore: () => {},
      }),
    );
    expect(card, 'заголовок ушёл из карточки').toContain(TITLE());
    expect(card, 'первая строка ушла из карточки').toContain(BODY());
    expect(card, 'вторая строка ушла из карточки').toContain(CALL());
    expect(card, 'кнопка ушла из карточки').toContain(ACTION());
    expect(card, 'кнопка перестала быть кнопкой').toMatch(/<button[^>]*>/);
  });

  it('карточка стоит ВЫШЕ поля ввода', async () => {
    setAnnouncement({ standing: 'absent', needsPress: true });
    setState({ messages: [], synced: false });
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
      variant: 'full' as const, busy: false, standing: 'absent' as const,
      onConfirm: () => { calls++; }, onRestore: () => {},
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
      variant: 'full' as const, busy: true, standing: 'absent' as const,
      onConfirm: () => {}, onRestore: () => {},
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

/* ══════════ «ключ с ДРУГОГО устройства» — свой текст и своё действие ═════════ */

const EL_TITLE = () => translate('chat.key_elsewhere_title');
const EL_BODY = () => translate('chat.key_elsewhere_body');
const EL_RESTORE_ACTION = () => translate('chat.key_elsewhere_restore_action');
const EL_RESTORE_NOTE = () => translate('chat.key_elsewhere_restore_note');
const EL_SWITCH = () => translate('chat.key_elsewhere_switch_action');
const EL_SWITCH_NOTE = () => translate('chat.key_elsewhere_switch_note');

describe('чужой ключ в справочнике: ловушка с потерей данных закрыта', () => {
  // ⚠️ ЗАЧЕМ ЭТИ ЗАМКИ. Ревью координатора по моему же сомнению. При чужом ключе
  // текст «Вам пока не могут писать» формально ПРАВДИВ — и именно поэтому не
  // вызывает подозрений. А кнопка под ним заменяет ключ другого устройства:
  // собеседники начнут запечатывать сюда, там новое приходить перестанет, а
  // прежние мешки останутся читаемыми только там. То есть мы предлагали нажать
  // кнопку, которая молча ломает переписку, и называли это починкой.

  it('текст ДРУГОЙ, не тот же самый', async () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК. Мутация «показывать тот же текст» красит именно его.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const other = renderToStaticMarkup(React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'other_key' as const,
      onConfirm: () => {}, onRestore: () => {},
    }));
    const absent = renderToStaticMarkup(React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'absent' as const,
      onConfirm: () => {}, onRestore: () => {},
    }));

    expect(other, 'при чужом ключе показан текст состояния «ключа нет»').not.toContain(TITLE());
    expect(other).toContain(EL_TITLE());
    expect(absent, 'при отсутствии ключа показан текст про другое устройство').not.toContain(EL_TITLE());
    expect(absent).toContain(TITLE());
  });

  it('ЦЕНА замены на экране — и стоит ПОД своей кнопкой, а не где-нибудь', async () => {
    // Решение владельца: цена — одна строка под кнопкой, к которой относится, и
    // сказана с той стороны, где стоит человек («увижу ли я тут свою переписку»).
    // Что красит: снятие подписи, либо её переезд к другой кнопке.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'other_key' as const,
      onConfirm: () => {}, onRestore: () => {},
    }));
    expect(html, 'человека не предупредили о цене замены').toContain(EL_SWITCH_NOTE());
    expect(html, 'подпись под входом по коду пропала').toContain(EL_RESTORE_NOTE());
    expect(html).toContain(EL_BODY());

    // Каждая подпись — ПОСЛЕ своей кнопки и ДО чужой. Замок на место, а не на
    // наличие: подпись, уехавшая под другую кнопку, объясняет не тот выбор.
    const restoreBtn = html.indexOf(EL_RESTORE_ACTION());
    const restoreNote = html.indexOf(EL_RESTORE_NOTE());
    const switchBtn = html.indexOf(EL_SWITCH());
    const switchNote = html.indexOf(EL_SWITCH_NOTE());
    expect(restoreBtn).toBeLessThan(restoreNote);
    expect(restoreNote, 'подпись про восстановление уехала за кнопку замены').toBeLessThan(switchBtn);
    expect(switchBtn, 'цена замены стоит НАД своей кнопкой').toBeLessThan(switchNote);
  });

  it('код восстановления предложен ПЕРВЫМ, замена — вторым', async () => {
    // Требование координатора дословно: «в этом состоянии главное предложение —
    // не Подтвердить, а Ввести код восстановления». Мерится порядок ОБОИХ
    // действий внутри одной карточки (что они в одной карточке — замок ниже).
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'other_key' as const,
      onConfirm: () => {}, onRestore: () => {},
    }));
    const restore = html.indexOf(EL_RESTORE_ACTION());
    const swap = html.indexOf(EL_SWITCH());
    expect(restore, 'входа по коду восстановления нет вовсе').toBeGreaterThanOrEqual(0);
    expect(swap, 'замены нет вовсе — состояние невылечимо без кода').toBeGreaterThanOrEqual(0);
    expect(restore, 'замена предложена раньше кода восстановления').toBeLessThan(swap);
  });

  it('оба действия ведут КУДА НАДО и не путаются местами', async () => {
    // Мерится употребление: кнопка без обработчика или перепутанные обработчики
    // прошли бы все замки выше.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    let confirms = 0;
    let restores = 0;
    const el = React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'other_key' as const,
      onConfirm: () => { confirms++; }, onRestore: () => { restores++; },
    });
    const rendered = (el.type as (p: Record<string, unknown>) => React.ReactElement)(
      el.props as Record<string, unknown>,
    );
    const buttons = findAllButtons(rendered);
    expect(buttons, 'кнопок не две').toHaveLength(2);

    // Первая — код восстановления, вторая — замена. Порядок заперт замком выше.
    (buttons[0].props as { onClick?: () => void }).onClick?.();
    expect(restores, 'первая кнопка не ведёт в восстановление').toBe(1);
    expect(confirms, 'первая кнопка заменяет ключ — ровно то, чего нельзя').toBe(0);

    (buttons[1].props as { onClick?: () => void }).onClick?.();
    expect(confirms, 'вторая кнопка не заменяет ключ').toBe(1);
  });

  it('при чужом ключе на экране НЕТ слова «Подтвердить» из состояния «ключа нет»', async () => {
    // Иначе два разных смысла носят одно имя, и человек решит, что это та же
    // безобидная кнопка, которую он видел раньше.
    const { ChatKeyNotAnnounced } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(ChatKeyNotAnnounced, {
      variant: 'full' as const, busy: false, standing: 'other_key' as const,
      onConfirm: () => {}, onRestore: () => {},
    }));
    expect(html).not.toContain(ACTION());
  });

  it('панель показывает состояние чужого ключа, а не текст «ключа нет»', async () => {
    setState({ messages: [], synced: false });
    setAnnouncement({ standing: 'other_key', needsPress: true });
    const html = await renderPanel();
    expect(html, 'до панели состояние чужого ключа не доехало').toContain(EL_TITLE());
    expect(html).not.toContain(TITLE());
  });
});

/** Все `<button>` в дереве элементов, в порядке обхода. */
function findAllButtons(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
  if (!node || typeof node !== 'object') return out;
  const el = node as React.ReactElement<{ children?: unknown }>;
  if (el.type === 'button') out.push(el);
  const kids = el.props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const kid of list) findAllButtons(kid, out);
  return out;
}

/* ═══ три правила владельца — теперь и для «ключ с другого устройства» ════════ */

describe('три правила владельца распространены на второй экран', () => {
  // ⚠️ ЭТИХ ЗАМКОВ НЕ БЫЛО ОДИН КРУГ, И Я СКАЗАЛ ОБ ЭТОМ ПРЯМО: правила
  // формулировались под первый экран, и распространять их механически без слова
  // владельца я не стал. Слово получено вместе со второй редакцией текста —
  // распространяю.
  const LOCALES = ['ar','de','en','es','fr','hi','it','ja','ko','pt','ru','th','uk','zh-CN'];
  const KEYS = [
    'key_elsewhere_title', 'key_elsewhere_body',
    'key_elsewhere_restore_action', 'key_elsewhere_restore_note',
    'key_elsewhere_switch_action', 'key_elsewhere_switch_note',
  ];

  function chatOf(loc: string): Record<string, string> {
    return (JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${loc}.json`), 'utf8')) as
      { chat: Record<string, string> }).chat;
  }

  it('все шесть строк есть во всех 14 локалях, и снятых ключей не осталось', () => {
    for (const loc of LOCALES) {
      const chat = chatOf(loc);
      for (const k of KEYS) expect(chat[k], `${loc}.${k}`).toBeTruthy();
      // Первая редакция: длинный абзац с тремя оговорками и лишняя строка.
      expect(chat.key_elsewhere_switch_warning, `${loc}: вернулся забракованный абзац`).toBeUndefined();
      expect(chat.key_elsewhere_restore, `${loc}: вернулась снятая строка`).toBeUndefined();
    }
  });

  it('ПРАВИЛО 1: заголовок называет факт, а не настройку', () => {
    // Забракованная первая редакция: «этот кошелёк уже настроен где-то ещё» —
    // пересказ механики. Мерится по языкам, которые я могу судить; про остальные
    // сказано честно — там держит только буквальная сверка русского ниже.
    const mechanics: Record<string, RegExp> = {
      ru: /настрой|шаг|заверш/i,
      uk: /налашт|крок|заверш/i,
      en: /\bset ?up\b|\bstep\b|\bcomplete/i,
    };
    for (const [loc, re] of Object.entries(mechanics)) {
      expect(chatOf(loc).key_elsewhere_title, `${loc}: заголовок пересказывает механику`).not.toMatch(re);
    }
  });

  it('ПРАВИЛО 2: подписи — одна строка, без «можно / тогда / есть»', () => {
    // От них текст звучит неуверенно — прямые слова владельца. Плюс «одна
    // строка»: подпись не имеет права снова стать абзацем с оговорками.
    const hedges: Record<string, RegExp> = {
      ru: /\bможно\b|\bтогда\b|\bесть\b/i,
      uk: /\bможна\b|\bтоді\b|\bє\b/i,
      en: /\byou can\b|\bthen\b|\bif you have\b/i,
    };
    for (const [loc, re] of Object.entries(hedges)) {
      const chat = chatOf(loc);
      for (const k of ['key_elsewhere_restore_note', 'key_elsewhere_switch_note', 'key_elsewhere_body']) {
        expect(chat[k], `${loc}.${k}: вернулась неуверенная оговорка`).not.toMatch(re);
      }
    }
    // Одна фраза, а не абзац: считаем завершители во ВСЕХ 14, это язык-независимо.
    for (const loc of LOCALES) {
      const chat = chatOf(loc);
      for (const k of ['key_elsewhere_restore_note', 'key_elsewhere_switch_note', 'key_elsewhere_body']) {
        const ends = (chat[k].match(/[.。।]/g) ?? []).length;
        expect(ends, `${loc}.${k} снова абзац: ${chat[k]}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ПРАВИЛО 3: на обеих кнопках нет слова «ключ» — во всех 14', () => {
    const keyWord: Record<string, RegExp> = {
      ru: /ключ/i, uk: /ключ/i, en: /\bkey\b/i, de: /schlüssel/i, fr: /clé|cle/i,
      es: /clave/i, pt: /chave/i, it: /chiave/i, ja: /キー|鍵/, ko: /키/,
      'zh-CN': /密钥/, hi: /कुंजी/, ar: /مفتاح/, th: /คีย์|กุญแจ/,
    };
    const offenders: string[] = [];
    for (const [loc, re] of Object.entries(keyWord)) {
      const chat = chatOf(loc);
      for (const k of ['key_elsewhere_restore_action', 'key_elsewhere_switch_action']) {
        if (re.test(chat[k])) offenders.push(`${loc}.${k}: ${chat[k]}`);
      }
    }
    expect(offenders, 'на кнопке снова слово «ключ»').toEqual([]);
  });

  it('слова «включить» нет и здесь — во всех 14', () => {
    const forbidden: Record<string, RegExp> = {
      ru: /включ/i, uk: /увімкн|включ/i, en: /\benable|\bturn on/i,
      de: /aktivier|einschalt/i, fr: /activer/i, es: /activar/i, pt: /ativar/i,
      it: /attivare/i, ja: /有効/, ko: /활성/, 'zh-CN': /启用|开启/,
      hi: /सक्षम|चालू/, ar: /تفعيل|تمكين/, th: /เปิดใช้/,
    };
    const offenders: string[] = [];
    for (const [loc, re] of Object.entries(forbidden)) {
      const chat = chatOf(loc);
      for (const k of KEYS) if (re.test(chat[k])) offenders.push(`${loc}.${k}: ${chat[k]}`);
    }
    expect(offenders, 'вернулось слово «включить»').toEqual([]);
  });

  it('русский текст — БУКВА В БУКВУ утверждённый владельцем', () => {
    // Самый сильный из замков этой группы: язык, на котором текст утверждали.
    const ru = chatOf('ru');
    expect(ru.key_elsewhere_title).toBe('Ваш чат уже на другом устройстве');
    expect(ru.key_elsewhere_body).toBe('Сообщения приходят туда.');
    expect(ru.key_elsewhere_restore_action).toBe('Ввести код восстановления');
    expect(ru.key_elsewhere_restore_note).toBe('Восстановить сообщения.');
    expect(ru.key_elsewhere_switch_action).toBe('Получать здесь');
    expect(ru.key_elsewhere_switch_note).toBe('Прежняя переписка здесь не откроется.');
  });
});
