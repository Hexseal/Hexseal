import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { deriveChatKeypair, sealForRecipient, type ChatKeypair } from './chatCrypto';
import * as chatCryptoModule from './chatCrypto';
import {
  packEnvelope, recoverOneTimeKey, openEnvelopeWithOneTimeKey, toOneTimeKey,
  MAX_ENVELOPE_BYTES, type OneTimeKey, type ChatPayload,
} from './chatEnvelope';
import { FORBIDDEN_SUBSTITUTIONS, MINTED_KEY } from './chatEnvelopeOneTimeKeyTypeBans';

const SIG_BOB     = ('0x' + '11'.repeat(65)) as `0x${string}`;
const SIG_ALICE   = ('0x' + '22'.repeat(65)) as `0x${string}`;
const SIG_EVE     = ('0x' + '33'.repeat(65)) as `0x${string}`;
const SIG_ARBITER = ('0x' + '44'.repeat(65)) as `0x${string}`;

// Адрес автора — в НИЖНЕМ регистре, как его отдаёт `decodeFrame(...).link.sender`
// (`chatConversation.ts:531-535`, `chatChain.ts:114`) и как его получает боевой
// `packEnvelope` (`chatConversation.ts:1268`). Чек-суммленный адрес взят рядом,
// чтобы проверить: приведение регистра внутри `envelopeAad` работает и на этом пути.
const AUTHOR_LOWER   = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
const AUTHOR_CHECKED = getAddress(AUTHOR_LOWER) as `0x${string}`;
const OTHER_AUTHOR   = ('0x' + 'cd'.repeat(20)) as `0x${string}`;

async function actors() {
  const [bob, alice, eve, arbiter] = await Promise.all([
    deriveChatKeypair(SIG_BOB),
    deriveChatKeypair(SIG_ALICE),
    deriveChatKeypair(SIG_EVE),
    deriveChatKeypair(SIG_ARBITER),
  ]);
  return { bob, alice, eve, arbiter };
}

/**
 * Собирает конверт вручную из тех же кирпичей, что `packEnvelope`, но берёт
 * СЫРОЙ JSON — включая формы, которые `ChatPayload` в TypeScript не пропустил
 * бы. По сети такое пришлёт кто угодно, у кого есть открытый ключ получателя.
 * Тот же приём и та же причина, что `buildRawEnvelope` в `chatEnvelope.test.ts`.
 */
async function buildRawEnvelope(
  jsonText: string, recipientPub: Uint8Array, ownPub: Uint8Array, author?: `0x${string}`,
): Promise<Uint8Array> {
  const oneTimeKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealedA = await sealForRecipient(recipientPub, oneTimeKey);
  const sealedB = await sealForRecipient(ownPub, oneTimeKey);
  const header = new Uint8Array(173);
  header[0] = 1;
  header.set(sealedA, 1);
  header.set(sealedB, 81);
  header.set(iv, 161);
  const aad = author === undefined
    ? header
    : (() => {
        const out = new Uint8Array(193);
        out.set(header, 0);
        const hex = author.slice(2).toLowerCase();
        for (let i = 0; i < 20; i++) out[173 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
      })();
  const cryptoKey = await crypto.subtle.importKey('raw', oneTimeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, cryptoKey, new TextEncoder().encode(jsonText)),
  );
  const out = new Uint8Array(173 + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, 173);
  return out;
}

/** Ключ, добытый парой `kp`. Падает громко, если не добылся — тест, который
 *  молча продолжает с null, доказывает не то, что написано в его названии. */
async function keyOf(envelope: Uint8Array, kp: ChatKeypair): Promise<OneTimeKey> {
  const k = await recoverOneTimeKey(envelope, kp);
  if (!k) throw new Error('заготовка теста: ключ не добылся, дальше проверять нечего');
  return k;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ═══════════════ recoverOneTimeKey — добыть голый разовый ключ ═════════════ */

describe('recoverOneTimeKey', () => {
  it('1. свой слот и чужой слот дают ОДИН И ТОТ ЖЕ ключ, и он реально расшифровывает', async () => {
    // Оба слота запечатывают один и тот же 32-байтный ключ (chatEnvelope.ts:345-351):
    // получателю открывается слот A, автору со второго устройства — слот B.
    // Проверяем не только совпадение байтов, но и что этим ключом конверт
    // ДЕЙСТВИТЕЛЬНО вскрывается — иначе «32 байта» доказывали бы только длину.
    const { bob, alice } = await actors();
    const payload: ChatPayload = { text: 'бриф: лендинг' };
    const env = await packEnvelope(payload, bob.publicKey, alice.publicKey, AUTHOR_LOWER);

    const asRecipient = await recoverOneTimeKey(env, bob);
    const asAuthor = await recoverOneTimeKey(env, alice);
    expect(asRecipient).not.toBeNull();
    expect(asAuthor).not.toBeNull();
    expect(asRecipient!.length).toBe(32);
    expect(Buffer.from(asAuthor!).toString('hex')).toBe(Buffer.from(asRecipient!).toString('hex'));

    expect(await openEnvelopeWithOneTimeKey(env, asAuthor!, AUTHOR_LOWER)).toEqual({ ok: true, payload });
  });

  it('2. третий и арбитр (у него НЕТ ни одного слота) — null, не исключение', async () => {
    // Это и есть причина, по которой вторая функция обязана существовать:
    // арбитру нечего пробовать, `unpackEnvelope` для него бесполезна в принципе.
    const { bob, alice, eve, arbiter } = await actors();
    const env = await packEnvelope({ text: 'секрет' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    await expect(recoverOneTimeKey(env, eve)).resolves.toBeNull();
    await expect(recoverOneTimeKey(env, arbiter)).resolves.toBeNull();
  });

  it('3. обрубок на байт короче заголовка — null, и ни одной попытки вскрыть слот', async () => {
    // ⚠️ У обрубка 172 байта СЛОТЫ ЦЕЛЫ (они кончаются на 161-м), короток
    // только вектор. Без гейта длин `openSealed` честно вернул бы НАСТОЯЩИЙ
    // ключ от заведомо негодного конверта — тихий мусор вместо отказа.
    const { bob, alice } = await actors();
    const spy = vi.spyOn(chatCryptoModule, 'openSealed');
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    await expect(recoverOneTimeKey(env.subarray(0, 172), bob)).resolves.toBeNull();
    expect(spy.mock.calls.length).toBe(0);
  });

  it('4. незнакомая версия — null, и ни одной попытки вскрыть слот', async () => {
    // Байт версии не мешает слотам открыться (AAD здесь не участвует вовсе).
    // Без гейта версии функция отдала бы ключ от формата, которого не знает.
    const { bob, alice } = await actors();
    const spy = vi.spyOn(chatCryptoModule, 'openSealed');
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    env[0] = 99;
    await expect(recoverOneTimeKey(env, bob)).resolves.toBeNull();
    expect(spy.mock.calls.length).toBe(0);
  });

  it('5. конверт на байт выше потолка — null, и ни одной попытки вскрыть слот', async () => {
    // Вход РОВНО MAX+1, а не «произвольно огромный», и утверждение по ЧИСЛУ
    // вызовов: у этого раннера провалившаяся проверка над многомегабайтным
    // аргументом печатает диагностику катастрофически дорого (К-2,
    // chatEnvelope.test.ts:491-526). Повторяем ту дисциплину, а не открываем
    // её заново.
    const { bob, alice } = await actors();
    // Ожидаемое число записано РУКАМИ (исправление 12 договора v2): без этой
    // строки `MAX_ENVELOPE_BYTES + 1` — тождество по построению, и подъём
    // боевого потолка хоть в сто раз оставил бы замер зелёным, просто дольше.
    expect(MAX_ENVELOPE_BYTES).toBe(262144);
    const spy = vi.spyOn(chatCryptoModule, 'openSealed');
    const valid = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const overLimit = new Uint8Array(MAX_ENVELOPE_BYTES + 1);
    overLimit.set(valid.subarray(0, Math.min(valid.length, overLimit.length)), 0);
    await expect(recoverOneTimeKey(overLimit, bob)).resolves.toBeNull();
    expect(spy.mock.calls.length).toBe(0);
  });

  it('6. пробуются ОБА слота: чужое сообщение — один вызов, своё — два', async () => {
    // Числами запирается сам факт второй пробы. Убери её — своё сообщение
    // (ключ в слоте B) перестанет добываться вовсе, а предъявитель не сможет
    // предъявить НИ ОДНОГО своего сообщения.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);

    const spyPeer = vi.spyOn(chatCryptoModule, 'openSealed');
    await recoverOneTimeKey(env, bob);      // получатель — слот A, первая проба
    expect(spyPeer.mock.calls.length).toBe(1);
    spyPeer.mockRestore();

    const spyOwn = vi.spyOn(chatCryptoModule, 'openSealed');
    await recoverOneTimeKey(env, alice);    // автор — слот B, вторая проба
    expect(spyOwn.mock.calls.length).toBe(2);
  });

  it('7. не Uint8Array (envelope) — TypeError, а не null (наш мусор не носит костюм штатного исхода)', async () => {
    const { bob } = await actors();
    // Строка — РОВНО в том виде, в каком поле приезжает из контейнера: base64
    // без `0x` (исправление 2 договора v2). Раскодировать обязан вызывающий;
    // забыл — получает громкий отказ, а не `null`, который слился бы с «не мой
    // конверт». В типах это к тому же запрещено (фикстура, запрет 7).
    // @ts-expect-error намеренно base64-строка вместо байт
    await expect(recoverOneTimeKey('q6urq6urq6urq6urq6urq6urq6urq6urq6urq6ur', bob)).rejects.toThrow(TypeError);
  });

  // ⚠️ Доработка ревью, находка «обе проверки половин пары не заперты — 0
  // красных из 1934»: `env` в обоих тестах ниже — КАНОНИЧЕСКИЙ конверт, а
  // проверка сравнивает ТЕКСТ отказа, не только класс. Без гейта
  // `ownKeypair.publicKey`/`privateKey` в самой `recoverOneTimeKey` исполнение
  // доходит до `sliceEnvelope` (проходит) и дальше до `openSealed`
  // (chatCrypto.ts) — а ТА бросает СВОЙ `TypeError` того же класса, с текстом
  // «openSealed: …», а не «recoverOneTimeKey: …». Замерено: снятие любой из
  // двух проверок ниже ПООДИНОЧКЕ даёт 0 красных из 1934, если проверять
  // только класс исключения через `.rejects.toThrow(TypeError)` — нужен
  // текст, по которому видно, ЧЬЯ это проверка среагировала. Каждая половина —
  // ОТДЕЛЬНЫЙ тест, чтобы «снять каждую проверку по одной» измерялось
  // однозначно, без риска, что первая ассерция уже упавшего теста скроет
  // вторую.
  it('7а. ownKeypair.publicKey не Uint8Array — TypeError ИМЕННО recoverOneTimeKey, не openSealed', async () => {
    const { bob } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, bob.publicKey, AUTHOR_LOWER);
    // @ts-expect-error намеренно строка вместо половины пары
    await expect(recoverOneTimeKey(env, { publicKey: 'нет', privateKey: bob.privateKey }))
      .rejects.toThrow(/recoverOneTimeKey: ownKeypair\.publicKey должен быть Uint8Array/);
  });

  it('7б. ownKeypair.privateKey не Uint8Array — TypeError ИМЕННО recoverOneTimeKey, не openSealed', async () => {
    const { bob } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, bob.publicKey, AUTHOR_LOWER);
    // @ts-expect-error намеренно строка вместо половины пары
    await expect(recoverOneTimeKey(env, { publicKey: bob.publicKey, privateKey: 'нет' }))
      .rejects.toThrow(/recoverOneTimeKey: ownKeypair\.privateKey должен быть Uint8Array/);
  });

  it('8. систематическая порча длины ключа брошена ГРОМКО и с именем ЭТОЙ функции', async () => {
    // Тот же урок, что заперт для `unpackEnvelope` (В-1/В-2): смена библиотеки
    // сломает ВСЕ сообщения разом, и это обязано отличаться от «один мешок не
    // наш». `label` в сообщении нужен, чтобы отказ не указывал на чужую функцию.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    vi.spyOn(chatCryptoModule, 'openSealed').mockResolvedValueOnce(new Uint8Array(31));
    await expect(recoverOneTimeKey(env, bob))
      .rejects.toThrow(/recoverOneTimeKey: unexpected recovered key length \(31\), expected 32/);
  });
});

/* ══════════ openEnvelopeWithOneTimeKey — вскрыть без единого слота ═════════ */

describe('openEnvelopeWithOneTimeKey', () => {
  it('9. верный ключ и верный автор — ok, содержимое то же, РОВНО один вызов decrypt', async () => {
    const { bob, alice } = await actors();
    const payload: ChatPayload = {
      text: 'да ты хуйню намутил',
      dealId: getAddress('0x1234567890123456789012345678901234567890') as `0x${string}`,
    };
    const env = await packEnvelope(payload, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: true, payload });
    // Боевой путь не платит за вторую пробу AAD.
    expect(spy.mock.calls.length).toBe(1);
  });

  it('9б. чек-суммленный адрес автора читает тот же конверт (регистр приводится)', async () => {
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_CHECKED)).toEqual({ ok: true, payload: { text: 'a' } });
  });

  it('10. конверт без автора в AAD, автор назван — aad_mismatch, содержимое НЕ выдано, РОВНО два decrypt', async () => {
    // Ключ здесь ВЕРНЫЙ — тег на голом заголовке сошёлся. Но привязки к автору
    // у конверта нет, значит выдать содержимое как «сказанное этим автором»
    // означало бы молчаливое «проверено» (§15.2). Отказ с названной причиной.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'без автора в AAD' }, bob.publicKey, alice.publicKey); // автор НЕ назван
    const key = await keyOf(env, bob);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    const out = await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER);
    expect(out).toEqual({ ok: false, reason: 'aad_mismatch' });
    expect('payload' in out).toBe(false);
    expect(spy.mock.calls.length).toBe(2);
  });

  it('11. конверт С автором в AAD, автор не назван — bad_key, РОВНО один decrypt', async () => {
    // Второго варианта AAD тут не существует: не зная автора, его 20 байт не
    // приписать. Одна проба, честный отказ.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await openEnvelopeWithOneTimeKey(env, key)).toEqual({ ok: false, reason: 'bad_key' });
    expect(spy.mock.calls.length).toBe(1);
  });

  it('12. чужой автор и случайный ключ дают ОДИН И ТОТ ЖЕ вердикт — различить нельзя, и это заперто', async () => {
    // ⚠️ Не «недоделка», а свойство примитива: единственный оракул — тег GCM.
    // Тест стоит здесь, чтобы никто не начал строить на несуществующем
    // различении. Различает ПАРА с `FrameVerdict` Задачи 4: если байты
    // доказанно те самые подписанные, `bad_key` уже нельзя списать на порчу.
    // Её `verifyFrameEvidence` по договору v2 (исправление 4) АСИНХРОННА и
    // готовности ждёт внутри — прогрев звать не надо, и это не моя забота: я
    // вердикт кадра не зову и не складываю со своим.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const wrongAuthor = await openEnvelopeWithOneTimeKey(env, key, OTHER_AUTHOR);
    const randomKey = await openEnvelopeWithOneTimeKey(env, toOneTimeKey(crypto.getRandomValues(new Uint8Array(32)))!, AUTHOR_LOWER);
    expect(wrongAuthor).toEqual({ ok: false, reason: 'bad_key' });
    expect(randomKey).toEqual({ ok: false, reason: 'bad_key' });
    expect(wrongAuthor).toEqual(randomKey);
  });

  it('13. случайный ключ — bad_key, РОВНО два decrypt (обе пробы честно сделаны)', async () => {
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    const out = await openEnvelopeWithOneTimeKey(env, toOneTimeKey(crypto.getRandomValues(new Uint8Array(32)))!, AUTHOR_LOWER);
    expect(out).toEqual({ ok: false, reason: 'bad_key' });
    expect(spy.mock.calls.length).toBe(2);
  });

  it('14. порча тега (последний байт) — bad_key, не исключение', async () => {
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    env[env.length - 1] ^= 0xff;
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'bad_key' });
  });

  it('15. порча байта внутри слота A видна ОБОИМ путям: bad_key арбитру и null добыче', async () => {
    // Слот входит в заголовок, заголовок — в AAD (К-1). Порча чужого слота не
    // тихая: рвётся и тег, и вскрытие самого слота.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    env[5] ^= 0xff;
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'bad_key' });
    await expect(recoverOneTimeKey(env, bob)).resolves.toBeNull();
  });

  it('16. обрубок 172 байта — malformed, decrypt не вызван ни разу', async () => {
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await openEnvelopeWithOneTimeKey(env.subarray(0, 172), key, AUTHOR_LOWER))
      .toEqual({ ok: false, reason: 'malformed' });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('17. незнакомая версия — malformed, decrypt не вызван ни разу', async () => {
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    env[0] = 99;
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'malformed' });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('18. конверт на байт выше потолка — malformed, decrypt не вызван ни разу', async () => {
    const { bob, alice } = await actors();
    expect(MAX_ENVELOPE_BYTES).toBe(262144); // руками, исправление 12 — см. тест 5
    const valid = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(valid, bob);
    const overLimit = new Uint8Array(MAX_ENVELOPE_BYTES + 1);
    overLimit.set(valid.subarray(0, Math.min(valid.length, overLimit.length)), 0);
    const spy = vi.spyOn(crypto.subtle, 'decrypt');
    expect(await openEnvelopeWithOneTimeKey(overLimit, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'malformed' });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('19. честно запечатанный не-JSON — bad_form, а НЕ bad_key', async () => {
    // Разница несущая: `bad_key` арбитр читает как «мне дали не тот ключ»
    // (вина предъявителя), `bad_form` — как «внутри мусор». Схлопнуть их
    // значит вернуть §15.4 наизнанку.
    const { bob, alice } = await actors();
    const env = await buildRawEnvelope('не json вовсе', bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'bad_form' });
  });

  it('20. честно запечатанный массив вместо объекта — bad_form', async () => {
    const { bob, alice } = await actors();
    const env = await buildRawEnvelope('[1,2,3]', bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'bad_form' });
  });

  it('21. text не строка — bad_form (гейт формы стоит на пути, а не рядом)', async () => {
    const { bob, alice } = await actors();
    const env = await buildRawEnvelope('{"text":123}', bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: false, reason: 'bad_form' });
  });

  it('22. незнакомые поля целы — будущая версия формата читается, а не отвергается', async () => {
    const { bob, alice } = await actors();
    const env = await buildRawEnvelope('{"text":"привет","новоеПоле":7}', bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const out = await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER);
    expect(out.ok).toBe(true);
    expect(out.ok && (out.payload as Record<string, unknown>).новоеПоле).toBe(7);
  });

  it('23. __proto__ внутри честно запечатанного не проезжает, text цел', async () => {
    // Тот же гейт, что на пути `unpackEnvelope` (chatEnvelope.test.ts:704).
    // Путь арбитра НОВЫЙ, и защита на нём обязана стоять своя — экспортированная
    // функция, которую этот путь не зовёт, защитой не является.
    const { bob, alice } = await actors();
    const env = await buildRawEnvelope('{"text":"привет","__proto__":{"evil":true}}', bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const out = await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER);
    expect(out).toEqual({ ok: true, payload: { text: 'привет' } });
    // ⚠️ Доработка ревью: `out.ok && X` — ПУСТОЕ утверждение само по себе,
    // когда ожидаемый результат `.toBe(false)` совпадает со значением, в
    // которое схлопывается короткое замыкание при `out.ok === false`. Раньше
    // это было прикрыто СОСЕДНЕЙ строкой (`toEqual` выше уже упал бы первой),
    // но как отдельная проверка — мертво. Сужение через `if` убирает
    // короткое замыкание: без него дальнейшие строки просто не выполнились
    // бы, а не молча прошли с `false`.
    if (!out.ok) throw new Error('заготовка теста: ожидался ok:true, дальше проверять нечего');
    expect(Object.prototype.hasOwnProperty.call(out.payload, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(out.payload)).toBe(Object.prototype);
  });

  it('24. toOneTimeKey — единственная дверь, и она мерит длину, а не верит на слово', async () => {
    // Через эту дверь Задача 6 клеймит байты, вышедшие из `openSealed` над
    // `bytesFromB64(keys[].forArbiter)`. Враждебный предъявитель запечатает
    // 31 байт — дверь обязана ответить null, а не пропустить огрызок в
    // расшифровку. Договор v2 (исправление 1) называет эту дверь единственной
    // точкой клеймения, значит длина мерится ИМЕННО здесь.
    expect(toOneTimeKey(new Uint8Array(31))).toBeNull();
    expect(toOneTimeKey(new Uint8Array(33))).toBeNull();
    expect(toOneTimeKey(new Uint8Array(80))).toBeNull();
    expect(toOneTimeKey(new Uint8Array(0))).toBeNull();
    const ok = toOneTimeKey(new Uint8Array(32));
    expect(ok).not.toBeNull();
    expect(ok!.length).toBe(32);

    // ⚠️ СТРОКА ДЛИНОЙ РОВНО 32 — не «ещё один негодный вход», а единственный
    // случай, в котором проверка длины сама по себе БЕСПОЛЕЗНА: `'…'.length`
    // тоже 32, и без гейта `instanceof` дверь заклеймила бы base64-строку из
    // контейнера как разовый ключ. Дальше она доехала бы до `importKey` и
    // вышла вердиктом «не тот ключ» — наш промах в костюме беды предъявителя.
    expect(toOneTimeKey('q6urq6urq6urq6urq6urq6urq6urq6ur' as unknown as Uint8Array)).toBeNull();
    expect('q6urq6urq6urq6urq6urq6urq6urq6ur'.length).toBe(32); // руками: иначе замер выше ни о чём
  });

  it('25. не Uint8Array конверт — TypeError; ключ не 32 байт — громко, а НЕ вердикт bad_key', async () => {
    // Второе — важнее. Клеймо живёт только в типах, значит приведением сюда
    // можно занести что угодно. ⚠️ Без явного гейта длины `importKey` НИЖЕ
    // всё равно бросил бы (он СНАРУЖИ try — см. докстринг `assertOneTimeKeyLength`
    // в `openEnvelopeWithOneTimeKey`, chatEnvelope.ts), но чужим `DOMException`
    // без имени нашей функции — этот тест проверяет, что отказ говорит именно
    // ЭТИМ текстом, а не первым попавшимся громким исключением.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    // @ts-expect-error намеренно строка вместо байт конверта
    await expect(openEnvelopeWithOneTimeKey('0xdead', key, AUTHOR_LOWER)).rejects.toThrow(TypeError);
    const stunted = new Uint8Array(31) as unknown as OneTimeKey; // приведение — ровно то, чего боимся
    await expect(openEnvelopeWithOneTimeKey(env, stunted, AUTHOR_LOWER))
      .rejects.toThrow(/openEnvelopeWithOneTimeKey: unexpected recovered key length \(31\), expected 32/);
  });

  it('25б. ключ не Uint8Array НА ИСПОЛНЕНИИ (приведение из строки) — TypeError про key, не чужая ошибка', async () => {
    // ⚠️ Доработка ревью, находка «проверка рода ключа не заперта»: до этого
    // теста НИ ОДИН тест файла не подавал НЕ-`Uint8Array` на месте `key` НА
    // ИСПОЛНЕНИИ — только на компиляции, через фикстуру запретов
    // (`chatEnvelopeOneTimeKeyTypeBans.ts`), а её тело НИКОГДА не вызывается
    // (см. докстринг файла фикстуры). Клеймо `OneTimeKey` живёт только в
    // типах — приведением (`as unknown as OneTimeKey`) сюда может приехать
    // строка, например если Задача 6 забудет разобрать base64 из
    // `keys[].forArbiter`.
    //
    // Строка ДЛИНОЙ РОВНО 32 — намеренно: если бы гейт `key instanceof
    // Uint8Array` сверял только `.length`, строка такой длины прошла бы его
    // и доехала до `toArrayBuffer(key)`/`importKey`, дав ЧУЖОЙ TypeError без
    // имени функции — тот же класс, что и наш, замок на класс это не поймал
    // бы (замерено, 0 красных из 1934 при снятии этой проверки в источнике).
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const bogusKey = 'q6urq6urq6urq6urq6urq6urq6urq6ur' as unknown as OneTimeKey;
    expect('q6urq6urq6urq6urq6urq6urq6urq6ur'.length).toBe(32); // руками: иначе замер выше ни о чём
    await expect(openEnvelopeWithOneTimeKey(env, bogusKey, AUTHOR_LOWER))
      .rejects.toThrow(/openEnvelopeWithOneTimeKey: key должен быть Uint8Array/);
  });

  it('25в. malformed-конверт + огрызок ключа — TypeError про ключ (НАШ гейт), а не вердикт malformed', async () => {
    // ⚠️ Доработка ревью, находка «порядок гейтов»: длина ключа — гейт про
    // КЛЮЧ (наш собственный мусор), не про форму конверта. Если бы он стоял
    // ПОСЛЕ sliceEnvelope (как было до доработки), негодный конверт ПЛЮС
    // огрызок ключа (оба разом) отдавали бы вердикт `malformed` — то есть
    // НАША ошибка (не та длина ключа) уезжала бы под видом беды предъявителя
    // (плохой конверт). Оба условия здесь ложны РАЗОМ, намеренно: только так
    // видно, какой гейт сработал первым.
    const malformedEnvelope = new Uint8Array(10); // короче заголовка — форма конверта негодная
    const stunted = new Uint8Array(31) as unknown as OneTimeKey; // и ключ тоже огрызок
    await expect(openEnvelopeWithOneTimeKey(malformedEnvelope, stunted))
      .rejects.toThrow(/openEnvelopeWithOneTimeKey: unexpected recovered key length \(31\), expected 32/);
  });

  it('26. входные байты конверта НЕ изменены — арбитр читает то же, что подписано', async () => {
    // Если бы функция что-нибудь «поправила» на месте (нормализовала версию,
    // обнулила поле), вызывающий пересчитал бы `bodyHash` по УЖЕ ДРУГИМ байтам
    // и подпись разошлась бы — доказательство умерло бы в читалке.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    const before = Buffer.from(env).toString('hex');
    await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER);
    await openEnvelopeWithOneTimeKey(env, key, OTHER_AUTHOR); // и на пути отказа тоже
    expect(Buffer.from(env).toString('hex')).toBe(before);

    // ⚠️ Доработка ревью: побайтовая сверка ВАЛИДНОГО конверта (выше) не
    // ловит «полезную» нормализацию, которая пишет ТО ЖЕ значение, что уже
    // там лежит (`envelope[0] = ENVELOPE_VERSION` на конверте, где версия и
    // так 1, — значение не меняется, только сама запись, а `Buffer`-сравнение
    // видит лишь итоговое значение). Отчёт задачи это признавал (мутация 15,
    // «не тот замок»): реальным замком оказался тест 17 (семантический), а
    // не эта побайтовая сверка. Чтобы она тоже ловила эту мутацию — нужен
    // конверт, где нормализация ИЗМЕНИЛА бы значение: версия ПОРЧЕНА (99), не
    // 1. Если бы `sliceEnvelope`/`openEnvelopeWithOneTimeKey` «чинили» байт
    // версии перед проверкой, здесь он стал бы `1`, и это увидела бы именно
    // побайтовая сверка, а не только вердикт `malformed`.
    const corruptedVersion = await packEnvelope({ text: 'b' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    // Ключ добывается на ЦЕЛОМ конверте, ДО порчи версии — recoverOneTimeKey
    // сама гейтится версией (тест 4), поэтому свой ключ этого, второго
    // конверта, не бывает того же, что у первого (`packEnvelope` берёт
    // свежий случайный разовый ключ на каждый вызов).
    const key2 = await keyOf(corruptedVersion, bob);
    corruptedVersion[0] = 99;
    const beforeCorrupted = Buffer.from(corruptedVersion).toString('hex');
    const out = await openEnvelopeWithOneTimeKey(corruptedVersion, key2, AUTHOR_LOWER);
    expect(out).toEqual({ ok: false, reason: 'malformed' });
    expect(Buffer.from(corruptedVersion).toString('hex')).toBe(beforeCorrupted);
    expect(corruptedVersion[0]).toBe(99); // руками: сверка выше бессмысленна, если байт мог остаться и порченым, и «починенным»
  });

  it('27. автор не адрес — TypeError (наш мусор), а не вердикт', async () => {
    // `envelopeAad` бросает на негодном адресе. Он обязан вычисляться ВНЕ try
    // — правило В-5 этого файла: гейт, чей бросок глотает чужой catch, не
    // отличим от «гейт честно отказал».
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const key = await keyOf(env, bob);
    await expect(openEnvelopeWithOneTimeKey(env, key, '0xнеадрес' as `0x${string}`)).rejects.toThrow(TypeError);
  });
});

/* ═══════════════════ мост §2: арбитр читает ИСХОДНЫЕ байты ════════════════ */

describe('§2 замысла: ключ на сообщение вместо перешифровки', () => {
  it('28. сторона добывает ключ своей парой, арбитр без слотов вскрывает ТЕ ЖЕ байты и видит те же слова', async () => {
    // Это вся суть работы одним тестом. Арбитру не запечатано НИ ОДНОГО слота
    // (проверено отдельно), и всё же он читает — потому что получил разовый
    // ключ рядом с доказательством, а байты конверта не тронуты.
    const { bob, alice, arbiter } = await actors();
    const payload: ChatPayload = { text: 'я ему говорил про срок' };
    const env = await packEnvelope(payload, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    const bytesBefore = Buffer.from(env).toString('hex');

    await expect(recoverOneTimeKey(env, arbiter)).resolves.toBeNull(); // слота нет
    const key = await keyOf(env, alice);                               // автор добыл свой
    expect(await openEnvelopeWithOneTimeKey(env, key, AUTHOR_LOWER)).toEqual({ ok: true, payload });
    expect(Buffer.from(env).toString('hex')).toBe(bytesBefore);
  });

  it('29. фикстура запрещённых подстановок на месте и участвует в поведении', async () => {
    // ⚠️ НАЗЫВАЮ ВСЛУХ, ЧЕГО ЭТА СТРОКА НЕ ДОКАЗЫВАЕТ. `FORBIDDEN_SUBSTITUTIONS`
    // — не поведенческий замок и НЕ признак «фикстура не выпотрошена»: вынь из
    // неё все семь `@ts-expect-error`, оставив оба экспорта, и здесь останется
    // зелено (мутация 22, названа честно). Она сторожит ровно две вещи: файл
    // существует (иначе импорт не соберётся) и число запретов то, что задумано.
    // Сами запреты живут в типах и краснеют только `npm run type-check` (тесты
    // из программы tsc исключены — замерено).
    expect(FORBIDDEN_SUBSTITUTIONS).toBe(7);
    expect(MINTED_KEY).not.toBeNull();

    // А это уже поведение: клеймо даёт право быть переданным, но не право на
    // содержимое — заведомо не тот ключ обязан дать `bad_key`, а не `ok`.
    const { bob, alice } = await actors();
    const env = await packEnvelope({ text: 'a' }, bob.publicKey, alice.publicKey, AUTHOR_LOWER);
    expect(await openEnvelopeWithOneTimeKey(env, MINTED_KEY!, AUTHOR_LOWER))
      .toEqual({ ok: false, reason: 'bad_key' });
  });
});
