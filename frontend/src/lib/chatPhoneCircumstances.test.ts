/**
 * chatPhoneCircumstances.test.ts — пять вопросов про обстоятельства, ответ числом.
 *
 * `docs/PROCESS.md`: про логику думают всегда, потому что она в задаче написана;
 * про обстоятельства не думает никто, потому что их в задаче нет. За план
 * «транспорт и хранение» из шести серьёзных находок ни одна не была ошибкой в
 * логике — все шесть про обстоятельства.
 *
 * Здесь те же пять вопросов, приложенные к починке чата на телефоне. Каждый —
 * замером на настоящем коде, а не рассуждением.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveChatKeypair } from '@/lib/chatCrypto';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import {
  _resetSignatureGateForTest, noteWalletHandoff, checkSignatureGate, wentAwayForWallet,
} from '@/lib/chatSignatureGate';
import {
  announceInto, keyAnnouncementState, _resetKeyAnnouncementForTest, readStandingInto,
} from '@/lib/chatAnnounceStore';
import { announceNeedsPress, announceMayAuto } from '@/lib/chatAnnounce';
import { getBagPass, publishChatKeys, fetchPeerChatKeys, signChatKeyLocked } from '@/hooks/useChatSession';
import type { ChatSession } from '@/lib/chatSession';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;
/**
 * Отдельные адреса для замеров с ЗАВИСШИМ кошельком.
 *
 * ⚠️ ЭТО НЕ УДОБСТВО, А НАХОДКА ЗАМЕРА, И ЕЙ МЕСТО В ОТЧЁТЕ. Мьютекс кошелька
 * (`lib/walletLock.ts`) — ПО АДРЕСУ, и брошенного держателя он ждёт
 * `WALLET_LOCK_TIMEOUT_MS` = 3 МИНУТЫ, прежде чем пустить следующего. Значит
 * зависшее окно подписи блокирует все остальные пути подписи ЭТОГО кошелька на
 * три минуты — во всём приложении. Так задумано (шапка `walletLock.ts` объясняет:
 * лучше редкое повторение, чем бессрочный клин), но знать это надо.
 *
 * В замерах это проявилось буквально: один зависший вызов на `ALICE` уронил по
 * таймауту ОДИННАДЦАТЬ следующих замеров этого файла. Поэтому зависания живут на
 * своих адресах.
 */
const HANGING = '0xdead00000000000000000000000000000000beef' as const;
const NEVER = '0xdead10000000000000000000000000000000beef' as const;
const sig = (f: string) => ('0x' + f.repeat(130).slice(0, 130)) as `0x${string}`;

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

let page: FakePage;
let session: ChatSession;
let walletPrompts = 0;
let keysWrites = 0;
let passRequests = 0;
let keysStatus = 200;

beforeEach(async () => {
  _resetBagPassCacheForTest();
  _resetSignatureGateForTest();
  _resetKeyAnnouncementForTest();
  walletPrompts = 0; keysWrites = 0; passRequests = 0; keysStatus = 200;
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
      return new Response(JSON.stringify({
        pass: 'v1.p', expiresAt: Math.floor(Date.now() / 1000) + 43_200,
      }), { status: 200 });
    }
    if (u.pathname === '/keys') {
      keysWrites++;
      return keysStatus === 200
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ error: 'нет', code: 'directory_unavailable' }), { status: keysStatus });
    }
    // Справочник про наш адрес: ключа нет.
    return new Response(JSON.stringify({ error: 'нет', code: 'key_not_found' }), { status: 404 });
  }));
});

afterEach(() => {
  _resetSignatureGateForTest();
  _resetKeyAnnouncementForTest();
  vi.unstubAllGlobals();
});

/** Кошелёк-приложение: открывая окно, уводит страницу из глаз. */
const phoneWallet = async () => {
  walletPrompts++;
  page.goAway();
  page.comeBack();
  return sig('b');
};
const deps = () => ({
  getPass: (o: { humanAsked: boolean }) =>
    getBagPass(ALICE, phoneWallet, undefined, { ...o, purpose: 'announce' as const }),
  publish: publishChatKeys,
});

/* ══════════════════════════════ 1. ПЕРЕЗАПУСТИЛИ ═══════════════════════════ */

describe('1. Перезапустили посреди: закрыл приложение между первой подписью и кнопкой', () => {
  it('при возврате: ключ цел, состояние опознано, кнопка есть, подписей 0', async () => {
    // Первая подпись прошла, страница уходила в кошелёк. Человек закрыл
    // приложение и вернулся — то есть модули загрузились заново, память отсечки
    // пуста, а ключ лежит в хранилище устройства.
    await signChatKeyLocked(ALICE, async () => {
      walletPrompts++; page.goAway(); page.comeBack(); return sig('a');
    });
    expect(walletPrompts).toBe(1);

    // ─── перезапуск: память отсечки обнуляется вместе с вкладкой ───
    _resetSignatureGateForTest();
    _resetKeyAnnouncementForTest();
    walletPrompts = 0;

    // Ключ на устройстве уцелел (он в IndexedDB, отсечка его не касается).
    expect(session.keypair.publicKey.length).toBe(32);

    // Справочник спрашивается открыто, без подписи.
    await readStandingInto(ALICE, session, fetchPeerChatKeys);
    const st = keyAnnouncementState(ALICE);
    expect(st.standing, 'состояние после возврата не опознано').toBe('absent');
    expect(walletPrompts, 'возврат стоил окна кошелька').toBe(0);
    expect(passRequests, 'возврат стоил запроса пропуска').toBe(0);

    // ⚠️ ЧЕСТНО О ЧИСЛЕ. После перезапуска страница НЕ пропадала из глаз, значит
    // отсечка пропускает — и объявление проходит САМО, без кнопки. Это не
    // недоделка: страница жива и на переднем плане, окно кошелька дойдёт. Кнопка
    // — для случая, когда мы ТОЛЬКО ЧТО были в кошельке.
    expect(announceMayAuto({ keyOnDevice: true, standing: st.standing, attempt: st.attempt, gate: checkSignatureGate(false) }))
      .toBe(true);
    expect(announceNeedsPress({ keyOnDevice: true, standing: st.standing, attempt: st.attempt, gate: checkSignatureGate(false) }))
      .toBe(false);

    // И оно доходит до конца.
    await announceInto(ALICE, session, false, deps());
    expect(keyAnnouncementState(ALICE).standing, 'после возврата объявиться не удалось').toBe('mine');
    expect(walletPrompts, 'подписей после возврата больше одной').toBe(1);
  });

  it('оборванная подпись не запирает следующую попытку', async () => {
    // Закрыл вкладку, пока висело окно: обещание не разрешилось никогда.
    let hang: (() => void) | null = null;
    const hangingWallet = async () => {
      walletPrompts++;
      return new Promise<string>((resolve) => { hang = () => resolve(sig('b')); });
    };
    void announceInto(HANGING, session, true, {
      getPass: (o) => getBagPass(HANGING, hangingWallet, undefined, { ...o, purpose: 'announce' }),
      publish: publishChatKeys,
    });
    // Даём микрозадачам докрутиться до самого окна: путь до кошелька идёт через
    // мьютекс и кэш пропуска, и одного оборота очереди на это не хватает.
    for (let i = 0; i < 40 && walletPrompts === 0; i++) await Promise.resolve();
    expect(walletPrompts, 'до зависшего окна дело не дошло — замер потерял смысл').toBe(1);

    // Перезапуск: всё в памяти обнулилось.
    _resetSignatureGateForTest();
    _resetKeyAnnouncementForTest();
    _resetBagPassCacheForTest();
    walletPrompts = 0;

    // Вторая попытка — ДРУГИМ адресом: тот же адрес заперт брошенным держателем
    // на три минуты (см. врезку у HANGING), и это свойство мьютекса, не наше.
    await announceInto(ALICE, session, true, deps());
    expect(keyAnnouncementState(ALICE).standing, 'вторая попытка прилипла к оборванной первой').toBe('mine');
    expect(walletPrompts, 'вторая попытка не дошла до кошелька').toBe(1);
    expect(hang, 'подделка кошелька не повисла — замер потерял смысл').not.toBeNull();
  });
});

/* ═════════════════════════ 2. ХРАНИЛИЩЕ НЕ ПИШЕТ ══════════════════════════ */

describe('2. Хранилище не пишет: приватный режим, встроенный браузер кошелька', () => {
  it('кладовой нет — объявление всё равно проходит, просто пропуск не переживёт вкладку', async () => {
    // `localStorage` уже подделан как `undefined` во всех замерах этого файла —
    // ровно приватный режим. Объявление обязано работать.
    await announceInto(ALICE, session, true, deps());
    expect(keyAnnouncementState(ALICE).standing).toBe('mine');
    expect(keysWrites).toBe(1);
  });

  it('кладовая БРОСАЕТ на каждом обращении — тот же исход, без падения', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('заперто'); },
      setItem: () => { throw new Error('заперто'); },
      removeItem: () => { throw new Error('заперто'); },
    });
    await announceInto(ALICE, session, true, deps());
    expect(keyAnnouncementState(ALICE).standing, 'запертая кладовая уронила объявление').toBe('mine');
  });

  it('что человек понимает: «ключ не сохранился» — отдельная новость, не эта', async () => {
    // ⚠️ ЧЕСТНО. Про незаписанный КЛЮЧ человеку говорит другой признак
    // (`sessionStorageNotice` → `storage_blocked`), и он был до этой ветки. Наша
    // надпись говорит только про справочник. Смешивать нельзя: «вам пока не могут
    // писать» лечится нажатием, а приватный режим нажатием не лечится, и обещать
    // это было бы враньём.
    const { sessionStorageNotice } = await import('@/hooks/useChatSession');
    const notice = sessionStorageNotice({ ...session, persisted: false, storageIssue: 'storage_blocked' });
    expect(notice).not.toBeNull();
    expect(notice!.actionable, 'у этой беды есть действие — значит его надо предложить').toBe(true);
  });
});

/* ═══════════════════════════ 3. ДВА ПРОЦЕССА РАЗОМ ════════════════════════ */

describe('3. Два процесса разом: приложение и браузер открыты, оба просят', () => {
  it('три одновременных объявления — ОДНО окно и ОДНА запись', async () => {
    await Promise.all([
      announceInto(ALICE, session, true, deps()),
      announceInto(ALICE, session, true, deps()),
      announceInto(ALICE, session, true, deps()),
    ]);
    expect(walletPrompts, 'окон кошелька больше одного: второе прилетит как -32002').toBe(1);
    expect(keysWrites, 'записей в справочник больше одной').toBe(1);
  });

  it('чтение справочника тремя экземплярами — один запрос', async () => {
    let reads = 0;
    const counting = async (a: `0x${string}`, s?: AbortSignal) => { reads++; return fetchPeerChatKeys(a, s); };
    await Promise.all([
      readStandingInto(ALICE, session, counting),
      readStandingInto(ALICE, session, counting),
      readStandingInto(ALICE, session, counting),
    ]);
    expect(reads, 'три экземпляра хука — три запроса к справочнику').toBe(1);
  });
});

/* ══════════════════════════════ 4. ПРИШЁЛ МУСОР ═══════════════════════════ */

describe('4. Пришёл мусор: кошелёк отказал, вернул мусор, не вернул ничего', () => {
  it('человек отказался подписывать — состояние «не удалось», кнопка есть, падения нет', async () => {
    const refusing = async () => { walletPrompts++; throw new Error('User rejected the request'); };
    await announceInto(ALICE, session, true, {
      getPass: (o) => getBagPass(ALICE, refusing, undefined, { ...o, purpose: 'announce' }),
      publish: publishChatKeys,
    });
    const st = keyAnnouncementState(ALICE);
    expect(st.attempt).toBe('failed');
    expect(announceNeedsPress({ keyOnDevice: true, standing: 'absent', attempt: st.attempt, gate: 'go' }),
      'отказавшись раз, человек остался без кнопки').toBe(true);
  });

  it('кошелёк вернул МУСОР вместо подписи — вердикт, а не падение', async () => {
    const junks = ['', 'не hex', '0x', '0xzz', 'null'];
    for (let i = 0; i < junks.length; i++) {
      const junk = junks[i];
      _resetKeyAnnouncementForTest(); _resetBagPassCacheForTest();
      const addr = (`0xj${i}` + '0'.repeat(37)).replace('j', '1') as `0x${string}`;
      const junkWallet = async () => junk;
      await announceInto(addr, session, true, {
        getPass: (o) => getBagPass(addr, junkWallet, undefined, { ...o, purpose: 'announce' }),
        publish: publishChatKeys,
      });
      const st = keyAnnouncementState(addr);
      // Сервер такую подпись не примет; главное — что мы не упали и состояние
      // названо, а не осталось «объявлено».
      expect(['mine', 'absent', 'unknown'], junk).toContain(st.standing);
      expect(st.attempt, junk).not.toBe('busy');
    }
  });

  it('ОБЕЩАНИЕ, КОТОРОЕ НЕ РАЗРЕШАЕТСЯ НИКОГДА — замер: сколько окон и что на экране', async () => {
    // ⚠️ Самый неприятный из четырёх, и в мобильном MetaMask он настоящий: окно
    // подписи там нечем отменить.
    let resolved = false;
    const neverWallet = async () => {
      walletPrompts++;
      return new Promise<string>(() => { /* никогда */ });
    };
    void announceInto(NEVER, session, true, {
      getPass: (o) => getBagPass(NEVER, neverWallet, undefined, { ...o, purpose: 'announce' }),
      publish: publishChatKeys,
    }).then(() => { resolved = true; });
    for (let i = 0; i < 40 && walletPrompts === 0; i++) await Promise.resolve();

    expect(walletPrompts, 'окон кошелька больше одного').toBe(1);
    expect(resolved, 'объявление разрешилось, хотя кошелёк молчит').toBe(false);
    // Пока висит — состояние «занято», значит кнопка заперта и второго окна не
    // будет; и это НЕ «не удалось», человеку не врут про поломку.
    expect(keyAnnouncementState(NEVER).attempt).toBe('busy');
    expect(announceNeedsPress({ keyOnDevice: true, standing: 'absent', attempt: 'busy', gate: 'go' }))
      .toBe(false);

    // Десять новых нажатий, пока то висит — окно по-прежнему одно.
    for (let i = 0; i < 10; i++) {
      void announceInto(NEVER, session, true, {
        getPass: (o) => getBagPass(NEVER, neverWallet, undefined, { ...o, purpose: 'announce' }),
        publish: publishChatKeys,
      });
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(walletPrompts, 'висящее окно не мешает открывать новые').toBe(1);
  });

  it('справочник отдал 503 на записи — «не удалось», и это отличимо от ожидания', async () => {
    keysStatus = 503;
    await announceInto(ALICE, session, true, deps());
    expect(keyAnnouncementState(ALICE).attempt).toBe('failed');
    expect(keyAnnouncementState(ALICE).errorCode).not.toBeNull();
  });
});

/* ═════════════════════════════ 5. ДОЛБЯТ НАРОЧНО ══════════════════════════ */

describe('5. Долбят нарочно: можно ли заставить жать кнопку без конца', () => {
  it('двадцать нажатий после успеха — окон кошелька ОДНО, записей ОДНА', async () => {
    await announceInto(ALICE, session, true, deps());
    expect(walletPrompts).toBe(1);
    expect(keysWrites).toBe(1);
    for (let i = 0; i < 20; i++) await announceInto(ALICE, session, true, deps());
    // Пропуск живёт 12 часов в памяти модуля, состояние уже `mine` — но даже если
    // кто-то зовёт объявление снова, окно не открывается.
    expect(walletPrompts, 'нажатие открывает окно каждый раз').toBe(1);
  });

  it('после успеха кнопки на экране НЕТ — нажимать нечего', async () => {
    await announceInto(ALICE, session, true, deps());
    const st = keyAnnouncementState(ALICE);
    expect(announceNeedsPress({ keyOnDevice: true, standing: st.standing, attempt: st.attempt, gate: 'needs_press' }),
      'кнопка осталась после успешного объявления').toBe(false);
  });

  it('отказ справочника не крутит объявление сам — второй раз только по нажатию', async () => {
    // Иначе «долбят нарочно» устраивали бы мы сами себе: своему серверу и своему
    // кошельку, каждый тик.
    keysStatus = 503;
    await announceInto(ALICE, session, true, deps());
    const st = keyAnnouncementState(ALICE);
    expect(announceMayAuto({ keyOnDevice: true, standing: 'absent', attempt: st.attempt, gate: 'go' }),
      'отказ будет повторяться сам каждый тик').toBe(false);
  });

  it('память отсечки не залипает навсегда: новое обращение к кошельку — свой отсчёт', async () => {
    // Иначе одно давнее сворачивание приложения требовало бы нажатия до конца
    // жизни вкладки, то есть отсечка из защиты стала бы вечной преградой.
    noteWalletHandoff();
    page.goAway();
    page.comeBack();
    expect(wentAwayForWallet()).toBe(true);
    noteWalletHandoff();
    expect(wentAwayForWallet(), 'память об уходе не обнулилась на новом обращении').toBe(false);
  });
});
