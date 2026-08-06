/**
 * chatPanelDisplay.test.tsx — что видит человек после пересадки (Задача 7).
 *
 * ⚠️ ЭТО НАСТОЯЩАЯ ПАНЕЛЬ, а не её описание. `ChatPanel` импортируется как
 * есть и отрисовывается `react-dom/server` в разметку; проверяется РАЗМЕТКА.
 * У фронта нет ни jsdom, ни @testing-library (см. шапку vitest.config.mjs),
 * поэтому эффекты и события здесь не работают — и это сказано прямо, а не
 * замолчано:
 *
 *   ЧТО НАСТОЯЩЕЕ: сам компонент, его ветвления, порядок узлов, тексты из
 *   настоящего `messages/ru.json`, иконки lucide.
 *   ЧТО ПОДМЕНЕНО: React-обёртки, которые в `node` не живут (wagmi,
 *   next-intl, react-query) и `usePairChat` — его состояние подаётся снаружи.
 *   В сквозном тесте (`lib/__stand__/chatScreen.test.tsx`) это состояние
 *   приезжает из НАСТОЯЩЕГО движка на НАСТОЯЩЕМ релеере.
 *
 * Зачем вообще: до этой задачи `gapAfterSeq` хук отдавал, а панель не читала
 * — разрыв цепочки был вычислен и невидим. Проверка «через модули» этого не
 * ловит по построению: модуль-то считает правильно.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;

/** Настоящий словарь, а не заглушка `k => k`: тест обязан видеть ТЕКСТ,
 *  который увидит человек. Отсутствующий ключ — красный тест, а не тихий
 *  прочерк на экране. */
function translate(key: string, params?: Record<string, string>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    RU,
  );
  if (typeof value !== 'string') throw new Error(`нет ключа перевода: ${key}`);
  return params
    ? value.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? `{${name}}`)
    : value;
}

/** Состояние `usePairChat`, которое панель получит в этом рендере. */
interface PanelState {
  messages: unknown[];
  gapAfterSeq: number[];
  peerKnown: boolean;
  error: string | null;
  isLoading: boolean;
  isInitialized: boolean;
  needsSetup: boolean;
  streamDead: boolean;
  passSignaturePending?: boolean;
  storageNotice?: { code: string | null; actionable: boolean } | null;
}

const state: PanelState = {
  messages: [], gapAfterSeq: [], peerKnown: true, error: null,
  isLoading: false, isInitialized: true, needsSetup: false, streamDead: false,
};

function setState(patch: Partial<PanelState>): void {
  Object.assign(state, {
    messages: [], gapAfterSeq: [], peerKnown: true, error: null,
    isLoading: false, isInitialized: true, needsSetup: false, streamDead: false,
    passSignaturePending: false, storageNotice: null,
  }, patch);
}

const ME = '0x1111111111111111111111111111111111111111';
const PEER = '0x2222222222222222222222222222222222222222';

function msg(o: {
  from: string; seq: number; text: string; delivered?: boolean; at?: number;
}) {
  return {
    id: `${o.from}-${o.seq}`,
    from: o.from,
    seq: o.seq,
    text: o.text,
    timestamp: o.at ?? Date.UTC(2026, 7, 6, 10, 0, 0) + o.seq * 60_000,
    isFromMe: o.from === ME.toLowerCase(),
    delivered: o.delivered ?? true,
  };
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
vi.mock('react-hot-toast', () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ displayName: null, avatarUrl: null }) }));
vi.mock('@/hooks/usePreDealBar', () => ({ usePreDealBar: () => null }));
vi.mock('@/hooks/useFeeConfig', () => ({
  useFeeConfig: () => ({ feeBps: 500, feeFloor: 1_000_000n, isLoading: false }),
}));
vi.mock('@/components/DealActionBar', () => ({ DealActionBar: () => null }));
vi.mock('@/hooks/usePairChat', () => ({
  usePairChat: () => ({
    ...state,
    sendMessage: async () => {},
    sendFile: async () => {},
    uploadProgress: null,
    reconnect: () => {},
  }),
}));

async function renderPanel(): Promise<string> {
  const { ChatPanel } = await import('@/components/ChatPanel');
  return renderToStaticMarkup(
    React.createElement(ChatPanel, { recipientAddress: PEER }),
  );
}

/** Иконка lucide по ПОЛНОМУ токену класса: `lucide-check` — префикс
 *  `lucide-check-check`, и наивный `includes` считал бы две галочки одной. */
function iconCount(html: string, name: string): number {
  return (html.match(new RegExp(`class="lucide lucide-${name} `, 'g')) ?? []).length;
}

beforeEach(() => { setState({}); });

describe('бейдж «Только вы двое»', () => {
  it('в шапке стоит бейдж, и его текст — все ТРИ строки, включая про арбитра', async () => {
    const html = await renderPanel();
    expect(html).toContain(translate('chat.privacy_badge_title'));
    // Все три строки доступны без единого действия — в подсказке бейджа.
    expect(html).toContain(escapeAttr(translate('chat.privacy_badge_title')));
    expect(html).toContain(escapeAttr(translate('chat.privacy_badge_storage')));
    expect(html).toContain(escapeAttr(translate('chat.privacy_badge_dispute')));
  });

  it('раскрытый бейдж показывает все три строки текстом, а не только подсказкой', async () => {
    // Раскрытие — состояние React; без DOM нажать нечем, поэтому раскрытая
    // часть отрисовывается напрямую. Компонент НАСТОЯЩИЙ, тот же самый, что
    // рисует панель.
    const { PrivacyNotice } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(PrivacyNotice, { open: true }));
    expect(html).toContain(translate('chat.privacy_badge_title'));
    expect(html).toContain(translate('chat.privacy_badge_storage'));
    expect(html).toContain(translate('chat.privacy_badge_dispute'));
  });

  it('закрытый бейдж не рисует текст в теле панели', async () => {
    const { PrivacyNotice } = await import('@/components/ChatPanel');
    const html = renderToStaticMarkup(React.createElement(PrivacyNotice, { open: false }));
    expect(html).not.toContain(translate('chat.privacy_badge_dispute'));
  });

  it('старого бейджа про журнал спора не осталось нигде', async () => {
    const html = await renderPanel();
    expect(html).not.toContain('Хранится для споров');
    expect(() => translate('chat.dispute_log_badge')).toThrow();
    expect(() => translate('chat.dispute_log_hint')).toThrow();
  });
});

describe('одна галочка вместо двух', () => {
  it('дошедшее своё — галочка, недошедшее своё — часы, двойной галочки нет', async () => {
    setState({
      messages: [
        msg({ from: ME.toLowerCase(), seq: 0, text: 'дошло', delivered: true }),
        msg({ from: ME.toLowerCase(), seq: 1, text: 'ещё нет', delivered: false, at: Date.UTC(2026, 7, 6, 12, 0, 0) }),
      ],
    });
    const html = await renderPanel();
    expect(iconCount(html, 'check')).toBe(1);
    expect(iconCount(html, 'clock')).toBe(1);
    expect(iconCount(html, 'check-check')).toBe(0);
  });

  it('чужие сообщения галочек не носят вовсе', async () => {
    setState({
      messages: [msg({ from: PEER.toLowerCase(), seq: 0, text: 'привет' })],
    });
    const html = await renderPanel();
    expect(iconCount(html, 'check')).toBe(0);
    expect(iconCount(html, 'check-check')).toBe(0);
    expect(iconCount(html, 'clock')).toBe(0);
  });
});

describe('разрыв цепочки виден', () => {
  it('вырезанное из середины называется на экране, и ровно в своём месте', async () => {
    setState({
      messages: [
        msg({ from: PEER.toLowerCase(), seq: 0, text: 'первое' }),
        msg({ from: PEER.toLowerCase(), seq: 1, text: 'второе' }),
        msg({ from: PEER.toLowerCase(), seq: 3, text: 'четвёртое' }),
      ],
      gapAfterSeq: [1],
    });
    const html = await renderPanel();
    const gapText = translate('chat.chain_gap');
    expect(html).toContain(gapText);
    // Между «вторым» и «четвёртым», а не где придётся.
    expect(html.indexOf('второе')).toBeLessThan(html.indexOf(gapText));
    expect(html.indexOf(gapText)).toBeLessThan(html.indexOf('четвёртое'));
  });

  it('целая переписка НИЧЕГО про разрыв не рисует', async () => {
    setState({
      messages: [
        msg({ from: PEER.toLowerCase(), seq: 0, text: 'первое' }),
        msg({ from: PEER.toLowerCase(), seq: 1, text: 'второе' }),
      ],
      gapAfterSeq: [],
    });
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.chain_gap'));
    expect(html).not.toContain(translate('chat.chain_gap_start'));
  });

  it('не предъявленное начало (−1) называется отдельно и стоит ПЕРЕД первым сообщением', async () => {
    setState({
      messages: [msg({ from: PEER.toLowerCase(), seq: 1, text: 'второе' })],
      gapAfterSeq: [-1],
    });
    const html = await renderPanel();
    const startText = translate('chat.chain_gap_start');
    expect(html).toContain(startText);
    expect(html.indexOf(startText)).toBeLessThan(html.indexOf('второе'));
    expect(html).not.toContain(translate('chat.chain_gap'));
  });

  it('разрыв в СВОЕЙ половине не приписывается собеседнику', async () => {
    // gapAfterSeq считается по цепочке собеседника (receiveBags(peer)), и
    // значок обязан стоять у ЕГО сообщений. Своё сообщение с тем же номером
    // значка получать не должно — иначе экран обвиняет человека в том, что
    // он утаил собственное письмо.
    setState({
      messages: [
        msg({ from: ME.toLowerCase(), seq: 1, text: 'моё' }),
        msg({ from: PEER.toLowerCase(), seq: 5, text: 'его' }),
      ],
      gapAfterSeq: [1],
    });
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.chain_gap'));
  });
});

describe('зоопарк ошибок подключения свёрнут до двух', () => {
  it('собеседник ещё не заходил — своё состояние со ссылкой-приглашением', async () => {
    setState({ peerKnown: false });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.recipient_no_messaging'));
    expect(html).toContain(translate('chat.share_invite_hint'));
    expect(html).toContain(translate('chat.copy_invite'));
  });

  it('нет сети — второе и последнее состояние, с повтором', async () => {
    setState({ error: 'network_failed' });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.could_not_connect'));
    expect(html).toContain(translate('chat.retry'));
    expect(html).not.toContain(translate('chat.recipient_no_messaging'));
  });

  it('код отказа склада НЕ выводится человеку сырым', async () => {
    setState({ error: 'payload_too_large' });
    const html = await renderPanel();
    expect(html).not.toContain('payload_too_large');
  });

  it('семи XMTP-причин отказа не осталось ни в одной локали', () => {
    for (const code of ['tab_busy', 'too_many_installations', 'brave', 'wrong_chain',
      'insecure_context', 'timeout', 'wallet_pending']) {
      expect(() => translate(`xmtp_error.${code}`)).toThrow();
    }
  });
});

describe('мёртвое убрано, а не спрятано', () => {
  it('янтарной плашки «журнал спора не ведётся» нет ни в разметке, ни в словаре', async () => {
    const html = await renderPanel();
    expect(html).not.toContain('Журнал спора');
    expect(() => translate('chat.log_incomplete')).toThrow();
  });

  it('кнопки «загрузить старые» нет: склад отдаёт всё одним списком', async () => {
    setState({ messages: [msg({ from: PEER.toLowerCase(), seq: 0, text: 'первое' })] });
    const html = await renderPanel();
    expect(() => translate('chat.load_older')).toThrow();
    expect(() => translate('chat.search_history_hint')).toThrow();
  });
});

describe('второе окно подписи объяснено словами', () => {
  it('пока склад просит подпись, на экране сказано зачем и как часто', async () => {
    setState({ passSignaturePending: true });
    const html = await renderPanel();
    expect(html).toContain(translate('chat.pass_signature_hint'));
  });

  it('без запроса подписи этой строки нет', async () => {
    const html = await renderPanel();
    expect(html).not.toContain(translate('chat.pass_signature_hint'));
  });

  it('ключ не лёг на устройство — сказано, и с действием только там, где оно есть', async () => {
    setState({ storageNotice: { code: 'storage_blocked', actionable: true } });
    const blocked = await renderPanel();
    expect(blocked).toContain(translate('chat.key_not_saved_blocked'));

    setState({ storageNotice: { code: 'storage_write_failed', actionable: false } });
    const quota = await renderPanel();
    expect(quota).toContain(translate('chat.key_not_saved'));
    expect(quota).not.toContain(translate('chat.key_not_saved_blocked'));
  });
});

/** HTML-экранирование, как его делает React в значении атрибута. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
