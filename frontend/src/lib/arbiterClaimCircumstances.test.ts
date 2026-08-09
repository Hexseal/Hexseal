import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compareChainWithDirectory, ZERO_KEY } from './arbiterChatKey';
import { acquireWalletLock, _resetWalletLockForTest } from './walletLock';
import type { Hex } from 'viem';

/**
 * Пять вопросов про обстоятельства взятия спора. Правило проекта: принимается
 * только с замером, не с рассуждением (docs/PROCESS.md).
 *
 * Пятый вопрос проекта — «кончилось место» — у фронта своего вида: это отказ
 * записи в localStorage (приватный режим, переполнение квоты). Соль тогда не
 * сохранится, и возврат к незаконченной заявке не сработает — но само взятие
 * спора рушиться НЕ должно. Замер 5 это и проверяет.
 */

const KEY_A = ('0x' + 'aa'.repeat(32)) as Hex;
const KEY_B = ('0x' + 'bb'.repeat(32)) as Hex;
const SIG_A = ('0x' + '11'.repeat(32)) as Hex;

function bytes(hex: Hex): Uint8Array {
  return new Uint8Array(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
}

/** Подставное хранилище: считает записи и умеет отказывать, как приватный режим. */
function makeStorage(opts: { failWrites?: boolean } = {}) {
  const data = new Map<string, string>();
  let writeAttempts = 0;
  return {
    writes: () => writeAttempts,
    size: () => data.size,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writeAttempts++;
      if (opts.failWrites) throw new DOMException('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
  };
}

/**
 * Модель пути взятия спора: ровно те шаги, что в handleClaim, с подставными
 * обращениями. Считаем ОКНА КОШЕЛЬКА и ТРАНЗАКЦИИ — это и есть числа, которыми
 * отвечаем на пять вопросов.
 */
function makeClaimRunner(store: ReturnType<typeof makeStorage>, opts: {
  keyOnDevice?: boolean;
  refuseKeySignature?: boolean;
} = {}) {
  const counters = { walletWindows: 0, commits: 0, claims: 0, keyDerivations: 0 };
  let deviceHasKey = !!opts.keyOnDevice;
  let locked = false;

  async function run(agreement: string) {
    // Лок кошелька: два одновременных вызова обязаны выстроиться, а не открыть
    // два окна. Здесь он моделируется честно — отказом на занятом.
    if (locked) throw new Error('wallet busy');
    locked = true;
    try {
      // ⚠️ НАХОДКА ПРИ ПРОВЕРКЕ (не было в брифе дословно): без единой точки
      // `await` внутри `try` тело `run()` — от проверки `locked` до сброса
      // в `finally` — исполняется атомарно между элементами литерала массива.
      // `Promise.allSettled([r.run(...), r.run(...)])` тогда НЕ гоняет два
      // вызова конкурентно: первый успевает полностью отработать и сбросить
      // `locked = false` ДО того, как JS вообще начнёт вычислять второй
      // элемент массива — замер (см. отчёт задачи 6) даёт 0 отклонённых из 2
      // и 4 окна вместо 2, то есть «замок» ничего не запирает НИ РАЗУМ.
      // Настоящий `acquireWalletLock` (walletLock.ts) этой болезни не имеет:
      // у него есть реальные await'ы (Web Locks API, ожидание кошелька).
      // Эта строка — минимальная честная правка: представляет реальный
      // асинхронный уход к кошельку (сеть/подпись занимают время), без
      // которого сам факт гонки в модели непроверяем. Замок ниже (`if
      // (locked) throw`) и `locked = true` выше НЕ ТРОНУТЫ — их семантика
      // ровно та, что была в брифе.
      await Promise.resolve();
      const key = `hexseal-arb-salt-${agreement.toLowerCase()}`;
      let salt = store.getItem(key);

      if (!salt) {
        salt = '0x' + 'cc'.repeat(32);
        try { store.setItem(key, salt); } catch { /* возврат просто не сработает */ }
        counters.walletWindows++; counters.commits++;      // подпись коммита
      }

      if (!deviceHasKey) {
        counters.walletWindows++; counters.keyDerivations++; // подпись ключа
        if (opts.refuseKeySignature) throw new Error('user rejected');
        deviceHasKey = true;
      }

      counters.walletWindows++; counters.claims++;          // подпись заявки
      store.removeItem(key);
    } finally { locked = false; }
  }

  return { run, counters, deviceHasKey: () => deviceHasKey };
}

describe('обстоятельства взятия спора — ответ числом', () => {
  it('1. бросил на середине: отказ от подписи ключа не съедает ход', async () => {
    const store = makeStorage();
    const r = makeClaimRunner(store, { refuseKeySignature: true });
    await expect(r.run('0xA9')).rejects.toThrow();

    // Соль ЦЕЛА — значит повторная попытка пойдёт в заявку, а не в новый коммит.
    expect(store.getItem('hexseal-arb-salt-0xa9')).not.toBeNull();
    expect(r.counters.commits).toBe(1);
    expect(r.counters.claims).toBe(0);
  });

  it('2. перезапустили посреди: возврат идёт в заявку, второго коммита нет', async () => {
    const store = makeStorage();
    const first = makeClaimRunner(store, { refuseKeySignature: true });
    await expect(first.run('0xA9')).rejects.toThrow();

    // Новая вкладка: соль на диске есть, ключа на устройстве нет.
    const second = makeClaimRunner(store, {});
    await second.run('0xA9');

    expect(second.counters.commits).toBe(0);   // <<< главное число
    expect(second.counters.claims).toBe(1);
    expect(store.getItem('hexseal-arb-salt-0xa9')).toBeNull();
  });

  it('3. два процесса разом: лок не даёт открыть два окна', async () => {
    const store = makeStorage();
    const r = makeClaimRunner(store, { keyOnDevice: true });
    const results = await Promise.allSettled([r.run('0xA9'), r.run('0xA9')]);

    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    // Окон ровно два (коммит + заявка) у прошедшего, а не четыре.
    expect(r.counters.walletWindows).toBe(2);
  });

  it('4. пришёл мусор: вердикт, не падение', () => {
    // Цепь отдала нули.
    expect(() =>
      compareChainWithDirectory({ boxKey: ZERO_KEY, signKey: ZERO_KEY }, null),
    ).not.toThrow();
    expect(compareChainWithDirectory({ boxKey: ZERO_KEY, signKey: ZERO_KEY }, null))
      .toBe('chain_missing');

    // Справочник назвал другой ключ.
    const verdict = compareChainWithDirectory(
      { boxKey: KEY_A, signKey: SIG_A },
      { boxKey: bytes(KEY_B), signKey: bytes(SIG_A) },
    );
    expect(verdict).toBe('directory_differs');
  });

  it('5. долбят нарочно: сто нажатий не дают ста окон', async () => {
    const store = makeStorage();
    const r = makeClaimRunner(store, { keyOnDevice: true });
    const all = await Promise.allSettled(
      Array.from({ length: 100 }, () => r.run('0xA9')),
    );
    const passed = all.filter((x) => x.status === 'fulfilled').length;

    expect(passed).toBe(1);                     // прошёл ровно один
    expect(r.counters.walletWindows).toBe(2);   // <<< не 200 и не 100
  });

  it('5-бис. отказ записи в хранилище не рушит взятие спора', async () => {
    // Приватный режим/переполнение: соль не сохранится, возврат не сработает —
    // но заявка обязана пройти. В коде это уже обёрнуто в try/catch с
    // комментарием «resume just won't work»; замер это подтверждает.
    const store = makeStorage({ failWrites: true });
    const r = makeClaimRunner(store, { keyOnDevice: true });
    await r.run('0xA9');

    expect(r.counters.claims).toBe(1);   // заявка прошла
    expect(store.size()).toBe(0);        // а соль действительно не сохранилась
    expect(store.writes()).toBe(1);      // попытка была, отказ проглочен
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * ДОПОЛНИТЕЛЬНО: то же самое, но против НАСТОЯЩЕГО `lib/walletLock.ts`, а не
 * модели `makeClaimRunner`.
 *
 * Требование задачи: там, где замер можно сделать против настоящей функции —
 * делать против настоящей. Сверка модели с `handleClaim` (arbiter/page.tsx)
 * построчно показала, что для вопросов 3 и 5 модель заметно расходится с
 * настоящим устройством:
 *
 *  - `handleClaim` НЕ держит один лок на весь путь (коммит → вывод ключа →
 *    заявка). Он берёт `acquireWalletLock(address)` ДВАЖДЫ по отдельности —
 *    внутри `commitDisputeClaimGasless` и внутри `claimDisputeGasless`
 *    (`lib/relay.ts`), каждый раз освобождая между вызовами. Шаг вывода ключа
 *    (`deriveClaimChatKeys` → `openSession`) этим локом вообще не защищён —
 *    у него свой отдельный замок (`withCrossTabLock` по ключу сессии чата,
 *    `chatSession.ts`), и то только когда ключа на устройстве ещё нет.
 *
 *  - Настоящий `acquireWalletLock` — это ОЧЕРЕДЬ (FIFO, с потолком 3 минуты),
 *    а не отказ. Второй вызов не бросает 'wallet busy' — он ЖДЁТ и потом всё
 *    равно едет. Модель шага 3/5 (`if (locked) throw`) — это не то, что
 *    делает настоящий код; это упрощение ради самого дешёвого замера.
 *
 * Ниже — измерения на настоящей `acquireWalletLock`, без модели.
 */
describe('дополнительно: против настоящего lib/walletLock.ts, не модели', () => {
  const ADDR = '0x' + '42'.repeat(20);

  beforeEach(() => { _resetWalletLockForTest(); });

  it('3-бис. настоящий лок не пересекает окна, но и не отвергает второго — очередь, не отказ', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    async function window() {
      const release = await acquireWalletLock(ADDR);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 0));
      concurrent--;
      release();
    }

    const results = await Promise.allSettled([window(), window()]);

    // Настоящее число: окна не пересеклись.
    expect(maxConcurrent).toBe(1);
    // И настоящее число, расходящееся с моделью шага 3: НИКТО не отвергнут —
    // оба прошли, второй просто подождал в очереди.
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(0);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
  });

  it('3-тер. шаг вывода ключа между коммитом и заявкой НЕ под общим локом — чужое окно может влезть', async () => {
    // Воспроизводит настоящую форму handleClaim: acquireWalletLock берётся
    // отдельно для коммита, отдельно для заявки, а между ними — незапертый
    // промежуток (в реальности это `deriveClaimChatKeys`). Если в реальности
    // это дыра, то второй, независимый вызов лока должен суметь проехать
    // ИМЕННО в этот промежуток — не после заявки, а внутри него.
    let keyDerivationWindowOpen = false;
    let sawOverlap = false;

    async function ourClaimFlow() {
      const releaseCommit = await acquireWalletLock(ADDR);
      releaseCommit(); // коммит замайнен, лок отпущен — как в relay.ts

      keyDerivationWindowOpen = true;           // <-- незащищённый промежуток
      await new Promise((r) => setTimeout(r, 10));
      keyDerivationWindowOpen = false;

      const releaseClaim = await acquireWalletLock(ADDR);
      releaseClaim();
    }

    async function otherTabCommit() {
      await new Promise((r) => setTimeout(r, 3)); // догнать в момент вывода ключа
      const release = await acquireWalletLock(ADDR);
      if (keyDerivationWindowOpen) sawOverlap = true;
      release();
    }

    await Promise.all([ourClaimFlow(), otherTabCommit()]);

    // Настоящее число: чужой коммит проехал, пока наш вывод ключа шёл —
    // потому что настоящий лок этот промежуток не накрывает.
    expect(sawOverlap).toBe(true);
  });

  it('5-бис-настоящий. сто настоящих запросов лока: окна не пересекаются, но и не ограничены двумя', async () => {
    // Отвечает на «долбят нарочно» против настоящего lib/walletLock.ts, а не
    // модели. Модель шага 5 (`makeClaimRunner`) утверждает «окон ровно два»
    // ДЛЯ ВСЕГО ПОТОКА — но это верно только потому, что второй и далее вызов
    // ОТВЕРГАЕТСЯ моделью же ('wallet busy'). Настоящий `acquireWalletLock` не
    // отвергает — он ставит в очередь. Значит настоящая защита от «100
    // нажатий → 100 окон» живёт НЕ здесь: это `disabled={!!busy}` на кнопке
    // страницы арбитра (arbiter/page.tsx), которую этот файл проверить не
    // может — там нет окружения рендера ни для одной страницы (см. отчёт).
    let concurrent = 0;
    let maxConcurrent = 0;
    async function window() {
      const release = await acquireWalletLock(ADDR);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 0));
      concurrent--;
      release();
    }

    const results = await Promise.allSettled(Array.from({ length: 100 }, () => window()));
    const fulfilled = results.filter((x) => x.status === 'fulfilled').length;

    // Настоящие числа: окна никогда не пересекались (это лок действительно
    // даёт) — но ни один из ста вызовов не был отвергнут (это уже НЕ даёт).
    expect(maxConcurrent).toBe(1);
    expect(fulfilled).toBe(100);   // <<< расходится с моделью (там — 1)
  });
});
