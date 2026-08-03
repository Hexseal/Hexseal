import { describe, it, expect } from 'vitest';
import { bytesToHex } from 'viem';
import { deriveChatKeypair, sealForRecipient, openSealed, CHAT_KEY_TYPED_DATA, type ChatKeypair } from './chatCrypto';

const SIG_A = ('0x' + 'ab'.repeat(65)) as `0x${string}`;
const SIG_B = ('0x' + 'cd'.repeat(65)) as `0x${string}`;
const text = (s: string) => new TextEncoder().encode(s);
const str  = (b: Uint8Array) => new TextDecoder().decode(b);

describe('deriveChatKeypair', () => {
  it('одна и та же подпись всегда даёт одну и ту же пару', async () => {
    const first  = await deriveChatKeypair(SIG_A);
    const second = await deriveChatKeypair(SIG_A);
    expect(first.publicKey).toEqual(second.publicKey);
    expect(first.privateKey).toEqual(second.privateKey);
  });

  it('разные подписи дают разные пары', async () => {
    const a = await deriveChatKeypair(SIG_A);
    const b = await deriveChatKeypair(SIG_B);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('золотой вектор: абсолютные байты для SIG_A, не сравнение двух вызовов', async () => {
    // Все остальные тесты в этом файле ОТНОСИТЕЛЬНЫЕ — сравнивают два вызова
    // между собой. Ревью Задачи 2 (раунд 2) доказало мутацией, что этого
    // недостаточно: смена `CHAT_KEY_SEED_CONTEXT` (единственной константы,
    // реально влияющей на ключ на тот момент) меняла публичный ключ у ВСЕХ
    // пользователей, а все относительные тесты оставались зелёными — они не
    // видят СМЕЩЕНИЕ, только несовпадение между двумя своими же вызовами.
    //
    // Значения посчитаны независимо от этого файла — отдельным скриптом на
    // чистом node (не через chatCrypto.ts), реализующим ту же формулу
    // (context ‖ подпись ‖ hashTypedData(CHAT_KEY_TYPED_DATA) → keccak256 →
    // crypto_box_seed_keypair), и перепроверены в трёх отдельных процессах
    // `node` — совпали побайтово во всех трёх. Тест ниже — четвёртая,
    // независимая проверка: что САМА `chatCrypto.ts` даёт то же самое.
    //
    // Если этот тест когда-нибудь покраснеет — это ЛИБО осознанная миграция
    // (тогда вектор пересчитывается и обновляется здесь тем же способом),
    // ЛИБО молчаливый сдвиг константы, который иначе не поймал бы ничто.
    const { publicKey, privateKey } = await deriveChatKeypair(SIG_A);
    expect(bytesToHex(publicKey)).toBe(
      '0x16cf8aa0cecfda7229d1f3e15b92732f96d0f9f695c697753d0a8cc22c6b9e0a',
    );
    expect(bytesToHex(privateKey)).toBe(
      '0xb46f6d2e59217f698a3817f3667574ec52b7cb0de60f6217eaf718d2459ccfbc',
    );
  });

  it('домен и содержимое подписи (EIP-712) зафиксированы целиком', () => {
    // Смена домена ИЛИ содержимого = смена ключа у ВСЕХ существующих
    // пользователей разом: их прежняя переписка станет нечитаемой. Тест
    // стоит здесь как замок: менять можно только вместе с осознанной
    // миграцией. Проверяется структура целиком (не отдельная строка) —
    // именно её обязана подписывать вызывающая сторона через
    // `walletClient.signTypedData(CHAT_KEY_TYPED_DATA)`, без права
    // собрать запрос из кусков по-своему.
    expect(CHAT_KEY_TYPED_DATA).toEqual({
      domain: { name: 'Hexseal', version: '1' },
      types: { ChatKey: [{ name: 'purpose', type: 'string' }] },
      primaryType: 'ChatKey',
      message: { purpose: 'hexseal.chat.key.v1' },
    });
  });

  it('регистр hex-цифр в подписи не влияет на результат (реальный случай: кошельки отдают hex по-разному)', async () => {
    const lower = await deriveChatKeypair(SIG_A);
    const upperDigits = await deriveChatKeypair(('0x' + 'AB'.repeat(65)) as `0x${string}`);
    expect(lower.publicKey).toEqual(upperDigits.publicKey);
  });

  it('заглавный префикс 0X тоже приводится к нижнему регистру (не встречается у реальных кошельков, но не должен ронять функцию)', async () => {
    const lower = await deriveChatKeypair(SIG_A);
    const upperPrefix = await deriveChatKeypair(SIG_A.toUpperCase() as `0x${string}`);
    expect(lower.publicKey).toEqual(upperPrefix.publicKey);
  });

  describe('отказ на невалидном входе — молчаливый приём мусора означает, что все, кто подал один и тот же мусор, получат один и тот же ключ', () => {
    const cases: Array<[label: string, input: string]> = [
      ['пустая строка', ''],
      ['голый префикс без байт', '0x'],
      ['невалидные hex-символы', '0x' + 'zz'.repeat(65)],
      ['строковая константа вместо подписи', 'undefined'],
      ['подпись на один байт короче нужного', '0x' + 'ab'.repeat(64)],
      ['подпись на один байт длиннее нужного', '0x' + 'ab'.repeat(66)],
    ];

    for (const [label, input] of cases) {
      it(label, async () => {
        // Раунд 7, находка I3: было `.rejects.toThrow()` без класса —
        // сейчас именно TypeError, тем же классом, что sealForRecipient и
        // openSealed бросают на своём негодном входе (см. тест ниже).
        await expect(
          deriveChatKeypair(input as unknown as `0x${string}`),
        ).rejects.toThrow(TypeError);
      });
    }
  });

  // Раунд 7, находка I3: deriveChatKeypair бросал обычный Error, а
  // sealForRecipient/openSealed — TypeError, причём openSealed использует
  // `instanceof TypeError` КАК ПРИЗНАК смысла «это наш мусор на входе»
  // (см. JSDoc над openSealed в chatCrypto.ts). Вызывающий, скопировавший
  // задокументированный в этом же файле образец
  //   catch (e) { if (e instanceof TypeError) throw e; return null }
  // вокруг входа в чат проглотил бы негодную подпись от deriveChatKeypair
  // как «не наш мешок» — два разных класса в одном файле означали одно и то
  // же намерение («наш мусор на входе»), но были неотличимы по этому
  // признаку ровно там, где признак и нужен вызывающему.
  it('раунд 7, находка I3: все три функции бросают ОДИН класс (TypeError) на негодном входе', async () => {
    await expect(deriveChatKeypair('' as unknown as `0x${string}`)).rejects.toBeInstanceOf(TypeError);
    const bob = await deriveChatKeypair(SIG_B);
    await expect(
      sealForRecipient('не Uint8Array' as unknown as Uint8Array, text('a')),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(openSealed(bob, new Uint8Array(3))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('sealForRecipient / openSealed', () => {
  it('получатель вскрывает своим ключом', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    const sealed = await sealForRecipient(bob.publicKey, text('бриф: лендинг'));
    const opened = await openSealed(bob, sealed);
    expect(opened).not.toBeNull();
    expect(str(opened!)).toBe('бриф: лендинг');
  });

  it('посторонний не вскрывает и получает null, а не исключение', async () => {
    const bob  = await deriveChatKeypair(SIG_B);
    const eve  = await deriveChatKeypair(SIG_A);
    const sealed = await sealForRecipient(bob.publicKey, text('секрет'));
    await expect(openSealed(eve, sealed)).resolves.toBeNull();
  });

  it('повреждённый мешок той же длины даёт null, а не исключение', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    const sealed = await sealForRecipient(bob.publicKey, text('секрет'));
    sealed[sealed.length - 1] ^= 0xff;
    await expect(openSealed(bob, sealed)).resolves.toBeNull();
  });

  // Три следующих теста держат границу между «мешок не наш» и «мы передали
  // мусор». Без них сплошной catch схлопнул бы оба случая, и перепутанный
  // формат ключа выглядел бы как чужое письмо — сбой под видом штатного
  // исхода. Разница классов исключений установлена в Задаче 1 прогоном
  // библиотеки; она принадлежит libsodium, а не нам, поэтому её надо
  // стеречь тестом: при обновлении зависимости она может поехать молча.

  it('обрезанный мешок — это наш баг, а не чужое письмо: пробрасывается', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    await expect(openSealed(bob, new Uint8Array(10))).rejects.toThrow(TypeError);
  });

  it('ключ неверной длины пробрасывается, а не выдаётся за чужой мешок', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    const sealed = await sealForRecipient(bob.publicKey, text('секрет'));
    const broken = { publicKey: bob.publicKey.slice(0, 31), privateKey: bob.privateKey };
    await expect(openSealed(broken, sealed)).rejects.toThrow(TypeError);
  });

  it('запечатывание на ключ неверной длины тоже пробрасывается', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    await expect(sealForRecipient(bob.publicKey.slice(0, 31), text('a'))).rejects.toThrow(TypeError);
  });

  it('два запечатывания одного текста дают РАЗНЫЕ мешки', async () => {
    // Если мешки совпадут — значит схема детерминированная, и по одинаковым
    // байтам на сервере видно, что человек написал одно и то же дважды.
    // Метаданные мы и так не скрываем, но повторяемость шифротекста — это
    // уже утечка содержимого, и она недопустима.
    const bob = await deriveChatKeypair(SIG_B);
    const one = await sealForRecipient(bob.publicKey, text('да'));
    const two = await sealForRecipient(bob.publicKey, text('да'));
    expect(one).not.toEqual(two);
  });

  it('пустое сообщение проходит круг', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    const sealed = await sealForRecipient(bob.publicKey, new Uint8Array(0));
    const opened = await openSealed(bob, sealed);
    expect(opened).toEqual(new Uint8Array(0));
  });

  // Ревью раунда 1: строгость `Uint8Array` в сигнатуре живёт только в
  // компиляции. Мешок из сети почти всегда приезжает как строка внутри
  // JSON (`JSON.parse` не восстанавливает `Uint8Array` — типизация TS тут
  // молчит, это ровно путь `any`). На живом модуле замерено: строка вместо
  // байт не всегда даёт ошибку — иногда тихая пустота без единого
  // исключения, неотличимая от штатного «мешок не наш». Три теста ниже
  // проверяют, что теперь это пробрасывается как TypeError на границе
  // функций, а не доезжает до библиотеки живым.

  it('строка вместо байт текста при запечатывании пробрасывается, а не кодируется молча как UTF-8', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    await expect(
      sealForRecipient(bob.publicKey, 'привет' as unknown as Uint8Array),
    ).rejects.toThrow(TypeError);
  });

  it('строка вместо байт публичного ключа при запечатывании пробрасывается', async () => {
    // Находка I2 финального ревью: фикстура была 'не байты' — 15 UTF-8-байт
    // (Buffer.byteLength('не байты', 'utf8') === 15), поэтому срабатывала
    // СОБСТВЕННАЯ проверка длины libsodium («invalid publicKey length»,
    // TypeError), а не наша `instanceof Uint8Array` — удаление нашей
    // проверки оставляло этот тест зелёным (мутация выжила). Строка ровно в
    // 32 UTF-8-байта — единственная длина, на которой библиотека НЕ жалуется
    // на длину сама (она приводит строку к байтам и честно пытается
    // запечатать на них, без единой ошибки, проверено прогоном библиотеки) —
    // и потому единственная, где несущей остаётся ровно наша проверка.
    const bob = await deriveChatKeypair(SIG_B);
    await expect(
      sealForRecipient('z'.repeat(32) as unknown as Uint8Array, text('a')),
    ).rejects.toThrow(TypeError);
  });

  it('строка вместо байт мешка при вскрытии пробрасывается, а не даёт молчаливую пустоту', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    // Правдоподобный вид мешка, каким он приезжает по сети: base64 внутри
    // JSON, забытый декодировать перед вызовом.
    const sealed = await sealForRecipient(bob.publicKey, text('секрет'));
    const asBase64String = Buffer.from(sealed).toString('base64');
    await expect(
      openSealed(bob, asBase64String as unknown as Uint8Array),
    ).rejects.toThrow(TypeError);
  });

  // Находка I1 финального ревью: `sealed` был защищён `instanceof Uint8Array`
  // ДО try, а `myKeypair.publicKey`/`myKeypair.privateKey` — нет, хотя они
  // проходят насквозь в ту же `sodium.crypto_box_seal_open`. Строка РОВНО в
  // 32 UTF-8-байта — тот самый провал: libsodium приводит её к 32 байтам
  // (crypto_box_PUBLICKEYBYTES/SECRETKEYBYTES) без единой жалобы на длину и
  // честно пытается открыть — получает `Error: incorrect key pair for the
  // given ciphertext` (обычный `Error`, НЕ `TypeError`, проверено прогоном
  // библиотеки), который наш собственный catch схлопывает в `null` как
  // «мешок не наш». Наш мусор на входе выдаёт себя за штатный отказ.
  // Другие длины сюда не годятся: на них сработала бы длинная проверка самой
  // библиотеки (TypeError «invalid publicKey length» и т.п.) ещё ДО попытки
  // открыть — тест был бы фиктивным, как I2 этого же ревью.
  it('раунд 7, находка I1: ключ подан строкой ровно в 32 UTF-8-байта — не выдаётся за «мешок не наш»', async () => {
    const bob = await deriveChatKeypair(SIG_B);
    const sealed = await sealForRecipient(bob.publicKey, text('секрет'));
    const garbageKeypair = {
      publicKey: 'x'.repeat(32),
      privateKey: 'y'.repeat(32),
    } as unknown as ChatKeypair;
    await expect(openSealed(garbageKeypair, sealed)).rejects.toThrow(TypeError);
  });
});
