import { describe, it, expect, beforeEach } from 'vitest';
import { deriveChatKeypair } from './chatCrypto';
import { GENESIS_HASH, buildLink, verifyChain, type ChainLink } from './chatChain';
import { packEnvelope } from './chatEnvelope';
import type { ChatSession } from './chatSession';
import {
  FRAME_HEADER_LEN,
  decodeFrame,
  deriveLinkSigningKeypair,
  linkSignaturePreimage,
  messageBodyHash,
  encodeFrame,
  receiveBags,
  verifyFrameEvidence,
  _resetFrameVerifierForTest,
  _resetParseCacheForTest,
  type FrameVerdict,
  type IncomingBag,
} from './chatConversation';

// ⚠️ `readyFrameVerifier` здесь НЕ импортируется — намеренно. Ни один тест ниже
// проверяльщик не греет, и это главное доказательство испр. 4: будь «сначала
// прогрей» ещё условием работы, зелёными остались бы ровно два теста — T12 (там
// греет `receiveBags`) и T13 (он кадры не судит вовсе). Замер этого утверждения
// числом — мутации 5 (13 красных) и 6 (12 красных).

// ─── Заготовки ─────────────────────────────────────────────────────────────
//
// Адреса — С КОНТРОЛЬНОЙ СУММОЙ, как их отдаёт `useAccount()`: звено лоукейсит
// `sender`, и сверка «заявленное против байтов» на регистре и ломалась бы.

const ALICE = '0x760F07367888C62f7c2Dfb619A5e534132855ce5' as const;
const BOB   = '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f' as const;
const CAROL = '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as const;

/** Настоящая по форме ECDSA-подпись: 0x + 130 hex (65 байт r‖s‖v). */
function signatureOf(marker: string): `0x${string}` {
  const body = marker.repeat(130).slice(0, 130).replace(/[^0-9a-f]/g, 'a');
  return `0x${body}` as `0x${string}`;
}

async function makeSession(marker: string, address: `0x${string}`): Promise<ChatSession> {
  return {
    keypair: await deriveChatKeypair(signatureOf(marker)),
    address, origin: 'signature', walletKind: 'eoa', restored: true, persisted: true,
  };
}

interface Evidence {
  bytes: Uint8Array;
  link: ChainLink;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
}

/** Кадр, собранный НАСТОЯЩИМИ примитивами — конверт, звено, подпись. Ни одного
 *  подставного байта: подпись выводится из ключа шифрования, и набитый руками
 *  ключ спрятал бы ошибку вывода. */
async function honestFrame(
  from: ChatSession, to: ChatSession, text: string, prev: ChainLink | null = null,
): Promise<Evidence> {
  const signer = await deriveLinkSigningKeypair(from.keypair);
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const envelope = await packEnvelope(
    { text }, to.keypair.publicKey, from.keypair.publicKey,
    from.address.toLowerCase() as `0x${string}`,
  );
  const link = buildLink(
    prev, messageBodyHash(signer.publicKey, envelope), from.address,
    1_754_400_000_000 + (prev ? prev.seq + 1 : 0) * 1000,
  );
  const signature = sodium.crypto_sign_detached(linkSignaturePreimage(link), signer.privateKey);
  return {
    bytes: encodeFrame({ link, signature, signerPublicKey: signer.publicKey, envelope }),
    link, signature, signerPublicKey: signer.publicKey,
  };
}

/** Байты с перевёрнутым байтом на месте `at`. Исходные не трогаются. */
function tampered(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[at] ^= 0xff;
  return copy;
}

/** Заявленное, взятое ИЗ САМИХ БАЙТОВ — ровно так его подаёт `receiveBags`. */
function claimOf(bytes: Uint8Array): Evidence {
  const f = decodeFrame(bytes)!;
  return { bytes, link: f.link, signature: f.signature, signerPublicKey: f.signerPublicKey };
}

/** ⚠️ АСИНХРОННА, и это не мелочь. `expect(judge(x)).toEqual({ ok: true })` без
 *  `await` сравнил бы обещание с объектом — такое падает, значит не соврёт. Но
 *  `expect(() => judge(x)).toThrow(TypeError)` был бы зелёным ВСЕГДА: async
 *  бросает отклонённым обещанием, а не синхронно. Поэтому T10 — на `rejects`. */
const judge = (e: Evidence): Promise<FrameVerdict> =>
  verifyFrameEvidence(e.bytes, e.link, e.signature, e.signerPublicKey);

const bagOf = (body: Uint8Array, key: string): IncomingBag =>
  ({ key, sender: BOB.toLowerCase() as `0x${string}`, uploadedAt: 1, body });

let alice: ChatSession;
let bob: ChatSession;
let honest: Evidence;

beforeEach(async () => {
  _resetParseCacheForTest();
  // ⚠️ ХОЛОДНЫМ НАМЕРЕННО, каждый тест. Сброс именно здесь, а не «в первом
  // тесте про прогрев»: иначе условием замера становился бы ПОРЯДОК объявления
  // тестов в файле — а T12 греет проверяльщик побочно (через `receiveBags`), и
  // всё, что стоит ниже него, судилось бы уже тёплым и ничего не доказывало.
  _resetFrameVerifierForTest();
  alice = await makeSession('1c3d', ALICE);
  bob = await makeSession('7f2e', BOB);
  // `honestFrame` грузит libsodium сама, для подписи — но НАШ проверяльщик она
  // не греет: у него своё обещание внутри модуля.
  honest = await honestFrame(bob, alice, 'честное');
});

// ═══════════════════════════════════════════════════════════════════════════
// Готовность библиотеки — забота функции, а не вызывающего (испр. 4)
// ═══════════════════════════════════════════════════════════════════════════

describe('готовности ждёт сама', () => {
  it('T1: без всякого прогрева — настоящий вердикт с первого вызова', async () => {
    // Сброс повторно, поверх beforeEach: ремень поверх подтяжек. Снимут сброс
    // из beforeEach — этот тест обязан продолжать краснеть на мутациях 5 и 6.
    _resetFrameVerifierForTest();
    expect(await judge(honest)).toEqual({ ok: true });
  });

  it('T1b: без прогрева мусор — malformed, а НЕ «подпись не сошлась»', async () => {
    // ⚠️ Ради этого теста он и отдельный. Верни непрогретая функция тихое
    // `bad_signature` (соблазнительный «мягкий» отказ) — T1 покраснеет, а T3
    // останется ЗЕЛЁНЫМ: ложь совпала бы с ожиданием честного теста. Красит её
    // здесь: мусору положен `malformed`, и подмена причины видна числом.
    // Обвинить честную сторону в подделке за нашу незагруженную библиотеку —
    // ровно то, чего этот файл не допускает.
    _resetFrameVerifierForTest();
    expect(await verifyFrameEvidence(
      new Uint8Array(300).fill(0xab), honest.link, honest.signature, honest.signerPublicKey,
    )).toEqual({ ok: false, reason: 'malformed' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Три вердикта по самим байтам
// ═══════════════════════════════════════════════════════════════════════════

describe('вердикт по байтам кадра', () => {
  it('T2: честный кадр — РОВНО { ok: true }, без лишних полей', async () => {
    // Сравнение целиком, а не по полю `ok`: новое поле в вердикте обязано
    // проехать через этот тест и быть замеченным.
    expect(await judge(honest)).toEqual({ ok: true });
  });

  it('T3: испорчена подпись — bad_signature', async () => {
    expect(await judge(claimOf(tampered(honest.bytes, 33))))     // первый байт подписи
      .toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('T4: испорчен конверт — body_mismatch, а не тихо искажённое содержимое', async () => {
    // Смещение порчи берётся ИЗ модуля, и это допустимо ровно потому, что
    // ширина заголовка уже сверена с написанным руками числом в существующем
    // замке (`chatConversation.test.ts:428`, `expect(FRAME_HEADER_LEN).toBe(193)`).
    // Второй такой же строки здесь не будет: замок без своей мутации — текст.
    expect(await judge(claimOf(tampered(honest.bytes, FRAME_HEADER_LEN + 5))))
      .toEqual({ ok: false, reason: 'body_mismatch' });
  });

  it('T5: заявленное звено не то, что в байтах — malformed по КАЖДОМУ полю', async () => {
    // Это нападение задачи 5: контейнер несёт звенья ОТДЕЛЬНО от кадров, и
    // предъявитель мог бы подать честные байты с сочинённым звеном рядом —
    // вердикт цепочки посчитался бы по сочинённому.
    const other32 = `0x${'11'.repeat(32)}` as `0x${string}`;
    const claims: Array<[string, ChainLink]> = [
      ['seq',      { ...honest.link, seq: honest.link.seq + 7 }],
      ['prevHash', { ...honest.link, prevHash: other32 }],
      ['bodyHash', { ...honest.link, bodyHash: other32 }],
      ['sender',   { ...honest.link, sender: CAROL.toLowerCase() as `0x${string}` }],
      ['sentAt',   { ...honest.link, sentAt: honest.link.sentAt + 1 }],
    ];
    for (const [what, link] of claims) {
      expect({ what, v: await verifyFrameEvidence(honest.bytes, link, honest.signature, honest.signerPublicKey) })
        .toEqual({ what, v: { ok: false, reason: 'malformed' } });
    }
  });

  it('T6: тот же кадр, шапки и адрес в ВЕРХНЕМ регистре — ok (регистр не повод обвинять)', async () => {
    // Та же дисциплина, что `sameHash` в chatChain.ts: гейт формы там принимает
    // A-F, значит сравнение обязано трактовать регистр так же — иначе честное
    // звено из JSON получает «сломано» за текстовый регистр одного поля.
    const upper: ChainLink = {
      ...honest.link,
      prevHash: honest.link.prevHash.toUpperCase() as `0x${string}`,
      bodyHash: honest.link.bodyHash.toUpperCase() as `0x${string}`,
      sender: honest.link.sender.toUpperCase() as `0x${string}`,
    };
    expect(await verifyFrameEvidence(honest.bytes, upper, honest.signature, honest.signerPublicKey))
      .toEqual({ ok: true });
  });

  it('T7: заявленная подпись не та, что в байтах — malformed', async () => {
    const other = new Uint8Array(honest.signature);
    other[0] ^= 0xff;
    expect(await verifyFrameEvidence(honest.bytes, honest.link, other, honest.signerPublicKey))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('T8: заявленный подписной ключ не тот, что в байтах — malformed', async () => {
    const carol = await makeSession('9b4a', CAROL);
    const alien = await deriveLinkSigningKeypair(carol.keypair);
    expect(await verifyFrameEvidence(honest.bytes, honest.link, honest.signature, alien.publicKey))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  it('T9: мусор вместо кадра — malformed', async () => {
    expect(await verifyFrameEvidence(
      new Uint8Array(300).fill(0xab), honest.link, honest.signature, honest.signerPublicKey,
    )).toEqual({ ok: false, reason: 'malformed' });
    // Ровно заголовок, без конверта — не сообщение.
    expect(await verifyFrameEvidence(
      new Uint8Array(FRAME_HEADER_LEN), honest.link, honest.signature, honest.signerPublicKey,
    )).toEqual({ ok: false, reason: 'malformed' });
  });

  it('T10: не Uint8Array вместо кадра — TypeError (НАШ мусор), а не вердикт', async () => {
    // То же правило, что у `decodeFrame`/`unpackEnvelope`: чужие данные —
    // вердикт, наш мусор — громко. Кадры к арбитру приезжают из base64,
    // то есть Uint8Array по построению (задача 6).
    //
    // ⚠️ ИМЕННО `rejects`, а не `expect(() => …).toThrow`. Функция async: она
    // возвращает ОТКЛОНЁННОЕ обещание, синхронно не бросает никогда, и
    // `toThrow` был бы зелёным ВСЕГДА — тот самый класс промаха («замок,
    // который не может упасть»), из-за которого договор v2 переписывали.
    await expect(verifyFrameEvidence(
      'кадр' as unknown as Uint8Array, honest.link, honest.signature, honest.signerPublicKey,
    )).rejects.toThrow(TypeError);
  });

  it('T11: мусор из JSON вместо звена/подписи/ключа — вердикт, а не падение', async () => {
    // Контейнер предъявления приезжает разобранным JSON от противной стороны
    // спора. Тип `ChainLink` на исполнении не значит ничего.
    const junk: unknown[] = [
      null, undefined, 5, 'звено', [],
      { seq: 'нет', prevHash: 1, bodyHash: null, sender: {}, sentAt: NaN },
      { ...honest.link, seq: Number.NaN },
      { ...honest.link, prevHash: undefined },
      { ...honest.link, sender: 42 },
    ];
    for (const link of junk) {
      expect({ link: String(JSON.stringify(link)), v: await verifyFrameEvidence(
        honest.bytes, link as ChainLink, honest.signature, honest.signerPublicKey,
      ) }).toEqual({ link: String(JSON.stringify(link)), v: { ok: false, reason: 'malformed' } });
    }
    const badBytes: unknown[] = [null, undefined, 'подпись', 7, new Uint8Array(0), new Uint8Array(63)];
    for (const bad of badBytes) {
      expect(await verifyFrameEvidence(honest.bytes, honest.link, bad as Uint8Array, honest.signerPublicKey))
        .toEqual({ ok: false, reason: 'malformed' });
      expect(await verifyFrameEvidence(honest.bytes, honest.link, honest.signature, bad as Uint8Array))
        .toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Приём и предъявление судят ОДИНАКОВО — расхождение двух копий заперто
// ═══════════════════════════════════════════════════════════════════════════

describe('приём и вынесенная проверка не расходятся', () => {
  it('T12: один и тот же испорченный мешок — беда приёма == повод вердикта', async () => {
    // ⚠️ ЧЕСТНО О ГРАНИЦЕ ЭТОГО ЗАМКА: он ловит РАСХОЖДЕНИЕ, а не «receiveBags
    // не зовёт вынесенную функцию». Сломав их обе одинаково, его не покраснить —
    // то, что приём зовёт именно эту функцию, доказывает мутация 1 (девять
    // красных в существующих тестах), а не этот тест.
    const cases: Array<[string, Uint8Array]> = [
      ['подпись', tampered(honest.bytes, 33)],
      ['конверт', tampered(honest.bytes, FRAME_HEADER_LEN + 5)],
      ['не кадр', new Uint8Array(300).fill(0xab)],
    ];
    for (const [what, body] of cases) {
      _resetParseCacheForTest();
      const state = await receiveBags(alice, [bagOf(body, `k-${what}`)]);
      const claim = decodeFrame(body);
      const verdict: FrameVerdict = claim
        ? await verifyFrameEvidence(body, claim.link, claim.signature, claim.signerPublicKey)
        : { ok: false, reason: 'malformed' };
      const reason = verdict.ok ? null : verdict.reason;
      expect({ what, kinds: state.troubles.map(t => t.kind), reason })
        .toEqual({ what, kinds: reason === null ? [] : [reason], reason });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Названный предел: verifyChain не смотрит на отправителя
// ═══════════════════════════════════════════════════════════════════════════

describe('предел, который закрывает не эта задача', () => {
  it('T13: verifyChain НЕ сравнивает отправителя между звеньями — ok:true на смене', () => {
    // ⚠️ ТЕСТ-ДОКУМЕНТ, как «НАСТОЯЩАЯ каскадная подделка проходит как целая»
    // в chatConversation.test.ts: он запирает ИЗВЕСТНУЮ дыру, чтобы она не
    // потерялась. В приёме от неё спасает группировка по свидетельству склада;
    // в предъявлении группировку по отправителю делает ЗАДАЧА 5. Покраснеет в
    // день, когда verifyChain начнёт сравнивать отправителя — и это будет
    // поводом убрать ТЕСТ, а не правку.
    const bodyHash = `0x${'22'.repeat(32)}` as `0x${string}`;
    const first = buildLink(null, bodyHash, BOB, 1_754_400_000_000);
    const second = buildLink(first, bodyHash, CAROL, 1_754_400_001_000);  // ДРУГОЙ отправитель
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.sender).not.toBe(first.sender);
    expect(verifyChain([first, second])).toEqual({ ok: true, unverifiedContentAtSeq: [0, 1] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ЗАМЕР (не замок — назван вслух): цена вынесенной проверки
// ═══════════════════════════════════════════════════════════════════════════

describe('цена проверки', () => {
  it('T14: ЗАМЕР — тысяча кадров судится за разумное время, все ok', async () => {
    // Вынесенная проверка разбирает кадр ВТОРОЙ раз (первый — в receiveBags,
    // ей нужен конверт) и на КАЖДОМ кадре ждёт мемоизированное обещание
    // готовности — обе цены названы числом, а не словом «дёшево». Порог
    // щедрый: он ловит алгоритм (например, загрузку библиотеки заново на
    // каждый кадр), а не микросекунды.
    const frames: Evidence[] = [];
    let prev: ChainLink | null = null;
    for (let i = 0; i < 1000; i++) {
      const e = await honestFrame(bob, alice, `сообщение ${i}`, prev);
      frames.push(e); prev = e.link;
    }
    // Первый кадр судится ОТДЕЛЬНО: модуль холодный (beforeEach его сбросил),
    // значит в это число входит загрузка libsodium — у арбитра это задержка
    // перед показом первого сообщения предъявления, и её называют, а не прячут
    // в среднем по тысяче.
    const coldStart = Date.now();
    const firstOk = (await judge(frames[0])).ok;
    const coldMs = Date.now() - coldStart;

    const started = Date.now();
    let ok = firstOk ? 1 : 0;
    for (const e of frames.slice(1)) if ((await judge(e)).ok) ok++;
    const elapsed = Date.now() - started;
    console.info(`[замер] verifyFrameEvidence: первый кадр (холодный модуль) ${coldMs} мс, `
      + `остальные 999: ${elapsed} мс`);
    expect(ok).toBe(1000);
    expect(elapsed).toBeLessThan(60_000);
  }, 300_000);
});
