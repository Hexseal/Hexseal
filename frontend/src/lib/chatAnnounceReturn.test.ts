/**
 * chatAnnounceReturn.test.ts — кнопка появляется, КОГДА ЧЕЛОВЕК ВЕРНУЛСЯ.
 *
 * ─── ЧТО СКАЗАЛ ВЛАДЕЛЕЦ ────────────────────────────────────────────────────
 *
 * Дословно: «кнопка появилась, но поздно, когда ты делаешь подпись первую, сходу
 * как я возвращаюсь я должен видеть кнопку, а сейчас она как будто на таймере
 * или че, пока со страницы не перешелкнешь, ниче не появляется».
 *
 * ─── ЧТО ИМЕННО ЗАМЕРЕНО ────────────────────────────────────────────────────
 *
 * Справочник спрашивался РОВНО ОДИН РАЗ за жизнь вкладки: эффект хука стоял под
 * условием «стояние ещё не известно», и другого случая спросить не было НИ
 * ОДНОГО. Значит любой неудачный первый ответ застревал навсегда:
 *
 *   - страница в этот момент была свёрнута (мы как раз ушли к кошельку!), сеть в
 *     фоне не идёт → `unreachable`;
 *   - справочник моргнул → `unreachable`.
 *
 * А `unreachable` — это «мы не знаем», и кнопки при нём нет по построению
 * (`announceNeedsPress`). Уход на другую страницу и обратно перемонтирует хук —
 * вот почему «перешелкнёшь, и появляется».
 *
 * Здесь мерится: сколько раз спрошен справочник и что стало со стоянием, когда
 * страница ВЕРНУЛАСЬ в глаза. И обратная сторона, которую владелец назвал
 * отдельно: возвраты НЕ ДОЛЖНЫ множить запросы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readStandingInto, keyAnnouncementState, ownKeyStanding, askStandingIfWorth,
  subscribeKeyAnnouncement, _resetKeyAnnouncementForTest, _resetStandingWatchForTest,
  STANDING_RECHECK_MIN_GAP_MS,
} from '@/lib/chatAnnounceStore';
import { fetchPeerChatKeys } from '@/hooks/useChatSession';
import { announceNeedsPress } from '@/lib/chatAnnounce';
import {
  _resetSignatureGateForTest, noteWalletHandoff, checkSignatureGate,
} from '@/lib/chatSignatureGate';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import type { ChatSession } from '@/lib/chatSession';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

/* ─────────────── подделка страницы: умеет уходить и возвращаться ───────────── */

interface FakePage {
  visibilityState: 'visible' | 'hidden';
  listeners: Map<string, Set<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
  fire: (t: string) => void;
  goAway: () => void;
  comeBack: () => void;
}

function fakePage(): FakePage {
  const p: FakePage = {
    visibilityState: 'visible',
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!p.listeners.has(t)) p.listeners.set(t, new Set());
      p.listeners.get(t)!.add(fn);
    },
    removeEventListener(t, fn) { p.listeners.get(t)?.delete(fn); },
    fire(t) { for (const fn of p.listeners.get(t) ?? []) fn(); },
    goAway() { p.visibilityState = 'hidden'; p.fire('visibilitychange'); p.fire('blur'); },
    comeBack() { p.visibilityState = 'visible'; p.fire('visibilitychange'); },
  };
  return p;
}

/* ────────────────────────── подделка справочника ───────────────────────────── */

let page: FakePage;
let session: ChatSession;
/** Что справочник ответит на СЛЕДУЮЩИЙ запрос. */
let answer: 'refuse' | 'absent' | 'mine';
let directoryCalls = 0;

function stubDirectory(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url), 'http://x');
    if (!u.pathname.startsWith('/keys/')) return new Response('{}', { status: 404 });
    directoryCalls++;
    if (answer === 'refuse') return new Response('{}', { status: 503 });
    if (answer === 'absent') return new Response(JSON.stringify({ code: 'key_not_found' }), { status: 404 });
    return new Response(JSON.stringify({
      boxKey: '0x' + Buffer.from(session.keypair.publicKey).toString('hex'),
    }), { status: 200 });
  }));
}

/** Сдвинуть часы. Все замеры этого файла идут на поддельных часах: правило
 *  «возня кошелька — не возврат» держится на ВРЕМЕНИ, и мерить его иначе
 *  нечем. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/**
 * НАСТОЯЩИЙ поход в кошелёк: страница ушла, прошло время, страница вернулась.
 *
 * Отдельным хелпером, потому что мгновенный `goAway(); comeBack();` — это НЕ
 * поход, а ровно та возня с фокусом, которую самописец увидел на живом Redmi
 * (полторы секунды). Замеры обязаны отличать одно от другого так же, как код.
 */
function walletTrip(awayMs = 10_000): void {
  page.goAway();
  advance(awayMs);
  page.comeBack();
}

/** Обещания подделанного справочника разрешаются микрозадачами — дать им дойти. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Ровно тот вопрос, на который отвечает экран: показывать кнопку или нет. */
function buttonShown(): boolean {
  const st = keyAnnouncementState(ALICE);
  return announceNeedsPress({
    keyOnDevice: true, standing: st.standing, attempt: st.attempt,
    gate: checkSignatureGate(false),
  });
}

beforeEach(async () => {
  _resetKeyAnnouncementForTest();
  _resetStandingWatchForTest();
  _resetSignatureGateForTest();
  directoryCalls = 0;
  answer = 'refuse';
  page = fakePage();
  vi.stubGlobal('document', page);
  vi.stubGlobal('localStorage', undefined);
  stubDirectory();
  session = { address: ALICE, keypair: await deriveChatKeypair(('0x' + 'ab'.repeat(65)) as `0x${string}`) } as ChatSession;
  // Часы поддельные — но ТОЛЬКО после вывода ключа: libsodium ждёт своей
  // готовности таймером, и поддельные часы его подвесили бы.
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  _resetStandingWatchForTest();
  _resetSignatureGateForTest();
  vi.unstubAllGlobals();
});

/* ═════════════ 1. вернулся из кошелька — кнопка на экране ══════════════════ */

describe('справочник не ответил, пока мы ходили к кошельку', () => {
  it('человек вернулся — справочник спрошен снова, и кнопка появилась', async () => {
    // Первая подпись: уходим к кошельку, страница пропадает из глаз.
    noteWalletHandoff();
    page.goAway();
    // Ровно то, что делает хук, когда ключ появился на устройстве. Сеть в фоне
    // не идёт — справочник отказывает.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    expect(ownKeyStanding(ALICE), 'отказ справочника принят за ответ').toBe('unreachable');
    expect(buttonShown(), 'кнопка есть до возврата — замер не про то').toBe(false);
    const askedBefore = directoryCalls;

    // Человек подтвердил подпись и вернулся на страницу. Ничего не нажимал и
    // никуда не переходил.
    answer = 'absent';
    walletTrip();
    await flush();

    expect(directoryCalls, 'справочник не спрошен на возврате').toBe(askedBefore + 1);
    expect(ownKeyStanding(ALICE)).toBe('absent');
    expect(buttonShown(), 'кнопки нет и после возврата — то есть «пока не перешелкнёшь»').toBe(true);
  });

  it('возврат перерисовывает тех, кто спрашивал (иначе кнопка есть, а её не видно)', async () => {
    let told = 0;
    const stop = subscribeKeyAnnouncement(() => { told++; });
    try {
      await readStandingInto(ALICE, session, fetchPeerChatKeys);
      told = 0;
      page.goAway();
      expect(told, 'уход в фон перерисовывает зря').toBe(0);
      answer = 'absent';
      advance(10_000);
      page.comeBack();
      await flush();
      expect(told, 'возврат никого не перерисовал').toBeGreaterThan(0);
    } finally { stop(); }
  });

  it('перечитывать НЕЧЕГО, а перерисовать всё равно надо — иначе кнопки не видно', async () => {
    // ⚠️ ЭТОТ ЗАМЕР ПОЯВИЛСЯ ПОТОМУ, ЧТО МУТАЦИЯ НАШЛА ДЫРУ В ПРЕДЫДУЩЕМ.
    // Снятие `tell()` из обработчика возврата проходило ЗЕЛЁНЫМ на 8 замерах:
    // перерисовку, которую тот замер видел, посылало САМО ПЕРЕЧИТЫВАНИЕ, а не
    // возврат. То есть замок сторожил не то, что был должен, — ровно класс
    // «ищет имя, а не употребление».
    //
    // Здесь перечитывать нечего по правилу (стояние известно), а перерисовать
    // ОБЯЗАТЕЛЬНО: пока страница была скрыта, кнопки не было (показывать
    // некому), и её появление зависит ТОЛЬКО от того, что кто-то перерисуется.
    answer = 'absent';
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    noteWalletHandoff();

    let told = 0;
    const stop = subscribeKeyAnnouncement(() => { told++; });
    try {
      page.goAway();
      expect(buttonShown(), 'кнопка у свёрнутого приложения').toBe(false);
      const askedBefore = directoryCalls;
      told = 0;
      advance(10_000);
      page.comeBack();
      await flush();
      expect(directoryCalls - askedBefore, 'спросили справочник там, где ответ ничего не меняет').toBe(0);
      expect(told, 'возврат не перерисовал никого — кнопка есть, но её не рисуют').toBeGreaterThan(0);
      expect(buttonShown(), 'после возврата кнопка обязана быть').toBe(true);
    } finally { stop(); }
  });

  it('фокус тоже считается возвратом (iOS в приложении не даёт visibilitychange)', async () => {
    // ⚠️ ЭТО НЕ ПЕРЕСТРАХОВКА. В этом проекте уже записано, что в установленном
    // приложении на iOS событие видимости ненадёжно (`providers.tsx`,
    // `VisibilityRefresher`), и там ради этого заведён свой обход.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const askedBefore = directoryCalls;
    answer = 'absent';
    page.fire('focus');
    await flush();
    expect(directoryCalls, 'фокус не считается возвратом').toBe(askedBefore + 1);
  });
});

/* ═════════════ 2. возвраты не множат запросы ═══════════════════════════════ */

describe('десять переключений — сколько запросов к справочнику', () => {
  it('не знаем стояния: десять походов в кошелёк — ДВА запроса, не десять', async () => {
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const askedBefore = directoryCalls;
    // Справочник продолжает отказывать: стояние остаётся «не знаем», то есть
    // спрашивать по-прежнему есть зачем — и вот тут порог обязан держать.
    //
    // Десять походов по четыре секунды — это сорок секунд. Порог 30 с пускает
    // первый и ещё один за тридцатой секундой: два запроса на десять
    // переключений вместо десяти.
    for (let i = 0; i < 10; i++) { walletTrip(4_000); await flush(); }
    expect(directoryCalls - askedBefore, 'каждое переключение стоит запроса').toBe(2);
  });

  it('порог отпустил — следующий возврат снова спрашивает', async () => {
    // Замок, который запирает навсегда, — не порог, а поломка.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const askedBefore = directoryCalls;
    walletTrip(); await flush();
    expect(directoryCalls - askedBefore).toBe(1);
    advance(STANDING_RECHECK_MIN_GAP_MS + 1);
    walletTrip(); await flush();
    expect(directoryCalls - askedBefore).toBe(2);
  });

  it('ключ объявлен — НОЛЬ запросов на десять переключений', async () => {
    // Спрашивать нечего: экран уже правильный. Лишний запрос на каждое
    // переключение кошелька — это своя починка хуже дефекта.
    answer = 'mine';
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    expect(ownKeyStanding(ALICE)).toBe('mine');
    const askedBefore = directoryCalls;
    for (let i = 0; i < 10; i++) { walletTrip(4_000); await flush(); }
    expect(directoryCalls - askedBefore, 'здоровое состояние стоит запросов').toBe(0);
  });

  it('кнопка уже показана — НОЛЬ запросов: ответ ничего не изменит', async () => {
    answer = 'absent';
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    expect(ownKeyStanding(ALICE)).toBe('absent');
    const askedBefore = directoryCalls;
    for (let i = 0; i < 10; i++) { page.goAway(); page.comeBack(); await flush(); }
    expect(directoryCalls - askedBefore).toBe(0);
  });

  it('хук смонтировался снова: спрашиваем только пока не знаем', async () => {
    // ⚠️ ЭТО ЗАМЕР ТОГО, ЧТО РАНЬШЕ ЖИЛО УСЛОВИЕМ ВНУТРИ ХУКА и не сторожилось
    // ничем: мутация «вернуть прежнее правило» прошла зелёной на 37 замерах.
    // Правило переехало в склад ровно затем, чтобы получить это число.
    answer = 'refuse';
    expect(askStandingIfWorth(ALICE, session, fetchPeerChatKeys), 'первый вопрос не задан').toBe(true);
    // Три экземпляра хука на одной странице — ОДИН запрос, а не три.
    expect(askStandingIfWorth(ALICE, session, fetchPeerChatKeys)).toBe(false);
    expect(askStandingIfWorth(ALICE, session, fetchPeerChatKeys)).toBe(false);
    await flush();
    expect(directoryCalls, 'три экземпляра дали три запроса').toBe(1);

    // Справочник отказал — «мы не знаем», и новое монтирование обязано спросить.
    expect(ownKeyStanding(ALICE)).toBe('unreachable');
    answer = 'mine';
    expect(askStandingIfWorth(ALICE, session, fetchPeerChatKeys), 'отказ справочника заперт до перезагрузки').toBe(true);
    await flush();
    expect(ownKeyStanding(ALICE)).toBe('mine');

    // Ответ по существу есть — больше не спрашиваем ни на каком монтировании.
    const asked = directoryCalls;
    for (let i = 0; i < 10; i++) askStandingIfWorth(ALICE, session, fetchPeerChatKeys);
    await flush();
    expect(directoryCalls - asked, 'каждое монтирование стоит запроса').toBe(0);
  });

  /* ═══════ ВОЗНЯ КОШЕЛЬКА С ФОКУСОМ — НЕ ВОЗВРАТ ═══════════════════════════
     ⚠️ САМОПИСЕЦ НА ЖИВОМ REDMI (9 августа), настоящий MetaMask, дословно:

         34,7 с  расфокус                  видимость: visible
         36,0 с  фокус → расфокус          visible     ← кошелёк дёргает фокус
         37,1 с  видимость → hidden        hidden      ← поход в кошелёк
         52,9 с  ключ лёг на устройство    hidden
         67,2 с  видимость → visible + фокус           ← человек вернулся

     Кошелёк даёт расфокус-фокус-расфокус за полторы секунды ДО похода. Если
     считать этот фокус возвратом, он съедает порог — и настоящий возврат на
     67-й секунде окажется внутри тридцатисекундного окна и НЕ перечитает
     справочник. То есть кнопка снова появится «как будто на таймере», только
     теперь по вине нашей же защиты.

     Отличитель — время: возня кошелька укладывается в полторы секунды, поход в
     кошелёк идёт секунды и минуты. */
  it('возня кошелька с фокусом не тратит ни одного запроса', async () => {
    {
      vi.setSystemTime(34_700);
      await readStandingInto(ALICE, session, fetchPeerChatKeys);
      const askedBefore = directoryCalls;
      answer = 'absent';

      // 34,7 расфокус → 36,0 фокус → расфокус. Страница ни разу не скрывалась.
      page.fire('blur');
      vi.setSystemTime(36_000);
      page.fire('focus');
      await flush();
      page.fire('blur');
      expect(directoryCalls - askedBefore, 'возня кошелька стоила запроса').toBe(0);

      // 37,1 уход, 67,2 возврат — вот это возврат.
      vi.setSystemTime(37_100);
      page.goAway();
      vi.setSystemTime(67_200);
      page.comeBack();
      await flush();
      expect(directoryCalls - askedBefore, 'настоящий возврат не перечитал справочник').toBe(1);
      expect(ownKeyStanding(ALICE)).toBe('absent');
    }
  });

  it('короткий уход и возврат (быстрая подпись) — возврат всё равно считается', async () => {
    // Порог отличает возню от похода, а не «долгий поход от короткого». Подпись
    // в расширении может занять три секунды, и это настоящий возврат.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const askedBefore = directoryCalls;
    answer = 'absent';
    walletTrip(6_000);
    await flush();
    expect(directoryCalls - askedBefore).toBe(1);
  });

  it('ушли в фон и остались там — ни одного запроса', async () => {
    // Спрашивать из свёрнутого приложения незачем: показывать некому, а сеть в
    // фоне всё равно не идёт.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const askedBefore = directoryCalls;
    page.goAway();
    page.fire('visibilitychange');
    page.fire('visibilitychange');
    await flush();
    expect(directoryCalls - askedBefore).toBe(0);
  });
});
