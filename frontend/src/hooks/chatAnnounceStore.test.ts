/**
 * chatAnnounceStore.test.ts — переход состояния объявления, замером.
 *
 * ─── ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ ─────────────────────────────────────────────
 *
 * Он появился ПОСЛЕ того, как мутация нашла дыру, и это надо назвать прямо.
 *
 * Различие «ещё не время» / «не удалось» вынесено в чистую функцию
 * `attemptAfterFailure` и заперто таблицей. Но мутация «хук перестал её звать и
 * пишет `failed` всегда» проходила ЗЕЛЁНОЙ на 58 замерах: функция заперта, её
 * УПОТРЕБЛЕНИЕ — нет. Ровно тот класс, который в этом проекте зовут «замок,
 * который ищет имя, а не употребление»: код есть, никто им не пользуется, все
 * тесты зелены.
 *
 * Вопрос-отличитель («что исчезнет из ПОВЕДЕНИЯ, если снять правку») здесь
 * получает ответ: исчезнет автоматика на десктопе после одного моргания
 * видимости. Это и мерится.
 *
 * ─── ЧТО ПОДДЕЛАНО ──────────────────────────────────────────────────────────
 *
 * Только кошелёк и сеть. Склад состояния, порог подписи, `announceInto` и
 * `getBagPass` — настоящие, те самые, которые зовёт хук.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  announceInto, keyAnnouncementState, _resetKeyAnnouncementForTest,
  mailboxWorthPollingFor, readStandingInto,
} from '@/lib/chatAnnounceStore';
import { getBagPass, publishChatKeys, fetchPeerChatKeys } from '@/hooks/useChatSession';
import { announceMayAuto, announceNeedsPress } from '@/lib/chatAnnounce';
import {
  _resetSignatureGateForTest, noteWalletHandoff, checkSignatureGate,
} from '@/lib/chatSignatureGate';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import type { ChatSession } from '@/lib/chatSession';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

interface FakePage {
  visibilityState: 'visible' | 'hidden';
  listeners: Set<() => void>;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
  goAway: () => void;
  comeBack: () => void;
}

function fakePage(): FakePage {
  const p: FakePage = {
    visibilityState: 'visible',
    listeners: new Set(),
    addEventListener: (t, fn) => { if (t === 'visibilitychange') p.listeners.add(fn); },
    removeEventListener: (_t, fn) => { p.listeners.delete(fn); },
    goAway() { p.visibilityState = 'hidden'; for (const fn of p.listeners) fn(); },
    comeBack() { p.visibilityState = 'visible'; for (const fn of p.listeners) fn(); },
  };
  return p;
}

let session: ChatSession;
let page: FakePage;
/** Что отвечает сервер на `POST /keys` в этом замере. */
let keysStatus = 200;
let passStatus = 200;
let walletPrompts = 0;
let keysWrites = 0;
let passRequests = 0;

beforeEach(async () => {
  _resetKeyAnnouncementForTest();
  _resetSignatureGateForTest();
  _resetBagPassCacheForTest();
  keysStatus = 200;
  passStatus = 200;
  walletPrompts = 0;
  keysWrites = 0;
  passRequests = 0;
  page = fakePage();
  vi.stubGlobal('document', page);
  vi.stubGlobal('localStorage', undefined);
  session = {
    keypair: await deriveChatKeypair(sig('a')),
    address: ALICE, origin: 'signature', walletKind: 'eoa', restored: false, persisted: true,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/bags/pass') {
      passRequests++;
      return passStatus === 200
        ? new Response(JSON.stringify({
            pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 43_200,
          }), { status: 200 })
        : new Response(JSON.stringify({ error: 'no', code: 'rate_limited' }), { status: passStatus });
    }
    if (u.pathname === '/keys') {
      keysWrites++;
      return keysStatus === 200
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ error: 'нет', code: 'directory_unavailable' }), { status: keysStatus });
    }
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  _resetSignatureGateForTest();
  _resetKeyAnnouncementForTest();
  vi.unstubAllGlobals();
});

const wallet = async () => { walletPrompts++; return sig('b'); };

/** Настоящие зависимости объявления — те же, что подставляет хук: `getBagPass`
 *  с `purpose: 'announce'` и настоящая `publishChatKeys`. Подделан только кошелёк. */
function deps() {
  return {
    getPass: (o: { humanAsked: boolean }) =>
      getBagPass(ALICE, wallet, undefined, { ...o, purpose: 'announce' as const }),
    publish: publishChatKeys,
  };
}

describe('ЗАМЕР: успешное объявление', () => {
  it('нажатие — ключ объявлен, состояние «mine», ящик снова стоит опрашивать', async () => {
    expect(mailboxWorthPollingFor(ALICE), 'ящик опрашивали до объявления').toBe(false);

    await announceInto(ALICE, session, true, deps());

    expect(keyAnnouncementState(ALICE).standing).toBe('mine');
    expect(keyAnnouncementState(ALICE).attempt).toBe('none');
    expect(walletPrompts).toBe(1);
    expect(mailboxWorthPollingFor(ALICE), 'ящик так и не начали опрашивать').toBe(true);
  });
});

describe('ЗАМЕР: «ещё не время» не превращается в «не удалось»', () => {
  it('порог отказал — состояние остаётся «none», автоматика на десктопе ЖИВА', async () => {
    // ⚠️ ГЛАВНЫЙ ЗАМОК ФАЙЛА, и он мерит УПОТРЕБЛЕНИЕ. Что красит: хук перестал
    // звать `attemptAfterFailure` и пишет `failed` всегда.
    //
    // Порядок как на телефоне: пошли к кошельку, страница пропала, вернулась.
    noteWalletHandoff();
    page.goAway();
    page.comeBack();
    expect(checkSignatureGate(false), 'порог не сработал — замер потерял смысл').toBe('needs_press');

    await announceInto(ALICE, session, false, deps());

    const st = keyAnnouncementState(ALICE);
    expect(st.attempt, 'ожидание нажатия записано как поломка').toBe('none');
    expect(st.errorCode, 'ожидание нажатия названо ошибкой').toBeNull();
    expect(walletPrompts, 'подпись ушла без нажатия').toBe(0);

    // И вот ПОСЛЕДСТВИЕ, ради которого различие существует: десктоп, у которого
    // видимость моргнула, сохраняет право объявиться сам.
    expect(announceMayAuto({
      keyOnDevice: true, standing: 'absent', attempt: st.attempt, gate: 'go',
    }), 'десктоп потерял автоматику из-за одного моргания видимости').toBe(true);
  });

  it('страница скрыта — то же самое: ни подписи, ни поломки', async () => {
    page.visibilityState = 'hidden';
    await announceInto(ALICE, session, false, deps());
    expect(keyAnnouncementState(ALICE).attempt).toBe('none');
    expect(walletPrompts).toBe(0);
  });
});

describe('ЗАМЕР: настоящий отказ — это «не удалось», и кнопка появляется', () => {
  it('справочник отдал 503 — состояние «failed», кнопка есть, автоматика молчит', async () => {
    // Замок, который горит всегда, — не замок: настоящая поломка обязана
    // выглядеть иначе, чем ожидание.
    keysStatus = 503;
    await announceInto(ALICE, session, true, deps());

    const st = keyAnnouncementState(ALICE);
    expect(st.attempt, 'настоящий отказ проглочен как ожидание').toBe('failed');
    expect(st.errorCode, 'причина отказа не сохранена').not.toBeNull();
    expect(walletPrompts, 'до кошелька не дошло — тогда мерится не то').toBe(1);

    expect(announceNeedsPress({
      keyOnDevice: true, standing: 'absent', attempt: st.attempt, gate: 'go',
    }), 'после отказа человек остался без кнопки').toBe(true);
    expect(announceMayAuto({
      keyOnDevice: true, standing: 'absent', attempt: st.attempt, gate: 'go',
    }), 'отказ будет крутиться сам каждый тик').toBe(false);
  });

  it('пропуск не выдан (429) — тоже «не удалось», и ключ не объявлен', async () => {
    passStatus = 429;
    await announceInto(ALICE, session, true, deps());
    expect(keyAnnouncementState(ALICE).attempt).toBe('failed');
    expect(keyAnnouncementState(ALICE).standing, 'объявленным считаем то, чего нет').not.toBe('mine');
  });
});

describe('ЗАМЕР: два процесса разом', () => {
  it('три одновременных объявления — ОДНА запись в справочник и одно окно', async () => {
    // Панель, список и движок зовут это на одной странице.
    //
    // ⚠️ МЕРИТСЯ ЧИСЛО ЗАПИСЕЙ `POST /keys`, А НЕ ТОЛЬКО ОКОН КОШЕЛЬКА, и это
    // исправление замера, найденное мутацией. Первая версия считала окна — и
    // мутация «дедуп объявления снят» проходила ЗЕЛЁНОЙ: окно всё равно одно,
    // потому что от второго окна защищает СВОЙ дедуп внутри `requestBagPass`.
    // То есть замер сторожил чужую защиту, а не ту, что рядом с ним.
    await Promise.all([
      announceInto(ALICE, session, true, deps()),
      announceInto(ALICE, session, true, deps()),
      announceInto(ALICE, session, true, deps()),
    ]);
    expect(keysWrites, 'дедуп объявления снят: три записи в справочник вместо одной').toBe(1);
    expect(walletPrompts, 'окон кошелька больше одного').toBe(1);
    expect(keyAnnouncementState(ALICE).standing).toBe('mine');
  });
});

describe('ЗАМЕР: долбят нарочно', () => {
  it('десять нажатий подряд после успеха — окон кошелька не десять', async () => {
    // Первое объявление берёт пропуск (одно окно). Дальше пропуск живой 12 часов,
    // и повторные нажатия окон не открывают — то есть заставить человека
    // подписывать без конца нельзя.
    await announceInto(ALICE, session, true, deps());
    for (let i = 0; i < 10; i++) await announceInto(ALICE, session, true, deps());
    expect(walletPrompts, 'нажатия открывают окно каждый раз').toBe(1);
  });
});

/* ═══════════ порог ящика: ОДИН, и он на единственной дороге к пропуску ═══════ */

describe('ЗАМЕР: пропуск ради ЯЩИКА не берётся, пока ключ не объявлен', () => {
  // ⚠️ ЭТИ ЗАМКИ ЗАМЕНИЛИ ДВА НЕСТОРОЖИМЫХ. Порог стоял по строке в
  // `usePairChat` и в `usePairConversations`; мутации «снять из открытой
  // переписки» и «снять из списка» проходили ЗЕЛЁНЫМИ на 73 замерах — у фронта
  // нет jsdom, проводку внутри хука не сторожит ничто. Порог переехал в
  // `getBagPass`, и вот он мерится.
  it('ключ не объявлен — НОЛЬ запросов пропуска и ноль окон кошелька', async () => {
    expect(keyAnnouncementState(ALICE).standing).toBe('unknown');
    await expect(getBagPass(ALICE, wallet, undefined)).rejects.toThrow(/объявлен/i);
    expect(passRequests, 'пропуск попросили, хотя писать нам некуда').toBe(0);
    expect(walletPrompts, 'кошелёк открыли, хотя писать нам некуда').toBe(0);
  });

  it('ключ объявлен — пропуск берётся как раньше', async () => {
    // Замок, который горит всегда, — не замок.
    await announceInto(ALICE, session, true, deps());
    _resetBagPassCacheForTest();
    const pass = await getBagPass(ALICE, wallet, undefined);
    expect(pass).toBe('v1.p');
    expect(passRequests, 'после объявления пропуск так и не берётся').toBeGreaterThanOrEqual(1);
  });

  it('справочник недоступен — пропуск БЕРЁТСЯ: отказ в сторону работы', async () => {
    // Опрос блокируется только когда мы ПОЛОЖИТЕЛЬНО знаем, что писать нам
    // некуда. Иначе моргнувший справочник означал бы чат, молчащий навсегда.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/bags/pass') {
        passRequests++;
        return new Response(JSON.stringify({
          pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 43_200,
        }), { status: 200 });
      }
      // Справочник отвечает 503 на чтение своего ключа.
      return new Response(JSON.stringify({ error: 'ой', code: 'directory_unavailable' }), { status: 503 });
    }));
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    expect(keyAnnouncementState(ALICE).standing).toBe('unreachable');

    const pass = await getBagPass(ALICE, wallet, undefined);
    expect(pass, 'моргнувший справочник запер чат').toBe('v1.p');
  });

  it('пропуск РАДИ ОБЪЯВЛЕНИЯ порогом ящика не отсекается', async () => {
    // Иначе кольцо: объявиться нельзя без пропуска, пропуск нельзя без
    // объявления. Мутация «применять порог и к объявлению» красит этот замок и
    // делает состояние невылечиваемым НАВСЕГДА.
    expect(keyAnnouncementState(ALICE).standing).toBe('unknown');
    const pass = await getBagPass(ALICE, wallet, undefined, { humanAsked: true, purpose: 'announce' });
    expect(pass).toBe('v1.p');
  });
});

describe('ЗАМЕР: чтение справочника оборвалось — чат не молчит навсегда', () => {
  it('чтение отменено — стояние «unreachable», и пропуск берётся', async () => {
    // ⚠️ НАЙДЕНО МУТАЦИЕЙ. Мутация «падать в `unknown` вместо `unreachable`»
    // проходила зелёной: замер выше подсовывал 503, а его `readOwnStanding`
    // разбирает САМА и до `.catch` дело не доходит. В `.catch` попадает только
    // отмена — уход со страницы посреди запроса, — и это ровно тот случай,
    // который решает судьбу чата.
    //
    // `unknown` не пускает опрос ящика, а перечитать по своей воле здесь нечем:
    // эффект хука зависит от адреса и сеанса, без их смены второй попытки не
    // будет. Значит застрявшее `unknown` — это чат, молчащий до перезагрузки
    // страницы.
    const aborted = () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    };

    await readStandingInto(ALICE, session, aborted as never);

    expect(keyAnnouncementState(ALICE).standing,
      'застряли в «не знаем» — опрос ящика не начнётся до перезагрузки').toBe('unreachable');
    expect(mailboxWorthPollingFor(ALICE), 'чат замолчал навсегда').toBe(true);

    const pass = await getBagPass(ALICE, wallet, undefined);
    expect(pass).toBe('v1.p');
  });

  it('внятный ответ 404 при этом по-прежнему «absent», а не «unreachable»', async () => {
    // Замок, который горит всегда, — не замок: отказ в сторону работы не должен
    // съесть настоящий ответ справочника.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    expect(keyAnnouncementState(ALICE).standing).toBe('absent');
    expect(mailboxWorthPollingFor(ALICE)).toBe(false);
  });
});
