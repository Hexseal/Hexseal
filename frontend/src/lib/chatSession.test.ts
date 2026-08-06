import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { CHAT_KEY_TYPED_DATA } from './chatCrypto';
import {
  openSession,
  openSessionFromRecoveryCode,
  exportRecoveryCode,
  forgetSession,
  ChatSessionError,
  SESSION_LOCK_TIMEOUT_MS,
  RECOVERY_WORD_COUNT,
  RECORD_VERSION,
  STORAGE_OPEN_TIMEOUT_MS,
} from './chatSession';

// ─── Заготовки берут данные в том виде, в каком они приходят из жизни ──────
//
// Адреса — С КОНТРОЛЬНОЙ СУММОЙ (заглавные буквы внутри), ровно как отдаёт
// `useAccount()` из wagmi. Правило куплено находкой, где 650 зелёных тестов
// означали полностью нерабочий вход: адрес в заготовке был строчными, а
// кошелёк отдаёт смешанным регистром. Здесь это не украшение — хранилище
// ключуется приведённым адресом, и тест «тот же адрес в другом регистре —
// тот же сеанс» ниже держит именно этот класс.
const ALICE = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as const;
const BOB   = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as const;

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex-цифр (65 байт r‖s‖v).
 *  `deriveChatKeypair` проверяет форму на исполнении и бросает на всём
 *  остальном — подпись-заглушка вроде '0xdeadbeef' не доехала бы никуда. */
function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

const ALICE_SIG = signatureOf('1c3d');
const BOB_SIG   = signatureOf('7f2e');

/** Золотой вектор BIP-39 (энтропия 0x7f×16) — детерминированный, чтобы
 *  проверки негодного кода не зависели от случайности. */
const GOLD = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist);

// ─── Поддельный IndexedDB ─────────────────────────────────────────────────
//
// Среда тестов — node, настоящего IndexedDB здесь нет. Подделка нарочно
// моделирует ТРИ вещи, ради которых модуль вообще выбрал IndexedDB, а не
// localStorage, и на которых стоят ответы на вопросы про обстоятельства:
//
//  1. Транзакция атомарна: записи КОПЯТСЯ и применяются одним куском на
//     `oncomplete`. Откат (`abort`) не оставляет половины записи — именно это
//     проверяет тест «вкладку закрыли между подписью и записью».
//  2. Значение проходит через `structuredClone` — как настоящее хранилище;
//     объект, изменённый после `put`, не меняет уже сохранённое.
//  3. Отказ можно вызвать нарочно (квота, сбой чтения) — и он приходит по
//     тому же пути событий, что настоящий: `request.onerror` плюс откат
//     транзакции.
//
// Никакого «успех по умолчанию»: каждый отказ включается явным флагом.

interface FakeControl {
  failOpen?: boolean;
  /** Открытие упирается в соседнюю вкладку, держащую прежнюю версию базы:
   *  браузер шлёт `blocked` и БОЛЬШЕ НИЧЕГО. Сегодня недостижимо (версия
   *  одна), но первое же её повышение делает это обычным делом. */
  blockOpen?: boolean;
  /** Открытие молчит вовсе — ни успеха, ни ошибки, ни блокировки. */
  hangOpen?: boolean;
  failPut?: boolean;
  failGet?: boolean;
  failDelete?: boolean;
}

type Handler = ((ev: unknown) => void) | null;

class FakeRequest {
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  result: unknown = undefined;
  error: unknown = null;
}

function quotaError(): Error {
  const err = new Error('The quota has been exceeded.');
  err.name = 'QuotaExceededError';
  return err;
}

function makeFakeIndexedDB(control: FakeControl = {}) {
  /** Сколько раз хранилище реально трогали. Без счётчика утверждение «одно
   *  ожидание, а не два» непроверяемо: снаружи оба случая выглядят как
   *  «сеанс в итоге получен». */
  const stats = { opens: 0, gets: 0, puts: 0 };
  /** Каталог «устройства»: имя хранилища → ключ → значение. Живёт в подделке,
   *  а не в объекте базы: перезагрузка вкладки открывает базу заново и обязана
   *  видеть то же самое, а «другое устройство» — это НОВАЯ подделка. */
  const disk = new Map<string, Map<string, unknown>>();
  let dbVersion = 0;

  class FakeTransaction {
    oncomplete: Handler = null;
    onerror: Handler = null;
    onabort: Handler = null;
    private pending = 0;
    private settled = false;
    private staged: Array<() => void> = [];

    objectStore(name: string) {
      return new FakeObjectStore(name, this);
    }

    run(op: () => unknown, forcedError?: Error): FakeRequest {
      const req = new FakeRequest();
      this.pending += 1;
      setTimeout(() => {
        if (this.settled) return;
        this.pending -= 1;
        if (forcedError) {
          req.error = forcedError;
          req.onerror?.({ target: req });
          this.abortWith(forcedError);
          return;
        }
        try {
          req.result = op();
        } catch (err) {
          req.error = err;
          req.onerror?.({ target: req });
          this.abortWith(err as Error);
          return;
        }
        req.onsuccess?.({ target: req });
        this.maybeComplete();
      }, 0);
      return req;
    }

    stage(apply: () => void): void {
      this.staged.push(apply);
    }

    private maybeComplete(): void {
      if (this.settled || this.pending > 0) return;
      setTimeout(() => {
        if (this.settled || this.pending > 0) return;
        this.settled = true;
        for (const apply of this.staged) apply(); // фиксация — всё сразу
        this.oncomplete?.({ target: this });
      }, 0);
    }

    private abortWith(err: Error): void {
      if (this.settled) return;
      this.settled = true;
      this.staged.length = 0; // откат: ничего из этой транзакции не осело
      this.onerror?.({ target: { error: err } });
      this.onabort?.({ target: { error: err } });
    }

    abort(): void {
      this.abortWith(new Error('AbortError'));
    }
  }

  class FakeObjectStore {
    constructor(private name: string, private tx: FakeTransaction) {}

    get(key: string): FakeRequest {
      stats.gets += 1;
      return this.tx.run(
        () => {
          // Настоящее хранилище отдаёт СВЕЖУЮ копию на каждое чтение —
          // подделка обязана делать так же, иначе вызывающий, изменивший
          // прочитанное, незаметно правил бы «диск» (мелочь ревью).
          const found = disk.get(this.name)?.get(key);
          return found === undefined ? undefined : structuredClone(found);
        },
        control.failGet ? new Error('read failed') : undefined,
      );
    }

    put(value: unknown, key: string): FakeRequest {
      stats.puts += 1;
      const cloned = structuredClone(value);
      return this.tx.run(
        () => {
          this.tx.stage(() => {
            let store = disk.get(this.name);
            if (!store) { store = new Map(); disk.set(this.name, store); }
            store.set(key, cloned);
          });
          return key;
        },
        control.failPut ? quotaError() : undefined,
      );
    }

    delete(key: string): FakeRequest {
      return this.tx.run(
        () => {
          this.tx.stage(() => { disk.get(this.name)?.delete(key); });
          return undefined;
        },
        control.failDelete ? new Error('delete failed') : undefined,
      );
    }
  }

  class FakeDatabase {
    objectStoreNames = { contains: (name: string) => disk.has(name) };
    createObjectStore(name: string) {
      if (!disk.has(name)) disk.set(name, new Map());
      return {};
    }
    transaction(_names: string[] | string, _mode?: string) {
      return new FakeTransaction();
    }
    close() {}
  }

  return {
    /** Прямой осмотр «диска» — тесты смотрят, что реально осело, а не верят
     *  возвращённому значению. */
    _disk: disk,
    _stats: stats,
    open(_name: string, version: number): FakeRequest {
      stats.opens += 1;
      const req = new FakeRequest();
      setTimeout(() => {
        if (control.hangOpen) return; // тишина: ни одного события
        if (control.blockOpen) {
          req.onblocked?.({ target: req });
          return;
        }
        if (control.failOpen) {
          req.error = new Error('open failed');
          req.onerror?.({ target: req });
          return;
        }
        const db = new FakeDatabase();
        req.result = db;
        if (dbVersion < version) {
          dbVersion = version;
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
  };
}

// ─── Поддельный localStorage: пишет всё в наблюдаемую карту ───────────────
//
// Не заглушка-пустышка: любая запись видна тесту прямым осмотром. Если бы
// модуль однажды положил ключ сюда, тест это увидел бы, а не поверил бы
// комментарию в коде.
function makeFakeLocalStorage() {
  const map = new Map<string, string>();
  const calls: string[] = [];
  return {
    _map: map,
    _calls: calls,
    getItem: (k: string) => (calls.push(`get:${k}`), map.get(k) ?? null),
    setItem: (k: string, v: string) => { calls.push(`set:${k}`); map.set(k, v); },
    removeItem: (k: string) => { calls.push(`remove:${k}`); map.delete(k); },
    clear: () => { calls.push('clear'); map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

const g = globalThis as {
  indexedDB?: unknown;
  localStorage?: unknown;
};

let fakeIdb: ReturnType<typeof makeFakeIndexedDB>;
let fakeLs: ReturnType<typeof makeFakeLocalStorage>;
let warn: ReturnType<typeof vi.spyOn>;

function installStorage(control: FakeControl = {}) {
  fakeIdb = makeFakeIndexedDB(control);
  g.indexedDB = fakeIdb;
}

beforeEach(() => {
  installStorage();
  fakeLs = makeFakeLocalStorage();
  g.localStorage = fakeLs;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete g.indexedDB;
  delete g.localStorage;
  warn.mockRestore();
  // Безусловно, а не в `finally` внутри теста: тест, упавший по таймауту,
  // до своего `finally` не доходит и оставил бы подменённый `setTimeout`
  // всему остальному файлу — 20 чужих тестов падали бы по времени, пряча
  // настоящую причину. Тот же класс, что «тест, убивающий исполнителя
  // тестов вместо провала».
  vi.unstubAllGlobals();
});

/** Подпись КОШЕЛЬКА-КОНТРАКТА: переменной длины, проверяется контрактом
 *  (ERC-1271, у счётных — обёрнутая по ERC-6492). Род кошелька определяется
 *  ИМЕННО ЭТИМ — длиной подписи, а не кодом на цепи: код отвечал неверно и
 *  на делегированных (код есть, подпись обычная), и на счётных (кода нет,
 *  подпись необычная). */
const ALICE_CONTRACT_SIG = `0x${'ab'.repeat(220)}` as `0x${string}`;
const BOB_CONTRACT_SIG = `0x${'cd'.repeat(180)}` as `0x${string}`;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ═══ 1. Второй заход не просит подпись ═════════════════════════════════════

describe('сеанс чата: ключ живёт на устройстве', () => {
  it('два открытия подряд — РОВНО ОДИН вызов signTypedData', async () => {
    const sign = vi.fn(async () => ALICE_SIG);

    const first = await openSession(ALICE, sign);
    const second = await openSession(ALICE, sign);

    // Замер, а не рассуждение: единица — весь смысл этого теста.
    expect(sign).toHaveBeenCalledTimes(1);
    expect(hex(second.keypair.privateKey)).toBe(hex(first.keypair.privateKey));
    expect(hex(second.keypair.publicKey)).toBe(hex(first.keypair.publicKey));
    expect(first.restored).toBe(false);
    expect(second.restored).toBe(true);
  });

  it('подписывать дают РОВНО CHAT_KEY_TYPED_DATA, не пересобранную копию', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign);

    // Сравнение по ссылке: пересобранная структура с тем же содержимым не
    // пройдёт. Единственный источник истины о том, что подписывается, —
    // объект из chatCrypto.ts, а не строка, собранная вызывающим.
    expect(sign.mock.calls[0][0]).toBe(CHAT_KEY_TYPED_DATA);
  });

  it('десять открытий подряд — всё ещё одна подпись', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    for (let i = 0; i < 10; i += 1) await openSession(ALICE, sign);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

// ═══ 2. Тот же адрес и та же подпись дают тот же ключ ══════════════════════

describe('восстановление обычного кошелька — это сам кошелёк', () => {
  it('другое устройство, та же подпись — тот же ключ', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const onPhone = await openSession(ALICE, sign);

    // «Другое устройство» = чистое хранилище. Ключ обязан совпасть, потому
    // что он выводится из подписи, а не из того, что лежало на диске.
    installStorage();
    const onLaptop = await openSession(ALICE, sign);

    expect(hex(onLaptop.keypair.privateKey)).toBe(hex(onPhone.keypair.privateKey));
    expect(sign).toHaveBeenCalledTimes(2); // по разу на устройство
    expect(onLaptop.origin).toBe('signature');
  });

  it('другая подпись — другой ключ', async () => {
    const a = await openSession(ALICE, async () => ALICE_SIG);
    installStorage();
    const b = await openSession(ALICE, async () => BOB_SIG);
    expect(hex(b.keypair.privateKey)).not.toBe(hex(a.keypair.privateKey));
  });

  it('умный аккаунт EIP-7702 — обычный кошелёк: подпись у него обычная (К-1)', async () => {
    // Делегированный адрес подписывает СВОИМ ключом: подпись 65 байт и
    // стабильна. Прежде для этого нужна была отдельная проверка указателя
    // 0xef0100 в байткоде; с признаком по подписи род определяется тем же
    // путём, что у всех, и подпорка не нужна.
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign);

    expect(session.origin).toBe('signature');
    expect(session.walletKind).toBe('eoa');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
  });

  it('включил делегацию, снял делегацию — ключ НЕ меняется (К-1)', async () => {
    // Подпись у делегированного и у обычного одна и та же, значит и ключ.
    const withDelegation = await openSession(ALICE, async () => ALICE_SIG);
    installStorage(); // новое устройство, делегация снята
    const without = await openSession(ALICE, async () => ALICE_SIG);
    expect(hex(without.keypair.privateKey)).toBe(hex(withDelegation.keypair.privateKey));
  });
});

// ═══ Признак рода кошелька — САМА ПОДПИСЬ, а не код на цепи ══════════════

describe('род кошелька выясняется подписью', () => {
  /** Счётный смарт-кошелёк (Coinbase Smart Wallet до первой транзакции):
   *  КОДА НА ЦЕПИ НЕТ, а подпись переменной длины — ERC-6492 обёртка.
   *  Прежний признак звал его обычным, и человек упирался в два
   *  противоречащих отказа: «нужен код восстановления» и «код не положен».
   *  Дороги в чат не было ни одной. */
  const counterfactualSignature = `0x${'ab'.repeat(220)}` as `0x${string}`;

  it('счётный смарт-кошелёк (кода на цепи нет, подпись длинная) получает код', async () => {
    const sign = vi.fn(async () => counterfactualSignature);
    const session = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.walletKind).toBe('contract');
    expect(session.origin).toBe('recovery');
    expect(exportRecoveryCode(session).split(' ')).toHaveLength(RECOVERY_WORD_COUNT);
  });

  it('обычная 65-байтовая подпись — обычный кошелёк, ключ выводится', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.walletKind).toBe('eoa');
    expect(session.origin).toBe('signature');
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
  });

  it('делегированный EIP-7702 лечится сам: подпись обычная — кошелёк обычный', async () => {
    // Раньше для этого нужна была отдельная проверка указателя 0xef0100.
    // С признаком по подписи род определяется тем же путём, что у всех.
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.walletKind).toBe('eoa');
  });

  it('сжатая подпись 64 байта НЕ даёт молча другой ключ — уходит в контрактную ветку', async () => {
    // Замер по ядру: deriveChatKeypair такую подпись ОТВЕРГАЕТ (TypeError),
    // молча другого ключа не выводит. Значит худшее, что бывает, — человек
    // получает код восстановления вместо выводимого ключа: чат работает,
    // тихой подмены личности нет.
    const compact = `0x${'1c3d'.repeat(130).slice(0, 128)}` as `0x${string}`;
    expect((compact.length - 2) / 2).toBe(64);

    const session = await openSession(ALICE, async () => compact);
    expect(session.walletKind).toBe('contract');
    expect(hex(session.keypair.publicKey))
      .not.toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
    expect(exportRecoveryCode(session).split(' ')).toHaveLength(RECOVERY_WORD_COUNT);
  });

  it('сети не касаемся вовсе: цепь не спрашивается ни разу', async () => {
    // Шпион подаётся приведением: `getBytecode` в типе OpenSessionOptions
    // больше НЕТ вовсе — сети модулю взять негде. Проверка на исполнении:
    // даже подсунутый насильно, он не зовётся ни разу.
    const bytecode = vi.fn(async () => undefined);
    const smuggled = { getBytecode: bytecode } as unknown as Parameters<typeof openSession>[2];
    await openSession(ALICE, async () => ALICE_SIG, smuggled);
    await openSession(ALICE, async () => ALICE_SIG, smuggled);
    expect(bytecode).toHaveBeenCalledTimes(0);
  });

  it('подписать не удалось — отказ, и ничего не записано', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    let thrown: unknown;
    try {
      await openSession(ALICE, async () => { throw rejection; });
    } catch (err) { thrown = err; }
    expect(thrown).toBe(rejection);
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('подпись — не строка: вердикт с кодом, а не падение', async () => {
    await expect(
      openSession(ALICE, async () => undefined as unknown as `0x${string}`),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('род, выясненный подписью, ложится в запись и переживает перезаход', async () => {
    const first = await openSession(ALICE, async () => counterfactualSignature);
    const sign = vi.fn(async () => counterfactualSignature);
    const second = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(0); // взят с устройства
    expect(second.walletKind).toBe('contract');
    expect(exportRecoveryCode(second)).toBe(exportRecoveryCode(first));
  });
});

// ═══ Золотые векторы: вывод ключа прибит намертво ════════════════════════

describe('золотые векторы вывода ключа', () => {
  /** Все остальные проверки здесь — КРУГОВЫЕ: сгенерировали, восстановили,
   *  сравнили сами с собой. Такая проверка остаётся зелёной при ЛЮБОЙ смене
   *  формулы вывода — а смена формулы означает, что у всех существующих людей
   *  переписка становится нечитаемой молча, без единой ошибки. Векторы ниже
   *  посчитаны один раз и зафиксированы; их изменение — не правка, а
   *  миграция, которую надо объявлять вслух.
   *
   *  Заперты обе дороги: подпись обычного кошелька и код восстановления. */

  it('обычный кошелёк: подпись → ровно этот ключ', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
    expect(hex(session.keypair.privateKey))
      .toBe('2d7ca08f696a30497580d743da64687362744d309f062c65dc02e4229a2514d9');
  });

  it('код восстановления: двенадцать слов → ровно этот ключ', async () => {
    expect(GOLD).toBe('legal winner thank year wave sausage worth useful legal winner thank yellow');
    const session = await openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG);
    expect(hex(session.keypair.publicKey))
      .toBe('377e94d7047bf2f0241998be0c9ab6bae18ac90139edc3f2d2f4bf51f2c53253');
    expect(hex(session.keypair.privateKey))
      .toBe('0a177c57e1eb21a420c0b7e39336ce68335d5395c85e105909ccf17304c72ad0');
  });

  it('ключ из кода и ключ из подписи — РАЗНЫЕ, дороги не пересекаются', async () => {
    const byCode = await openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG);
    installStorage();
    const bySig = await openSession(ALICE, async () => ALICE_SIG);
    expect(hex(byCode.keypair.privateKey)).not.toBe(hex(bySig.keypair.privateKey));
  });
});

// ═══ 4. Негодный код — внятная ошибка с кодом, а не другой ключ ═══════════

describe('негодный код восстановления отказывает внятно', () => {
  /** Каждый случай сверяет `.code`, а не текст и не «просто упало»: к одному
   *  отказу ведёт несколько дорог, и молчаливо ДРУГОЙ ключ здесь читается
   *  человеком как «переписка пропала». */
  async function expectCode(code: string, expected: string) {
    await expect(openSessionFromRecoveryCode(ALICE, code, async () => ALICE_CONTRACT_SIG)).rejects.toMatchObject({
      code: expected,
    });
    await expect(openSessionFromRecoveryCode(ALICE, code, async () => ALICE_CONTRACT_SIG)).rejects.toBeInstanceOf(ChatSessionError);
  }

  it('пустая строка', async () => {
    await expectCode('', 'recovery_code_empty');
    await expectCode('    ', 'recovery_code_empty');
  });

  it('не то число слов: одиннадцать', async () => {
    await expectCode(GOLD.split(' ').slice(0, 11).join(' '), 'recovery_code_word_count');
  });

  it('не то число слов: настоящая 24-словная мнемоника кошелька', async () => {
    const twentyFour = entropyToMnemonic(new Uint8Array(32).fill(0x7f), wordlist);
    expect(twentyFour.split(' ')).toHaveLength(24);
    await expectCode(twentyFour, 'recovery_code_word_count');
  });

  it('опечатка, давшая несуществующее слово', async () => {
    const w = GOLD.split(' ');
    await expectCode([...w.slice(0, 11), 'yellowz'].join(' '), 'recovery_code_unknown_word');
  });

  it('опечатка, давшая ДРУГОЕ существующее слово — ловит контрольная сумма', async () => {
    const w = GOLD.split(' ');
    const spoiled = [...w.slice(0, 11), 'zoo'].join(' ');
    expect(spoiled.split(' ')).toHaveLength(12);
    await expectCode(spoiled, 'recovery_code_checksum');
  });

  it('переставленные слова — тоже контрольная сумма, а не тихо другой ключ', async () => {
    const w = GOLD.split(' ');
    await expectCode([w[1], w[0], ...w.slice(2)].join(' '), 'recovery_code_checksum');
    await expectCode([...w.slice(0, 10), w[11], w[10]].join(' '), 'recovery_code_checksum');
  });

  it('не строка вовсе — TypeError, как в ядре: это НАШ мусор, а не событие', async () => {
    await expect(
      openSessionFromRecoveryCode(ALICE, undefined as unknown as string, async () => ALICE_CONTRACT_SIG),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('ни один отказ НИЧЕГО не записал на устройство', async () => {
    for (const bad of ['', GOLD.split(' ').slice(0, 11).join(' '), GOLD.replace('yellow', 'zoo')]) {
      await openSessionFromRecoveryCode(ALICE, bad, async () => ALICE_CONTRACT_SIG).catch(() => {});
    }
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('лишние пробелы и ДРУГОЙ РЕГИСТР — работают: человек перепечатывает с бумажки', async () => {
    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const code = exportRecoveryCode(session);

    installStorage();
    const messy = `  ${code.toUpperCase().replace(/ /g, '   ')}\n`;
    const restored = await openSessionFromRecoveryCode(ALICE, messy, async () => ALICE_CONTRACT_SIG);

    expect(hex(restored.keypair.privateKey)).toBe(hex(session.keypair.privateKey));
    // и выдаётся обратно в опрятном виде, а не как человек его набрал
    expect(exportRecoveryCode(restored)).toBe(code);
  });
});

// ═══ К-2: код восстановления не затирает уже лежащий сеанс ═══════════════

describe('код восстановления поверх живого сеанса — отказ, а не тихая замена', () => {
  it('чужой код по адресу с сеансом отвергается, ключ и код на месте', async () => {
    const mine = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const myCode = exportRecoveryCode(mine);

    await expect(openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG)).rejects.toMatchObject({
      code: 'session_already_present',
    });

    // ничего не сдвинулось: тот же ключ, тот же код, без окна подписи
    const after = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    expect(hex(after.keypair.privateKey)).toBe(hex(mine.keypair.privateKey));
    expect(exportRecoveryCode(after)).toBe(myCode);
  });

  it('обычный сеанс тоже не затирается кодом', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const mine = await openSession(ALICE, sign);

    await expect(openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG)).rejects.toMatchObject({
      code: 'session_already_present',
    });

    const after = await openSession(ALICE, sign);
    expect(hex(after.keypair.privateKey)).toBe(hex(mine.keypair.privateKey));
    expect(after.origin).toBe('signature');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('снять сеанс можно только явно — через forgetSession', async () => {
    const mine = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    await forgetSession(ALICE);

    const restored = await openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG);
    expect(hex(restored.keypair.privateKey)).not.toBe(hex(mine.keypair.privateKey));
    expect(exportRecoveryCode(restored)).toBe(GOLD);
  });

  it('по СВОБОДНОМУ соседнему адресу код по-прежнему принимается', async () => {
    await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const bob = await openSessionFromRecoveryCode(BOB, GOLD, async () => BOB_CONTRACT_SIG);
    expect(exportRecoveryCode(bob)).toBe(GOLD);
  });
});

// ═══ К-3: обычный кошелёк не может уйти в ветку кода восстановления ══════

describe('род кошелька выясняет сам модуль, а не вызывающий', () => {
  it('обычному кошельку код восстановления не принимается вовсе', async () => {
    const sign = vi.fn(async () => ALICE_SIG);

    await expect(
      openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_SIG),
    ).rejects.toMatchObject({ code: 'recovery_not_applicable' });

    // и на диске по-прежнему пусто — обычный заход даёт ВЫВОДИМЫЙ ключ
    const session = await openSession(ALICE, sign);
    expect(session.origin).toBe('signature');
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
  });

  it('умный аккаунт EIP-7702 — тоже обычный, кода не получает', async () => {
    await expect(
      openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_SIG),
    ).rejects.toMatchObject({ code: 'recovery_not_applicable' });
  });

  it('подписать не удалось — код не принят, ошибка кошелька как есть', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    let thrown: unknown;
    try {
      await openSessionFromRecoveryCode(ALICE, GOLD, async () => { throw rejection; });
    } catch (err) { thrown = err; }
    expect(thrown).toBe(rejection);
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('род кошелька лежит В ЗАПИСИ и сверяется при выдаче кода', async () => {
    // Обход через подмену происхождения на диске: даже если запись говорит
    // origin=recovery, род кошелька в ней говорит правду, и код не выдаётся.
    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    expect(session.walletKind).toBe('contract');

    const store = fakeIdb._disk.get('sessions')!;
    const key = Array.from(store.keys())[0];
    const rec = store.get(key) as Record<string, unknown>;
    store.set(key, { ...rec, walletKind: 'eoa' });

    const tampered = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    expect(tampered.walletKind).toBe('eoa');
    let thrown: unknown;
    try { exportRecoveryCode(tampered); } catch (err) { thrown = err; }
    expect((thrown as ChatSessionError)?.code).toBe('recovery_not_applicable');
  });

  it('запись без walletKind отвергается — тип не должен врать пустотой', async () => {
    // Отличается от годной РОВНО отсутствием поля. Без этого замка запись
    // проходила бы, а `session.walletKind` был бы undefined при типе
    // WalletKind — то самое «заперто на одном пути, открыто на соседнем».
    await openSession(ALICE, async () => ALICE_SIG);
    const store = fakeIdb._disk.get('sessions')!;
    const key = Array.from(store.keys())[0];
    const rec = { ...(store.get(key) as Record<string, unknown>) };
    expect(rec.walletKind).toBe('eoa'); // запись действительно годная
    delete rec.walletKind;
    store.set(key, rec);

    const sign = vi.fn(async () => ALICE_SIG);
    const after = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1); // отвергнута, подписали заново
    expect(after.walletKind).toBe('eoa');
    expect(after.restored).toBe(false);
  });

  it('обычный сеанс несёт walletKind eoa, контрактный — contract', async () => {
    const eoa = await openSession(ALICE, async () => ALICE_SIG);
    const contract = await openSession(BOB, async () => BOB_CONTRACT_SIG);
    expect(eoa.walletKind).toBe('eoa');
    expect(contract.walletKind).toBe('contract');
  });
});

// ═══ В-2: гейт версии записи — собственный замок ═════════════════════════

describe('версия формата записи', () => {
  it('запись, годная ВО ВСЁМ ОСТАЛЬНОМ, но с чужой версией — отвергается', async () => {
    // Прежний тест целился в этот гейт, но клал запись без версии — она
    // отлетала раньше, на проверке происхождения, и сам гейт версии не
    // сторожил никто (снять его давало 0 красных). Здесь запись отличается
    // от годной РОВНО версией.
    const good = await openSession(ALICE, async () => ALICE_SIG);
    const store = fakeIdb._disk.get('sessions')!;
    const key = Array.from(store.keys())[0];
    const rec = store.get(key) as Record<string, unknown>;
    expect(rec.v).toBe(RECORD_VERSION); // запись действительно годная
    store.set(key, { ...rec, v: RECORD_VERSION + 1 });

    const sign = vi.fn(async () => ALICE_SIG);
    const after = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1); // запись отвергнута, подписали заново
    expect(hex(after.keypair.privateKey)).toBe(hex(good.keypair.privateKey));
  });
});

// ═══ 8. exportRecoveryCode отказывает обычному кошельку ═══════════════════

describe('у обычного кошелька кода восстановления нет и не должно быть', () => {
  it('exportRecoveryCode отказывает с кодом, а не отдаёт пустую строку', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.origin).toBe('signature');

    let thrown: unknown;
    try { exportRecoveryCode(session); } catch (err) { thrown = err; }

    expect(thrown).toBeInstanceOf(ChatSessionError);
    expect((thrown as ChatSessionError).code).toBe('recovery_not_applicable');
  });
});

// ═══ 5. forgetSession действительно убирает ══════════════════════════════

describe('forgetSession', () => {
  it('следующий заход снова просит подпись — замер: 2 вызова', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign);
    await forgetSession(ALICE);
    await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(2);
    // и на диске снова ровно одна запись, а не две
    expect(fakeIdb._disk.get('sessions')?.size).toBe(1);
  });

  it('забывает ТОЛЬКО названный адрес — сеанс соседа цел', async () => {
    const signA = vi.fn(async () => ALICE_SIG);
    const signB = vi.fn(async () => BOB_SIG);
    await openSession(ALICE, signA);
    await openSession(BOB, signB);

    await forgetSession(ALICE);

    await openSession(BOB, signB);
    expect(signB).toHaveBeenCalledTimes(1); // сеанс BOB не тронут
  });

  it('не смог удалить — говорит об этом, а не врёт «забыто»', async () => {
    await openSession(ALICE, async () => ALICE_SIG);
    installStorageKeepingDisk({ failDelete: true });

    await expect(forgetSession(ALICE)).rejects.toMatchObject({ code: 'forget_failed' });
  });

  it('хранилища нет вовсе — забывать нечего, молча ок', async () => {
    delete g.indexedDB;
    await expect(forgetSession(ALICE)).resolves.toBeUndefined();
  });
});

/** Пересобирает подделку с новым поведением, СОХРАНЯЯ уже записанное — это
 *  «то же устройство, но диск начал отказывать», а не «другое устройство». */
function installStorageKeepingDisk(control: FakeControl) {
  const old = fakeIdb._disk;
  installStorage(control);
  for (const [name, store] of old) fakeIdb._disk.set(name, store);
}

// ═══ 6. Ключ не попадает в localStorage ═══════════════════════════════════

describe('ключа нет в localStorage — прямой осмотр', () => {
  it('после открытия сеанса localStorage пуст и его не трогали на запись', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);

    expect(fakeLs._map.size).toBe(0);
    expect(fakeLs._calls.filter(c => c.startsWith('set:'))).toHaveLength(0);

    // и ни в одном значении нет байтов ключа — на случай, если запись
    // однажды появится под невинным именем
    const priv = hex(session.keypair.privateKey);
    for (const v of fakeLs._map.values()) expect(v).not.toContain(priv);
  });

  it('и у кошелька-контракта тоже: ни ключа, ни кода восстановления', async () => {
    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const code = exportRecoveryCode(session);

    expect(fakeLs._map.size).toBe(0);
    for (const v of fakeLs._map.values()) expect(v).not.toContain(code);
  });
});

// ═══ 7. Ключ не привязан к чужому адресу ═════════════════════════════════

describe('ключ принадлежит своему адресу, а не устройству', () => {
  it('A, потом B, потом снова A: две подписи, у каждого свой ключ, A не потерян', async () => {
    const signA = vi.fn(async () => ALICE_SIG);
    const signB = vi.fn(async () => BOB_SIG);

    const a1 = await openSession(ALICE, signA);
    const b  = await openSession(BOB, signB);
    const a2 = await openSession(ALICE, signA);

    // Замер держит мутацию «ключевать хранилище константой»: тогда запись B
    // затрёт запись A, и третий заход попросит подпись — станет 3.
    expect(signA).toHaveBeenCalledTimes(1);
    expect(signB).toHaveBeenCalledTimes(1);

    expect(hex(b.keypair.privateKey)).not.toBe(hex(a1.keypair.privateKey));
    expect(hex(a2.keypair.privateKey)).toBe(hex(a1.keypair.privateKey));
    expect(a2.restored).toBe(true);
    expect(fakeIdb._disk.get('sessions')?.size).toBe(2);
  });

  it('тот же адрес в другом регистре — тот же сеанс, а не второе окно подписи', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign);
    await openSession(ALICE.toLowerCase() as `0x${string}`, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(fakeIdb._disk.get('sessions')?.size).toBe(1);
  });

  it('запись, подписанная чужим адресом, не выдаётся за свою', async () => {
    await openSession(ALICE, async () => ALICE_SIG);
    // подменяем адрес внутри записи, ключ хранилища оставляем
    const store = fakeIdb._disk.get('sessions')!;
    const key = Array.from(store.keys())[0];
    const rec = store.get(key) as { address: string };
    store.set(key, { ...rec, address: BOB.toLowerCase() });

    const sign = vi.fn(async () => ALICE_SIG);
    const again = await openSession(ALICE, sign);
    expect(sign).toHaveBeenCalledTimes(1); // запись отвергнута, подписали заново
    expect(again.origin).toBe('signature');
  });
});

// ═══ Обстоятельство 1: перезапустили посреди работы ══════════════════════

describe('вкладку закрыли между подписью и записью на устройство', () => {
  it('полузаписанного не остаётся: диск пуст, следующий заход просит подпись', async () => {
    installStorage({ failPut: true }); // запись откатывается транзакцией
    const sign = vi.fn(async () => ALICE_SIG);

    const session = await openSession(ALICE, sign);

    // сеанс отдан — переписка в этой вкладке работает
    expect(session.keypair.privateKey).toHaveLength(32);
    // но на диске НИЧЕГО: ни половины записи, ни мусора
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
    // и человек об этом узнает
    expect(session.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('кошелёк-контракт при непрошедшей записи получает НОВУЮ личность — и это видно', async () => {
    // Самое дорогое следствие обрыва, названное вслух: у обычного кошелька
    // ключ выводится из подписи и после обрыва получится ТОТ ЖЕ; у кошелька-
    // контракта он случайный, поэтому следующий заход заводит ДРУГОЙ ключ и
    // ДРУГОЙ код. Показанный до обрыва код становится бесполезным.
    // Потерять при этом нечего (открытый ключ никуда не публиковался), но
    // интерфейс обязан не обещать сохранность — для этого persisted.
    installStorage({ failPut: true });

    const first = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const second = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);

    expect(first.persisted).toBe(false);
    expect(second.persisted).toBe(false);
    expect(exportRecoveryCode(second)).not.toBe(exportRecoveryCode(first));
    expect(hex(second.keypair.privateKey)).not.toBe(hex(first.keypair.privateKey));
  });

  it('следующий заход читает пустоту, а не мусор', async () => {
    installStorage({ failPut: true });
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign);
    const second = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(2);
    expect(second.keypair.privateKey).toHaveLength(32);
  });
});

// ═══ Обстоятельство 2: диск кончился ═════════════════════════════════════

describe('IndexedDB отказала в записи (квота)', () => {
  it('сеанс работает, но помечен неcохранённым и об этом сказано вслух', async () => {
    installStorage({ failPut: true });
    const session = await openSession(ALICE, async () => ALICE_SIG);

    expect(session.persisted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain('chatSession');
  });

  it('успешная запись НЕ жалуется', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.persisted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('хранилища нет вовсе (сервер, приватный режим) — тот же честный ответ', async () => {
    delete g.indexedDB;
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign);
    expect(session.persisted).toBe(false);
    expect(session.keypair.privateKey).toHaveLength(32);
  });

  it('соседняя вкладка держит прежнюю версию базы — отказ, а не тишина (В-4)', async () => {
    // Браузер шлёт `blocked` и больше ничего. Без обработчика это вечное
    // молчание — не отказ, а зависший чат без единого сигнала.
    installStorage({ blockOpen: true });
    await expect(openSession(ALICE, async () => ALICE_CONTRACT_SIG))
      .rejects.toMatchObject({ code: 'storage_blocked' });
  });

  it('открытие молчит вовсе — потолок ожидания, а не зависание (В-4)', async () => {
    installStorage({ hangOpen: true });
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms === STORAGE_OPEN_TIMEOUT_MS ? 0 : ms, ...rest);
    }));
    try {
      await expect(openSession(ALICE, async () => ALICE_CONTRACT_SIG))
        .rejects.toMatchObject({ code: 'storage_open_timeout' });
      // и потолок — боевой, а не подставленный
      expect(delays).toContain(STORAGE_OPEN_TIMEOUT_MS);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('боевой потолок открытия хранилища — не тестовое значение', () => {
    expect(STORAGE_OPEN_TIMEOUT_MS).toBe(10_000);
  });

  it('база не открывается — отказ с кодом: пустоты мы не установили (К-4)', async () => {
    // «Не смогли открыть» — не «там пусто». Различить нечем, а цена ошибки
    // для кошелька-контракта — новая личность поверх старой.
    installStorage({ failOpen: true });
    await expect(openSession(ALICE, async () => ALICE_CONTRACT_SIG))
      .rejects.toMatchObject({ code: 'storage_read_failed' });
  });
});

// ═══ Обстоятельство 3: два процесса разом ════════════════════════════════

describe('две вкладки открывают сеанс одновременно', () => {
  it('два параллельных вызова в ОДНОЙ вкладке — одно окно подписи', async () => {
    let resolveSign: (v: `0x${string}`) => void;
    const gate = new Promise<`0x${string}`>(r => { resolveSign = r; });
    const sign = vi.fn(() => gate);

    const both = Promise.all([
      openSession(ALICE, sign),
      openSession(ALICE, sign),
    ]);
    // даём обоим дойти до места, где они решают спрашивать подпись
    await new Promise(r => setTimeout(r, 20));
    resolveSign!(ALICE_SIG);
    const [x, y] = await both;

    expect(sign).toHaveBeenCalledTimes(1);
    expect(hex(x.keypair.privateKey)).toBe(hex(y.keypair.privateKey));
  });

  it('ДВЕ РАЗНЫЕ вкладки (два экземпляра модуля, общий диск) — тоже одно окно', async () => {
    vi.resetModules();
    const tabOne = await import('./chatSession');
    vi.resetModules();
    const tabTwo = await import('./chatSession');
    expect(tabOne.openSession).not.toBe(tabTwo.openSession); // это правда два экземпляра

    let resolveSign: (v: `0x${string}`) => void;
    const gate = new Promise<`0x${string}`>(r => { resolveSign = r; });
    const sign = vi.fn(() => gate);

    const both = Promise.all([
      tabOne.openSession(ALICE, sign),
      tabTwo.openSession(ALICE, sign),
    ]);
    await new Promise(r => setTimeout(r, 20));
    resolveSign!(ALICE_SIG);
    const [x, y] = await both;

    // Замок обязан ДЕРЖАТЬ, а не просто быть вызванным: единица здесь
    // достижима только если вторая вкладка ПЕРЕЧИТАЛА диск под замком.
    expect(sign).toHaveBeenCalledTimes(1);
    expect(hex(x.keypair.privateKey)).toBe(hex(y.keypair.privateKey));
  });

  it('без Web Locks (старый Safari, небезопасный контекст) — всё ещё одно окно', async () => {
    // Замок между вкладками есть не везде. Там, где его нет, защита обязана
    // остаться хотя бы в пределах вкладки — иначе два параллельных вызова из
    // двух мест интерфейса (страница сделки и её же чат) откроют два окна
    // подписи, а второе кошелёк отклонит как -32002.
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'test' }, configurable: true, writable: true,
    });
    try {
      expect((globalThis.navigator as { locks?: unknown }).locks).toBeUndefined();

      let resolveSign: (v: `0x${string}`) => void;
      const gate = new Promise<`0x${string}`>(r => { resolveSign = r; });
      const sign = vi.fn(() => gate);

      const both = Promise.all([
        openSession(ALICE, sign),
        openSession(ALICE, sign),
      ]);
      await new Promise(r => setTimeout(r, 20));
      resolveSign!(ALICE_SIG);
      const [x, y] = await both;

      expect(sign).toHaveBeenCalledTimes(1);
      expect(hex(x.keypair.privateKey)).toBe(hex(y.keypair.privateKey));
    } finally {
      if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
    }
  });

  it('чужая вкладка держит замок вечно — мы не виснем навсегда', async () => {
    // Захватываем тот же самый межвкладочный замок и не отпускаем.
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let taken!: () => void;
    const takenP = new Promise<void>(r => { taken = r; });
    void navigator.locks.request(`hexseal-chat-session-${ALICE.toLowerCase()}`, () => {
      taken();
      return held;
    });
    await takenP;

    const sign = vi.fn(async () => ALICE_SIG);
    const started = Date.now();
    const session = await openSession(ALICE, sign, { lockTimeoutMs: 30 });
    const waited = Date.now() - started;

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.keypair.privateKey).toHaveLength(32);
    expect(waited).toBeGreaterThanOrEqual(25);
    release();
  });

  it('боевой потолок реально ПРОВОДИТСЯ в ожидание, а не только объявлен (В-1)', async () => {
    // Значение заперто соседним тестом, но проводки не было: подмена
    // «умолчание → 5 секунд» при нетронутой константе давала 0 красных,
    // потому что единственный поведенческий тест подставлял свои 30 мс.
    // Здесь openSession зовётся БЕЗ lockTimeoutMs, а таймер боевой длины
    // подменяется на немедленный — сама длина при этом наблюдаема.
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms === SESSION_LOCK_TIMEOUT_MS ? 0 : ms, ...rest);
    }));
    try {
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; });
      let taken!: () => void;
      const takenP = new Promise<void>(r => { taken = r; });
      void navigator.locks.request(`hexseal-chat-session-${ALICE.toLowerCase()}`, () => {
        taken();
        return held;
      });
      await takenP;

      const sign = vi.fn(async () => ALICE_SIG);
      await openSession(ALICE, sign); // умолчание, не подставленное

      expect(delays).toContain(SESSION_LOCK_TIMEOUT_MS);
      expect(sign).toHaveBeenCalledTimes(1);
      release();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('боевой потолок ожидания замка — не тестовое значение', () => {
    // Правило проекта: правка, проверенная только на подставленных значениях,
    // может не изменить ничего. Боевое умолчание заперто здесь.
    // Три минуты — то же значение и та же причина, что WALLET_LOCK_TIMEOUT_MS
    // в walletLock.ts: под замком стоит живое окно подписи.
    expect(SESSION_LOCK_TIMEOUT_MS).toBe(180_000);
  });
});

// ═══ Обстоятельство 4: пришёл мусор ══════════════════════════════════════

describe('мусор на входе — вердикт, а не падение', () => {
  it('подпись пустая', async () => {
    await expect(
      openSession(ALICE, async () => '' as `0x${string}`),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('подпись не той длины — это НЕ мусор, а признак кошелька-контракта', async () => {
    // Прежде такой ответ был отказом signature_malformed и оставлял человека
    // без чата вовсе. Теперь это сам признак: длинная подпись → код.
    const long = ('0x' + 'ab'.repeat(200)) as `0x${string}`;
    const session = await openSession(ALICE, async () => long);
    expect(session.walletKind).toBe('contract');
    expect(exportRecoveryCode(session).split(' ')).toHaveLength(RECOVERY_WORD_COUNT);
  });

  it('подпись не hex, пустая или нечётной длины — вот это мусор', async () => {
    for (const junk of ['', '0x', '0xzz', '0x' + 'ab'.repeat(200) + 'a']) {
      await expect(
        openSession(ALICE, async () => junk as `0x${string}`),
      ).rejects.toMatchObject({ code: 'signature_malformed' });
    }
  });

  it('подпись — не строка вовсе', async () => {
    await expect(
      openSession(ALICE, async () => undefined as unknown as `0x${string}`),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('негодная подпись НИЧЕГО не записала на устройство', async () => {
    await openSession(ALICE, async () => '' as `0x${string}`).catch(() => {});
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('человек отказался подписывать — ошибка кошелька доезжает КАК ЕСТЬ', async () => {
    // Код 4001 (user rejected) хук обязан уметь отличить; заворачивать его в
    // свой класс значило бы стереть единственный признак отказа человека.
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    let thrown: unknown;
    try {
      await openSession(ALICE, async () => { throw rejection; });
    } catch (err) { thrown = err; }
    expect(thrown).toBe(rejection);
  });

  it('второй заход не трогает ни кошелёк, ни что-либо ещё', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign);
    const second = await openSession(ALICE, sign);

    expect(second.restored).toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('в IndexedDB запись прежней версии формата — не мусор наружу, а новая подпись', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      { address: ALICE.toLowerCase(), secret: 'старый формат без версии' },
    ]]));

    const session = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.keypair.privateKey).toHaveLength(32);
    expect(session.keypair.publicKey).toHaveLength(32);
    // запись заменена годной
    const rec = fakeIdb._disk.get('sessions')!.get(ALICE.toLowerCase()) as { v: number };
    expect(rec.v).toBe(RECORD_VERSION);
  });

  it('в IndexedDB запись с ключом не той длины — отвергается', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: RECORD_VERSION,
        address: ALICE.toLowerCase(),
        origin: 'signature',
        walletKind: 'eoa',
        publicKey: new Uint8Array(31),
        privateKey: new Uint8Array(32),
      },
    ]]));

    await openSession(ALICE, sign);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('в IndexedDB запись «recovery» без кода — ключ цел, кода нет (В-3, К-4)', async () => {
    // Отвергать такую запись целиком значило бы завести НОВУЮ личность
    // поверх живого ключа — та же беда, что в К-4, только помельче. Ключ
    // отдаётся, а вот кода нет, и об этом говорится кодом ошибки.
    const keys = { pub: new Uint8Array(32).fill(9), priv: new Uint8Array(32).fill(8) };
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: RECORD_VERSION,
        address: ALICE.toLowerCase(),
        origin: 'recovery',
        walletKind: 'contract',
        publicKey: keys.pub,
        privateKey: keys.priv,
      },
    ]]));

    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);

    expect(sign).toHaveBeenCalledTimes(0);
    expect(hex(session.keypair.privateKey)).toBe(hex(keys.priv));
    let thrown: unknown;
    try { exportRecoveryCode(session); } catch (err) { thrown = err; }
    expect((thrown as ChatSessionError)?.code).toBe('recovery_code_unavailable');
  });

  it('в IndexedDB код из двенадцати НЕСУЩЕСТВУЮЩИХ слов — не выдаётся человеку (В-3)', async () => {
    // Годность кода в записи проверялась СЧЁТОМ ПРОБЕЛОВ. Человек получал
    // «aaa bbb ccc ...», переписывал на бумажку и считал себя застрахованным.
    const junk = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll';
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: RECORD_VERSION,
        address: ALICE.toLowerCase(),
        origin: 'recovery',
        walletKind: 'contract',
        publicKey: new Uint8Array(32).fill(9),
        privateKey: new Uint8Array(32).fill(8),
        recoveryCode: junk,
      },
    ]]));

    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);

    let thrown: unknown;
    try { exportRecoveryCode(session); } catch (err) { thrown = err; }
    expect((thrown as ChatSessionError)?.code).toBe('recovery_code_unavailable');
    expect(String((thrown as Error)?.message)).not.toContain('aaa');
  });

  it('в IndexedDB код с несошедшейся контрольной суммой — тоже не выдаётся (В-3)', async () => {
    // Все слова настоящие, длина верная — ловится только суммой.
    const spoiled = GOLD.split(' ').slice(0, 11).concat('zoo').join(' ');
    expect(spoiled.split(' ')).toHaveLength(RECOVERY_WORD_COUNT);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: RECORD_VERSION,
        address: ALICE.toLowerCase(),
        origin: 'recovery',
        walletKind: 'contract',
        publicKey: new Uint8Array(32).fill(9),
        privateKey: new Uint8Array(32).fill(8),
        recoveryCode: spoiled,
      },
    ]]));

    const session = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    let thrown: unknown;
    try { exportRecoveryCode(session); } catch (err) { thrown = err; }
    expect((thrown as ChatSessionError)?.code).toBe('recovery_code_unavailable');
  });

  // ─── Сбой чтения: размен несимметричен, поэтому разведён по роду ──────
  //
  // Обычному кошельку непрочитанный диск не стоит НИЧЕГО, кроме лишнего
  // окна подписи: ключ выводится из подписи и получается побайтово тот же.
  // Кошельку-контракту он стоит личности: ключ случайный, диск — его
  // единственный источник. Отказывать обоим одинаково значит наказывать
  // первого за беду второго. Разводка возможна потому, что род кошелька
  // берётся ИЗ ЦЕПИ, а не с диска: при отказе чтения он всё ещё известен.

  it('ветка 1: сбой чтения + обычный кошелёк — работает, ключ ТОТ ЖЕ (К-4-бис)', async () => {
    installStorage({ failGet: true });
    const sign = vi.fn(async () => ALICE_SIG);

    const session = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.origin).toBe('signature');
    expect(session.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
    // побайтово тот же ключ, что при исправном диске — терять нечего
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
  });

  it('ветка 2: сбой чтения + делегированный EIP-7702 — тоже работает', async () => {
    // Делегированный подписывает как обычный, значит и спасается как обычный.
    installStorage({ failGet: true });
    const sign = vi.fn(async () => ALICE_SIG);

    const session = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.origin).toBe('signature');
    expect(session.walletKind).toBe('eoa');
    expect(session.persisted).toBe(false);
  });

  it('ветка 3: сбой чтения + кошелёк-контракт — отказ, на диск ничего', async () => {
    // Цена нового признака названа честно: род выясняется подписью, значит
    // контрактный кошелёк ОДИН РАЗ подпишет — и получит отказ. Иначе род не
    // установить, а не установив, пришлось бы либо отказать и обычному
    // (наказать его за чужую беду), либо завести новую личность поверх старой.
    installStorage({ failGet: true });
    const sign = vi.fn(async () => ALICE_CONTRACT_SIG);

    await expect(openSession(ALICE, sign))
      .rejects.toMatchObject({ code: 'storage_read_failed' });

    expect(sign).toHaveBeenCalledTimes(1);
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('ветка 4: сбой чтения + подписать не удалось — ответ человека, а не наш', async () => {
    // Ветки «род не выяснен» больше нет: род выясняется подписью, и если
    // подписи нет, то нет и вопроса. Наружу идёт ошибка кошелька КАК ЕСТЬ —
    // человек отказался, это его ответ, а не наша беда с хранилищем.
    installStorage({ failGet: true });
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });

    let thrown: unknown;
    try {
      await openSession(ALICE, async () => { throw rejection; });
    } catch (err) { thrown = err; }

    expect(thrown).toBe(rejection);
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('молчащее хранилище стоит ОДНО ожидание, а не два подряд', async () => {
    // Первое чтение и перечитывание под замком — два полных ожидания
    // подряд: человек сидел бы вдвое дольше собственного потолка, а
    // хранилище за это время так и не ответило бы ни на одно из них.
    installStorage({ failGet: true });

    await openSession(ALICE, async () => ALICE_SIG);

    expect(fakeIdb._stats.gets).toBe(1);
  });

  it('а вот пустое хранилище перечитывается — на этом стоит замок', async () => {
    // Обратная сторона: когда первое чтение сказало «пусто», перечитать под
    // замком ОБЯЗАТЕЛЬНО — иначе вторая вкладка откроет второе окно подписи.
    await openSession(ALICE, async () => ALICE_SIG);
    expect(fakeIdb._stats.gets).toBe(2);
  });

  it('совет «закройте другую вкладку» доезжает и до ОБЫЧНОГО кошелька', async () => {
    // Побочка разводки приватного режима: обычный кошелёк продолжает
    // работать, а значит исключения со storage_blocked не увидит никогда —
    // и подписывал бы заново при каждой перезагрузке, не зная почему.
    installStorage({ blockOpen: true });
    const sign = vi.fn(async () => ALICE_SIG);

    const session = await openSession(ALICE, sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.persisted).toBe(false);
    expect(session.storageIssue).toBe('storage_blocked');
  });

  it('у неудачной ЗАПИСИ причина тоже названа, а не только «не сохранилось»', async () => {
    installStorage({ failPut: true });
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.persisted).toBe(false);
    expect(session.storageIssue).toBe('storage_write_failed');
  });

  it('когда всё в порядке — причины нет вовсе', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG);
    expect(session.persisted).toBe(true);
    expect(session.storageIssue).toBeUndefined();
  });

  it('сбой чтения у обычного кошелька НИЧЕГО не пишет поверх непрочитанного', async () => {
    // Под непрочитанной записью может лежать чужой сеанс. Работать в
    // памяти — да, писать вслепую — нет.
    const before = await openSession(BOB, async () => BOB_SIG);
    const snapshot = structuredClone(fakeIdb._disk.get('sessions')!.get(BOB.toLowerCase()));

    installStorageKeepingDisk({ failGet: true });
    const blind = await openSession(BOB, async () => BOB_SIG);
    expect(blind.persisted).toBe(false);

    // диск байт в байт прежний: ни новой записи, ни перезаписи
    const after = fakeIdb._disk.get('sessions')!;
    expect(after.size).toBe(1);
    expect(after.get(BOB.toLowerCase())).toEqual(snapshot);

    // чтение починилось — на месте ровно то, что лежало
    installStorageKeepingDisk({});
    const back = await openSession(BOB, async () => BOB_SIG);
    expect(back.restored).toBe(true);
    expect(hex(back.keypair.privateKey)).toBe(hex(before.keypair.privateKey));
  });

  it('сбой чтения НЕ уничтожает личность кошелька-контракта (К-4)', async () => {
    // Самое дорогое следствие прежнего поведения: отказ чтения трактовался
    // как «записи нет», поверх живого ключа ложился новый случайный, и сеанс
    // при этом рапортовал persisted: true.
    const mine = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    const myCode = exportRecoveryCode(mine);

    installStorageKeepingDisk({ failGet: true });
    await expect(openSession(ALICE, async () => ALICE_CONTRACT_SIG))
      .rejects.toMatchObject({ code: 'storage_read_failed' });

    // диск не тронут: чтение починилось — ключ и код на месте
    installStorageKeepingDisk({});
    const after = await openSession(ALICE, async () => ALICE_CONTRACT_SIG);
    expect(hex(after.keypair.privateKey)).toBe(hex(mine.keypair.privateKey));
    expect(exportRecoveryCode(after)).toBe(myCode);
  });

  it('код восстановления при сбое чтения тоже не принимается вслепую (К-4)', async () => {
    installStorage({ failGet: true });
    await expect(openSessionFromRecoveryCode(ALICE, GOLD, async () => ALICE_CONTRACT_SIG))
      .rejects.toMatchObject({ code: 'storage_read_failed' });
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });
});
