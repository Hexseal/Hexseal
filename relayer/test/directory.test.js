// ─── Справочник открытых ключей чата (Задача 2, план «Клиент чата») ───────
//
// Два слоя тестов в одном файле — брифом Задачи 2 создаётся ровно один
// тестовый файл (в отличие от Задачи 1, где под маршруты был отдельный
// bagSenderView.test.js):
//   - модульный слой — прямые вызовы putKey()/getKeyRecord() из
//     relayer/directory.js: форма ключа, история, атомарная запись,
//     громкий отказ при потере/порче файла, откат в памяти при неудачной
//     записи на диск;
//   - HTTP-слой — POST /keys и GET /keys/:address через настоящий `app`
//     (relayer/app.js) с настоящим пропуском (`/bags/pass`), тот же приём,
//     что test/bagRoutes.test.js уже применяет: пять правил брифа проверяемы
//     ТОЛЬКО на границе HTTP (адрес из пропуска, а не из тела — это решение
//     маршрута, не модуля).
//
// Порядок «переменные окружения — до импорта» (урок bagStore.js, на который
// прямо ссылается бриф Задачи 2): STORAGE_DIR и остальные обязательные
// переменные выставлены здесь, на уровне модуля теста, ДО динамического
// import() и directory.js, и app.js — тот же приём, что bagStore.test.js/
// bagRoutes.test.js уже применяют.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import request from 'supertest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-directory-'));
process.env.STORAGE_DIR = TMP;
// Малый потолок истории — граничные тесты дешевле гонять на маленьком числе,
// чем на боевом умолчании (тот же приём, что test/bagRoutes.test.js уже
// применяет к BAG_*_RATE_MAX). Боевое умолчание (без переопределения) не
// тестируется отдельным "live defaults" файлом в этой задаче — сравни с
// test/bagRoutesLiveDefaults.test.js, который появился РЕАКТИВНО, после
// того как нашли конкретный провал; здесь такой находки пока нет.
process.env.MAX_KEY_HISTORY = '4';
// Маленькие бюджеты для быстрых границ лимитера — тот же приём, что и выше.
process.env.KEYS_WRITE_RATE_MAX = '5';
process.env.KEYS_IP_RATE_MAX    = '10';

const directory = await import('../directory.js');
const {
  putKey, getKeyRecord, assertDirectoryReady, isDirectoryHealthy, _loadDirectory,
} = directory;

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const BOB   = '0xb0b1000000000000000000000000000000005eed';

const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const KEY_C = '0x' + '33'.repeat(32);

beforeEach(() => {
  fs.rmSync(directory.DIRECTORY_FILE, { force: true });
  _loadDirectory();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── Модульный слой ─────────────────────────────────────────────────────────

describe('directory.js — форма и хранение', () => {
  it('свежая установка: неизвестный адрес — null, справочник здоров', () => {
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(isDirectoryHealthy()).toBe(true);
  });

  it('putKey сохраняет, getKeyRecord читает обратно тот же ключ', () => {
    const stored = putKey(ALICE, KEY_A, 1000);
    expect(stored.key).toBe(KEY_A);
    expect(stored.updatedAt).toBe(1000);

    const rec = getKeyRecord(ALICE);
    expect(rec.key).toBe(KEY_A);
    expect(rec.updatedAt).toBe(1000);
    expect(rec.history).toEqual([]);
  });

  // Правило 2: форма — 32 байта, hex. Мусор отвергается с кодом.
  it.each([
    ['слишком короткий', '0x' + '11'.repeat(16)],
    ['слишком длинный',  '0x' + '11'.repeat(40)],
    ['не hex',           '0x' + 'zz'.repeat(32)],
    ['без 0x',           '11'.repeat(32)],
    ['пустая строка',    ''],
    ['число вместо строки', 12345],
    ['массив вместо строки', ['0x' + '11'.repeat(32)]],
    ['объект вместо строки', { key: '0x' + '11'.repeat(32) }],
    ['null',             null],
    ['undefined',        undefined],
  ])('putKey отвергает мусорный ключ (%s) с кодом invalid_key, не меняя справочник', (_label, badKey) => {
    expect(() => putKey(ALICE, badKey, 1000)).toThrow();
    try {
      putKey(ALICE, badKey, 1000);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('invalid_key');
    }
    // Мутация: без этой проверки putKey мог бы забраковать вход, но всё
    // равно записать пустую/частичную запись — здесь адрес обязан остаться
    // ровно таким же, каким был до вызова (отсутствующим).
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it('замена ключа сохраняет старый в истории, с меткой времени замены', () => {
    putKey(ALICE, KEY_A, 1000);
    putKey(ALICE, KEY_B, 2000);

    const rec = getKeyRecord(ALICE);
    expect(rec.key).toBe(KEY_B);
    expect(rec.updatedAt).toBe(2000);
    expect(rec.history).toEqual([{ key: KEY_A, replacedAt: 2000 }]);
  });

  it('повторная отправка ТОГО ЖЕ ключа не создаёт запись в истории', () => {
    putKey(ALICE, KEY_A, 1000);
    putKey(ALICE, KEY_A, 2000);

    const rec = getKeyRecord(ALICE);
    expect(rec.key).toBe(KEY_A);
    expect(rec.history).toEqual([]);
  });

  it('история не растёт без предела — потолок MAX_KEY_HISTORY (=4 в тесте), хранит НОВЕЙШИЕ замены', () => {
    putKey(ALICE, KEY_A, 1000);
    // Пять смен подряд разными ключами — потолок 4 в тесте (env выше).
    for (let i = 0; i < 6; i++) {
      putKey(ALICE, '0x' + String(i).padStart(2, '9') + '00'.repeat(31), 2000 + i);
    }
    const rec = getKeyRecord(ALICE);
    expect(rec.history.length).toBe(4);
    // Мутация числом: если бы потолок не работал, длина была бы 6, не 4.
    // Если бы срез шёл не с того конца (хранил бы старейшие, не новейшие),
    // KEY_A (самая первая замена) остался бы в истории — его там быть не
    // должно, потолок обязан выталкивать САМОЕ старое.
    expect(rec.history.some(h => h.key === KEY_A)).toBe(false);
  });

  it('переживает перезапуск процесса: putKey → перечитать файл заново → данные на месте', () => {
    putKey(ALICE, KEY_A, 1000);
    putKey(ALICE, KEY_B, 2000);

    // Симулирует рестарт: сбрасывает in-memory состояние модуля тем же
    // приёмом, каким сервер грузит справочник при старте — читает файл с
    // диска заново, не полагаясь на память процесса.
    _loadDirectory();

    const rec = getKeyRecord(ALICE);
    expect(rec.key).toBe(KEY_B);
    expect(rec.history).toEqual([{ key: KEY_A, replacedAt: 2000 }]);
  });

  it('запись на диск атомарна: файл всегда валидный JSON, содержит адрес после putKey', () => {
    putKey(ALICE, KEY_A, 1000);
    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    expect(raw[ALICE].key).toBe(KEY_A);
  });
});

describe('directory.js — громкий отказ при потере/порче файла (урок bagStore.js)', () => {
  it('файл существует, но не JSON — режим недоверия: putKey/getKeyRecord бросают directory_unavailable, файл не тронут', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, 'это не json{{{', 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(false);
    expect(() => getKeyRecord(ALICE)).toThrow();
    try { getKeyRecord(ALICE); } catch (e) { expect(e.code).toBe('directory_unavailable'); }
    try { putKey(ALICE, KEY_A, 1000); } catch (e) { expect(e.code).toBe('directory_unavailable'); }

    // Битый файл — это улика, не мусор для уборки: НЕ переписан молча.
    expect(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8')).toBe('это не json{{{');
  });

  it('файл существует, JSON, но не объект (массив) — та же громкая потеря доверия', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, '[1,2,3]', 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(false);
    expect(() => getKeyRecord(ALICE)).toThrow();
  });

  it('порча ОДНОЙ записи не топит весь справочник — остальные адреса читаются, справочник здоров', () => {
    putKey(ALICE, KEY_A, 1000);
    putKey(BOB, KEY_B, 1000);

    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    raw[ALICE] = { key: 'не ключ', updatedAt: 'не число', history: 'не массив' };
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(raw), 'utf8');
    _loadDirectory();

    // Мутация: без этого различия порча ОДНОЙ записи вела бы себя как порча
    // ВСЕГО файла (isDirectoryHealthy() === false), закрывая доступ и к Bob,
    // хотя его запись цела и валидна.
    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(BOB).key).toBe(KEY_B);
  });

  it('нет файла вообще — легитимная пустота (свежая установка), не потеря доверия', () => {
    // beforeEach уже удалил файл — проверяем явно, что это не то же самое,
    // что порча.
    expect(fs.existsSync(directory.DIRECTORY_FILE)).toBe(false);
    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
  });
});

describe('directory.js — диск кончился (Q2 отчёта)', () => {
  it('запись падает (диск полон) — putKey бросает, а не тихо теряет изменение; память откатывается к прежнему значению', () => {
    putKey(ALICE, KEY_A, 1000); // прежнее, "хорошее" состояние

    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device (simulated)');
    });
    try {
      expect(() => putKey(ALICE, KEY_B, 2000)).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    // Память НЕ забежала вперёд диска: неудавшаяся запись не оставила
    // ALICE указывающей на KEY_B, которого на диске никогда не было.
    expect(getKeyRecord(ALICE).key).toBe(KEY_A);
    // И на диске лежит то же самое старое значение — ничего не рассинхронилось.
    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    expect(raw[ALICE].key).toBe(KEY_A);
  });
});

// ─── HTTP-слой ──────────────────────────────────────────────────────────────

let _ipCounter = 0;
function freshIp() {
  _ipCounter++;
  return `10.9.${(_ipCounter >> 8) & 255}.${_ipCounter & 255}`;
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
  return res.body.pass;
}

function postKeys({ pass, body, ip = freshIp() }) {
  const req = request(app).post('/keys').set('CF-Connecting-IP', ip);
  if (pass !== undefined) req.set('x-bag-pass', pass);
  return req.send(body);
}

function getKeys(address, { ip = freshIp() } = {}) {
  return request(app).get(`/keys/${address}`).set('CF-Connecting-IP', ip);
}

describe('POST /keys — правило 1: адрес берётся из пропуска, не из тела', () => {
  it('без x-bag-pass — 401, ключ никуда не сохранён', async () => {
    const walletA = ethers.Wallet.createRandom();
    const addrA = (await walletA.getAddress()).toLowerCase();

    const res = await postKeys({ body: { key: KEY_A, address: addrA } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBeDefined();

    const check = await getKeys(addrA);
    expect(check.status).toBe(404);
  });

  it('тело с чужим адресом не может положить ключ за другого — ключ ложится за держателя пропуска', async () => {
    const walletA = ethers.Wallet.createRandom();
    const walletVictim = ethers.Wallet.createRandom();
    const addrA = (await walletA.getAddress()).toLowerCase();
    const addrVictim = (await walletVictim.getAddress()).toLowerCase();

    const passA = await issuePassFor(walletA);

    // A держит пропуск НА СЕБЯ, но в теле указывает адрес жертвы.
    const res = await postKeys({ pass: passA, body: { key: KEY_A, address: addrVictim } });
    expect(res.status).toBe(200);
    // Мутация: без правила 1 сервер прочитал бы address из тела — ключ
    // оказался бы у жертвы, а этот тест это заметил бы (addrVictim имел бы
    // ключ, addrA — нет).
    expect(res.body.address).toBe(addrA);

    const own = await getKeys(addrA);
    expect(own.status).toBe(200);
    expect(own.body.key).toBe(KEY_A);

    const victim = await getKeys(addrVictim);
    expect(victim.status).toBe(404);
  });
});

describe('POST /keys — правило 2: форма ключа, мусор с кодом', () => {
  it.each([
    ['слишком короткий', '0x1234'],
    ['не hex', '0x' + 'zz'.repeat(32)],
    ['отсутствует', undefined],
    ['число', 42],
  ])('%s — 400, code invalid_key', async (_label, badKey) => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await issuePassFor(wallet);
    const res = await postKeys({ pass, body: { key: badKey } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_key');
  });
});

describe('POST /keys — правило 3: замена разрешена, старый ключ остаётся в истории', () => {
  it('вторая отправка меняет текущий, GET отдаёт историю со старым', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);

    await postKeys({ pass, body: { key: KEY_A } });
    const second = await postKeys({ pass, body: { key: KEY_B } });
    expect(second.status).toBe(200);
    expect(second.body.key).toBe(KEY_B);

    const read = await getKeys(address);
    expect(read.status).toBe(200);
    expect(read.body.key).toBe(KEY_B);
    expect(read.body.history).toEqual([{ key: KEY_A, replacedAt: expect.any(Number) }]);
  });
});

describe('GET /keys/:address — правило 4: чтение чужого без пропуска', () => {
  it('без заголовка x-bag-pass вообще — 200, не 401', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);
    await postKeys({ pass, body: { key: KEY_A } });

    const res = await request(app).get(`/keys/${address}`).set('CF-Connecting-IP', freshIp());
    // Явно НЕ ставим x-bag-pass вовсе.
    expect(res.status).toBe(200);
    expect(res.body.key).toBe(KEY_A);
  });

  it('чексуммированный адрес (как отдаёт кошелёк) находит ключ, зарегистрированный через пропуск', async () => {
    const wallet = ethers.Wallet.createRandom();
    const checksummed = ethers.getAddress(await wallet.getAddress()); // EIP-55, смешанный регистр
    const pass = await issuePassFor(wallet);
    await postKeys({ pass, body: { key: KEY_A } });

    const res = await getKeys(checksummed);
    expect(res.status).toBe(200);
    expect(res.body.key).toBe(KEY_A);
  });
});

describe('GET /keys/:address — правило 5: неизвестный адрес — 404 с кодом', () => {
  it('незнакомый адрес — 404, code key_not_found, не пустой 200', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const res = await getKeys(address);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('key_not_found');
  });

  it('мусорный адрес в URL — 400, не 404 (разные причины — разный код)', async () => {
    const res = await getKeys('not-an-address');
    expect(res.status).toBe(400);
  });
});

describe('Q3 — два запроса разом на один и тот же адрес не дерутся', () => {
  it('одновременные POST /keys с разными ключами для одного адреса — оба применяются по очереди, история честная', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);

    const [r1, r2] = await Promise.all([
      postKeys({ pass, body: { key: KEY_B } }),
      postKeys({ pass, body: { key: KEY_C } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const read = await getKeys(address);
    // Порядок между двумя параллельными HTTP-запросами не детерминирован
    // (зависит от сети), но результат ОБЯЗАН быть непротиворечивым: текущий
    // ключ — один из двух, и ДРУГОЙ обязан оказаться в истории, а не
    // потеряться молча (что случилось бы при гонке read-modify-write).
    expect([KEY_B, KEY_C]).toContain(read.body.key);
    const other = read.body.key === KEY_B ? KEY_C : KEY_B;
    expect(read.body.history.some(h => h.key === other)).toBe(true);
  });
});
