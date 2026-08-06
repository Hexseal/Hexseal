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
//
// ⚠️ Раунд 2 (ревью координатора, находки И-1/И-2): поле переименовано
// key → boxKey (честно: это ключ ЗАПЕЧАТЫВАНИЯ, не проверки подписи —
// signKey заведён рядом, пока всегда пуст), потолок истории поднят 20→200,
// заведены keyChangeCount (никогда не обрезается) и historyTruncated
// (честное "не знаю" вместо неверного ответа). Живые умолчания (200/20/120)
// проверяются ОТДЕЛЬНО, в test/directoryLiveDefaults.test.js — этот файл
// продолжает переопределять их маленькими числами для дешёвых границ.

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
// применяет к BAG_*_RATE_MAX). Боевое умолчание проверяется отдельно, БЕЗ
// переопределения — test/directoryLiveDefaults.test.js (раунд 2, находка
// координатора: "боевое умолчание истории 20 → миллион" пережила 645
// зелёных именно потому, что ни один тест не смотрел на настоящее число).
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
const SIGN_A = '0x' + 'aa'.repeat(32);
const SIGN_B = '0x' + 'bb'.repeat(32);

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

  it('putKey сохраняет boxKey, версию, нулевой счётчик смен, false-truncated', () => {
    const stored = putKey(ALICE, { boxKey: KEY_A }, 1000);
    expect(stored.boxKey).toBe(KEY_A);
    expect(stored.updatedAt).toBe(1000);
    expect(typeof stored.v).toBe('number');
    expect(stored.keyChangeCount).toBe(0);
    expect(stored.historyTruncated).toBe(false);
    expect(stored.signKey).toBeUndefined();

    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_A);
    expect(rec.updatedAt).toBe(1000);
    expect(rec.history).toEqual([]);
    expect(rec.keyChangeCount).toBe(0);
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
    // Мелочь (ревью координатора, round 2): раньше верхний регистр
    // принимался и молча приводился к нижнему — строковое сравнение на
    // клиенте (например, "тот же ли ключ я только что отправил") могло
    // разойтись с тем, что реально хранит сервер. Форма, в которой ключ
    // реально приходит из жизни (viem bytesToHex), — ВСЕГДА нижний регистр;
    // отвергаем, а не подстраиваемся. 'ab' (не '11') — цифры регистра не
    // меняют, нужны настоящие hex-буквы, иначе .toUpperCase() — молчаливый
    // no-op и мутация этого теста не поймала бы вообще ничего.
    ['верхний регистр (не coerce, а отказ)', '0x' + 'ab'.repeat(32).toUpperCase()],
    // Мелочь (ревью координатора, round 2): все-нулевой X25519-ключ — один
    // из известных вырожденных low-order-точек кривой (RFC 7748 §5) —
    // запечатать на него можно, но результат крипто-бессмыслен; чаще всего
    // это сигнатура неинициализированного буфера на клиенте, а не
    // настоящий ключ. Отклоняем по форме, не пытаясь понять природу байт.
    ['все нули (вырожденный X25519-ключ)', '0x' + '00'.repeat(32)],
  ])('putKey отвергает мусорный boxKey (%s) с кодом invalid_key, не меняя справочник', (_label, badKey) => {
    expect(() => putKey(ALICE, { boxKey: badKey }, 1000)).toThrow();
    try {
      putKey(ALICE, { boxKey: badKey }, 1000);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('invalid_key');
    }
    // Мутация: без этой проверки putKey мог бы забраковать вход, но всё
    // равно записать пустую/частичную запись — здесь адрес обязан остаться
    // ровно таким же, каким был до вызова (отсутствующим).
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it.each([
    ['голая строка вместо {boxKey}', KEY_A],
    ['null вместо {boxKey}', null],
    ['массив вместо {boxKey}', [KEY_A]],
  ])('putKey отвергает keys целиком не-объектом (%s) с кодом invalid_key', (_label, badKeys) => {
    try {
      putKey(ALICE, badKeys, 1000);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('invalid_key');
    }
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it('замена boxKey сохраняет старый в истории, двигает updatedAt и keyChangeCount', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_B);
    expect(rec.updatedAt).toBe(2000);
    expect(rec.history).toEqual([{ boxKey: KEY_A, replacedAt: 2000 }]);
    expect(rec.keyChangeCount).toBe(1);
  });

  it('повторная отправка ТОГО ЖЕ boxKey не создаёт запись в истории, не двигает keyChangeCount и НЕ ДВИГАЕТ updatedAt', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    // И-2 (находка координатора, round 2): раньше updatedAt переписывался
    // на nowMs даже при идентичной повторной отправке — "с какого момента
    // ключ действует" становилось невосстановимо для адреса, который
    // вообще никогда не менял ключ. nowMs здесь заведомо ПОЗЖЕ (5000) —
    // если бы отметка двигалась, тест поймал бы это напрямую по числу.
    putKey(ALICE, { boxKey: KEY_A }, 5000);

    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_A);
    expect(rec.history).toEqual([]);
    expect(rec.keyChangeCount).toBe(0);
    expect(rec.updatedAt).toBe(1000); // НЕ 5000
  });

  it('signKey необязателен: putKey без него оставляет поле отсутствующим', () => {
    const stored = putKey(ALICE, { boxKey: KEY_A }, 1000);
    expect(stored.signKey).toBeUndefined();
    expect(getKeyRecord(ALICE).signKey).toBeUndefined();
  });

  it('signKey сохраняется и переживает последующий putKey без него', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    expect(getKeyRecord(ALICE).signKey).toBe(SIGN_A);

    // Второй вызов не передаёт signKey вовсе — не должен стереть уже сохранённый.
    putKey(ALICE, { boxKey: KEY_A }, 2000);
    expect(getKeyRecord(ALICE).signKey).toBe(SIGN_A);
  });

  it('смена ТОЛЬКО signKey (boxKey тот же) не создаёт запись в истории, не двигает updatedAt/keyChangeCount', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_B }, 5000);

    const rec = getKeyRecord(ALICE);
    expect(rec.signKey).toBe(SIGN_B);
    expect(rec.boxKey).toBe(KEY_A);
    expect(rec.history).toEqual([]);
    expect(rec.keyChangeCount).toBe(0);
    expect(rec.updatedAt).toBe(1000);
  });

  it.each([
    ['слишком короткий', '0x1234'],
    ['не hex', '0x' + 'zz'.repeat(32)],
    ['число', 42],
  ])('putKey отвергает мусорный signKey (%s) с кодом invalid_key, не меняя справочник', (_label, badSignKey) => {
    try {
      putKey(ALICE, { boxKey: KEY_A, signKey: badSignKey }, 1000);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('invalid_key');
    }
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it('история капается на MAX_KEY_HISTORY (=4 в тесте), но keyChangeCount считает ВСЕ смены и не обрезается', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    // Пять смен подряд разными ключами — потолок 4 в тесте (env выше),
    // итого 6 настоящих смен считая самую первую регистрацию как "смену 0".
    for (let i = 0; i < 6; i++) {
      putKey(ALICE, { boxKey: '0x' + String(i).padStart(2, '9') + '00'.repeat(31) }, 2000 + i);
    }
    const rec = getKeyRecord(ALICE);
    expect(rec.history.length).toBe(4);
    // Мутация числом: если бы потолок не работал, длина была бы 6, не 4.
    expect(rec.history.some(h => h.boxKey === KEY_A)).toBe(false);
    // И-2, находка координатора: keyChangeCount — 6 (шесть настоящих смен
    // произошло), а не 4 (не путается с длиной обрезанной истории).
    expect(rec.keyChangeCount).toBe(6);
    // historyTruncated честно говорит "не всё уцелело" — 6 > 4.
    expect(rec.historyTruncated).toBe(true);
  });

  it('historyTruncated остаётся false, пока смен меньше или равно потолку', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000); // 1 смена, потолок 4 — не превышен
    const rec = getKeyRecord(ALICE);
    expect(rec.keyChangeCount).toBe(1);
    expect(rec.historyTruncated).toBe(false);
  });

  it('переживает перезапуск процесса: putKey → перечитать файл заново → данные на месте', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    // Симулирует рестарт: сбрасывает in-memory состояние модуля тем же
    // приёмом, каким сервер грузит справочник при старте — читает файл с
    // диска заново, не полагаясь на память процесса.
    _loadDirectory();

    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_B);
    expect(rec.history).toEqual([{ boxKey: KEY_A, replacedAt: 2000 }]);
    expect(rec.keyChangeCount).toBe(1);
  });

  it('запись на диск атомарна: файл всегда валидный JSON, содержит адрес после putKey', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    expect(raw[ALICE].boxKey).toBe(KEY_A);
  });

  // Мелочь (ревью координатора, round 2): "51 крах — 51 файл, уборки нет".
  // Крах ровно между writeFileSync и renameSync (кончилось место, процесс
  // убит) оставляет `.tmp-*` осколок в STORAGE_DIR навсегда — ни один
  // штатный путь этого модуля его не видит (_loadDirectory читает только
  // DIRECTORY_FILE по имени). Тот же приём, что sweepStaleTmpFiles() в
  // bagStore.js: подчищаем осколки СТАРШЕ часа (заведомо дольше, чем может
  // идти одна запись+переименование в норме) — не трогаем свежие, чтобы не
  // забежать вперёд ещё идущей записи другого процесса. Опортунистично, при
  // следующей УСПЕШНОЙ записи — не отдельным расписанием (у directory.js,
  // в отличие от bagStore.js, нет ночного cron-цикла, который мог бы это
  // сделать вместо этого).
  it('осиротевшие .tmp-* файлы старше часа подчищаются при следующей успешной записи, свежие не трогаются', () => {
    const dir = path.dirname(directory.DIRECTORY_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const stalePath = path.join(dir, `${path.basename(directory.DIRECTORY_FILE)}.tmp-99999-1-aaaa`);
    const freshPath = path.join(dir, `${path.basename(directory.DIRECTORY_FILE)}.tmp-99999-2-bbbb`);
    fs.writeFileSync(stalePath, 'orphan');
    fs.writeFileSync(freshPath, 'orphan');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, twoHoursAgo, twoHoursAgo);
    // freshPath держит "сейчас" mtime — как если бы это была ещё идущая
    // запись другого процесса; метла обязана её не тронуть.

    try {
      putKey(ALICE, { boxKey: KEY_A }, 1000); // успешная запись — триггер метлы

      expect(fs.existsSync(stalePath)).toBe(false);
      expect(fs.existsSync(freshPath)).toBe(true);
    } finally {
      fs.rmSync(freshPath, { force: true });
    }
  });

  it('деep-копия: мутация возвращённой записи (getKeyRecord) не портит состояние модуля', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    const rec = getKeyRecord(ALICE);
    // Мутируем то, что нам вернули — как это сделала бы небрежная
    // вызывающая сторона (случайно переиспользовала объект).
    rec.history[0].boxKey = '0x' + 'ff'.repeat(32);
    rec.history.push({ boxKey: '0x' + 'ee'.repeat(32), replacedAt: 9999 });

    // Мутация замка: без деep-копии оба изменения выше отразились бы на
    // ВНУТРЕННЕМ состоянии модуля — следующий независимый вызов
    // getKeyRecord() тоже увидел бы испорченное звено и лишний элемент.
    const rec2 = getKeyRecord(ALICE);
    expect(rec2.history[0].boxKey).toBe(KEY_A);
    expect(rec2.history.length).toBe(1);
  });

  it('деep-копия: putKey() тоже отдаёт свежие объекты-звенья, не разделяемые с модулем', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    const stored = putKey(ALICE, { boxKey: KEY_B }, 2000);
    stored.history[0].boxKey = '0x' + 'ff'.repeat(32);

    const rec = getKeyRecord(ALICE);
    expect(rec.history[0].boxKey).toBe(KEY_A);
  });

  // И-1 (ревью координатора, round 2, вторая половина находки — целиком
  // моя): раньше _loadDirectory() пересобирала запись, явно перечисляя
  // только known-поля — любое постороннее поле стиралось молча на КАЖДОЙ
  // загрузке. Ломающая миграция, обнаруживаемая не сразу.
  it('неизвестное поле переживает ЗАГРУЗКУ (форма записи вперёд-совместима)', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify({
      [ALICE]: {
        v: 7, // гипотетическая будущая версия — не должна отвергаться
        boxKey: KEY_A,
        updatedAt: 1000,
        history: [],
        keyChangeCount: 0,
        futureField: 'написано версией кода, которой ещё нет',
      },
    }), 'utf8');
    _loadDirectory();

    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_A);
    expect(rec.v).toBe(7);
    expect(rec.futureField).toBe('написано версией кода, которой ещё нет');
  });

  it('неизвестное поле переживает и ПОСЛЕДУЮЩУЮ ЗАПИСЬ, не только загрузку', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify({
      [ALICE]: {
        v: 7,
        boxKey: KEY_A,
        updatedAt: 1000,
        history: [],
        keyChangeCount: 0,
        futureField: 'написано версией кода, которой ещё нет',
      },
    }), 'utf8');
    _loadDirectory();

    // Этот процесс (текущая версия кода) не понимает futureField, но
    // всё равно меняет boxKey — putKey() не имеет права стереть то, чего
    // не понимает, просто потому что он что-то ДРУГОЕ поменял.
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    // Мутация: без spread `...existing` в putKey() запись пересобиралась
    // бы заново только из known-полей — futureField пропал бы уже здесь,
    // на первой же записи ПОСЛЕ загрузки, даже если бы сама загрузка его
    // сохраняла честно.
    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_B);
    expect(rec.futureField).toBe('написано версией кода, которой ещё нет');

    // И на диске — не только в памяти этого процесса.
    _loadDirectory();
    expect(getKeyRecord(ALICE).futureField).toBe('написано версией кода, которой ещё нет');
  });

  it('потолок истории применяется и ПРИ ЗАГРУЗКЕ, не только при следующей смене (И-2)', () => {
    // На диске — история длиннее текущего MAX_KEY_HISTORY (4 в тесте),
    // как если бы её писала версия/окружение с бОльшим потолком, а читает
    // — с меньшим (администратор понизил ручку). recordBag-стиль: пишем
    // файл руками, не через putKey (у putKey и так есть свой тест на
    // применение потолка на ЗАПИСИ, это тест именно про ЧТЕНИЕ).
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    const bigHistory = Array.from({ length: 9 }, (_, i) => ({
      boxKey: '0x' + String(i).padStart(2, '8') + '00'.repeat(31),
      replacedAt: 1000 + i,
    }));
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify({
      [ALICE]: { v: 1, boxKey: KEY_A, updatedAt: 2000, history: bigHistory, keyChangeCount: 9 },
    }), 'utf8');
    _loadDirectory();

    const rec = getKeyRecord(ALICE);
    // Мутация числом: без применения потолка на загрузке длина осталась
    // бы 9, не 4 — и жила бы так до следующей смены ключа этого адреса.
    expect(rec.history.length).toBe(4);
    expect(rec.keyChangeCount).toBe(9); // счётчик НЕ обрезается никогда
    expect(rec.historyTruncated).toBe(true);
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
    try { putKey(ALICE, { boxKey: KEY_A }, 1000); } catch (e) { expect(e.code).toBe('directory_unavailable'); }

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
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(BOB, { boxKey: KEY_B }, 1000);

    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    raw[ALICE] = { boxKey: 'не ключ', updatedAt: 'не число', history: 'не массив', keyChangeCount: 'не число' };
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(raw), 'utf8');
    _loadDirectory();

    // Мутация: без этого различия порча ОДНОЙ записи вела бы себя как порча
    // ВСЕГО файла (isDirectoryHealthy() === false), закрывая доступ и к Bob,
    // хотя его запись цела и валидна.
    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(BOB).boxKey).toBe(KEY_B);
  });

  it('запись с all-zero boxKey на диске (обошла putKey рукой) отбрасывается при загрузке как повреждённая', () => {
    putKey(BOB, { boxKey: KEY_B }, 1000);

    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    raw[ALICE] = { v: 1, boxKey: '0x' + '00'.repeat(32), updatedAt: 1000, history: [], keyChangeCount: 0 };
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(raw), 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(BOB).boxKey).toBe(KEY_B);
  });

  it('нет файла вообще — легитимная пустота (свежая установка), не потеря доверия', () => {
    // beforeEach уже удалил файл — проверяем явно, что это не то же самое,
    // что порча.
    expect(fs.existsSync(directory.DIRECTORY_FILE)).toBe(false);
    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
  });

  it('пустой объект {} на диске (не отсутствие файла) — тоже легитимная пустота, не потеря доверия', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, '{}', 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
  });
});

// ─── C1 (ревью координатора, round 3, КРИТИЧЕСКАЯ): все записи не прошли
// форму ≠ "отбросили несколько кривых, остальное здоровое". Если ОТБРОШЕНЫ
// ВСЕ записи (и их было больше нуля), это неотличимо от "формат целиком
// незнаком этому коду" (откат релеера на код, который ещё не знает
// boxKey — рассинхрон, который эта же задача и создала переименованием
// поля; или накат обратно после отката; или будущий signKey другого
// размера) — а НЕ от "каждый адрес одновременно испортился по отдельности
// случайно". Без этого замка: справочник объявляет себя здоровым и пустым,
// GET отвечает 404 key_not_found (= "вы никогда не регистрировались") для
// КАЖДОГО адреса, что реально был на диске, а первая же запись ЛЮБОГО
// постороннего адреса переписывает файл одной этой записью — навсегда.
// Ровно тот урок, на который bagStore.js потратил шесть раундов, и шапка
// этого же модуля обещает: полная потеря обязана быть громкой.
describe('directory.js — C1: ВСЕ записи не прошли форму — тоже потеря доверия, не "здоров и пуст"', () => {
  it('откат ревизии: файл в СТАРОМ формате (только key, без boxKey) — распознаётся как потеря доверия, файл НЕ переписан', () => {
    // Симулирует ровно то, что нашёл координатор: старая (округлённая до
    // Задачи 2, до И-1) ревизия писала record = {key, updatedAt, history}
    // — новый код требует boxKey, старый формат для него полностью чужой.
    const oldFormatRaw = JSON.stringify({
      [ALICE]: { key: '0x' + '11'.repeat(32), updatedAt: 1000, history: [] },
      [BOB]:   { key: '0x' + '22'.repeat(32), updatedAt: 2000, history: [] },
    });
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, oldFormatRaw, 'utf8');
    _loadDirectory();

    // Мутация: без этого замка isDirectoryHealthy() был бы true, а оба
    // getKeyRecord() — null (не throw) вместо directory_unavailable.
    expect(isDirectoryHealthy()).toBe(false);
    expect(() => getKeyRecord(ALICE)).toThrow();
    try { getKeyRecord(ALICE); } catch (e) { expect(e.code).toBe('directory_unavailable'); }

    // Главное: файл СТАРОГО формата — улика, не мусор. Первая же запись
    // постороннего адреса (Chuck) НЕ должна переписать его одной записью.
    expect(() => putKey('0x' + 'c4' + '0'.repeat(38), { boxKey: KEY_A }, 3000))
      .toThrow();
    expect(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8')).toBe(oldFormatRaw);
  });

  it('все записи повреждены по РАЗНЫМ причинам (не одна и та же) — всё равно потеря доверия целиком', () => {
    const raw = JSON.stringify({
      [ALICE]: { boxKey: 'не ключ', updatedAt: 1000, history: [], keyChangeCount: 0 },
      [BOB]:   { boxKey: '0x' + '00'.repeat(32), updatedAt: 1000, history: [], keyChangeCount: 0 }, // all-zero
    });
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, raw, 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(false);
    expect(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8')).toBe(raw);
  });

  it('контраст: хотя бы ОДНА валидная запись среди прочих — остаётся частичной порчей, не переходит в недоверие целиком', () => {
    const raw = JSON.stringify({
      [ALICE]: { boxKey: 'не ключ', updatedAt: 1000, history: [], keyChangeCount: 0 }, // битая
      [BOB]:   { v: 1, boxKey: KEY_B, updatedAt: 1000, history: [], keyChangeCount: 0 }, // валидная
    });
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, raw, 'utf8');
    _loadDirectory();

    // Ключевая граница C1: "не все" остаётся здоровым (как и было).
    expect(isDirectoryHealthy()).toBe(true);
    expect(getKeyRecord(ALICE)).toBeNull();
    expect(getKeyRecord(BOB).boxKey).toBe(KEY_B);
  });
});

describe('directory.js — диск кончился (Q2 отчёта)', () => {
  it('запись падает (диск полон) — putKey бросает, а не тихо теряет изменение; память откатывается к прежнему значению', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000); // прежнее, "хорошее" состояние

    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device (simulated)');
    });
    try {
      expect(() => putKey(ALICE, { boxKey: KEY_B }, 2000)).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    // Память НЕ забежала вперёд диска: неудавшаяся запись не оставила
    // ALICE указывающей на KEY_B, которого на диске никогда не было.
    expect(getKeyRecord(ALICE).boxKey).toBe(KEY_A);
    // И на диске лежит то же самое старое значение — ничего не рассинхронилось.
    const raw = JSON.parse(fs.readFileSync(directory.DIRECTORY_FILE, 'utf8'));
    expect(raw[ALICE].boxKey).toBe(KEY_A);
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

    const res = await postKeys({ body: { boxKey: KEY_A, address: addrA } });
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
    const res = await postKeys({ pass: passA, body: { boxKey: KEY_A, address: addrVictim } });
    expect(res.status).toBe(200);
    // Мутация: без правила 1 сервер прочитал бы address из тела — ключ
    // оказался бы у жертвы, а этот тест это заметил бы (addrVictim имел бы
    // ключ, addrA — нет).
    expect(res.body.address).toBe(addrA);

    const own = await getKeys(addrA);
    expect(own.status).toBe(200);
    expect(own.body.boxKey).toBe(KEY_A);

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
    const res = await postKeys({ pass, body: { boxKey: badKey } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_key');
  });
});

describe('POST /keys — правило 3: замена разрешена, старый ключ остаётся в истории', () => {
  it('вторая отправка меняет текущий, GET отдаёт историю со старым и keyChangeCount', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);

    await postKeys({ pass, body: { boxKey: KEY_A } });
    const second = await postKeys({ pass, body: { boxKey: KEY_B } });
    expect(second.status).toBe(200);
    expect(second.body.boxKey).toBe(KEY_B);

    const read = await getKeys(address);
    expect(read.status).toBe(200);
    expect(read.body.boxKey).toBe(KEY_B);
    expect(read.body.history).toEqual([{ boxKey: KEY_A, replacedAt: expect.any(Number) }]);
    expect(read.body.keyChangeCount).toBe(1);
    expect(read.body.historyTruncated).toBe(false);
  });

  it('signKey проходит по HTTP-границе целиком (POST принимает, GET отдаёт)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);

    const res = await postKeys({ pass, body: { boxKey: KEY_A, signKey: SIGN_A } });
    expect(res.status).toBe(200);
    expect(res.body.signKey).toBe(SIGN_A);

    const read = await getKeys(address);
    expect(read.body.signKey).toBe(SIGN_A);
  });
});

describe('GET /keys/:address — правило 4: чтение чужого без пропуска', () => {
  it('без заголовка x-bag-pass вообще — 200, не 401', async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = (await wallet.getAddress()).toLowerCase();
    const pass = await issuePassFor(wallet);
    await postKeys({ pass, body: { boxKey: KEY_A } });

    const res = await request(app).get(`/keys/${address}`).set('CF-Connecting-IP', freshIp());
    // Явно НЕ ставим x-bag-pass вовсе.
    expect(res.status).toBe(200);
    expect(res.body.boxKey).toBe(KEY_A);
  });

  it('чексуммированный адрес (как отдаёт кошелёк) находит ключ, зарегистрированный через пропуск', async () => {
    const wallet = ethers.Wallet.createRandom();
    const checksummed = ethers.getAddress(await wallet.getAddress()); // EIP-55, смешанный регистр
    const pass = await issuePassFor(wallet);
    await postKeys({ pass, body: { boxKey: KEY_A } });

    const res = await getKeys(checksummed);
    expect(res.status).toBe(200);
    expect(res.body.boxKey).toBe(KEY_A);
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
      postKeys({ pass, body: { boxKey: KEY_B } }),
      postKeys({ pass, body: { boxKey: KEY_C } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const read = await getKeys(address);
    // Порядок между двумя параллельными HTTP-запросами не детерминирован
    // (зависит от сети), но результат ОБЯЗАН быть непротиворечивым: текущий
    // ключ — один из двух, и ДРУГОЙ обязан оказаться в истории, а не
    // потеряться молча (что случилось бы при гонке read-modify-write).
    expect([KEY_B, KEY_C]).toContain(read.body.boxKey);
    const other = read.body.boxKey === KEY_B ? KEY_C : KEY_B;
    expect(read.body.history.some(h => h.boxKey === other)).toBe(true);
    expect(read.body.keyChangeCount).toBe(1);
  });
});

// ─── Замки на шесть находок ревью (round 2, координатор) ───────────────────
//
// «Числа работают, но следующая правка сломает их бесшумно» — шесть
// мутаций выживали на 645 зелёных. Каждая заперта отдельно ниже, тем же
// приёмом мутации-с-числом, что и остальной файл.

describe('directory.js — атомарность записи заперта напрямую (замок 1)', () => {
  // Тот же приём, что test/bagStore.test.js, describe "I2 — сохранение
  // индекса атомарно" — spyOn БЕЗ mockImplementation продолжает звать
  // настоящий fs.writeFileSync (наблюдает, не подменяет), прямое
  // доказательство, что путь записи отличается от основного файла, а не
  // косвенный вывод из отсутствия мусора после успеха.
  it('_saveDirectory пишет во временный путь, не напрямую в DIRECTORY_FILE', () => {
    const mainPath = directory.DIRECTORY_FILE;
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    expect(writeSpy).toHaveBeenCalled();
    const writtenPaths = writeSpy.mock.calls.map((call) => call[0]);
    expect(writtenPaths.length).toBeGreaterThan(0);
    expect(writtenPaths.every((p) => p !== mainPath)).toBe(true);
    writeSpy.mockRestore();

    const leftovers = fs.readdirSync(path.dirname(mainPath))
      .filter((f) => f.startsWith(`${path.basename(mainPath)}.tmp`));
    expect(leftovers).toEqual([]);
  });

  // Находка ревью: предыдущий тест запирает "запись идёт через временный
  // путь", но сам АТОМАРНЫЙ ШАГ ПУБЛИКАЦИИ (замена временного файла
  // основным) не заперт ничем — замена fs.renameSync на
  // fs.copyFileSync+fs.unlinkSync (НЕ атомарная публикация: между copy и
  // unlink возможно прерывание) молча проходит весь набор теста целиком,
  // включая тест выше (copyFileSync тоже пишет не в mainPath напрямую).
  it('публикация идёт через настоящий fs.renameSync(temp, DIRECTORY_FILE) — заперт напрямую', () => {
    const mainPath = directory.DIRECTORY_FILE;
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      putKey(ALICE, { boxKey: KEY_A }, 1000);
    } finally {
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [src, dest] = renameSpy.mock.calls[0];
      expect(dest).toBe(mainPath);
      expect(src).not.toBe(dest);
      expect(String(src)).toContain(`${path.basename(mainPath)}.tmp-`);
      renameSpy.mockRestore();
    }
  });
});

describe('/keys — лимитер заперт на обоих маршрутах (замок 2)', () => {
  // KEYS_WRITE_RATE_MAX='5' (env выше). Один адрес/пропуск, разные IP на
  // каждый вызов — так граница ловит именно АДРЕСНЫЙ бюджет записи, не
  // делится с IP-бюджетом (тот же приём, что test/bagRoutes.test.js,
  // "лимитер по адресу срабатывает на САМОМ PUT даже при разных IP").
  it('KEYS_WRITE_RATE_MAX срабатывает на POST /keys — 5 успехов, 6-й 429 rate_limited_write', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await issuePassFor(wallet, freshIp());

    for (let i = 0; i < 5; i++) {
      const res = await postKeys({ pass, body: { boxKey: KEY_A }, ip: freshIp() });
      expect(res.status).toBe(200);
    }
    const blocked = await postKeys({ pass, body: { boxKey: KEY_B }, ip: freshIp() });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_write');
  });

  // KEYS_IP_RATE_MAX='10' (env выше). Один IP, разные адреса/пропуска на
  // каждый вызов — граница ловит именно IP-бюджет, не адресный.
  it('KEYS_IP_RATE_MAX срабатывает на POST /keys — 10 успехов, 11-й 429 rate_limited_ip', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const wallet = ethers.Wallet.createRandom();
      const pass = await issuePassFor(wallet, freshIp()); // выпуск пропуска — свой IP, не тратит бюджет /keys
      const res = await postKeys({ pass, body: { boxKey: KEY_A }, ip });
      expect(res.status).toBe(200);
    }
    const walletLast = ethers.Wallet.createRandom();
    const passLast = await issuePassFor(walletLast, freshIp());
    const blocked = await postKeys({ pass: passLast, body: { boxKey: KEY_A }, ip });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_ip');
  });

  // Тот же IP-бюджет, но на GET — маршрут БЕЗ пропуска (правило 4), так что
  // единственная защита от долбёжки здесь вообще — этот лимитер. Отдельная
  // мутация ("снять лимитер только с GET, оставить на POST") иначе прошла
  // бы мимо предыдущего теста незамеченной.
  it('KEYS_IP_RATE_MAX срабатывает на GET /keys/:address — 10 успехов, 11-й 429 rate_limited_ip', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const wallet = ethers.Wallet.createRandom();
      const address = (await wallet.getAddress()).toLowerCase();
      const res = await getKeys(address, { ip });
      // Случайный кошелёк здесь никогда не регистрировал ключ — честные
      // 404, не 200. С точки зрения ЛИМИТЕРА это всё равно "прошёл", не
      // "заблокирован" — граница ниже (429) проверяется отдельно.
      expect(res.status).toBe(404);
    }
    const walletLast = ethers.Wallet.createRandom();
    const addressLast = (await walletLast.getAddress()).toLowerCase();
    const blocked = await getKeys(addressLast, { ip });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited_ip');
  });
});

// Свежий импорт directory.js под временно подменённым окружением — тот же
// приём, что withFreshBagStoreModule() в test/bagStore.test.js.
async function withFreshDirectoryModule(envOverrides, fn) {
  const saved = Object.fromEntries(Object.keys(envOverrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    const fresh = await import('../directory.js');
    return await fn(fresh);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    await import('../directory.js');
  }
}

describe('assertDirectoryReady — проверка MAX_KEY_HISTORY заперта напрямую (замок 3)', () => {
  it('молчит на годном значении по умолчанию', () => {
    expect(() => assertDirectoryReady()).not.toThrow();
  });

  it.each([
    ['0', '0'],
    ['-1', '-1'],
    ['не число', 'twenty'],
  ])('assertDirectoryReady бросает, когда MAX_KEY_HISTORY=%s, называя переменную', async (_label, value) => {
    await withFreshDirectoryModule({ MAX_KEY_HISTORY: value }, async (fresh) => {
      expect(() => fresh.assertDirectoryReady()).toThrow(/MAX_KEY_HISTORY/);
    });
  });
});

describe('assertDirectoryReady — окружение читается заново, не заморожено на импорте (замок 4, урок bagStore.js И-3)', () => {
  // Находка ревью: app.js зовёт dotenv.config() В ТЕЛЕ, после того как ESM
  // уже вычислил все импорты — тот же урок, что уже дважды кусал bagStore.js
  // и bagPass.js (см. их собственные комментарии над импортом в app.js).
  // Без повторного _refreshConfig() внутри assertDirectoryReady() STORAGE_DIR,
  // прочитанный НА ИМПОРТЕ (до dotenv), замораживался бы навсегда для
  // этого процесса — ровно как замораживался DIR_BAGS до фикса И-3 в
  // bagStore.js.
  it('поменять STORAGE_DIR ПОСЛЕ импорта модуля, позвать assertDirectoryReady() — DIRECTORY_FILE подхватывает новый путь', async () => {
    const storageDirAtImport = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-directory-lock4-import-'));
    const storageDirAfterDotenv = fs.mkdtempSync(path.join(os.tmpdir(), 'hexseal-directory-lock4-dotenv-'));
    const savedStorageDir = process.env.STORAGE_DIR;

    process.env.STORAGE_DIR = storageDirAtImport; // "до dotenv.config()"
    vi.resetModules();
    const fresh = await import('../directory.js'); // импорт — как в app.js, раньше dotenv

    try {
      process.env.STORAGE_DIR = storageDirAfterDotenv; // "dotenv.config() в теле app.js"
      fresh.assertDirectoryReady();

      expect(fresh.DIRECTORY_FILE).toBe(path.join(storageDirAfterDotenv, 'chat-key-directory.json'));

      // Не только имя пути — реальное поведение: запись после
      // assertDirectoryReady() обязана попасть на НОВЫЙ путь, не на старый.
      fresh.putKey(ALICE, { boxKey: KEY_A }, 1000);
      expect(fs.existsSync(path.join(storageDirAfterDotenv, 'chat-key-directory.json'))).toBe(true);
      expect(fs.existsSync(path.join(storageDirAtImport, 'chat-key-directory.json'))).toBe(false);
    } finally {
      process.env.STORAGE_DIR = savedStorageDir;
      fs.rmSync(storageDirAtImport, { recursive: true, force: true });
      fs.rmSync(storageDirAfterDotenv, { recursive: true, force: true });
      vi.resetModules();
      await import('../directory.js');
    }
  });
});
