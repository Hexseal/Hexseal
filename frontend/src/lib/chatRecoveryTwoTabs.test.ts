/**
 * chatRecoveryTwoTabs.test.ts — обстоятельство 3 для показа кода: две
 * вкладки открывают сеанс разом. Сколько окон с кодом и один ли это код?
 *
 * ⚠️ ПОЧЕМУ ОТДЕЛЬНО ОТ `chatSession.test.ts`. Там замерено, что две вкладки
 * дают ОДНО окно подписи и один и тот же закрытый ключ. Про КОД там не
 * сказано ничего, а вопрос не тот же самый: показывает окно не тот, у кого
 * ключ, а тот, у кого `restored === false`. Между «ключ один» и «окно одно»
 * лежит целый признак, и он мог бы врать.
 *
 * Подделка `IndexedDB` здесь нарочно МИНИМАЛЬНАЯ: она моделирует общий диск
 * двух вкладок и атомарную запись, и больше ничего. Все отказы хранилища
 * (квота, блокировка, молчание) замерены в `chatSession.test.ts` своим,
 * куда более придирчивым стендом — задваивать его тут значило бы получить
 * две подделки, расходящиеся со временем.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAT_KEY_TYPED_DATA } from './chatCrypto';

const ACCOUNT = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const ADDRESS = ACCOUNT.address;

/** Подпись кошелька-КОНТРАКТА: длиннее 65 байт, значит род `contract` и
 *  ветка кода восстановления (три ступени — `establishIdentity`). */
const CONTRACT_SIG = `0x${'ab'.repeat(96)}` as `0x${string}`;
/** Обычная подпись — настоящая, над той же структурой: только такая
 *  восстанавливается в свой же адрес и даёт род `eoa`. */
const EOA_SIG = await ACCOUNT.signTypedData(CHAT_KEY_TYPED_DATA as never);

/* ── Общий диск двух вкладок: минимальная подделка IndexedDB ───────────── */

function installSharedDisk() {
  const disk = new Map<string, unknown>();
  type Cb = ((ev: unknown) => void) | null;

  class Req { onsuccess: Cb = null; onerror: Cb = null; onupgradeneeded: Cb = null; onblocked: Cb = null; result: unknown; }

  const store = (tx: { done: () => void }) => ({
    get(key: string) {
      const r = new Req();
      queueMicrotask(() => { r.result = structuredClone(disk.get(key)); r.onsuccess?.({}); tx.done(); });
      return r;
    },
    put(value: unknown, key: string) {
      const r = new Req();
      queueMicrotask(() => { disk.set(key, structuredClone(value)); r.onsuccess?.({}); tx.done(); });
      return r;
    },
    delete(key: string) {
      const r = new Req();
      queueMicrotask(() => { disk.delete(key); r.onsuccess?.({}); tx.done(); });
      return r;
    },
  });

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    close: () => {},
    transaction() {
      const tx: { oncomplete: Cb; onerror: Cb; onabort: Cb; done: () => void; objectStore: () => unknown } = {
        oncomplete: null, onerror: null, onabort: null,
        done: () => queueMicrotask(() => tx.oncomplete?.({})),
        objectStore: () => store(tx),
      };
      return tx;
    },
  };

  vi.stubGlobal('indexedDB', {
    open() {
      const r = new Req();
      queueMicrotask(() => { r.result = db; r.onsuccess?.({}); });
      return r;
    },
  });
  // ⚠️ ЗАМОК МЕЖДУ ВКЛАДКАМИ НЕ ПОДДЕЛАН. Node 24 отдаёт настоящий
  // `navigator.locks` (Web Locks), и он общий на процесс — то есть ровно то,
  // чем он является для двух вкладок одного источника. Замерено:
  // `typeof globalThis.navigator.locks === 'object'` на node v24.12.0.
  //
  // Первая версия этого стенда замок ПОДДЕЛЫВАЛА и подделала неверно:
  // `request(name, opts, fn)` вместо настоящего `request(name, fn)`. Вызов
  // падал, `withCrossTabLock` ловил отказ и честно ехал БЕЗ замка — стенд
  // намерил два окна подписи там, где их одно. Числа врал стенд, а не код.
  return disk;
}

describe('обстоятельство 3: две вкладки и код восстановления', () => {
  beforeEach(() => { installSharedDisk(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ кошелёк-контракт, две вкладки разом — ОДИН показ и ОДИН код', async () => {
    vi.resetModules();
    const tabOne = await import('./chatSession');
    vi.resetModules();
    const tabTwo = await import('./chatSession');
    expect(tabOne.openSession).not.toBe(tabTwo.openSession); // это правда два экземпляра

    const sign = vi.fn(async () => CONTRACT_SIG);
    const [a, b] = await Promise.all([
      tabOne.openSession(ADDRESS, sign),
      tabTwo.openSession(ADDRESS, sign),
    ]);

    // Одно окно подписи — то есть личность заводилась ровно раз.
    expect(sign).toHaveBeenCalledTimes(1);

    // ⚠️ ГЛАВНОЕ ЧИСЛО. Окно с кодом показывает тот, у кого `restored ===
    // false` (`useChatSession.ts`). Здесь таких РОВНО ОДИН: вторая вкладка
    // перечитала запись под замком и пришла с `restored: true`.
    const shows = [a, b].filter(s => s.origin === 'recovery' && !s.restored);
    expect(shows).toHaveLength(1);

    // И код у обеих вкладок ОДИН И ТОТ ЖЕ — вторая не завела свой.
    const codeA = tabOne.exportRecoveryCode(a);
    const codeB = tabTwo.exportRecoveryCode(b);
    expect(codeB).toBe(codeA);
    expect(codeA.split(' ')).toHaveLength(tabOne.RECOVERY_WORD_COUNT);
  });

  it('обычный кошелёк, две вкладки разом — НОЛЬ показов', async () => {
    vi.resetModules();
    const tabOne = await import('./chatSession');
    vi.resetModules();
    const tabTwo = await import('./chatSession');

    const sign = vi.fn(async () => EOA_SIG);
    const [a, b] = await Promise.all([
      tabOne.openSession(ADDRESS, sign),
      tabTwo.openSession(ADDRESS, sign),
    ]);

    expect([a, b].filter(s => s.origin === 'recovery' && !s.restored)).toHaveLength(0);
    for (const s of [a, b]) expect(s.walletKind).toBe('eoa');
  });

  it('перезагрузка вкладки после показа — код ТОТ ЖЕ и второго окна нет', async () => {
    // Обстоятельство 1: закрыл вкладку, не записав. Запись на диске цела,
    // значит код достижим — но САМ СОБОЙ он больше не показывается.
    vi.resetModules();
    const first = await import('./chatSession');
    const opened = await first.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = first.exportRecoveryCode(opened);
    expect(opened.restored).toBe(false); // первый раз — показ

    vi.resetModules();
    const reloaded = await import('./chatSession');
    const again = await reloaded.openSession(ADDRESS, async () => CONTRACT_SIG);
    expect(again.restored).toBe(true);   // второй раз — показа нет
    // Но код на месте: пункт меню кошелька его достанет.
    expect(reloaded.exportRecoveryCode(again)).toBe(code);
  });
});
