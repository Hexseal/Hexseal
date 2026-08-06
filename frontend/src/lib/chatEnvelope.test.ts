import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { deriveChatKeypair, sealForRecipient, type ChatKeypair } from './chatCrypto';
import {
  packEnvelope, unpackEnvelope, assertSealedKeyLength, assertOneTimeKeyLength, MAX_ENVELOPE_BYTES, type ChatPayload,
} from './chatEnvelope';

// Подписи разной формы — тот же приём, что в chatCrypto.test.ts (SIG_A/SIG_B):
// 65-байтная hex-строка, три разных актёра.
const SIG_BOB   = ('0x' + '11'.repeat(65)) as `0x${string}`;
const SIG_ALICE = ('0x' + '22'.repeat(65)) as `0x${string}`;
const SIG_EVE   = ('0x' + '33'.repeat(65)) as `0x${string}`;

// Настоящий чек-суммленный адрес (как отдаёт useAccount()/getAddress()), а не
// строчными буквами вручную — правило проекта, купленное находкой «650
// зелёных тестов означали нерабочий вход» (адрес в заготовке был не той формы,
// какую реально отдаёт кошелёк).
const DEAL = getAddress('0x1234567890123456789012345678901234567890') as `0x${string}`;

async function actors() {
  const [bob, alice, eve] = await Promise.all([
    deriveChatKeypair(SIG_BOB),
    deriveChatKeypair(SIG_ALICE),
    deriveChatKeypair(SIG_EVE),
  ]);
  return { bob, alice, eve };
}

/**
 * Собирает конверт вручную из тех же кирпичей, что и `packEnvelope` (версия
 * 1, `sealForRecipient` дважды, AES-256-GCM), но берёт СЫРОЙ JSON-текст
 * как есть — включая формы, которые `ChatPayload` в TypeScript никогда не
 * пропустил бы. Нужен ровно для одного класса тестов: по сети прислать
 * произвольный JSON внутри честно запечатанного конверта может кто угодно,
 * у кого есть открытый ключ получателя — `packEnvelope` типами этого не
 * ловит (мусор рождается не на нашей стороне), а `unpackEnvelope` обязан.
 */
async function buildRawEnvelope(
  jsonText: string,
  recipientPub: Uint8Array,
  ownPub: Uint8Array,
): Promise<Uint8Array> {
  const oneTimeKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealedA = await sealForRecipient(recipientPub, oneTimeKey);
  const sealedB = await sealForRecipient(ownPub, oneTimeKey);

  // Заголовок собирается ДО шифрования и идёт в AAD — тот же порядок и то
  // же связывание, что реальный packEnvelope делает теперь (К-1, ревью
  // координатора). Без этого расшифровка любого сюда собранного конверта
  // проваливалась бы по тегу аутентификации, даже когда сами байты честные.
  const header = new Uint8Array(1 + sealedA.length + sealedB.length + iv.length);
  header[0] = 1;
  header.set(sealedA, 1);
  header.set(sealedB, 1 + sealedA.length);
  header.set(iv, 1 + sealedA.length + sealedB.length);

  const cryptoKey = await crypto.subtle.importKey('raw', oneTimeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      cryptoKey,
      new TextEncoder().encode(jsonText),
    ),
  );
  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('packEnvelope / unpackEnvelope', () => {
  it('получатель вскрывает, содержимое совпадает', async () => {
    const { bob, alice } = await actors();
    const payload: ChatPayload = {
      text: 'бриф: лендинг',
      dealId: DEAL,
      file: {
        url: 'https://relayer.example/files/abc',
        name: 'скан.pdf',
        size: 123456,
        keyHex: 'ab'.repeat(32),
        ivHex: 'cd'.repeat(12),
      },
    };
    const env = await packEnvelope(payload, bob.publicKey, alice.publicKey);
    // Вопрос 2 отчёта («память кончилась на большом вложении»): конверт
    // несёт только УКАЗАТЕЛЬ на вложение (url/keyHex/ivHex — короткие
    // строки), не сами байты файла — байты идут отдельным путём
    // (fileCrypto.ts, чанками по 8 МБ, вообще не через этот модуль). Даже с
    // заполненным `file` конверт остаётся в единицах КБ, не растёт с
    // реальным размером файла (1 КБ он или 10 ГБ — для этого модуля разницы нет).
    expect(env.length).toBeLessThan(1024);
    const opened = await unpackEnvelope(env, bob);
    expect(opened).toEqual(payload);
  });

  it('отправитель вскрывает своё же', async () => {
    const { bob, alice } = await actors();
    const payload: ChatPayload = { text: 'моё собственное сообщение — читаю с другого устройства' };
    const env = await packEnvelope(payload, bob.publicKey, alice.publicKey);
    const opened = await unpackEnvelope(env, alice);
    expect(opened).toEqual(payload);
  });

  it('третий получает null, а не исключение и не мусор', async () => {
    const { bob, alice, eve } = await actors();
    const env = await packEnvelope({ text: 'секрет' }, bob.publicKey, alice.publicKey);
    const opened = await unpackEnvelope(env, eve);
    expect(opened).toBeNull();
  });

  describe('испорченный конверт — null; не-Uint8Array — исключение', () => {
    it('подмена последнего байта (тег GCM) — null получателю, не исключение', async () => {
      const { bob, alice } = await actors();
      const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
      env[env.length - 1] ^= 0xff;
      await expect(unpackEnvelope(env, bob)).resolves.toBeNull();
    });

    it('строка вместо байт конверта — исключение (TypeError), не null', async () => {
      const { bob } = await actors();
      await expect(
        unpackEnvelope('не Uint8Array' as unknown as Uint8Array, bob),
      ).rejects.toThrow(TypeError);
    });

    it('мусор вместо publicKey своей пары — исключение (TypeError)', async () => {
      const { bob, alice } = await actors();
      const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
      const broken = { publicKey: 'мусор', privateKey: bob.privateKey } as unknown as ChatKeypair;
      await expect(unpackEnvelope(env, broken)).rejects.toThrow(TypeError);
    });

    it('мусор вместо privateKey своей пары — исключение (TypeError)', async () => {
      const { bob, alice } = await actors();
      const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
      const broken = { publicKey: bob.publicKey, privateKey: 'мусор' } as unknown as ChatKeypair;
      await expect(unpackEnvelope(env, broken)).rejects.toThrow(TypeError);
    });
  });

  it('метка сделки не встречается в байтах конверта (И-2, ревью координатора: искать в той кодировке, в которой она реально лежит)', async () => {
    // dealId живёт в JSON payload'а ОБЫЧНОЙ строкой ("0x1234...7890") — если
    // бы шифрование не работало, она утекла бы как ASCII/UTF-8-байты, то
    // есть каждый символ строки как СВОЙ байт. Старая проверка искала СЫРЫЕ
    // hex-байты (адрес как 20 декодированных байт, упакованных по 2 hex-
    // цифры на байт) — кодировку, в которой метка нигде в реальности не
    // лежит. Найдено ревью координатора мутацией: утечка метки СТРОКОЙ в
    // хвост конверта оставляла старую проверку зелёной.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'привет', dealId: DEAL }, bob.publicKey, alice.publicKey);
    const raw = Buffer.from(env);

    // Как она реально лежит в JSON — ASCII/UTF-8 строкой, в разных
    // вероятных вариантах регистра/префикса.
    expect(raw.includes(Buffer.from(DEAL))).toBe(false);
    expect(raw.includes(Buffer.from(DEAL.toLowerCase()))).toBe(false);
    expect(raw.includes(Buffer.from(DEAL.slice(2)))).toBe(false);

    // Дополнительный слой — сырые hex-декодированные байты (на случай другой
    // сериализации в будущем): менее вероятная, но тоже стоит перекрыть.
    const hay = raw.toString('hex');
    expect(hay).not.toContain(DEAL.slice(2).toLowerCase());
  });

  it('К-1 (ревью координатора): подмена ЛЮБОГО байта конверта — перебор ВСЕХ, не одного — блокирует чтение ОБЕИМ сторонам', async () => {
    // Заголовок (версия + оба запечатанных слота + вектор) обязан быть
    // защищён целиком, не только шифротекст: до этой находки подмена байта
    // внутри "чужого" слота (81..160 для получателя, 1..80 для отправителя)
    // была НЕВИДИМА — тот, чей слот не тронут, продолжал читать как ни в
    // чём не бывало, а другая сторона тихо теряла архив без единого сигнала.
    // Перебор всех байт, не выборочный (один байт на 90% пути показывал
    // только часть поверхности — заголовок вообще не задет).
    const { bob, alice } = await actors();
    const payload: ChatPayload = { text: 'важное сообщение о сумме перевода' };
    const original = await packEnvelope(payload, bob.publicKey, alice.publicKey);

    for (let i = 0; i < original.length; i++) {
      const tampered = original.slice();
      tampered[i] ^= 0xff;
      const [openedByBob, openedByAlice] = await Promise.all([
        unpackEnvelope(tampered, bob),
        unpackEnvelope(tampered, alice),
      ]);
      expect(openedByBob, `байт ${i}: получатель должен получить null`).toBeNull();
      expect(openedByAlice, `байт ${i}: отправитель должен получить null на своей копии`).toBeNull();
    }

    // Контроль: неповреждённый конверт по-прежнему читается ОБЕИМИ сторонами —
    // без этого цикл выше мог бы быть зелёным просто потому, что обе стороны
    // вообще ничего не читают (сломанный тест, не сломанный конверт).
    expect(await unpackEnvelope(original, bob)).toEqual(payload);
    expect(await unpackEnvelope(original, alice)).toEqual(payload);
  });

  describe('размер', () => {
    it('конверт с пустым текстом влезает в разумные сотни байт, не килобайты', async () => {
      const { bob, alice } = await actors();
      const env = await packEnvelope({ text: '' }, bob.publicKey, alice.publicKey);
      expect(env.length).toBeLessThan(512);
      // Не подозрительно маленький — там реально два запечатанных 80-байтных
      // слота плюс IV плюс тег GCM, даже для пустого текста.
      expect(env.length).toBeGreaterThan(150);
    });

    it('пустой payload ({}) тоже проходит круг', async () => {
      const { bob, alice } = await actors();
      const env = await packEnvelope({}, bob.publicKey, alice.publicKey);
      const opened = await unpackEnvelope(env, bob);
      expect(opened).toEqual({});
    });
  });

  describe('В-6 (ревью координатора): сборка отказывает громко, когда результат никто не сможет прочитать', () => {
    it('текст, из-за которого конверт превысил бы потолок, — packEnvelope бросает ДО всякой работы, не собирает письмо, которое никто не прочтёт', async () => {
      // Раньше packEnvelope собирала конверт без единой жалобы, даже если
      // итоговый размер превышал MAX_ENVELOPE_BYTES — unpackEnvelope тихо
      // отвечал null ОБЕИМ сторонам (включая отправителя на собственной
      // копии): человек отправил, увидел «всё хорошо», и переписка молча
      // пуста у обоих. Разбор знал про потолок, сборка — нет.
      const { bob, alice } = await actors();
      const hugeText = 'a'.repeat(MAX_ENVELOPE_BYTES); // заведомо превышает: overhead конверта ещё +189 байт
      await expect(packEnvelope({ text: hugeText }, bob.publicKey, alice.publicKey))
        .rejects.toThrow(/payload too large/);
    });

    it('текст чуть МЕНЬШЕ потолка — проходит круг как обычно, не ложный отказ', async () => {
      const { bob, alice } = await actors();
      const okText = 'a'.repeat(MAX_ENVELOPE_BYTES - 1000); // с явным запасом под накладные (189 байт)
      const env = await packEnvelope({ text: okText }, bob.publicKey, alice.publicKey);
      const opened = await unpackEnvelope(env, bob);
      expect(opened).toEqual({ text: okText });
    });
  });

  it('В-4 (ревью координатора): значение потолка — число, записанное руками, не переиспользование константы модуля', () => {
    // Тест на "потолок+1" импортирует MAX_ENVELOPE_BYTES из проверяемого
    // модуля — доказывает «какой-то потолок есть», не «потолок именно
    // такой, как задуман». Замер координатора: подъём константы в 100 раз
    // оставляет 24 теста зелёными. Число ниже — записано руками, не
    // производное от модуля, поэтому смена константы станет видимой.
    expect(MAX_ENVELOPE_BYTES).toBe(262144); // 256 КиБ = 1/4 мегабайта = MAX_BAG_SIZE склада, не выдумано
  });

  describe('версия и структура — незнакомый/повреждённый конверт не роняет разбор', () => {
    it('неизвестный байт версии — null, БЕЗ попытки расшифровать (В-3, ревью координатора)', async () => {
      // Побочный эффект К-1 (AAD): версия входит в заголовок, а заголовок —
      // в AAD, поэтому подмена version-байта и БЕЗ явного гейта версии
      // рвёт тег аутентификации на decrypt — итог (null) не отличить.
      // Найдено независимой проверкой: снятие явного гейта
      // `envelope[0] !== ENVELOPE_VERSION` оставляло этот тест зелёным
      // (подтверждено здесь отдельным прогоном перед фиксом). Явный гейт
      // всё ещё нужен — он экономит попытку открыть слоты/расшифровать на
      // заведомо непонятном формате, а не просто дублирует AAD — поэтому
      // тест ловит именно ЭТО: что decrypt НЕ был вызван вовсе, а не
      // просто что итог null.
      const { bob, alice } = await actors();
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');
      const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
      env[0] = 99;
      const opened = await unpackEnvelope(env, bob);
      expect(opened).toBeNull();
      expect(decryptSpy.mock.calls.length).toBe(0);
    });

    it('пустой Uint8Array — null, не исключение', async () => {
      const { bob } = await actors();
      await expect(unpackEnvelope(new Uint8Array(0), bob)).resolves.toBeNull();
    });

    it('обрубленный конверт (короче заголовка) — null, не исключение', async () => {
      const { bob } = await actors();
      await expect(unpackEnvelope(new Uint8Array(10), bob)).resolves.toBeNull();
    });

    it('И-3 (ревью координатора, откорректировано): ВСЕ 174 длины обрубка (0..173) С ВЕРНЫМ байтом версии — null, ни разу исключение', async () => {
      // Отличие от исходного теста ("код-1"): там `new Uint8Array(10)`
      // нулевой байт версии (0 ≠ ENVELOPE_VERSION=1), поэтому отказ мог
      // случиться на проверке ВЕРСИИ, а не на проверке ДЛИНЫ. Найдено
      // ревью координатора: со снятой проверкой длины и ВЕРНЫМ байтом
      // версии обрубок любой длины даёт исключение вместо null — чужой
      // битый мешок начинает выглядеть как наш собственный баг.
      //
      // Независимая проверка также нашла: единственная проверка длины
      // среза (`sealedSlotA/B/iv`) и БЫВШАЯ отдельная `envelope.length <
      // HEADER_LEN` были представлены как «два независимых слоя», но при
      // ФИКСИРОВАННЫХ смещениях они математически эквивалентны — снятие
      // любой ОДНОЙ поодиночке не красило НИ ОДНОГО теста. Оставлена ОДНА
      // проверка (chatEnvelope.ts). Этот тест — перебор ВСЕХ 174 длин
      // усечения (0..172, короче заголовка) плюс контрольная длина 173
      // (ровно заголовок, без ciphertext — тоже должна дать null: пустое
      // тело не аутентифицируется), с ЧЕСТНЫМ байтом версии на каждой.
      const { bob, alice } = await actors();
      const real = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
      for (let len = 0; len <= 173; len++) {
        const truncated = real.subarray(0, len);
        const opened = await unpackEnvelope(truncated, bob);
        expect(opened, `длина ${len}: ожидался null, не исключение и не содержимое`).toBeNull();
      }
    });

    it('случайный мусор ровно на границе заголовка — null, не исключение', async () => {
      const { bob } = await actors();
      const junk = crypto.getRandomValues(new Uint8Array(173));
      junk[0] = 1; // подделаем правильную версию, остальное — мусор
      await expect(unpackEnvelope(junk, bob)).resolves.toBeNull();
    });
  });

  it('И-1 (ревью координатора): разовый ключ и вектор — РАЗНЫЕ СЫРЫЕ БАЙТЫ на каждый вызов, не только байты итогового конверта', async () => {
    // Сравнение байтов КОНВЕРТА (как в тесте на одновременную упаковку ниже)
    // не запирает это свойство: sealForRecipient сама рандомизирует
    // эфемерный ключ печати при КАЖДОМ вызове (chatCrypto.ts,
    // crypto_box_seal), так что итоговые байты конверта различались бы,
    // даже если бы разовый ключ и вектор были намертво прибиты к одной и
    // той же константе на все сообщения — находка координатора: обе такие
    // мутации порознь дают 0 красных из всего набора. Перехватываем именно
    // СЫРЫЕ входы в crypto.subtle (то, что packEnvelope реально сгенерировала
    // как разовый ключ/вектор), а не то, что получилось после запечатывания.
    const { bob, alice } = await actors();
    const importSpy = vi.spyOn(crypto.subtle, 'importKey');
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');

    await packEnvelope({ text: 'первое' }, bob.publicKey, alice.publicKey);
    await packEnvelope({ text: 'второе' }, bob.publicKey, alice.publicKey);

    // importKey('raw', oneTimeKey, ...) — второй аргумент обоих вызовов.
    const key1 = new Uint8Array(importSpy.mock.calls[0]![1] as ArrayBuffer);
    const key2 = new Uint8Array(importSpy.mock.calls[1]![1] as ArrayBuffer);
    expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));

    // encrypt({name, iv, additionalData}, ...) — вектор в первом аргументе.
    const iv1 = (encryptSpy.mock.calls[0]![0] as AesGcmParams).iv as Uint8Array;
    const iv2 = (encryptSpy.mock.calls[1]![0] as AesGcmParams).iv as Uint8Array;
    expect(Buffer.from(iv1).toString('hex')).not.toBe(Buffer.from(iv2).toString('hex'));
  });

  it('вопрос 3 отчёта: два конверта пакуются ОДНОВРЕМЕННО — разовые ключи и содержимое не путаются', async () => {
    const { bob, alice } = await actors();
    const [envA, envB] = await Promise.all([
      packEnvelope({ text: 'первое' }, bob.publicKey, alice.publicKey),
      packEnvelope({ text: 'второе' }, bob.publicKey, alice.publicKey),
    ]);
    // Разные разовые ключи ⇒ разные конверты даже при близких по смыслу payload.
    expect(Buffer.from(envA).toString('hex')).not.toBe(Buffer.from(envB).toString('hex'));
    const [openedA, openedB] = await Promise.all([
      unpackEnvelope(envA, bob),
      unpackEnvelope(envB, bob),
    ]);
    expect(openedA).toEqual({ text: 'первое' });
    expect(openedB).toEqual({ text: 'второе' });
  });

  it('вопрос 5 отчёта: конверт над потолком отклоняется БЕЗ попытки расшифровать (К-2, ревью координатора)', async () => {
    // К-2, ревью координатора (важная переработка после round 1): ДВЕ
    // правки одновременно, обе обязательны.
    //
    // (1) Размер входа — РОВНО на границе (MAX_ENVELOPE_BYTES + 1), а не
    // произвольно огромный (было 6 МиБ). Раньше тест сам был источником
    // риска: у Vitest/Node в этом окружении замерено (координатором и
    // независимо перепроверено здесь), что ПРОВАЛИВШАЯСЯ проверка
    // `.not.toHaveBeenCalled()` над АРГУМЕНТОМ в несколько мегабайт
    // печатает диагностику катастрофически дорого (гигабайты кучи и падение
    // воркера, а не сам crypto.subtle.decrypt — прямой вызов decrypt на
    // 6 МиБ мусора вне тестового раннера отрабатывает штатно за 14 мс).
    // Дело не в шифровании, а именно в печати ПРОВАЛИВШЕЙСЯ проверки с
    // большим аргументом: голая ошибка сохраняется, даже если разработчик
    // уберёт потолок и тест обязан покраснеть — раньше в этой ситуации он
    // не читаемо краснел, а убивал процесс тестов целиком.
    //
    // (2) Assertion — по ЧИСЛУ вызовов (`mock.calls.length`), не по
    // смысловому матчеру: при провале печатает два маленьких числа
    // ("expected 1 to be 0"), а не пытается сериализовать сами аргументы
    // вызова.
    //
    // Обе правки проверены по отдельности (маленький вход со старым
    // матчером; большой вход с новым матчером) — обе сами по себе снимают
    // риск; здесь применены вместе.
    const { bob, alice } = await actors();
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');
    const validEnv = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey);
    // Ровно на 1 байт больше потолка — наименьший вход, реально
    // пересекающий границу, а не произвольно огромный.
    const overLimit = new Uint8Array(MAX_ENVELOPE_BYTES + 1);
    overLimit.set(validEnv.subarray(0, Math.min(validEnv.length, overLimit.length)), 0);
    const opened = await unpackEnvelope(overLimit, bob);
    expect(opened).toBeNull();
    expect(decryptSpy.mock.calls.length).toBe(0);
  });

  it('мусор внутри полей расшифрованного payload — null для каждой формы, ни разу не искажённые поля и не исключение', async () => {
    const { bob, alice } = await actors();
    const badShapes = [
      '{"text": 123}',                                                                    // text не строка
      '{"dealId": "не-hex-совсем"}',                                                       // dealId без префикса 0x
      '{"dealId": 12345}',                                                                 // dealId не строка вовсе
      '{"file": {"url": 1, "name": "a", "size": "big", "keyHex": "x", "ivHex": "y"}}',      // поля file не той формы
      '{"file": {"url": "u", "name": "n"}}',                                               // file без обязательных полей
      'не json вовсе {{{',                                                                  // невалидный JSON целиком
      '[1,2,3]',                                                                            // валидный JSON, но не объект
      'null',                                                                               // валидный JSON null
      '"просто строка"',                                                                    // валидный JSON, но не объект
    ];
    for (const shape of badShapes) {
      const env = await buildRawEnvelope(shape, bob.publicKey, alice.publicKey);
      await expect(unpackEnvelope(env, bob)).resolves.toBeNull();
    }
  });

  it('мелочь ревью: dealId непривычной формы (не сегодняшний адрес) переживает разбор — та же дисциплина, что незнакомые поля', async () => {
    // Найдено ревью: строгая проверка формы (ровно 40 hex-символов адреса)
    // роняла бы ВСЁ сообщение целиком, если однажды метка сделки сменит
    // форму (например, на другой тип идентификатора) — противоречит
    // соседнему правилу «незнакомое поле не повод отказывать» (см. тест
    // ниже про replyTo). Разница в том, что dealId — ЗНАКОМОЕ поле с
    // подвижной формой, а не незнакомое поле целиком; тест ниже подтверждает,
    // что дисциплина одна и та же и для этого случая: текст выживает, даже
    // если метка не в сегодняшнем формате адреса (66-символьная bytes32-
    // подобная строка — правдоподобный вид будущей формы).
    const { bob, alice } = await actors();
    const futureDealId = '0x' + 'ab'.repeat(32); // 64 hex-символа — не сегодняшние 40
    const raw = JSON.stringify({ text: 'привет', dealId: futureDealId });
    const env = await buildRawEnvelope(raw, bob.publicKey, alice.publicKey);
    const opened = await unpackEnvelope(env, bob);
    expect(opened).toEqual({ text: 'привет', dealId: futureDealId });
  });

  it('незнакомое дополнительное поле в payload переживает разбор — задел на будущее расширение формата', async () => {
    const { bob, alice } = await actors();
    // `replyTo` — гипотетическое поле будущей версии, которого ChatPayload
    // сегодня не знает. unpackEnvelope не обязан его понимать, но не должен
    // молча стирать: тот же урок, что был куплен в Задаче 2 (справочник
    // ключей стирал незнакомые поля при перезаписи).
    const raw = JSON.stringify({ text: 'привет', replyTo: 'msg-42' });
    const env = await buildRawEnvelope(raw, bob.publicKey, alice.publicKey);
    const opened = await unpackEnvelope(env, bob);
    expect(opened).toEqual({ text: 'привет', replyTo: 'msg-42' });
  });

  it('мелочь ревью: замок на длину запечатанного слота при сборке реально бросает — проверено изолированно, без подмены chatCrypto.ts целиком', () => {
    // packEnvelope зовёт эту проверку на выходе sealForRecipient, но до
    // ревью она сама была ничем не проверена (единственная громкая проверка
    // во всём модуле). Подмена chatCrypto.ts через vi.mock ради проверки
    // "а что если sealForRecipient вернула не ту длину" создала бы риск
    // загрязнения состояния между остальными 20+ тестами файла — тот же
    // класс хрупкости, что чинили в К-2. Функция вынесена отдельно (см.
    // chatEnvelope.ts) ровно для того, чтобы это можно было проверить
    // напрямую, без мокирования вообще.
    expect(() => assertSealedKeyLength(new Uint8Array(79), 'recipient'))
      .toThrow(/unexpected recipient sealed key length \(79\), expected 80/);
    expect(() => assertSealedKeyLength(new Uint8Array(81), 'own'))
      .toThrow(/unexpected own sealed key length \(81\), expected 80/);
    expect(() => assertSealedKeyLength(new Uint8Array(80), 'own')).not.toThrow();
  });

  it('мелочь ревью: систематическая порча длины разового ключа брошена громко, не слита с обычным null (проверено изолированно)', () => {
    // unpackEnvelope ловит ВСЁ подряд вокруг расшифровки, в отличие от
    // openSealed, который различает "не наш мешок" и "наш мусор". Такая
    // порча в принципе не может случиться для ОДНОГО чужого/повреждённого
    // мешка (crypto_box_seal фиксирует длину открытого текста жёстко) —
    // только систематически, для ВСЕХ сообщений разом. Проверено напрямую,
    // без мокирования chatCrypto.ts (тот же приём, что для sealed-слота выше).
    expect(() => assertOneTimeKeyLength(new Uint8Array(31)))
      .toThrow(/unexpected recovered key length \(31\), expected 32/);
    expect(() => assertOneTimeKeyLength(new Uint8Array(33)))
      .toThrow(/unexpected recovered key length \(33\), expected 32/);
    expect(() => assertOneTimeKeyLength(new Uint8Array(32))).not.toThrow();
  });
});
