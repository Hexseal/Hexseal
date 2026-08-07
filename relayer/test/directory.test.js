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
  putKey, getKeyRecord, assertDirectoryReady, isDirectoryHealthy, _loadDirectory, _saveDirectory,
} = directory;

const { app } = await import('../app.js');
const { bagPassChallenge } = await import('../bagPass.js');

const ALICE = '0xa1ce00000000000000000000000000000000cafe';
const BOB   = '0xb0b1000000000000000000000000000000005eed';
const CAROL = '0xca401000000000000000000000000000000beef1'; // В-2: «другая копия» релеера

const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);
const KEY_C = '0x' + '33'.repeat(32);
const SIGN_A = '0x' + 'aa'.repeat(32);
const SIGN_B = '0x' + 'bb'.repeat(32);

// Справочник на диске — снимок ПЛЮС журнал дозаписи. Спрашиваем «что увидит
// перезапуск», а не «что лежит в одном конкретном файле»: иначе тест
// запирает выбор файла, а не сохранность.
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

beforeEach(() => {
  fs.rmSync(directory.DIRECTORY_FILE, { force: true });
  // Справочник — ДВА файла: снимок и журнал дозаписи. Журнал обязан
  // сноситься вместе со снимком, иначе он доигрывается поверх пустого
  // снимка и воскрешает записи предыдущего теста (поймано ровно так).
  fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true });
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
    expect(rec.history).toEqual([{ boxKey: KEY_A, replacedAt: 2000, changed: ["boxKey"] }]);
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

  // Мелочь (ревью координатора, round 3): байт-в-байт идентичная повторная
  // регистрация раньше ВСЁ РАВНО переписывала весь файл целиком — 15,5мс
  // вхолостую при 20 000 адресов (пункт 31 docs/OPEN-ITEMS.md), а клиент
  // чата будет слать свой ключ при КАЖДОМ запуске сеанса (lib/chatSession.ts,
  // Задача 4) — усиление пункта 31 обычным пользованием, без единого
  // нападающего. Тест выше проверяет ТОЛЬКО итог (history/keyChangeCount/
  // updatedAt не сдвинулись) — итог совпал бы и при полной перезаписи тем
  // же содержимым. Этот тест проверяет само ДЕЙСТВИЕ: диск не тронут вовсе.
  it('байт-в-байт идентичная повторная регистрация не пишет на диск вообще', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);

    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 5000);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
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

  // И-2 (ревью координатора, round 3): раньше история отслеживала ТОЛЬКО
  // boxKey — эта версия теста запирала потерю как правильное поведение
  // (координатор, дословно: "тест directory.test.js:195 запирает потерю
  // как правильное поведение"). Замер координатора: смена signKey трижды
  // при неизменном boxKey — history пуста, keyChangeCount ноль, признака
  // обрезки нет, прежний signKey стёрт с диска бесследно. Ровно тот ключ,
  // ради проверки которого история и заводится — переписано на верное
  // поведение: смена ЛЮБОГО из двух ключей создаёт звено, и в звене видно,
  // какой именно сменился (`changed`).
  it('смена ТОЛЬКО signKey (boxKey тот же) СОЗДАЁТ звено истории, двигает updatedAt/keyChangeCount, звено называет signKey', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_B }, 5000);

    const rec = getKeyRecord(ALICE);
    expect(rec.signKey).toBe(SIGN_B);
    expect(rec.boxKey).toBe(KEY_A);
    // Прежний signKey НЕ потерян — уцелел в звене истории.
    expect(rec.history).toEqual([{ boxKey: KEY_A, signKey: SIGN_A, replacedAt: 5000, changed: ['signKey'] }]);
    expect(rec.keyChangeCount).toBe(1);
    expect(rec.updatedAt).toBe(5000);
  });

  it('смена ОБОИХ ключей одним вызовом — одно звено, changed называет оба', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B, signKey: SIGN_B }, 5000);

    const rec = getKeyRecord(ALICE);
    expect(rec.history).toEqual([{ boxKey: KEY_A, signKey: SIGN_A, replacedAt: 5000, changed: ['boxKey', 'signKey'] }]);
    expect(rec.keyChangeCount).toBe(1); // один вызов — одно событие, не два
    expect(rec.updatedAt).toBe(5000);
  });

  it('смена только boxKey — звено называет только boxKey, не signKey (тот не менялся)', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B, signKey: SIGN_A }, 5000); // signKey тот же, повторно передан

    const rec = getKeyRecord(ALICE);
    expect(rec.history).toEqual([{ boxKey: KEY_A, signKey: SIGN_A, replacedAt: 5000, changed: ['boxKey'] }]);
    expect(rec.keyChangeCount).toBe(1);
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
    expect(rec.history).toEqual([{ boxKey: KEY_A, replacedAt: 2000, changed: ["boxKey"] }]);
    expect(rec.keyChangeCount).toBe(1);
  });

  it('запись на диск атомарна: файл всегда валидный JSON, содержит адрес после putKey', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    const raw = directoryOnDisk();
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
      // Триггер метлы — успешная запись СНИМКА (схлопывание). Горячий путь
      // теперь дозаписывает строку в журнал и снимка не трогает, а .tmp-*
      // осколки только снимок и создаёт — так что мести их при схлопывании
      // и есть правильное место.
      putKey(ALICE, { boxKey: KEY_A }, 1000);
      _saveDirectory();

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

  // Тот же класс дыры на один уровень глубже (И-2, round 3, `changed` —
  // новое поле, найдено и закрыто самостоятельно, не отдельная находка
  // ревью): `{...h}` копирует звено, но НЕ содержимое вложенного массива
  // `changed` — без отдельного клонирования мутация ВЛОЖЕННОГО массива
  // возвращённого звена тоже портила бы состояние модуля исподтишка.
  it('деep-копия: вложенный массив changed в звене истории тоже не разделяется с модулем', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    const rec = getKeyRecord(ALICE);
    rec.history[0].changed.push('лишнее');

    const rec2 = getKeyRecord(ALICE);
    expect(rec2.history[0].changed).toEqual(['boxKey']);
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

  // ⚠️ ЭТО ПРАВИЛО ПЕРЕВЁРНУТО 6 августа находкой В-5 (аудит устойчивости).
  //
  // Раньше здесь стояло «потолок применяется и ПРИ ЗАГРУЗКЕ» (И-2), и это
  // было ошибкой ровно того класса, ради которого история вообще заведена.
  // Замер (scratchpad/measure-v5-keys.mjs): 30 честных смен ключа, затем
  // ЗАКОННАЯ ОПЕЧАТКА в окружении — хотели MAX_KEY_HISTORY=200, набрали 2:
  //
  //   до опечатки, на диске:        29 звеньев, счётчик смен 29
  //   после перезапуска, в памяти:   2 звена
  //   после ОДНОЙ обычной смены:     2 звена НА ДИСКЕ, счётчик 30
  //   опечатку исправили на 200:     2 звена — НЕ ВЕРНУЛИСЬ
  //
  // То есть одна опечатка в переменной окружения необратимо стирала историю
  // ключей — а история заведена ровно затем, чтобы переписка на прежний
  // ключ не стала непроверяемой. Ключ, которым подписано неудобное
  // сообщение, исчезал, и подпись под ним больше нечем было проверить.
  //
  // Новое правило: потолок ограничивает РОСТ, а не задним числом уже
  // записанное. На загрузке не обрезаем вовсе; на записи режем до
  // max(потолок, сколько уже есть) — история перестаёт расти, но ни одно
  // уже сохранённое звено не пропадает от смены настройки.
  it('В-5: понижение MAX_KEY_HISTORY НЕ обрезает уже сохранённую историю при загрузке', () => {
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
    // Все девять на месте, хотя текущий потолок — 4.
    expect(rec.history.length).toBe(9);
    expect(rec.keyChangeCount).toBe(9);
  });

  it('В-5: и следующая смена ключа не роняет историю до потолка — она лишь перестаёт расти', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    const bigHistory = Array.from({ length: 9 }, (_, i) => ({
      boxKey: '0x' + String(i).padStart(2, '8') + '00'.repeat(31),
      replacedAt: 1000 + i,
    }));
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify({
      [ALICE]: { v: 1, boxKey: KEY_A, updatedAt: 2000, history: bigHistory, keyChangeCount: 9 },
    }), 'utf8');
    _loadDirectory();

    putKey(ALICE, { boxKey: KEY_B }, 3000);

    // Девять было, девять и осталось: новое звено встало впереди, самое
    // старое вытеснено — обычная работа потолка на ТЕКУЩЕЙ длине. Раньше
    // здесь стало бы 4, и пять звеньев исчезли бы навсегда.
    const rec = getKeyRecord(ALICE);
    expect(rec.history.length).toBe(9);
    expect(rec.history[0].boxKey).toBe(KEY_A); // вытесненный ключ — впереди
    expect(rec.keyChangeCount).toBe(10);

    // И на диске — не только в памяти.
    _loadDirectory();
    expect(getKeyRecord(ALICE).history.length).toBe(9);
  });

  // И-2 (round 3): `changed` — новое поле звена, необязательное на загрузке
  // намеренно (та же вперёд/назад-совместимость, что И-1 уже устанавливает
  // для формы записи целиком) — звено, записанное ДО этого поля (та же
  // ветка разработки, до этого самого раунда), не должно отбрасываться как
  // повреждённое только за его отсутствие.
  it('звено истории БЕЗ поля changed (более старая запись) загружается нормально, не отбрасывается', () => {
    fs.mkdirSync(path.dirname(directory.DIRECTORY_FILE), { recursive: true });
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify({
      [ALICE]: {
        v: 1, boxKey: KEY_B, updatedAt: 2000, keyChangeCount: 1,
        history: [{ boxKey: KEY_A, replacedAt: 2000 }], // без changed
      },
    }), 'utf8');
    _loadDirectory();

    expect(isDirectoryHealthy()).toBe(true);
    const rec = getKeyRecord(ALICE);
    expect(rec.boxKey).toBe(KEY_B);
    expect(rec.history).toEqual([{ boxKey: KEY_A, replacedAt: 2000 }]);
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

    const raw = directoryOnDisk();
    raw[ALICE] = { boxKey: 'не ключ', updatedAt: 'не число', history: 'не массив', keyChangeCount: 'не число' };
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(raw), 'utf8');
    // Портим ХРАНИМОЕ состояние целиком: снимок плюс журнал. Оставить
    // журнал значило бы, что целая запись из него тут же вернёт ALICE к
    // жизни, и тест проверял бы не порчу, а восстановление из журнала.
    fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true });
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

    const raw = directoryOnDisk();
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
    const raw = directoryOnDisk();
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
    // Мелочь (ревью координатора, round 3): toBeDefined() не сверяет,
    // КАКОЙ именно код — прошло бы с любым кодом, хоть с опечаткой.
    // requireBagPass()/verifyBagPass() (bagPass.js) на отсутствующий
    // заголовок отвечают именно этим кодом — сверяем его буквально.
    expect(res.body.code).toBe('pass_invalid');

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

  // Мелочь (ревью координатора, round 3): "413 — единственный ответ без
  // кода. Раунд закрыл 500, соседа пропустил." Тело сверх лимита
  // express.json({limit:'64kb'}) сегодня даёт HTML-страницу Express со
  // стеком вызовов, не JSON, — обязано отвечать так же честно, как и
  // остальные статусы этого маршрута (400/401/404/503/500 — все несут
  // code). Настоящий socket-запрос, не supertest .send() — supertest
  // сериализует тело в памяти и не бьёт по реальному размеру, минуя
  // проверку body-parser'а.
  it('тело сверх 64кб — 413 с кодом payload_too_large, JSON, не HTML-страница express', async () => {
    const wallet = ethers.Wallet.createRandom();
    const pass = await issuePassFor(wallet);
    const oversized = JSON.stringify({ boxKey: KEY_A, pad: 'x'.repeat(70 * 1024) });

    const res = await request(app)
      .post('/keys')
      .set('CF-Connecting-IP', freshIp())
      .set('x-bag-pass', pass)
      .set('Content-Type', 'application/json')
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
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
    expect(read.body.history).toEqual([{ boxKey: KEY_A, replacedAt: expect.any(Number), changed: ["boxKey"] }]);
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
    // Мелочь (ревью координатора, round 3): заголовок теста обещал "разный
    // код" — тело код не сверяло вовсе, само название теста было
    // единственным, что это утверждало. app.js отвечает invalid_address
    // именно на эту ветку (ETH_ADDR_RE.test(address) провалился).
    expect(res.body.code).toBe('invalid_address');
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
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    const writeSpy = vi.spyOn(fs, 'writeFileSync'); // снимок пишет только схлопывание
    _saveDirectory();
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
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    const renameSpy = vi.spyOn(fs, 'renameSync'); // снимок пишет только схлопывание
    try {
      _saveDirectory();
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

// ─── В-2 (аудит устойчивости, 6 августа): окно выкатки, две живые копии ───
//
// При обычной выкатке старая и новая копии релеера какое-то время работают
// одновременно поверх одного STORAGE_DIR. Справочник целиком лежит в памяти
// каждой из них и перезаписывается ЦЕЛИКОМ при каждой записи — то есть та
// копия, что записала последней, стирает всё, что успела сделать другая.
//
// Замер до правки (scratchpad/measure-v2.mjs):
//   до выкатки, счётчик смен адреса A: 11
//   старая копия доработала (ещё одна смена A + регистрация адреса C): 12, C есть
//   после переключения на новую копию: счётчик A = 12 (а смен было 13),
//                                      адрес C ИСЧЕЗ ПОЛНОСТЬЮ
//
// keyChangeCount объявлен ВЕЧНОЙ УЛИКОЙ против вытеснения неудобного ключа
// (см. докстринг MAX_KEY_HISTORY) — «этот адрес менял ключ 47 раз». Улика,
// которую стирает обычная выкатка, уликой не является. А адрес, целиком
// пропавший из справочника, — это ещё и человек, которому чат перестал
// отвечать: его открытый ключ больше негде взять.
// ─── Тот же дефект, что К-3 сняла со склада мешков (сквозная проверка, 8
// августа): справочник переписывает ВЕСЬ файл на каждую запись ───────────
//
// Замер (scratchpad/measure-dir.mjs, боевые умолчания):
//
//   адресов │ регистрация нового адреса │ путь до N
//   ────────┼───────────────────────────┼───────────
//     2 000 │  8,87 мс                  │  9,6 с
//     4 000 │ 22,76 мс                  │ 41,4 с
//    20 000 │ не уложилось в 10 минут   │ —
//
// И моя же правка В-2 (слияние с диском ради защиты от взаимного стирания в
// окне выкатки) сделала это ВТРОЕ дороже, без замера: до неё те же числа
// были 2,78 мс и 5,60 мс. Защита была нужна, цена — нет.
//
// Регистрация НОВОГО адреса — это и есть путь нападения из пункта 31: сто
// двадцать записей в минуту дают 172 800 новых адресов в сутки с одного IP,
// и каждая замораживала релеер на всё это время.
describe('справочник — регистрация не переписывает весь файл', () => {
  function bytesForOneWriteAt(n) {
    fs.rmSync(directory.DIRECTORY_FILE, { force: true });
    fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true });
    _loadDirectory();
    const addr = (i) => '0x' + i.toString(16).padStart(40, '0');
    const k = (i) => '0x' + i.toString(16).padStart(64, '0');
    for (let i = 1; i <= n; i++) putKey(addr(i), { boxKey: k(i) }, 1000 + i);

    let bytes = 0;
    const count = (_fp, data) => { bytes += Buffer.byteLength(typeof data === 'string' ? data : (data ?? '')); };
    const rw = fs.writeFileSync, ra = fs.appendFileSync;
    const w = vi.spyOn(fs, 'writeFileSync').mockImplementation((fp, d, ...r) => { count(fp, d); return rw(fp, d, ...r); });
    const a = vi.spyOn(fs, 'appendFileSync').mockImplementation((fp, d, ...r) => { count(fp, d); return ra(fp, d, ...r); });
    try {
      putKey(addr(n + 1), { boxKey: k(n + 1) }, 9999);
    } finally { w.mockRestore(); a.mockRestore(); }
    return bytes;
  }

  it('цена регистрации в байтах не растёт вместе с числом адресов', () => {
    const at100 = bytesForOneWriteAt(100);
    const at1000 = bytesForOneWriteAt(1000);
    // Справочник из 1000 записей примерно вдесятеро тяжелее справочника из
    // 100. Если запись по-прежнему переписывает его целиком, вторая цифра
    // будет примерно вдесятеро больше. Требуем, чтобы десятикратный рост
    // не давал даже двукратного.
    expect(at1000).toBeLessThan(at100 * 2);
    expect(at1000).toBeLessThan(4096);
  });

  it('записанное дешёвым путём переживает перезапуск', () => {
    putKey(ALICE, { boxKey: KEY_A, signKey: SIGN_A }, 1000);
    putKey(BOB, { boxKey: KEY_B }, 2000);
    _loadDirectory(); // «перезапуск»
    expect(getKeyRecord(ALICE).boxKey).toBe(KEY_A);
    expect(getKeyRecord(ALICE).signKey).toBe(SIGN_A);
    expect(getKeyRecord(BOB).boxKey).toBe(KEY_B);
  });

  // Мутация «не доигрывать журнал» сначала НЕ красила ни одного теста:
  // снимок в них не появлялся вовсе (его пишет только схлопывание), и все
  // проверки шли по ветке «снимка нет», где разбор журнала остался. Дыра
  // ровно в той ветке, что случается на живом сервере: снимок ЕСТЬ (ночное
  // схлопывание отработало), и поверх него легли новые записи.
  it('снимок ЕСТЬ, поверх него журнал — перезапуск видит и старое, и новое', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    _saveDirectory();                       // схлопывание: ALICE в снимке, журнал пуст
    expect(fs.existsSync(directory.DIRECTORY_FILE)).toBe(true);

    putKey(BOB, { boxKey: KEY_B }, 2000);   // легло в журнал ПОВЕРХ снимка
    putKey(ALICE, { boxKey: KEY_C }, 3000); // и смена ключа уже записанного адреса

    _loadDirectory();                       // «перезапуск»

    expect(getKeyRecord(BOB).boxKey).toBe(KEY_B);   // новое из журнала
    expect(getKeyRecord(ALICE).boxKey).toBe(KEY_C); // журнал перекрывает снимок
    expect(getKeyRecord(ALICE).keyChangeCount).toBe(1);
  });

  it('оборванная последняя строка не уносит с собой остальные', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(BOB, { boxKey: KEY_B }, 2000);
    const log = directory.DIRECTORY_FILE + '.log';
    if (fs.existsSync(log)) fs.appendFileSync(log, '{"a":"0xdead', 'utf8');
    _loadDirectory();
    expect(getKeyRecord(ALICE)).not.toBeNull();
    expect(getKeyRecord(BOB)).not.toBeNull();
  });
});

describe('В-2 — окно выкатки: запись другой копии не стирается, счётчик смен не убывает', () => {
  it('адрес, зарегистрированный ДРУГОЙ копией в окне выкатки, переживает нашу запись', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);

    // «Другая копия» зарегистрировала CAROL, пока мы жили со своим снимком
    // в памяти. Пишем прямо в файл — ровно это делает её _saveDirectory().
    // Другая копия СХЛОПЫВАЕТ: пишет снимок целиком и обнуляет журнал —
    // ровно оба действия _saveDirectory(), моделировать только первое было
    // бы нечестно (тот же урок, что на складе мешков).
    const onDisk = directoryOnDisk();
    onDisk[CAROL] = { v: 1, boxKey: KEY_C, updatedAt: 1500, history: [], keyChangeCount: 0 };
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(onDisk), 'utf8');
    fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true });

    // Наша обычная запись — про СОВСЕМ другой адрес.
    putKey(ALICE, { boxKey: KEY_B }, 2000);

    const after = directoryOnDisk();
    expect(after[CAROL]).toBeDefined();          // не стёрт нашим снимком
    expect(after[CAROL].boxKey).toBe(KEY_C);
    expect(after[ALICE].boxKey).toBe(KEY_B);     // и наша запись, конечно, на месте
  });

  it('счётчик смен не убывает: он берётся из БОЛЬШЕГО — своего или того, что на диске', () => {
    putKey(ALICE, { boxKey: KEY_A }, 1000);
    putKey(ALICE, { boxKey: KEY_B }, 2000); // наш счётчик: 1

    // «Другая копия» успела провести ещё несколько смен того же адреса.
    const onDisk = directoryOnDisk();
    onDisk[ALICE].keyChangeCount = 12;
    fs.writeFileSync(directory.DIRECTORY_FILE, JSON.stringify(onDisk), 'utf8');
    fs.rmSync(directory.DIRECTORY_FILE + '.log', { force: true }); // другая копия схлопнула

    putKey(ALICE, { boxKey: KEY_C }, 3000);

    const after = directoryOnDisk();
    // 13, а не 2: улику нельзя откатить назад чужим устаревшим снимком.
    expect(after[ALICE].keyChangeCount).toBe(13);
  });
});

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
      // Горячий путь пишет строку в журнал; снимок появляется только при
      // схлопывании. Проверяем оба имени по НОВОМУ пути — важно ведь, что
      // запись ушла туда, а не в старый каталог.
      expect(fs.existsSync(path.join(storageDirAfterDotenv, 'chat-key-directory.json.log'))).toBe(true);
      fresh._saveDirectory();
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
