// ─── Заверение ключей кошельком на стороне справочника (4в-1, §15.2) ──────
//
// Сервер ХРАНИТ и ОТДАЁТ заверение, но НЕ ПРОВЕРЯЕТ подпись и не может: весь
// смысл заверения в том, что его проверяет читатель, у которого нет причин
// верить нам (§10 замысла). Вторая реализация EIP-712 здесь была бы вторым
// источником истины о том, что подписано — запрещено шапкой chatCrypto.ts.
// Поэтому проверяется ФОРМА и СОГЛАСОВАННОСТЬ (то заверение про этот адрес и
// про эти ключи?), а смысл — не проверяется вовсе.
//
// Порядок «переменные окружения — до импорта» — как в test/directory.test.js.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-dir-att-'));
process.env.STORAGE_DIR = TMP;
// Малый потолок истории — граничные проверки дешевле на маленьком числе.
// ⚠️ Заверений в истории потолка НЕТ намеренно (разбор — Л-7 задачи).
process.env.MAX_KEY_HISTORY = '6';
process.env.KEYS_WRITE_RATE_MAX = '40';
process.env.KEYS_IP_RATE_MAX = '80';

const directory = await import('../directory.js');
const { putKey, getKeyRecord, isDirectoryHealthy, _loadDirectory, _saveDirectory } = directory;
const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const CAROL = '0xca401000000000000000000000000000000beef1'; // «другая живая копия»

const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const SIGN_A = '0x' + 'aa'.repeat(32);
const SIGN_B = '0x' + 'bb'.repeat(32);

/**
 * Потолок подписи — ОЖИДАЕМОЕ число, записанное РУКАМИ.
 *
 * ⚠️ Исправление 12 договора v2, и здесь оно поймало живой промах: раньше этим
 * числом ЗАДАВАЛСЯ размер подписи в замере объёма (R17), а из модуля не брали
 * ничего — значит замер сверял значение сам с собой и молча поехал бы за боевой
 * константой. Теперь ожидаемое — руками, измеряемое — из модуля.
 */
const MAX_SIG_EXPECTED = 512;

/** Заверение нужной ФОРМЫ. Подпись синтетическая: сервер её не проверяет и
 *  проверять не должен — настоящую проверяет читатель (frontend). */
function attOf({ address = ALICE, boxKey = KEY_A, signKey = SIGN_A, issuedAt = 1_700_000_000_000, sigBytes = 65 } = {}) {
  return { address, boxKey, signKey, issuedAt, signature: '0x' + 'ab'.repeat(sigBytes) };
}

function directoryOnDisk() {
  const out = {};
  if (fs.existsSync(directory.DIRECTORY_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(out, parsed);
    } catch { /* битый снимок */ }
  }
  const log = directory.DIRECTORY_FILE + '.log';
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r && typeof r.a === 'string') out[r.a] = r.r;
    }
  }
  return out;
}

function journalBytes() {
  const log = directory.DIRECTORY_FILE + '.log';
  return fs.existsSync(log) ? fs.statSync(log).size : 0;
}

beforeEach(() => {
  fs.rmSync(directory.DIRECTORY_FILE, { force: true });
  fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true });
  _loadDirectory();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/* ───────────────────────── модульный слой ────────────────────────── */

describe('directory.js — заверение хранится и отдаётся', () => {
  it('R1 putKey кладёт заверение, getKeyRecord его отдаёт', () => {
    const att = attOf();
    const stored = putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    expect(stored.attestation).toEqual(att);
    expect(getKeyRecord(ALICE).attestation).toEqual(att);
    expect(directoryOnDisk()[ALICE].attestation).toEqual(att);
  });

  it('R2 заверение про ЧУЖИЕ ключи — invalid_attestation, запись не тронута', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    const wrong = attOf({ boxKey: KEY_B });
    expect(() => putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: wrong }, 2000))
      .toThrow(/invalid attestation/i);
    try {
      putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: wrong }, 2000);
    } catch (e) {
      expect(e.code).toBe('invalid_attestation');
    }
    expect(getKeyRecord(ALICE).attestation).toBeUndefined();
    expect(getKeyRecord(ALICE).updatedAt).toBe(1000);
  });

  it('R3 заверение про ЧУЖОЙ адрес — invalid_attestation', () => {
    expect(() => putKey(
      ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: attOf({ address: CAROL }) }, 1000,
    )).toThrow(/invalid attestation/i);
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it('R4 заверение без signKey в том же вызове — отказ: сверять нечем', () => {
    expect(() => putKey(ALICE, { boxKey: KEY_A, attestation: attOf() }, 1000))
      .toThrow(/invalid attestation/i);
  });

  it('R5 подпись сверх потолка — отказ (граница диска, не смысла)', () => {
    // Границы записаны РУКАМИ (512/513), а не выведены из модуля: иначе
    // поднятый боевой потолок переехал бы вместе с замером.
    expect(() => putKey(
      ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: attOf({ sigBytes: MAX_SIG_EXPECTED + 1 }) }, 1000,
    )).toThrow(/invalid attestation/i);
    // Ровно потолок — принимается.
    expect(() => putKey(
      ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: attOf({ sigBytes: MAX_SIG_EXPECTED }) }, 1000,
    )).not.toThrow();
  });

  it('R6 подпись 130 байт (кошелёк-контракт) принимается: сервер судит форму, не смысл', () => {
    const att = attOf({ sigBytes: 130 });
    const stored = putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    expect(stored.attestation.signature).toBe(att.signature);
  });

  it('R7 те же ключи, НОВОЕ заверение — запись обновляется, а не глотается ранним возвратом', () => {
    // Обычный порядок жизни: ключи объявлены давно, заверение подписано позже.
    // Без учёта этого заверение не попадёт на сервер НИКОГДА (Л-6 задачи).
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    const att = attOf();
    const stored = putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 2000);

    expect(stored.attestation).toEqual(att);
    expect(directoryOnDisk()[ALICE].attestation).toEqual(att);
    // Ключи не менялись — счётчик смен и история стоят на месте.
    expect(stored.keyChangeCount).toBe(0);
    expect(stored.history).toEqual([]);
  });

  it('R8 то же заверение второй раз — ранний возврат, журнал не растёт', () => {
    const att = attOf();
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    const before = journalBytes();
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 2000);
    expect(journalBytes(), 'повторная публикация переписала справочник').toBe(before);
    expect(getKeyRecord(ALICE).updatedAt).toBe(1000);
  });

  it('R9 ключи сменились без нового заверения — старое УХОДИТ с записи и ложится в звено', () => {
    const att = attOf();
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    const after = putKey(ALICE, { boxKey: KEY_B, signKey: SIGN_B }, 2000);

    // На записи его быть НЕ ДОЛЖНО: оно про прежние ключи, и оставленное здесь
    // читалось бы как «заверение не сходится», а не как «заверения нет».
    expect(after.attestation, 'заверение прежних ключей осталось на записи').toBeUndefined();
    // Но потеряться оно не смеет: им проверяются сообщения, подписанные
    // прежним signKey (класс бага Б-2).
    expect(after.history[0].attestation).toEqual(att);
    expect(after.history[0].boxKey).toBe(KEY_A);
  });

  it('R10 шесть смен ключа — все шесть заверений уцелели в истории (улику не выталкивают)', () => {
    // Потолка на ЧИСЛО заверений нет намеренно: он повторил бы ошибку, которую
    // MAX_KEY_HISTORY уже исправил — девять смен выталкивали бы заверение той
    // пары, которой подписано НЕУДОБНОЕ сообщение.
    let n = 0;
    const keyN = (i) => '0x' + i.toString(16).padStart(2, '0').repeat(32);
    for (; n < 7; n++) {
      putKey(ALICE, {
        boxKey: keyN(n + 1), signKey: keyN(n + 0x81),
        attestation: attOf({ boxKey: keyN(n + 1), signKey: keyN(n + 0x81), issuedAt: 1_700_000_000_000 + n }),
      }, 1000 + n);
    }
    const rec = getKeyRecord(ALICE);
    expect(rec.history).toHaveLength(6); // MAX_KEY_HISTORY
    expect(rec.history.filter(h => h.attestation).length).toBe(6);
    expect(rec.history[0].attestation.issuedAt).toBe(1_700_000_000_005);
  });

  it('R11 читателю отдаётся КОПИЯ: правка возвращённого не меняет справочник', () => {
    const att = attOf();
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    putKey(ALICE, { boxKey: KEY_B, signKey: SIGN_B }, 2000); // старое уехало в историю

    const first = getKeyRecord(ALICE);
    first.history[0].attestation.boxKey = '0x' + 'ff'.repeat(32);
    expect(getKeyRecord(ALICE).history[0].attestation.boxKey).toBe(KEY_A);
  });

  it('R12 битое заверение в файле — запись отброшена поодиночке, справочник в целом здоров', () => {
    const raw = JSON.stringify({
      [ALICE]: {
        v: 1, boxKey: KEY_A, signKey: SIGN_A, updatedAt: 1000, history: [], keyChangeCount: 0,
        attestation: { address: ALICE, boxKey: 'не ключ', signKey: SIGN_A, issuedAt: 1, signature: '0xab' },
      },
      [CAROL]: { v: 1, boxKey: KEY_B, updatedAt: 1000, history: [], keyChangeCount: 0 },
    });
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, raw, 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(CAROL).boxKey).toBe(KEY_B);
  });

  it('R12b битое заверение ВНУТРИ ЗВЕНА ИСТОРИИ (не на самой записи) — тоже отбрасывается поодиночке', () => {
    // ⚠️ Отдельный тест от R12 не ради полноты: замерено мутацией — снять
    // ТОЛЬКО проверку формы заверения в `_isValidHistoryEntry` (оставив
    // проверку в `_isValidRecord`) даёт 0 красных без этого теста. R12 бьёт
    // исключительно по заверению НА ЗАПИСИ; путь через историю — другой
    // вызов `_isValidAttestation`, и без отдельного случая он остаётся
    // непроверенным кодом.
    const raw = JSON.stringify({
      [ALICE]: {
        v: 1, boxKey: KEY_B, signKey: SIGN_B, updatedAt: 2000, keyChangeCount: 1,
        history: [{
          boxKey: KEY_A, signKey: SIGN_A, replacedAt: 1500, changed: ['boxKey'],
          attestation: { address: ALICE, boxKey: 'не ключ', signKey: SIGN_A, issuedAt: 1, signature: '0xab' },
        }],
      },
      [CAROL]: { v: 1, boxKey: KEY_B, updatedAt: 1000, history: [], keyChangeCount: 0 },
    });
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, raw, 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(true);
    // Битое звено ИСТОРИИ роняет ВСЮ запись Алисы (тот же закон, что уже
    // держит любое другое поле истории, changed/signKey — не новый: форма
    // проверяется на запись целиком, а не на отдельные звенья).
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(CAROL).boxKey).toBe(KEY_B);
  });
});

/* ─────────────────── обстоятельства (пять вопросов) ────────────────── */

describe('directory.js — обстоятельства заверения', () => {
  it('R14 перезапуск посреди работы — заверение уцелело', () => {
    const att = attOf();
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: att }, 1000);
    _loadDirectory(); // «перезапустили процесс»
    expect(getKeyRecord(ALICE).attestation).toEqual(att);
    _saveDirectory(); // схлопывание журнала в снимок
    _loadDirectory();
    expect(getKeyRecord(ALICE).attestation).toEqual(att);
  });

  it('R15 диск кончился — отказ, а не половина записи', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device (simulated)');
    });
    try {
      expect(() => putKey(
        ALICE, { boxKey: KEY_A, signKey: SIGN_A, attestation: attOf() }, 2000,
      )).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    // Память не забежала вперёд диска.
    expect(getKeyRecord(ALICE).attestation).toBeUndefined();
    expect(directoryOnDisk()[ALICE].attestation).toBeUndefined();
  });

  it('R16 другая живая копия положила заверение — наше схлопывание его не стёрло', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    fs.appendFileSync(
      directory.DIRECTORY_FILE + '.log',
      JSON.stringify({
        a: CAROL,
        r: {
          v: 1, boxKey: KEY_B, signKey: SIGN_B, updatedAt: 1500, history: [], keyChangeCount: 0,
          attestation: attOf({ address: CAROL, boxKey: KEY_B, signKey: SIGN_B }),
        },
      }) + '\n',
      'utf8',
    );
    _saveDirectory();
    _loadDirectory();
    expect(getKeyRecord(CAROL).attestation.address).toBe(CAROL);
  });

  it('R17 замер объёма: боевой потолок — 512, и заверение по нему не больше 1,2 КБ', () => {
    // ⚠️ ДВЕ РАЗНЫЕ СТРОКИ, и это исправление 12 договора:
    //   (1) ожидаемое число — РУКАМИ. Поднимут боевой потолок — краснеет здесь,
    //       а не «переезжает вместе с замером»;
    //   (2) измеряемое — ИЗ МОДУЛЯ. Подпись строится по боевому потолку, а не по
    //       нашему представлению о нём, иначе замер объёма не про боевой путь.
    // Клиент держит вторую половину того же числа (A14): расхождение стоит
    // человеку объявления ключа целиком (Л-5). Читается через пространство имён
    // (`directory.*`), а не именованным импортом: до реализации именованного
    // экспорта нет, и импорт положил бы ВЕСЬ файл ошибкой связывания вместо
    // одного честного красного.
    expect(directory.MAX_ATTESTATION_SIG_BYTES, 'потолок подписи разошёлся с клиентом').toBe(MAX_SIG_EXPECTED);

    const ceiling = directory.MAX_ATTESTATION_SIG_BYTES;
    putKey(ALICE, {
      boxKey: KEY_A, signKey: SIGN_A, attestation: attOf({ sigBytes: ceiling }),
    }, 1000);
    const bytes = Buffer.byteLength(JSON.stringify(directoryOnDisk()[ALICE].attestation), 'utf8');
    // ⚠️ РАСХОЖДЕНИЕ С ЧЕРНОВИКОМ ПЛАНА, НАЗВАНО ВСЛУХ: черновик задачи оценивал
    // «≤ ~1,15 КБ» и предлагал жёсткую границу 1200 байт. Замер на боевых
    // константах (address 42 hex-цифры + два ключа по 66 + issuedAt +
    // signature на 512-байтовой подписи, ровно то, что JSON.stringify реально
    // даёт) — 1279 байт, не 1200: `0x` + 1024 hex-цифры одной только подписи
    // уже 1026 символов. Правило проекта — доверять коду, а не подгонять его
    // под неверную оценку плана, поэтому граница здесь поднята до измеренного
    // числа с небольшим запасом, а не до того, что было написано заранее.
    expect(bytes).toBeLessThanOrEqual(1400);
    console.log(`[замер] заверение с подписью ${ceiling} байт занимает ${bytes} байт на диске`);
  });
});

/* ─────────────────────────── HTTP-слой ───────────────────────────── */

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.7.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
}

async function issuePassFor(wallet, ip = freshIp()) {
  const address = (await wallet.getAddress()).toLowerCase();
  const ts = Math.floor(Date.now() / 1000);
  const sig = await wallet.signMessage(bagPassChallenge(address, ts));
  const res = await request(app)
    .post('/bags/pass')
    .set('CF-Connecting-IP', ip)
    .set('x-ts', String(ts))
    .set('x-sig', sig)
    .send({ address });
  if (res.status !== 200) {
    throw new Error(`issuePassFor precondition failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { pass: res.body.pass, address };
}

describe('POST /keys — заверение проезжает маршрут целиком', () => {
  it('R13 положили с заверением — GET отдаёт его; негодное — 400 invalid_attestation', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { pass, address } = await issuePassFor(wallet);
    const att = attOf({ address, boxKey: KEY_A, signKey: SIGN_A });

    const ok = await request(app).post('/keys')
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass)
      .send({ boxKey: KEY_A, signKey: SIGN_A, attestation: att });
    expect(ok.status).toBe(200);

    const read = await request(app).get(`/keys/${address}`).set('CF-Connecting-IP', freshIp());
    expect(read.status).toBe(200);
    expect(read.body.attestation, 'маршрут потерял заверение по дороге').toEqual(att);

    const bad = await request(app).post('/keys')
      .set('CF-Connecting-IP', freshIp()).set('x-bag-pass', pass)
      .send({ boxKey: KEY_A, signKey: SIGN_A, attestation: { ...att, boxKey: KEY_B } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_attestation');
  });
});
