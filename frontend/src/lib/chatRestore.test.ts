/**
 * chatRestore.test.ts — записанный код ОТКРЫВАЕТ переписку (Задача 8б).
 *
 * ⚠️ ЗАЧЕМ ЗАДАЧА СУЩЕСТВУЕТ. Задача 8 сделала половину, которая пугает:
 * показали двенадцать слов, заставили доказать, что записаны, пообещали
 * «потеряете — переписка не вернётся». Половины, ради которой всё
 * затевалось, не было: `openSessionFromRecoveryCode` в интерфейсе не звал
 * НИКТО (`grep -rn openSessionFromRecoveryCode src/` давал только
 * `chatSession.ts` и его тест). Человек выполнял нашу просьбу и оставался ни
 * с чем — хуже, чем если бы кода не было совсем.
 *
 * Главная проверка файла — сквозная: показали код, забыли сеанс, ввели код,
 * ПРОЧИТАЛИ прежнее сообщение. Всё остальное здесь обслуживает её.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_KEY_TYPED_DATA, sealForRecipient, openSealed } from './chatCrypto';
import { installFakeChatDisk } from './__stand__/fakeChatDisk';
import {
  RESTORE_ERROR_KEYS,
  restoreErrorKey,
  unknownWordPosition,
} from './chatRecovery';
import { requireWebLocks } from './__stand__/requireWebLocks';

// ⚠️ THIS STAND NEEDS A REAL WEB LOCK, AND SAYS SO BEFORE MEASURING ANYTHING.
// `navigator.locks` is how two tabs of one origin queue for one resource, and
// node ships it only from v24 on. Without this line node 22 does not fail here
// — the production code degrades gracefully, and the two-tab expectations below
// quietly turn into `expected 1 to be 2` diffs that name no cause at all. That
// cost eighteen red CI runs in August 2026. Fail once, by name, instead.
// Called at module level on purpose: the throw lands during collection, so no
// misleading assertion is ever reported. See `__stand__/requireWebLocks.ts`.
requireWebLocks('chatRestore.test.ts ("обстоятельство 3: две вкладки восстанавливают разом")');

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../messages');
const RU = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, 'ru.json'), 'utf8')) as Record<string, unknown>;
const pick = (key: string) => key.split('.').reduce<unknown>(
  (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), RU);

const ACCOUNT = privateKeyToAccount(`0x${'05'.repeat(32)}`);
const ADDRESS = ACCOUNT.address;

/** Подпись кошелька-КОНТРАКТА: длиннее 65 байт → род `contract`. */
const CONTRACT_SIG = `0x${'cd'.repeat(96)}` as `0x${string}`;
/** Настоящая обычная подпись над той же структурой → род `eoa`. */
const EOA_SIG = await ACCOUNT.signTypedData(CHAT_KEY_TYPED_DATA as never);

async function freshModule() {
  vi.resetModules();
  return import('./chatSession');
}

describe('сквозной замер: код открывает прежнюю переписку', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ ГЛАВНОЕ: показали код → забыли сеанс → ввели код → ПРОЧИТАЛИ прежнее сообщение', async () => {
    const first = await freshModule();

    // 1. Кошелёк-контракт заходит впервые: ключ заводится, код выдаётся.
    const before = await first.openSession(ADDRESS, async () => CONTRACT_SIG);
    expect(before.origin).toBe('recovery');
    const code = first.exportRecoveryCode(before);

    // 2. Собеседник запечатывает сообщение на ОТКРЫТУЮ половину этого ключа —
    //    ровно так, как это делает настоящая переписка (`chatCrypto`).
    const PLAIN = new TextEncoder().encode('привет из прошлого');
    const sealed = await sealForRecipient(before.keypair.publicKey, PLAIN);

    // 3. Устройство потеряло ключ (человек нажал «выключить чат», сменил
    //    браузер, почистил хранилище) — читать нечем.
    await first.forgetSession(ADDRESS, { acknowledged: true });

    // 4. Новая вкладка. Человек вводит те самые двенадцать слов.
    const later = await freshModule();
    const after = await later.openSessionFromRecoveryCode(ADDRESS, code, async () => CONTRACT_SIG);

    // 5. И прежнее сообщение ЧИТАЕТСЯ. Это и есть замыкание петли: без
    //    восстановления здесь была бы негодная расшифровка.
    const opened = await openSealed(after.keypair, sealed);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe('привет из прошлого');
    expect([...after.keypair.publicKey]).toEqual([...before.keypair.publicKey]);
  });

  it('⚠️ КОНТРОЛЬ: ДРУГОЙ код даёт ДРУГОЙ ключ, и прежнее сообщение НЕ читается', async () => {
    // Без этого теста главный был бы зелёным и на реализации «любой код
    // открывает что угодно»: тогда петля замкнута не кодом, а тем, что мы
    // просто не стёрли ключ.
    const first = await freshModule();
    const mine = await first.openSession(ADDRESS, async () => CONTRACT_SIG);
    const PLAIN = new TextEncoder().encode('привет из прошлого');
    const sealed = await sealForRecipient(mine.keypair.publicKey, PLAIN);

    // Чужой, но совершенно настоящий код — от другого адреса.
    const otherAddr = '0x3333333333333333333333333333333333333333' as `0x${string}`;
    const other = await first.openSession(otherAddr, async () => `0x${'99'.repeat(96)}` as `0x${string}`);
    const foreignCode = first.exportRecoveryCode(other);
    expect(foreignCode).not.toBe(first.exportRecoveryCode(mine));

    await first.forgetSession(ADDRESS, { acknowledged: true });
    const later = await freshModule();
    const wrong = await later.openSessionFromRecoveryCode(ADDRESS, foreignCode, async () => CONTRACT_SIG);

    expect([...wrong.keypair.publicKey]).not.toEqual([...mine.keypair.publicKey]);
    expect(await openSealed(wrong.keypair, sealed)).toBeNull();
  });
});

/* ────────────────── каждая причина — своя надпись ─────────────────────── */

describe('каждая причина отказа — своя надпись', () => {
  const CAUSES = [
    'recovery_code_empty',
    'recovery_code_word_count',
    'recovery_code_unknown_word',
    'recovery_code_checksum',
    'session_already_present',
    'recovery_not_applicable',
    'storage_write_failed',
    'storage_read_failed',
    'storage_blocked',
    'storage_open_timeout',
    'address_malformed',
    'signature_malformed',
  ] as const;

  it('у каждой причины есть свой ключ надписи, и все они разные', () => {
    // Свойство 2. Красит: карта, где две причины ведут на один ключ —
    // «код не подошёл» вместо «ошиблись в седьмом слове».
    const keys = CAUSES.map(c => restoreErrorKey(c));
    expect(new Set(keys).size).toBe(CAUSES.length);
    for (const c of CAUSES) expect(RESTORE_ERROR_KEYS[c], c).toBeTruthy();
  });

  it('каждый ключ надписи есть в русском словаре и не пуст', () => {
    const missing: string[] = [];
    for (const key of Object.values(RESTORE_ERROR_KEYS)) {
      const value = pick(key);
      if (typeof value !== 'string' || value.trim().length === 0) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('незнакомая причина и её отсутствие дают ОБЩУЮ надпись, а не пустоту', () => {
    // Молчание здесь читается как «переписка пропала». Пусть лучше общее,
    // чем ничего.
    expect(typeof pick(restoreErrorKey(null))).toBe('string');
    expect(typeof pick(restoreErrorKey('storage_version_unknown'))).toBe('string');
  });

  it('«занятый адрес» и «обычный кошелёк» — разные надписи, и обе объясняют', () => {
    // Свойства 3 и 4. Занятый адрес — не ошибка, а защита соседа; обычному
    // кошельку надо сказать, что его восстановление это сам кошелёк.
    const busy = pick(restoreErrorKey('session_already_present')) as string;
    const eoa = pick(restoreErrorKey('recovery_not_applicable')) as string;
    expect(busy).not.toBe(eoa);
    expect(busy.length).toBeGreaterThan(20);
    expect(eoa.length).toBeGreaterThan(20);
  });
});

describe('номер слова, набранного с ошибкой', () => {
  it('называет номер первого слова не из списка BIP-39', async () => {
    // Красит: надпись «код не подошёл» на всю строку — человек перебирает
    // двенадцать слов вслепую вместо одного.
    const words = 'legal winner thank yeaar wave sausage worth useful legal winner thank yellow';
    await expect(unknownWordPosition(words)).resolves.toBe(4);
  });

  it('регистр и лишние пробелы не сбивают НОМЕР — считается по тем же правилам', async () => {
    // Красит: подсчёт по сырой строке. Человек вставил из PDF в верхнем
    // регистре — и ему назвали бы первое слово вместо четвёртого.
    const messy = '  LEGAL   winner\nthank  YEAAR wave sausage worth useful legal winner thank yellow ';
    await expect(unknownWordPosition(messy)).resolves.toBe(4);
  });

  it('все слова из списка — номера нет', async () => {
    const good = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await expect(unknownWordPosition(good)).resolves.toBeNull();
  });

  it.each([['пусто', ''], ['не строка', 5], ['ничего', null]])(
    'мусор («%s») — `null`, а не падение', async (_n, junk) => {
      await expect(unknownWordPosition(junk as string)).resolves.toBeNull();
    });
});

/* ──────────────── пять форм вставки из буфера ─────────────────────────── */

describe('вставка из буфера — все пять форм', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ регистр, пробелы, перенос строки, неразрывный пробел и полноширинные буквы — все открывают ТОТ ЖЕ ключ', async () => {
    // Свойство 5. Человек вставляет из заметки, из PDF, из мессенджера.
    const mod = await freshModule();
    const opened = await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = mod.exportRecoveryCode(opened);
    const expected = [...opened.keypair.publicKey];
    await mod.forgetSession(ADDRESS, { acknowledged: true });

    const forms: Array<[string, string]> = [
      ['ВЕРХНИЙ РЕГИСТР', code.toUpperCase()],
      ['лишние пробелы', `   ${code.replace(/ /g, '    ')}   `],
      ['перенос строки', code.replace(/ /g, '\n')],
      ['неразрывный пробел из PDF', code.replace(/ /g, ' ')],
      ['полноширинные буквы', [...code].map(c => c === ' ' ? ' '
        : String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('')],
    ];

    for (const [name, form] of forms) {
      const tab = await freshModule();
      const restored = await tab.openSessionFromRecoveryCode(ADDRESS, form, async () => CONTRACT_SIG);
      expect([...restored.keypair.publicKey], name).toEqual(expected);
      await tab.forgetSession(ADDRESS, { acknowledged: true });
    }
  });
});

/* ─────────────── обстоятельства: числа, а не рассуждения ───────────────── */

describe('обстоятельство 4: мусор в поле — вердикт, а не падение', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  const JUNK: Array<[string, string, string]> = [
    ['пусто', '', 'recovery_code_empty'],
    ['одни пробелы', '    ', 'recovery_code_empty'],
    ['не двенадцать слов', 'legal winner thank', 'recovery_code_word_count'],
    ['слово не из списка', 'legal winner thank yeaar wave sausage worth useful legal winner thank yellow', 'recovery_code_unknown_word'],
    ['переставленные слова', 'winner legal thank year wave sausage worth useful legal winner thank yellow', 'recovery_code_checksum'],
  ];

  it.each(JUNK)('«%s» → код `%s`, а не падение', async (_name, junk, expected) => {
    const mod = await freshModule();
    await expect(mod.openSessionFromRecoveryCode(ADDRESS, junk, async () => CONTRACT_SIG))
      .rejects.toMatchObject({ code: expected });
  });

  it('⚠️ НИ ОДНА опечатка не стоит окна подписи — замер числом', async () => {
    // Обстоятельство 5 (подбор) и вежливость разом. Местные проверки стоят
    // ПЕРЕД `establishIdentity`, значит перебор через наш интерфейс не может
    // дёргать кошелёк даром, а человек с опечаткой не платит за неё окном.
    const mod = await freshModule();
    const sign = vi.fn(async () => CONTRACT_SIG);
    for (const [, junk] of JUNK) {
      await mod.openSessionFromRecoveryCode(ADDRESS, junk, sign).catch(() => {});
    }
    expect(sign).toHaveBeenCalledTimes(0);
  });

  it('годный по контрольной сумме код — РОВНО одно окно подписи на попытку', async () => {
    // Оборотная сторона: у перебора есть цена, и платит её тот, кто перебирает.
    const mod = await freshModule();
    const opened = await mod.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = mod.exportRecoveryCode(opened);
    await mod.forgetSession(ADDRESS, { acknowledged: true });

    const sign = vi.fn(async () => CONTRACT_SIG);
    await mod.openSessionFromRecoveryCode(ADDRESS, code, sign);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('обстоятельство 3: две вкладки восстанавливают разом', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('⚠️ второй получает отказ «адрес занят», а не второй сеанс', async () => {
    // Гонка закрывалась в `chatSession.ts` замком; проверяем, что через
    // интерфейс она не открывается заново. Без замка ОБА проходили, и один
    // жил на ключе, которого нет на диске, считая себя сохранённым.
    const seed = await freshModule();
    const opened = await seed.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = seed.exportRecoveryCode(opened);
    await seed.forgetSession(ADDRESS, { acknowledged: true });

    const tabOne = await freshModule();
    const tabTwo = await freshModule();
    const results = await Promise.allSettled([
      tabOne.openSessionFromRecoveryCode(ADDRESS, code, async () => CONTRACT_SIG),
      tabTwo.openSessionFromRecoveryCode(ADDRESS, code, async () => CONTRACT_SIG),
    ]);

    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter(r => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'session_already_present' });
    // Победитель считает себя сохранённым — и это ПРАВДА, ключ на диске его.
    expect((won[0] as PromiseFulfilledResult<{ persisted: boolean }>).value.persisted).toBe(true);
  });
});

describe('обстоятельство 2: хранилище не пишет (приватный режим)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('восстановление РАБОТАЕТ, но сеанс честно говорит `persisted: false`', async () => {
    const working = installFakeChatDisk();
    const seed = await freshModule();
    const opened = await seed.openSession(ADDRESS, async () => CONTRACT_SIG);
    const code = seed.exportRecoveryCode(opened);
    const expected = [...opened.keypair.publicKey];
    working.restore();

    // Тот же случай, но запись молча не проходит.
    const broken = installFakeChatDisk({ failPut: true });
    try {
    const tab = await freshModule();
    const restored = await tab.openSessionFromRecoveryCode(ADDRESS, code, async () => CONTRACT_SIG);
    expect([...restored.keypair.publicKey]).toEqual(expected);
    // Переписка в этой вкладке работает; человеку об этом обязана сказать
    // та же плашка, что и при обычном заходе (`chat.key_not_saved`).
    expect(restored.persisted).toBe(false);
    } finally {
      broken.restore();
    }
  });
});

describe('свойство 4: обычному кошельку восстановление не даётся', () => {
  let stand: ReturnType<typeof installFakeChatDisk>;
  beforeEach(() => { stand = installFakeChatDisk(); });
  afterEach(() => { stand?.restore(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('обычный кошелёк, даже с настоящим чужим кодом — `recovery_not_applicable`', async () => {
    const seed = await freshModule();
    const opened = await seed.openSession(
      '0x2222222222222222222222222222222222222222',
      async () => `0x${'ab'.repeat(96)}` as `0x${string}`,
    );
    const code = seed.exportRecoveryCode(opened);

    const mod = await freshModule();
    await expect(mod.openSessionFromRecoveryCode(ADDRESS, code, async () => EOA_SIG))
      .rejects.toMatchObject({ code: 'recovery_not_applicable' });
  });
});

/* ─────────────────── вход доехал до экрана ────────────────────────────── */

describe('вход в восстановление подключён, а не просто написан', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('окно ввода не просто ввезено, а ОТРИСОВАНО привратником', () => {
    // ⚠️ Сверяется РАЗМЕТКА, а не упоминание. Первая версия теста искала
    // строку `RecoveryRestoreModal` и была зелёной на привратнике, который
    // окно импортирует и не рисует — то есть на ровно том дефекте, ради
    // которого эта задача заведена (мутация М-31 прошла незамеченной).
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toMatch(/<RecoveryRestoreModal\b/);
    expect(gate).toMatch(/\{\s*restoreModal\s*\}/);
    expect(gate).toContain('openSessionFromRecoveryCode');
  });

  it('привратник СТИРАЕТ набранное при закрытии — обстоятельство 1', () => {
    // Двенадцать слов не должны висеть в памяти вкладки после того, как
    // человек закрыл окно на середине ввода.
    const gate = read('components/RecoveryCodeGate.tsx');
    const closer = gate.slice(gate.indexOf('const closeRestore'), gate.indexOf('const runRestore'));
    expect(closer).toMatch(/setTyped\(''\)/);
  });

  it('в меню кошелька есть вход, и он рядом с показом кода', () => {
    const menu = read('components/WalletMenu.tsx');
    expect(menu).toContain('RESTORE_RECOVERY_EVENT');
  });

  it('на экране «чат не открылся» вход тоже есть', () => {
    const panel = read('components/ChatPanel.tsx');
    expect(panel).toContain('RESTORE_RECOVERY_EVENT');
  });

  it('имя события — одно на всех, из одного места', () => {
    const gate = read('components/RecoveryCodeGate.tsx');
    expect(gate).toMatch(/export const RESTORE_RECOVERY_EVENT\s*=/);
    for (const rel of ['components/WalletMenu.tsx', 'components/ChatPanel.tsx']) {
      expect(read(rel), rel).not.toMatch(/'hexseal:restore-recovery-code'/);
    }
  });
});
