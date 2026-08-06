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
  failPut?: boolean;
  failGet?: boolean;
  failDelete?: boolean;
}

type Handler = ((ev: unknown) => void) | null;

class FakeRequest {
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  result: unknown = undefined;
  error: unknown = null;
}

function quotaError(): Error {
  const err = new Error('The quota has been exceeded.');
  err.name = 'QuotaExceededError';
  return err;
}

function makeFakeIndexedDB(control: FakeControl = {}) {
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
      return this.tx.run(
        () => disk.get(this.name)?.get(key),
        control.failGet ? new Error('read failed') : undefined,
      );
    }

    put(value: unknown, key: string): FakeRequest {
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
    open(_name: string, version: number): FakeRequest {
      const req = new FakeRequest();
      setTimeout(() => {
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
});

/** Обычный кошелёк: кода на цепи нет. Настоящий `getBytecode` (viem) отдаёт
 *  для такого адреса `undefined`, а не `'0x'` — обе формы встречаются в жизни
 *  (разные узлы/версии), поэтому проверяются обе. */
const eoaBytecode = vi.fn(async () => undefined);
const eoaBytecodeEmptyHex = vi.fn(async () => '0x' as const);
/** Кошелёк-контракт: минимальный EIP-1167 клон — настоящая форма из этого же
 *  проекта (`AgreementDeployer` клонирует именно так). */
const contractBytecode = vi.fn(
  async () => '0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3' as const,
);
/** Указатель делегации EIP-7702: `0xef0100` ‖ 20 байт адреса реализации,
 *  ровно 23 байта. Это НЕ кошелёк-контракт — подпись у такого адреса
 *  остаётся обычной подписью обычного ключа (К-1). */
const DELEGATION = '0xef0100bebebebebebebebebebebebebebebebebebebebe';
const delegationBytecode = vi.fn(async () => DELEGATION as `0x${string}`);

function eoaOpts() { return { getBytecode: eoaBytecode }; }
function contractOpts() { return { getBytecode: contractBytecode }; }

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ═══ 1. Второй заход не просит подпись ═════════════════════════════════════

describe('сеанс чата: ключ живёт на устройстве', () => {
  it('два открытия подряд — РОВНО ОДИН вызов signTypedData', async () => {
    const sign = vi.fn(async () => ALICE_SIG);

    const first = await openSession(ALICE, sign, eoaOpts());
    const second = await openSession(ALICE, sign, eoaOpts());

    // Замер, а не рассуждение: единица — весь смысл этого теста.
    expect(sign).toHaveBeenCalledTimes(1);
    expect(hex(second.keypair.privateKey)).toBe(hex(first.keypair.privateKey));
    expect(hex(second.keypair.publicKey)).toBe(hex(first.keypair.publicKey));
    expect(first.restored).toBe(false);
    expect(second.restored).toBe(true);
  });

  it('подписывать дают РОВНО CHAT_KEY_TYPED_DATA, не пересобранную копию', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign, eoaOpts());

    // Сравнение по ссылке: пересобранная структура с тем же содержимым не
    // пройдёт. Единственный источник истины о том, что подписывается, —
    // объект из chatCrypto.ts, а не строка, собранная вызывающим.
    expect(sign.mock.calls[0][0]).toBe(CHAT_KEY_TYPED_DATA);
  });

  it('десять открытий подряд — всё ещё одна подпись', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    for (let i = 0; i < 10; i += 1) await openSession(ALICE, sign, eoaOpts());
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

// ═══ 2. Тот же адрес и та же подпись дают тот же ключ ══════════════════════

describe('восстановление обычного кошелька — это сам кошелёк', () => {
  it('другое устройство, та же подпись — тот же ключ', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const onPhone = await openSession(ALICE, sign, eoaOpts());

    // «Другое устройство» = чистое хранилище. Ключ обязан совпасть, потому
    // что он выводится из подписи, а не из того, что лежало на диске.
    installStorage();
    const onLaptop = await openSession(ALICE, sign, eoaOpts());

    expect(hex(onLaptop.keypair.privateKey)).toBe(hex(onPhone.keypair.privateKey));
    expect(sign).toHaveBeenCalledTimes(2); // по разу на устройство
    expect(onLaptop.origin).toBe('signature');
  });

  it('другая подпись — другой ключ', async () => {
    const a = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    installStorage();
    const b = await openSession(ALICE, async () => BOB_SIG, eoaOpts());
    expect(hex(b.keypair.privateKey)).not.toBe(hex(a.keypair.privateKey));
  });

  it('умный аккаунт EIP-7702 — обычный кошелёк, а не контрактный (К-1)', async () => {
    // Боевая форма указателя делегации: 0xef0100 ‖ 20 байт адреса, ровно 23
    // байта. MetaMask на Base предлагает «умный аккаунт» прямо сейчас.
    // Подпись у такого адреса остаётся ОБЫЧНОЙ подписью обычного ключа и
    // остаётся стабильной — значит и ключ чата обязан быть выводимым.
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign, { getBytecode: delegationBytecode });

    expect(session.origin).toBe('signature');
    expect(sign).toHaveBeenCalledTimes(1);
    // тот же ключ, что у него же без делегации
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
  });

  it('включил делегацию, снял делегацию — ключ НЕ меняется (К-1)', async () => {
    const withDelegation = await openSession(ALICE, async () => ALICE_SIG, {
      getBytecode: delegationBytecode,
    });
    installStorage(); // новое устройство, делегация уже снята
    const without = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());

    expect(hex(without.keypair.privateKey)).toBe(hex(withDelegation.keypair.privateKey));
  });

  it('настоящий контрактный код всё ещё контрактный, а не «почти делегация»', async () => {
    // Граница: 0xef0100 с ЛИШНИМИ байтами — уже не указатель делегации, а
    // просто код, начинающийся так же. Такой адрес обязан остаться
    // контрактным, иначе признак превратился бы в «начинается с ef0100».
    const almost = vi.fn(async () => (DELEGATION + 'ff') as `0x${string}`);
    const s = await openSession(ALICE, async () => ALICE_SIG, { getBytecode: almost });
    expect(s.origin).toBe('recovery');
  });

  it('пустой байткод в виде «0x» — тоже обычный кошелёк, не контрактный', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const s = await openSession(ALICE, sign, { getBytecode: eoaBytecodeEmptyHex });
    expect(s.origin).toBe('signature');
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

// ═══ 3. Код восстановления возвращает тот же ключ ═════════════════════════

describe('кошелёк-контракт: код восстановления', () => {
  it('подписи не просят вовсе, а код — ровно 12 слов из английского списка', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign, contractOpts());

    expect(sign).toHaveBeenCalledTimes(0);
    expect(session.origin).toBe('recovery');

    const code = exportRecoveryCode(session);
    const words = code.split(' ');
    expect(words).toHaveLength(12);
    expect(RECOVERY_WORD_COUNT).toBe(12);
    for (const w of words) expect(wordlist).toContain(w);
  });

  it('код на другом устройстве возвращает ТОТ ЖЕ ключ', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const code = exportRecoveryCode(session);

    installStorage(); // другое устройство
    const restored = await openSessionFromRecoveryCode(ALICE, code);

    expect(hex(restored.keypair.privateKey)).toBe(hex(session.keypair.privateKey));
    expect(hex(restored.keypair.publicKey)).toBe(hex(session.keypair.publicKey));
    expect(restored.origin).toBe('recovery');
  });

  it('два кошелька-контракта получают РАЗНЫЕ коды и разные ключи', async () => {
    const a = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const b = await openSession(BOB, async () => BOB_SIG, contractOpts());
    expect(exportRecoveryCode(a)).not.toBe(exportRecoveryCode(b));
    expect(hex(a.keypair.privateKey)).not.toBe(hex(b.keypair.privateKey));
  });

  it('после восстановления код выдаётся снова, и он тот же', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const code = exportRecoveryCode(session);

    installStorage();
    const restored = await openSessionFromRecoveryCode(ALICE, code);
    expect(exportRecoveryCode(restored)).toBe(code);

    // и пережил перезагрузку вкладки — код лежит на устройстве
    const reopened = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    expect(reopened.restored).toBe(true);
    expect(exportRecoveryCode(reopened)).toBe(code);
  });

  it('код НЕ вылезает в JSON сеанса — его негде случайно залогировать', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const code = exportRecoveryCode(session);
    const dump = JSON.stringify(session);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(code.split(' ')[0] + ' ' + code.split(' ')[1]);
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
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    expect(hex(session.keypair.publicKey))
      .toBe('c785965fd58b37a43168ac4b45158f29abd55602e406cb75f8881076b5f00152');
    expect(hex(session.keypair.privateKey))
      .toBe('2d7ca08f696a30497580d743da64687362744d309f062c65dc02e4229a2514d9');
  });

  it('код восстановления: двенадцать слов → ровно этот ключ', async () => {
    expect(GOLD).toBe('legal winner thank year wave sausage worth useful legal winner thank yellow');
    const session = await openSessionFromRecoveryCode(ALICE, GOLD);
    expect(hex(session.keypair.publicKey))
      .toBe('377e94d7047bf2f0241998be0c9ab6bae18ac90139edc3f2d2f4bf51f2c53253');
    expect(hex(session.keypair.privateKey))
      .toBe('0a177c57e1eb21a420c0b7e39336ce68335d5395c85e105909ccf17304c72ad0');
  });

  it('ключ из кода и ключ из подписи — РАЗНЫЕ, дороги не пересекаются', async () => {
    const byCode = await openSessionFromRecoveryCode(ALICE, GOLD);
    installStorage();
    const bySig = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    expect(hex(byCode.keypair.privateKey)).not.toBe(hex(bySig.keypair.privateKey));
  });
});

// ═══ 4. Негодный код — внятная ошибка с кодом, а не другой ключ ═══════════

describe('негодный код восстановления отказывает внятно', () => {
  /** Каждый случай сверяет `.code`, а не текст и не «просто упало»: к одному
   *  отказу ведёт несколько дорог, и молчаливо ДРУГОЙ ключ здесь читается
   *  человеком как «переписка пропала». */
  async function expectCode(code: string, expected: string) {
    await expect(openSessionFromRecoveryCode(ALICE, code)).rejects.toMatchObject({
      code: expected,
    });
    await expect(openSessionFromRecoveryCode(ALICE, code)).rejects.toBeInstanceOf(ChatSessionError);
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
      openSessionFromRecoveryCode(ALICE, undefined as unknown as string),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('ни один отказ НИЧЕГО не записал на устройство', async () => {
    for (const bad of ['', GOLD.split(' ').slice(0, 11).join(' '), GOLD.replace('yellow', 'zoo')]) {
      await openSessionFromRecoveryCode(ALICE, bad).catch(() => {});
    }
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('лишние пробелы и ДРУГОЙ РЕГИСТР — работают: человек перепечатывает с бумажки', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const code = exportRecoveryCode(session);

    installStorage();
    const messy = `  ${code.toUpperCase().replace(/ /g, '   ')}\n`;
    const restored = await openSessionFromRecoveryCode(ALICE, messy);

    expect(hex(restored.keypair.privateKey)).toBe(hex(session.keypair.privateKey));
    // и выдаётся обратно в опрятном виде, а не как человек его набрал
    expect(exportRecoveryCode(restored)).toBe(code);
  });
});

// ═══ К-2: код восстановления не затирает уже лежащий сеанс ═══════════════

describe('код восстановления поверх живого сеанса — отказ, а не тихая замена', () => {
  it('чужой код по адресу с сеансом отвергается, ключ и код на месте', async () => {
    const mine = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const myCode = exportRecoveryCode(mine);

    await expect(openSessionFromRecoveryCode(ALICE, GOLD)).rejects.toMatchObject({
      code: 'session_already_present',
    });

    // ничего не сдвинулось: тот же ключ, тот же код, без окна подписи
    const after = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    expect(hex(after.keypair.privateKey)).toBe(hex(mine.keypair.privateKey));
    expect(exportRecoveryCode(after)).toBe(myCode);
  });

  it('обычный сеанс тоже не затирается кодом', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const mine = await openSession(ALICE, sign, eoaOpts());

    await expect(openSessionFromRecoveryCode(ALICE, GOLD)).rejects.toMatchObject({
      code: 'session_already_present',
    });

    const after = await openSession(ALICE, sign, eoaOpts());
    expect(hex(after.keypair.privateKey)).toBe(hex(mine.keypair.privateKey));
    expect(after.origin).toBe('signature');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('снять сеанс можно только явно — через forgetSession', async () => {
    const mine = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    await forgetSession(ALICE);

    const restored = await openSessionFromRecoveryCode(ALICE, GOLD);
    expect(hex(restored.keypair.privateKey)).not.toBe(hex(mine.keypair.privateKey));
    expect(exportRecoveryCode(restored)).toBe(GOLD);
  });

  it('по СВОБОДНОМУ соседнему адресу код по-прежнему принимается', async () => {
    await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const bob = await openSessionFromRecoveryCode(BOB, GOLD);
    expect(exportRecoveryCode(bob)).toBe(GOLD);
  });
});

// ═══ 8. exportRecoveryCode отказывает обычному кошельку ═══════════════════

describe('у обычного кошелька кода восстановления нет и не должно быть', () => {
  it('exportRecoveryCode отказывает с кодом, а не отдаёт пустую строку', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
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
    await openSession(ALICE, sign, eoaOpts());
    await forgetSession(ALICE);
    await openSession(ALICE, sign, eoaOpts());

    expect(sign).toHaveBeenCalledTimes(2);
    // и на диске снова ровно одна запись, а не две
    expect(fakeIdb._disk.get('sessions')?.size).toBe(1);
  });

  it('забывает ТОЛЬКО названный адрес — сеанс соседа цел', async () => {
    const signA = vi.fn(async () => ALICE_SIG);
    const signB = vi.fn(async () => BOB_SIG);
    await openSession(ALICE, signA, eoaOpts());
    await openSession(BOB, signB, eoaOpts());

    await forgetSession(ALICE);

    await openSession(BOB, signB, eoaOpts());
    expect(signB).toHaveBeenCalledTimes(1); // сеанс BOB не тронут
  });

  it('не смог удалить — говорит об этом, а не врёт «забыто»', async () => {
    await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
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
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());

    expect(fakeLs._map.size).toBe(0);
    expect(fakeLs._calls.filter(c => c.startsWith('set:'))).toHaveLength(0);

    // и ни в одном значении нет байтов ключа — на случай, если запись
    // однажды появится под невинным именем
    const priv = hex(session.keypair.privateKey);
    for (const v of fakeLs._map.values()) expect(v).not.toContain(priv);
  });

  it('и у кошелька-контракта тоже: ни ключа, ни кода восстановления', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
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

    const a1 = await openSession(ALICE, signA, eoaOpts());
    const b  = await openSession(BOB, signB, eoaOpts());
    const a2 = await openSession(ALICE, signA, eoaOpts());

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
    await openSession(ALICE, sign, eoaOpts());
    await openSession(ALICE.toLowerCase() as `0x${string}`, sign, eoaOpts());

    expect(sign).toHaveBeenCalledTimes(1);
    expect(fakeIdb._disk.get('sessions')?.size).toBe(1);
  });

  it('запись, подписанная чужим адресом, не выдаётся за свою', async () => {
    await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    // подменяем адрес внутри записи, ключ хранилища оставляем
    const store = fakeIdb._disk.get('sessions')!;
    const key = Array.from(store.keys())[0];
    const rec = store.get(key) as { address: string };
    store.set(key, { ...rec, address: BOB.toLowerCase() });

    const sign = vi.fn(async () => ALICE_SIG);
    const again = await openSession(ALICE, sign, eoaOpts());
    expect(sign).toHaveBeenCalledTimes(1); // запись отвергнута, подписали заново
    expect(again.origin).toBe('signature');
  });
});

// ═══ Обстоятельство 1: перезапустили посреди работы ══════════════════════

describe('вкладку закрыли между подписью и записью на устройство', () => {
  it('полузаписанного не остаётся: диск пуст, следующий заход просит подпись', async () => {
    installStorage({ failPut: true }); // запись откатывается транзакцией
    const sign = vi.fn(async () => ALICE_SIG);

    const session = await openSession(ALICE, sign, eoaOpts());

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

    const first = await openSession(ALICE, async () => ALICE_SIG, contractOpts());
    const second = await openSession(ALICE, async () => ALICE_SIG, contractOpts());

    expect(first.persisted).toBe(false);
    expect(second.persisted).toBe(false);
    expect(exportRecoveryCode(second)).not.toBe(exportRecoveryCode(first));
    expect(hex(second.keypair.privateKey)).not.toBe(hex(first.keypair.privateKey));
  });

  it('следующий заход читает пустоту, а не мусор', async () => {
    installStorage({ failPut: true });
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign, eoaOpts());
    const second = await openSession(ALICE, sign, eoaOpts());

    expect(sign).toHaveBeenCalledTimes(2);
    expect(second.keypair.privateKey).toHaveLength(32);
  });
});

// ═══ Обстоятельство 2: диск кончился ═════════════════════════════════════

describe('IndexedDB отказала в записи (квота)', () => {
  it('сеанс работает, но помечен неcохранённым и об этом сказано вслух', async () => {
    installStorage({ failPut: true });
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());

    expect(session.persisted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    expect(said).toContain('chatSession');
  });

  it('успешная запись НЕ жалуется', async () => {
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    expect(session.persisted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('хранилища нет вовсе (сервер, приватный режим) — тот же честный ответ', async () => {
    delete g.indexedDB;
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign, eoaOpts());
    expect(session.persisted).toBe(false);
    expect(session.keypair.privateKey).toHaveLength(32);
  });

  it('база не открывается — тоже не молча', async () => {
    installStorage({ failOpen: true });
    const session = await openSession(ALICE, async () => ALICE_SIG, eoaOpts());
    expect(session.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

// ═══ Обстоятельство 3: два процесса разом ════════════════════════════════

describe('две вкладки открывают сеанс одновременно', () => {
  it('два параллельных вызова в ОДНОЙ вкладке — одно окно подписи', async () => {
    let resolveSign: (v: `0x${string}`) => void;
    const gate = new Promise<`0x${string}`>(r => { resolveSign = r; });
    const sign = vi.fn(() => gate);

    const both = Promise.all([
      openSession(ALICE, sign, eoaOpts()),
      openSession(ALICE, sign, eoaOpts()),
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
      tabOne.openSession(ALICE, sign, eoaOpts()),
      tabTwo.openSession(ALICE, sign, eoaOpts()),
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
        openSession(ALICE, sign, eoaOpts()),
        openSession(ALICE, sign, eoaOpts()),
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
    const session = await openSession(ALICE, sign, { ...eoaOpts(), lockTimeoutMs: 30 });
    const waited = Date.now() - started;

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.keypair.privateKey).toHaveLength(32);
    expect(waited).toBeGreaterThanOrEqual(25);
    release();
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
      openSession(ALICE, async () => '' as `0x${string}`, eoaOpts()),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('подпись не той длины (кошелёк-контракт, ERC-1271)', async () => {
    const long = ('0x' + 'ab'.repeat(200)) as `0x${string}`;
    await expect(
      openSession(ALICE, async () => long, eoaOpts()),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('подпись — не строка вовсе', async () => {
    await expect(
      openSession(ALICE, async () => undefined as unknown as `0x${string}`, eoaOpts()),
    ).rejects.toMatchObject({ code: 'signature_malformed' });
  });

  it('негодная подпись НИЧЕГО не записала на устройство', async () => {
    await openSession(ALICE, async () => '' as `0x${string}`, eoaOpts()).catch(() => {});
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('человек отказался подписывать — ошибка кошелька доезжает КАК ЕСТЬ', async () => {
    // Код 4001 (user rejected) хук обязан уметь отличить; заворачивать его в
    // свой класс значило бы стереть единственный признак отказа человека.
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    let thrown: unknown;
    try {
      await openSession(ALICE, async () => { throw rejection; }, eoaOpts());
    } catch (err) { thrown = err; }
    expect(thrown).toBe(rejection);
  });

  it('getBytecode отказал по сети — отказ с кодом, БЕЗ подписи и БЕЗ записи', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    const failing = vi.fn(async () => { throw new Error('HTTP request failed'); });

    await expect(
      openSession(ALICE, sign, { getBytecode: failing }),
    ).rejects.toMatchObject({ code: 'wallet_kind_unknown' });

    // Гадать нельзя: ошибись в сторону «обычный» — контрактный кошелёк
    // получит негодную подпись; ошибись в сторону «контрактный» — обычный
    // получит случайный ключ вместо восстановимого, и история разъедется.
    expect(sign).toHaveBeenCalledTimes(0);
    const store = fakeIdb._disk.get('sessions');
    expect(store === undefined || store.size === 0).toBe(true);
  });

  it('getBytecode не передали вовсе — отказ с тем же кодом, а не догадка', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await expect(openSession(ALICE, sign)).rejects.toMatchObject({ code: 'wallet_kind_unknown' });
    expect(sign).toHaveBeenCalledTimes(0);
  });

  it('сеть отказала, но сеанс УЖЕ на устройстве — getBytecode даже не спрашивают', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    await openSession(ALICE, sign, eoaOpts());

    const failing = vi.fn(async () => { throw new Error('HTTP request failed'); });
    const second = await openSession(ALICE, sign, { getBytecode: failing });

    expect(failing).toHaveBeenCalledTimes(0);
    expect(second.restored).toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('в IndexedDB запись прежней версии формата — не мусор наружу, а новая подпись', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      { address: ALICE.toLowerCase(), secret: 'старый формат без версии' },
    ]]));

    const session = await openSession(ALICE, sign, eoaOpts());

    expect(sign).toHaveBeenCalledTimes(1);
    expect(session.keypair.privateKey).toHaveLength(32);
    expect(session.keypair.publicKey).toHaveLength(32);
    // запись заменена годной
    const rec = fakeIdb._disk.get('sessions')!.get(ALICE.toLowerCase()) as { v: number };
    expect(rec.v).toBe(1);
  });

  it('в IndexedDB запись с ключом не той длины — отвергается', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: 1,
        address: ALICE.toLowerCase(),
        origin: 'signature',
        publicKey: new Uint8Array(31),
        privateKey: new Uint8Array(32),
      },
    ]]));

    await openSession(ALICE, sign, eoaOpts());
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('в IndexedDB запись «recovery» без кода — отвергается, а не отдаётся без кода', async () => {
    const sign = vi.fn(async () => ALICE_SIG);
    fakeIdb._disk.set('sessions', new Map([[
      ALICE.toLowerCase(),
      {
        v: 1,
        address: ALICE.toLowerCase(),
        origin: 'recovery',
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      },
    ]]));

    await openSession(ALICE, sign, eoaOpts());
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('чтение хранилища отказало — сеанс всё равно есть, но сказано вслух', async () => {
    installStorage({ failGet: true });
    const sign = vi.fn(async () => ALICE_SIG);
    const session = await openSession(ALICE, sign, eoaOpts());
    expect(session.keypair.privateKey).toHaveLength(32);
    expect(warn).toHaveBeenCalled();
  });
});
