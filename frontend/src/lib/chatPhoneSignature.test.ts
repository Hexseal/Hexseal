/**
 * chatPhoneSignature.test.ts — ЗАМЕР: куда уходит вторая подпись на телефоне.
 *
 * ─── ОБСТОЯТЕЛЬСТВО, А НЕ ЛОГИКА ────────────────────────────────────────────
 *
 * На телефоне кошелёк — отдельное приложение. Переключение на него ЗАМОРАЖИВАЕТ
 * нашу страницу системой: `document.visibilityState` становится `'hidden'`, и
 * таймеры, обещания и запросы к кошельку в этот момент не идут никуда.
 *
 * Первая подпись выводит ключ переписки. Пока человек её подтверждает, страница
 * спит. Вторая подпись (пропуск к складу, без которого нельзя объявить свой ключ
 * — `POST /keys` берёт адрес из пропуска) запускается у нас АВТОМАТИЧЕСКИ, сразу
 * за первой, — то есть стреляет в спящую страницу.
 *
 * Живой замер 8 августа, после того как владелец прошёл заход в установленном
 * приложении:
 *
 *     castW  (десктоп)    → ключ объявлен, оба (шифрования и подписи)
 *     castW2 (приложение) → КЛЮЧА НЕТ
 *
 * Ключ выведен и лежит в хранилище телефона, но никому не объявлен. Человек
 * видит «никто не подключен» и уходит.
 *
 * На десктопе этого нет: кошелёк-расширение живёт в той же странице, замораживания
 * не происходит. Отсюда «на десктопе всегда всё гуд».
 *
 * ─── ЧТО МЕРИТ ЭТОТ ФАЙЛ ────────────────────────────────────────────────────
 *
 * Число ОКОН КОШЕЛЬКА, а не наличие кода. Мутация, которая должна его красить, —
 * снятие самой отсечки: тогда подпись снова уходит в спящую страницу, и число
 * становится 1 вместо 0.
 *
 * Замеры идут через НАСТОЯЩИЕ `signChatKeyLocked` и `getBagPass` — те самые две
 * функции, которые в приложении открывают окно кошелька (структурный гейт
 * `lib/signaturePaths.test.ts` держит, что других нет). Подделан только сам
 * кошелёк и склад.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetBagPassCacheForTest } from '@/lib/chatTransport';
import { CHAT_KEY_TYPED_DATA } from '@/lib/chatCrypto';
import { _resetSignatureGateForTest } from '@/lib/chatSignatureGate';

const ALICE = '0xa1ce00000000000000000000000000000000cafe' as const;

function sig(fill: string): `0x${string}` {
  return ('0x' + fill.repeat(130).slice(0, 130)) as `0x${string}`;
}

/* ─────────────────── подделка страницы: она умеет засыпать ────────────────── */

interface FakePage {
  visibilityState: 'visible' | 'hidden';
  listeners: Map<string, Set<() => void>>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  /** Система свернула приложение — ровно то, что делает переход в кошелёк. */
  goAway: () => void;
  /** Человек вернулся. */
  comeBack: () => void;
}

function fakePage(initial: 'visible' | 'hidden' = 'visible'): FakePage {
  const page: FakePage = {
    visibilityState: initial,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!page.listeners.has(type)) page.listeners.set(type, new Set());
      page.listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) { page.listeners.get(type)?.delete(fn); },
    goAway() { page.visibilityState = 'hidden'; page.fire(); },
    comeBack() { page.visibilityState = 'visible'; page.fire(); },
  } as FakePage & { fire: () => void };
  (page as FakePage & { fire: () => void }).fire = () => {
    for (const fn of page.listeners.get('visibilitychange') ?? []) fn();
  };
  return page;
}

/* ─────────────────────────── подделка склада ──────────────────────────────── */

let walletPrompts = 0;
let passCalls = 0;
let page: FakePage;

function stubServer(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname === '/bags/pass') {
      passCalls++;
      return new Response(
        JSON.stringify({ pass: 'v1.by-wallet.mac', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }));
}

/** Кошелёк-приложение: открывая окно, оно УВОДИТ страницу из глаз. Так и есть на
 *  телефоне, и это единственная разница с расширением. */
function phoneWallet(): (args: { message: string }) => Promise<string> {
  return async () => {
    walletPrompts++;
    page.goAway();
    // Человек подтвердил и вернулся.
    page.comeBack();
    return sig('b');
  };
}

/** Кошелёк-расширение: живёт в той же странице, засыпания нет. */
function desktopWallet(): (args: { message: string }) => Promise<string> {
  return async () => { walletPrompts++; return sig('b'); };
}

beforeEach(() => {
  _resetBagPassCacheForTest();
  walletPrompts = 0;
  passCalls = 0;
  page = fakePage();
  vi.stubGlobal('document', page);
  vi.stubGlobal('localStorage', undefined);
  // ⚠️ Порог помнит уход к кошельку между вызовами — на то он и заведён. Между
  // ЗАМЕРАМИ эта память обязана обнуляться, иначе первый же замер, уводящий
  // страницу, красил бы все следующие, и файл мерил бы порядок тестов, а не код.
  _resetSignatureGateForTest();
  stubServer();
});

afterEach(() => {
  // Снимаем наблюдение ДО того, как исчезнет подделанная страница: иначе
  // слушатель остаётся висеть на выброшенном объекте.
  _resetSignatureGateForTest();
  vi.unstubAllGlobals();
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe('ЗАМЕР 1: подпись в спящую страницу', () => {
  it('страница скрыта — окон кошелька НОЛЬ', async () => {
    // Требование 1 задания дословно: «Ни одна подпись не запрашивается, пока
    // страница скрыта. Замер: число запросов подписи при скрытой странице — ноль».
    //
    // Так бывает не только на первом заходе: приложение свёрнуто, а опрос ящика
    // продолжает тикать в фоне (30 с) и на холодном пропуске зовёт кошелёк.
    const { getBagPass } = await import('@/hooks/useChatSession');
    page.visibilityState = 'hidden';

    await getBagPass(ALICE, phoneWallet(), undefined).catch(() => { /* отказ — штатный исход */ });

    expect(walletPrompts, 'подпись ушла в спящую страницу — там её никто не увидит').toBe(0);
    expect(passCalls, 'запрос пропуска без подписи всё равно ушёл').toBe(0);
  });
});

describe('ЗАМЕР 2: вторая подпись сразу за первой', () => {
  it('после первой подписи вторая САМА не уходит — на телефоне', async () => {
    // Требование 2 задания. Первая подпись увела страницу в кошелёк и вернула;
    // страница снова видима, но мы ЗНАЕМ, что только что уходили к кошельку, —
    // значит вторую подпись обязан запустить человек, а не мы.
    const { signChatKeyLocked, getBagPass } = await import('@/hooks/useChatSession');

    // Первая подпись — настоящая функция, настоящий путь.
    await signChatKeyLocked(ALICE, async () => {
      walletPrompts++;
      page.goAway();
      page.comeBack();
      return sig('a');
    });
    expect(walletPrompts, 'первая подпись не состоялась — замер ниже потерял смысл').toBe(1);

    // Вторая — та, что сегодня уходит автоматически.
    await getBagPass(ALICE, phoneWallet(), undefined).catch(() => { /* отказ — штатный исход */ });

    expect(walletPrompts, 'вторая подпись ушла сама, сразу за первой').toBe(1);
    expect(passCalls, 'пропуск взят без участия человека').toBe(0);
  });

  it('нажатие человека доводит дело до конца — пропуск получен', async () => {
    // Требование 3 задания: «Нажатие кнопки доводит дело до конца». Здесь —
    // половина про подпись; вторая половина (запись в справочнике) — в
    // `chatAnnounceKey.test.ts`.
    const { signChatKeyLocked, getBagPass } = await import('@/hooks/useChatSession');
    await signChatKeyLocked(ALICE, async () => {
      walletPrompts++; page.goAway(); page.comeBack(); return sig('a');
    });

    // Приведение типа: замок обязан мерить ПОВЕДЕНИЕ и после того, как форма
    // параметра поменяется. Без прямой просьбы человека это тот же вызов, что
    // выше, и он обязан дать ноль.
    const asked = getBagPass as unknown as (
      address: string,
      signMessageAsync: (a: { message: string }) => Promise<string>,
      onSigning?: (b: boolean) => void,
      opts?: { humanAsked?: boolean },
    ) => Promise<string>;

    const pass = await asked(ALICE, phoneWallet(), undefined, { humanAsked: true });

    expect(walletPrompts, 'нажатие не довело до кошелька').toBe(2);
    expect(passCalls).toBe(1);
    expect(pass).toBe('v1.by-wallet.mac');
  });
});

describe('ЗАМЕР 3: десктоп не стал длиннее', () => {
  it('кошелёк-расширение — обе подписи подряд, БЕЗ нажатий', async () => {
    // Требование 6 задания: «число нажатий и подписей на десктопе не выросло».
    // Отличие от телефона — ровно одно: страница не пропадала из глаз.
    const { signChatKeyLocked, getBagPass } = await import('@/hooks/useChatSession');

    await signChatKeyLocked(ALICE, async () => { walletPrompts++; return sig('a'); });
    const pass = await getBagPass(ALICE, desktopWallet(), undefined);

    expect(walletPrompts, 'на десктопе подписей стало не две').toBe(2);
    expect(passCalls, 'на десктопе пропуск больше не берётся сам').toBe(1);
    expect(pass).toBe('v1.by-wallet.mac');
  });

  it('живой пропуск — ни окна, ни запроса, даже после ухода к кошельку', async () => {
    // Отсечка обязана стоять вокруг ОКНА КОШЕЛЬКА, а не вокруг пропуска. Иначе
    // она отняла бы работу у того, у кого пропуск уже есть, — то есть у всех на
    // повторных заходах в течение 12 часов.
    const { getBagPass } = await import('@/hooks/useChatSession');
    await getBagPass(ALICE, desktopWallet(), undefined);
    expect(passCalls).toBe(1);

    page.goAway();
    page.comeBack();
    const again = await getBagPass(ALICE, phoneWallet(), undefined);

    expect(walletPrompts, 'живой пропуск потребовал подписи').toBe(1);
    expect(passCalls, 'живой пропуск потребовал запроса').toBe(1);
    expect(again).toBe('v1.by-wallet.mac');
  });
});

describe('подпись типизированных данных — тот же порог', () => {
  it('ключ переписки в спящей странице не выводится', async () => {
    // Первая подпись тоже обязана слушаться требования 1: приложение может
    // оказаться свёрнутым в момент, когда хук взводится (вкладка ожила в фоне,
    // человек ушёл, пока крутился спиннер).
    const { signChatKeyLocked } = await import('@/hooks/useChatSession');
    page.visibilityState = 'hidden';

    await signChatKeyLocked(ALICE, async () => {
      walletPrompts++;
      return sig('a');
    }).catch(() => { /* отказ — штатный исход */ });

    expect(walletPrompts, 'подпись ключа ушла в спящую страницу').toBe(0);
  });

  it('подписанные данные — по-прежнему те самые, без пересборки', async () => {
    const { signChatKeyLocked } = await import('@/hooks/useChatSession');
    let seen: unknown = null;
    await signChatKeyLocked(ALICE, async (td) => { seen = td; return sig('a'); });
    expect(seen).toBe(CHAT_KEY_TYPED_DATA);
  });
});
