/**
 * arbiterPresentations.test.ts — ящик спора глазами арбитра.
 *
 * ⚠️ КОНТЕЙНЕРЫ ЗДЕСЬ НАСТОЯЩИЕ. Ключи выводятся `deriveChatKeypair`, кадры
 * подписываются, заверения — настоящая EIP-712 подпись ethers-кошелька,
 * контейнер собирает боевой `buildPresentation` и запечатывает боевой
 * `sealPresentation`. Подделан ровно склад: `DisputeBoxSource` — две функции,
 * которые в бою ходят в сеть.
 *
 * ⚠️ ЧИСЛА СКЛАДА ЗАПИСАНЫ РУКАМИ (122, 99, 262 144) — ни одно не берётся из
 * проверяемого модуля. Боевое умолчание бюджета сверяется отдельной строкой:
 * `expect(BAG_READ_BUDGET_PER_MIN).toBe(100)`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { keccak256 } from 'viem';
import { BAG_READ_BUDGET_PER_MIN } from '@/lib/chatTransport';
import { CHAT_KEY_TYPED_DATA, type ChatKeypair } from '@/lib/chatCrypto';
import { createGatedSignChatKey } from '@/lib/arbiterClaimKeys';
import { deriveLinkSigningKeypair } from '@/lib/chatConversation';
import {
  b64FromBytes, bytesFromB64, canonicalPresentationBytes,
  toArbiterBoxKeyBytes, toPeerBoxKeyBytes, buildPresentation,
  type PresentationContainer,
} from '@/lib/presentation';
import { sealPresentation } from '@/lib/presentationBag';
import type { DisputeBoxBag, DisputeBoxList } from '@/lib/disputeBox';
import type { ChatSession } from '@/lib/chatSession';
import {
  readingOrder, bagNameFromKey, arbitersBefore, deviceKeyVerdict,
  countsDisagreement, readDisputeBox, openArbiterBoxSession, isSessionAbsent,
  boxReadRefusal, attestationDateLabel,
  type DisputeBoxSource,
} from '@/lib/arbiterPresentations';
import {
  anchorOrder, bagAnchor, firstNoResponse, verifyDigest,
  type ChainAnchors, type DigestRecord,
} from '@/lib/presentationAnchor';

const AGREEMENT = '0x2e7a7a0515bfdc0006a812ebb3e55d32800bc660' as `0x${string}`;
const OTHER_DEAL = '0x760f07367888c62f7c2dfb619a5e534132855ce5' as `0x${string}`;
const JUDY = '0x268dcfa7ab0dc134d01c5cbcaa7d2834d6dd0f0f' as `0x${string}`;   // арбитр — я
const REX  = '0x4c3e4afd5707aee625f01b0042d8da9dd1ac689c' as `0x${string}`;   // прежний арбитр

/** Пара ключей арбитра. Настоящая: контейнеры печатаются именно на неё. */
let judy: ChatKeypair;
let alice: Actor;
let bob: Actor;
/** Один честный контейнер на весь файл — сборка стоит секунды, а тестам нужен
 *  ОДИН И ТОТ ЖЕ, чтобы расхождения были от правки, а не от разных данных. */
let honest: PresentationContainer;

type Actor = Awaited<ReturnType<typeof import('@/lib/__stand__/presentationFixtures')['makeActor']>>;

async function makeActor(pk: string, marker: string): Promise<Actor> {
  const f = await import('@/lib/__stand__/presentationFixtures');
  return f.makeActor(pk, marker);
}

/** Настоящее предъявление: кадры, архив устройства, сборка боевым сборщиком. */
async function buildHonest(dealId: `0x${string}`): Promise<PresentationContainer> {
  const { installFakeChatDisk } = await import('@/lib/__stand__/fakeChatDisk');
  const { attestationOf, forgeFrames, seedArchive } = await import('@/lib/__stand__/presentationFixtures');
  const { _resetConversationMemoryForTest } = await import('@/lib/chatConversation');
  _resetConversationMemoryForTest();
  const disk = installFakeChatDisk();
  try {
    const mine = await forgeFrames(alice, bob, ['сроки прошли', 'где работа']);
    const theirs = await forgeFrames(bob, alice, ['доделываю'], 1_754_400_500_000);
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(3);
    const built = await buildPresentation({
      dealId,
      presenter: alice.address,
      peer: bob.address,
      arbiterBoxKey: toArbiterBoxKeyBytes(judy.publicKey),
      peerBoxKey: toPeerBoxKeyBytes(bob.session.keypair.publicKey),
      selected: [
        { seq: 0, sender: alice.address }, { seq: 1, sender: alice.address },
        { seq: 0, sender: bob.address },
      ],
      session: alice.session,
      ownAttestation: await attestationOf(alice),
      // ⚠️ ИМЯ ВХОДА — `otherAttestations`, СПИСОК (Задача 4 сняла одиночное
      // `peerAttestation` и бросает TypeError на само его наличие). Здесь один
      // элемент — это сцена, а не образец: боевой путь Задачи 6 передаёт
      // `[attestation, ...attestationHistory]`, иначе честно сменивший ключ
      // собеседник приезжает арбитру подделывателем (пункт 48).
      otherAttestations: [await attestationOf(bob)],
    });
    if (!built.ok) throw new Error(`сборщик отказал: ${built.reason}`);
    return built.container;
  } finally {
    disk.restore();
    _resetConversationMemoryForTest();
  }
}

/**
 * Переподписать изменённый контейнер ключом предъявителя.
 *
 * ⚠️ БЕЗ ЭТОГО ЗАМЕР «сторона соврала в счёте» НЕ О ТОМ. Числа накрыты подписью
 * контейнера, поэтому подделка «на месте» даёт `bad_signature`, а не враньё в
 * счёте. Живой лжец подписывает СВОЁ враньё — его клиент собирает контейнер сам.
 */
async function resign(c: PresentationContainer, session: ChatSession): Promise<PresentationContainer> {
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const signer = await deriveLinkSigningKeypair(session.keypair);
  const { signature: _drop, ...unsigned } = c;
  void _drop;
  return { ...c, signature: b64FromBytes(sodium.crypto_sign_detached(canonicalPresentationBytes(unsigned), signer.privateKey)) };
}

/**
 * Мешок в описи. `sealedFor` — ЗАЯВЛЕНИЕ, сервер его не проверял.
 * `fetchedAt` — время ПЕРВОГО забора по часам сервера; `null` — не забирали.
 * Имени забравшего в описи нет, и в тестах его тоже быть не может.
 */
function summary(key: string, over: Partial<DisputeBoxBag> = {}): DisputeBoxBag {
  return {
    key: `${AGREEMENT}/${key}`,
    sender: alice.address.toLowerCase() as `0x${string}`,
    sealedFor: JUDY, size: 4096, uploadedAt: 1_754_400_900_000, fetchedAt: null,
    ...over,
  };
}

interface Stand {
  source: DisputeBoxSource;
  fetches: string[];
  lists: number;
}

/**
 * Склад: опись и тела. `budget` — сколько выдач до отказа СВОЕГО бюджета.
 *
 * ⚠️ `indexTrusted` УМОЛЧАНИЕМ `true`, и это не поблажка: боевой
 * `listDisputeBox` (Задача 6) БРОСАЕТ на `typeof indexTrusted !== 'boolean'`,
 * то есть описи без этого поля в природе не бывает. Стенд, отдающий здесь
 * `undefined`, мерил бы форму, которой сервер не отдаёт, а сцена
 * «перестроенная опись» (B9) поле называет явно.
 */
function stand(
  list: Omit<DisputeBoxList, 'indexTrusted'> & { indexTrusted?: boolean },
  bodies: Map<string, Uint8Array>,
  budget = Infinity,
): Stand {
  const full: DisputeBoxList = { indexTrusted: true, ...list };
  const s: Stand = {
    fetches: [], lists: 0,
    source: {
      list: async () => { s.lists++; return full; },
      fetch: async (key: string) => {
        if (s.fetches.length >= budget) {
          // Тот же ОБЛИК, что у боевого `BagBudgetError`: сверка идёт по `code`,
          // не по классу (см. `isReadBudget` в модуле).
          throw Object.assign(new Error('Local read budget exhausted'), { code: 'local_read_budget' });
        }
        s.fetches.push(key);
        return bodies.get(key) ?? null;
      },
    },
  };
  return s;
}

const read = (source: DisputeBoxSource) =>
  readDisputeBox({ source, own: judy, agreement: AGREEMENT, me: JUDY });

beforeAll(async () => {
  const { deriveChatKeypair } = await import('@/lib/chatCrypto');
  judy = await deriveChatKeypair(`0x${'3d'.repeat(65)}` as `0x${string}`);
  alice = await makeActor(`0x${'11'.repeat(32)}`, '1c');
  bob = await makeActor(`0x${'22'.repeat(32)}`, '7f');
  honest = await buildHonest(AGREEMENT);
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════
// A. Порядок чтения — единственное, что спасает при потопе
// ═══════════════════════════════════════════════════════════════════════════

describe('порядок чтения', () => {
  it('A1: ни один мешок не потерян — 122 на входе, 122 на выходе', () => {
    const bags = [
      ...Array.from({ length: 121 }, (_, i) => summary(`junk-${i}.bin`, { sealedFor: REX })),
      summary('honest.bin', { sealedFor: JUDY }),
    ];
    const order = readingOrder(bags, JUDY);
    expect(order.length, 'мешки выброшены — сервер решает, что арбитр увидит').toBe(122);
    expect(new Set(order.map(b => b.key)).size).toBe(122);
  });

  it('A2: заявленные на меня первыми, свежее первым; заявленные на другого — последними', () => {
    const bags = [
      summary('rex-new.bin',  { sealedFor: REX,  uploadedAt: 9 }),
      summary('none-old.bin', { sealedFor: null, uploadedAt: 1 }),
      summary('mine-old.bin', { sealedFor: JUDY, uploadedAt: 2 }),
      summary('mine-new.bin', { sealedFor: JUDY, uploadedAt: 8 }),
    ];
    expect(readingOrder(bags, JUDY).map(b => b.key.split('/')[1])).toEqual([
      'mine-new.bin', 'mine-old.bin', 'none-old.bin', 'rex-new.bin',
    ]);
  });

  it('A3: имя мешка — только своего ящика, и без второго слэша', () => {
    expect(bagNameFromKey(`${AGREEMENT}/1-a.bin`, AGREEMENT)).toBe('1-a.bin');
    expect(bagNameFromKey(`${AGREEMENT.toUpperCase()}/1-a.bin`, AGREEMENT)).toBe('1-a.bin');
    expect(bagNameFromKey(`${OTHER_DEAL}/1-a.bin`, AGREEMENT), 'чужой ящик').toBeNull();
    expect(bagNameFromKey(`${AGREEMENT}/sub/1-a.bin`, AGREEMENT), 'второй слэш').toBeNull();
    expect(bagNameFromKey(`${AGREEMENT}/`, AGREEMENT), 'пустое имя').toBeNull();
    expect(bagNameFromKey(`${AGREEMENT}/..`, AGREEMENT), 'выход наверх').toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Ящик: чей он, что забрано, почему остановились
// ═══════════════════════════════════════════════════════════════════════════

describe('ящик спора', () => {
  it('B1: спор ведёт другой — ни одного обращения за мешком', async () => {
    const s = stand({ bags: [summary('a.bin')], arbiter: REX, sealedForOthers: 0 }, new Map());
    const r = await read(s.source);
    expect(r.mine).toBe(false);
    expect(r.stop).toBe('not_mine');
    expect(r.arbiterNow).toBe(REX);
    expect(s.fetches, 'полезли в чужой ящик').toEqual([]);
    expect(r.presentations).toEqual([]);
  });

  it('B2: опись не прочиталась — отказ наружу, а НЕ пустой ящик', async () => {
    const source: DisputeBoxSource = {
      list: async () => { throw new Error('502'); },
      fetch: async () => null,
    };
    // Пустой ящик и непрочитанный — разные новости. Молчание не должно
    // выглядеть как факт: «сторона ничего не предъявила» здесь было бы ложью.
    await expect(read(source)).rejects.toThrow('502');
  });

  it('B3: 122 мешка, бюджет кончился на 99-м — честное предъявление прочитано, остаток назван', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bodies = new Map<string, Uint8Array>();
    const bags: DisputeBoxBag[] = [];
    for (let i = 0; i < 121; i++) {
      const b = summary(`junk-${String(i).padStart(3, '0')}.bin`, { sealedFor: REX, uploadedAt: 1_000 + i });
      bags.push(b);
      bodies.set(b.key, new Uint8Array(1024).fill(9));
    }
    // Честное — ПОСЛЕДНИМ, как в жизни: сторона предъявляет, когда её попросили.
    const good = summary('honest.bin', { sealedFor: JUDY, uploadedAt: 2_000 });
    bags.push(good);
    bodies.set(good.key, sealed);

    const s = stand({ bags, arbiter: JUDY, sealedForOthers: 121 }, bodies, 99);
    const r = await read(s.source);

    expect(BAG_READ_BUDGET_PER_MIN, 'боевой бюджет чтения больше не 100').toBe(100);
    expect(r.listed, 'в ящике не 122 мешка').toBe(122);
    expect(r.tried, 'забрано не 99').toBe(99);
    expect(r.stop).toBe('read_budget');
    expect(r.listed - r.tried, 'непрочитанных не осталось — потоп ничего не стоил').toBe(23);
    expect(r.presentations.length, 'честное предъявление не доехало до глаз').toBe(1);
    expect(r.notOurs, 'мусор не назван мусором').toBe(98);
    expect(r.sealedForOthersDeclared, 'слово сервера потеряно').toBe(121);
  }, 180_000);

  it('B4: помечен на другого арбитра, а запечатан на меня — прочитан', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const b = summary('mislabelled.bin', { sealedFor: REX });
    const s = stand({ bags: [b], arbiter: JUDY, sealedForOthers: 1 }, new Map([[b.key, sealed]]));
    const r = await read(s.source);
    // Заявление кладущего непроверяемо в принципе. Выбросив по нему, мы отдали
    // бы стороне право решать, что арбитр увидит.
    expect(r.presentations.length, 'мешок выброшен по СЛОВУ, а не по ключу').toBe(1);
  }, 60_000);

  it('B5: мешок толще потолка — не забирается вовсе', async () => {
    const fat = summary('fat.bin', { size: 262_145 });
    const s = stand({ bags: [fat], arbiter: JUDY, sealedForOthers: 0 }, new Map());
    const r = await read(s.source);
    expect(s.fetches, 'потолок склада — не наша проверка, а чужое обещание').toEqual([]);
    expect(r.skipped).toEqual([{ bagKey: fat.key, why: 'too_big' }]);
    expect(r.tried).toBe(0);
  });

  it('B6: предъявление по ДРУГОМУ делу — отбраковано с причиной', async () => {
    const alien = await sealPresentation(await buildHonest(OTHER_DEAL), judy.publicKey);
    const b = summary('alien.bin');
    const s = stand({ bags: [b], arbiter: JUDY, sealedForOthers: 0 }, new Map([[b.key, alien]]));
    const r = await read(s.source);
    expect(r.presentations).toEqual([]);
    expect(r.skipped).toEqual([{ bagKey: b.key, why: 'other_deal' }]);
  }, 120_000);

  it('B7: не открылось моим ключом — посчитано; и отдельно — сколько из них уже забирали', async () => {
    // Сцена нового арбитра: в ящике лежат мешки, запечатанные на ПРЕЖНЕГО.
    // Открыть их нельзя ни одним, а разница между «их уже кто-то забрал» и
    // «за ними никто не приходил» — это разница между «предъявление дошло до
    // прежнего арбитра» и «оно не дошло ни до кого». Второе — повод просить
    // сторону предъявить заново немедленно.
    const taken = summary('old-taken.bin', { sealedFor: REX, fetchedAt: 1_754_400_950_000 });
    const never = summary('old-never.bin', { sealedFor: REX, fetchedAt: null });
    const bodies = new Map([
      [taken.key, new Uint8Array(512).fill(3)],
      [never.key, new Uint8Array(512).fill(4)],
    ]);
    const s = stand({ bags: [taken, never], arbiter: JUDY, sealedForOthers: 2 }, bodies);
    const r = await read(s.source);
    expect(r.presentations, 'чужой печатью открылось предъявление').toEqual([]);
    expect(r.notOurs, 'нечитаемые мешки не посчитаны — «ящик пуст» станет ложью').toBe(2);
    // Опись читается ДО заборов, поэтому отметка здесь — не моя нынешняя.
    expect(r.notOursFetched, '«уже забирали» слито с «никто не приходил»').toBe(1);
    // Имени забравшего в модели нет и быть не может: опись его не несёт.
    expect(JSON.stringify(r), 'в выдачу поехало имя забравшего').not.toContain('fetchedBy');
  }, 60_000);

  it('B8: отказ ящика назван по КОДУ, а не по классу статуса', () => {
    // Коды — из таблицы Задачи 1. На чтении встречаются именно эти; советы у них
    // разные и несовместимые, поэтому схлопывать их нельзя.
    expect(boxReadRefusal({ code: 'not_the_arbiter', status: 403 })).toBe('not_mine_now');
    expect(boxReadRefusal({ code: 'no_such_deal', status: 404 })).toBe('no_such_deal');
    expect(boxReadRefusal({ code: 'chain_unavailable', status: 503 })).toBe('chain_unavailable');
    expect(boxReadRefusal({ code: 'rate_limited_read', status: 429 })).toBe('too_often');
    expect(boxReadRefusal({ code: 'rate_limited_box_chain', status: 429 })).toBe('too_often');
    expect(boxReadRefusal({ code: 'pass_expired', status: 401 })).toBe('pass_stale');
    expect(boxReadRefusal({ code: 'local_read_budget' }), 'свой бюджет назван бедой сервера').toBe('too_often');
    // Вот это и отличает разбор по коду от разбора по статусу: 403 у маршрутов
    // ящика ДВА (`not_a_party` на записи, `not_the_arbiter` на чтении), и
    // угадывать по числу нельзя. Незнакомое — честное «не знаем».
    expect(boxReadRefusal({ status: 403 }), 'причина угадана по классу статуса').toBe('unknown');
    expect(boxReadRefusal(new TypeError('fetch failed')), 'обрыв сети выдан за отказ сервера').toBe('unknown');
  });

  it('B8b: мешки, не доехавшие до вердикта, посчитаны ОТДЕЛЬНО от нечитаемых (ревью круг 1)', async () => {
    // `notOurs` живёт в `skipped` тоже, и сложить их значило бы посчитать один
    // мешок дважды. А главное — без своего числа `not_presentation` не виден
    // вовсе: контейнер от клиента другой версии отсеивается ДО читалки, мешок
    // ЗАБРАН (`tried` вырос), и «прочитано N из M» про него молчит.
    const alien = summary('alien.bin');           // не наша форма контейнера
    const mine  = summary('theirs.bin', { sealedFor: REX });  // не открылось моим ключом
    const bodies = new Map([
      // Годный JSON, вскрываемый МОИМ ключом, но не предъявление — ровно то,
      // что приедет от клиента другой версии.
      [alien.key, await sealPresentation(
        { kind: 'hexseal.presentation.v0' } as never, judy.publicKey)],
      [mine.key, new Uint8Array(512).fill(7)],
    ]);
    const s = stand({ bags: [alien, mine], arbiter: JUDY, sealedForOthers: 1 }, bodies);
    const r = await read(s.source);
    expect(r.tried, 'мешки не забраны — сцена не про то').toBe(2);
    expect(r.presentations).toEqual([]);
    expect(r.skipped.map(x => x.why).sort()).toEqual(['not_presentation', 'sealed_for_other']);
    expect(r.notOurs, 'нечитаемый посчитан не там').toBe(1);
    expect(r.notParsed, 'неразобранный слит с нечитаемым или потерян').toBe(1);
    // Ноль на честном ящике — иначе «подавить всегда» прошло бы даром.
    const clean = stand({ bags: [], arbiter: JUDY, sealedForOthers: 0 }, new Map());
    expect((await read(clean.source)).notParsed).toBe(0);
  }, 60_000);

  it('B8c: мусор в счёте сервера — ОТКАЗ, а не тихий ноль (ревью круг 1)', async () => {
    // Ноль здесь не безобидное умолчание, а СНЯТИЕ ОХРАНЫ: именно на `> 0`
    // держится подавление «вам ничего не предъявили». Молча превратив мусор в
    // ноль, мы вывели бы самое опасное утверждение экрана из числа, которого
    // никто не понял.
    for (const bad of [-1, 1.5, Number.NaN]) {
      const s = stand({ bags: [], arbiter: JUDY, sealedForOthers: bad }, new Map());
      await expect(read(s.source), `sealedForOthers = ${bad} проглочено молча`).rejects.toThrow();
    }
    // И отказ назван так, чтобы человеку сказали «это НЕ значит, что пусто».
    const s = stand({ bags: [], arbiter: JUDY, sealedForOthers: -1 }, new Map());
    const err = await read(s.source).catch((e: unknown) => e);
    expect(boxReadRefusal(err)).toBe('unknown');
  });

  it('B9: indexTrusted переживает модель — при пустом ящике летит ОБА состояния, не теряется (ревью Задачи 1, круг 3)', async () => {
    // Пустой ящик — ключевой случай, а не любой: посчитанные числа
    // (notOurs, sealedForOthersDeclared) молчат ОДИНАКОВО что при честной
    // пустоте, что при потере индекса релеера (deal/sealedFor восстановленной
    // записи неоткуда взять — см. relayer/bagStore.js, listDisputeBags).
    // Различить их может только indexTrusted, и readDisputeBox() обязана
    // пронести его без потерь и без домысливания.
    const untrusted = stand({ bags: [], arbiter: JUDY, sealedForOthers: 0, indexTrusted: false }, new Map());
    const rUntrusted = await read(untrusted.source);
    expect(rUntrusted.presentations).toEqual([]);
    expect(rUntrusted.indexTrusted, 'сигнал о перестроенной описи потерян моделью').toBe(false);

    // Зеркало: честная пустота при целом индексе — то же самое пустое
    // чтение, но indexTrusted честно true, а не подставлено угадыванием.
    const trusted = stand({ bags: [], arbiter: JUDY, sealedForOthers: 0, indexTrusted: true }, new Map());
    const rTrusted = await read(trusted.source);
    expect(rTrusted.presentations).toEqual([]);
    expect(rTrusted.indexTrusted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Вердикты и два набора чисел
// ═══════════════════════════════════════════════════════════════════════════

async function oneBag(container: PresentationContainer) {
  const sealed = await sealPresentation(container, judy.publicKey);
  const b = summary('one.bin');
  const s = stand({ bags: [b], arbiter: JUDY, sealedForOthers: 0 }, new Map([[b.key, sealed]]));
  const r = await read(s.source);
  return r.presentations[0];
}

describe('вердикты и числа', () => {
  it('C1: честное — оба набора чисел на месте и РАЗНЫЕ по составу', async () => {
    const bag = await oneBag(honest);
    expect(bag.view.container).toBe('ok');
    expect(bag.declared, 'слово стороны потеряно').not.toBeNull();
    expect(Object.keys(bag.declared!).sort()).toEqual(['hidden', 'notPrepared', 'read']);
    expect(Object.keys(bag.measured).sort()).toEqual(['hidden', 'notPrepared', 'read', 'unopened']);
    expect(bag.declared!.read).toBe(3);
    expect(bag.measured.read + bag.measured.unopened).toBe(3);
    expect(bag.countsDisagree, 'честный контейнер объявлен лжецом').toEqual([]);
    expect(bag.uploaderIsPresenter).toBe(true);
    expect(bag.messages.filter(m => m.read).length).toBe(3);
    expect(bag.messages.every(m => m.authorConfirmed)).toBe(true);
    expect(bag.messages[0].text, 'слов не видно — а они целиком по решению владельца').toBeTruthy();
  }, 60_000);

  it('C2: подпись контейнера не сошлась — вердикты есть, слов нет, слова стороны нет', async () => {
    const bytes = bytesFromB64(honest.signature)!;
    bytes[0] ^= 0xff;
    const bag = await oneBag({ ...honest, signature: b64FromBytes(bytes) });
    expect(bag.view.container).toBe('bad_signature');
    expect(bag.messages.length, 'вердикты стёрты вместе с содержимым').toBe(3);
    expect(bag.messages.every(m => m.text === null), 'содержимое показано при негодной подписи').toBe(true);
    expect(bag.messages.every(m => !m.read)).toBe(true);
    // Кто предъявил — неизвестно. Приписать эти три числа «стороне» значило бы
    // назвать автором того, кого мы не установили.
    expect(bag.declared, 'числа приписаны неизвестному автору').toBeNull();
    expect(bag.countsDisagree).toEqual([]);
    expect(bag.uploaderIsPresenter).toBeNull();
  }, 60_000);

  it('C3: сторона подписала СВОЁ враньё в счёте — расхождение названо полем', async () => {
    const lying = await resign(
      { ...honest, counts: { ...honest.counts, hidden: honest.counts.hidden + 5 } },
      alice.session,
    );
    const bag = await oneBag(lying);
    expect(bag.view.container, 'лжец подписал сам — подпись обязана сойтись').toBe('ok');
    expect(bag.countsDisagree).toEqual(['hidden']);
    expect(bag.declared!.hidden).toBe(honest.counts.hidden + 5);
    expect(bag.measured.hidden, 'посчитанное подменено заявленным').toBe(honest.counts.hidden);
  }, 60_000);

  it('C4: «прочитано меньше заявленного» — НЕ расхождение (у нас не открылось)', () => {
    // Сумма прочитанного и неоткрывшегося — вот что сверяется с заявленным.
    expect(countsDisagreement(
      { read: 10, hidden: 2, notPrepared: 1 },
      { read: 7, unopened: 3, hidden: 2, notPrepared: 1 },
    ), 'честную сторону обвинили за нашу сломанную печать').toEqual([]);
    expect(countsDisagreement(
      { read: 10, hidden: 2, notPrepared: 1 },
      { read: 7, unopened: 1, hidden: 2, notPrepared: 1 },
    )).toEqual(['read']);
    expect(countsDisagreement(null, { read: 0, unopened: 3, hidden: 0, notPrepared: 0 })).toEqual([]);
  });

  it('C5: автор не подтверждён — вердикт назван, «прочитано» этого не прячет', async () => {
    // Убираем заверение второй стороны: её кадры остаются читаемыми, но
    // подписной ключ больше ничем не связан с адресом.
    const noPeerAtt = await resign(
      { ...honest, attestations: honest.attestations.filter(a => a.address.toLowerCase() === alice.address.toLowerCase()) },
      alice.session,
    );
    const bag = await oneBag(noPeerAtt);
    expect(bag.view.container).toBe('ok');
    const theirs = bag.messages.filter(m => m.sender.toLowerCase() === bob.address.toLowerCase());
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every(m => m.attestation === 'absent')).toBe(true);
    expect(theirs.every(m => !m.authorConfirmed), 'неподтверждённый автор объявлен подтверждённым').toBe(true);
    const mine = bag.messages.filter(m => m.sender.toLowerCase() === alice.address.toLowerCase());
    expect(mine.every(m => m.authorConfirmed), 'подтверждённый автор объявлен неподтверждённым').toBe(true);
  }, 60_000);

  it('C5b: подтверждённый автор приезжает С ДАТОЙ ЗАВЕРЕНИЯ, а не одним словом (находка 51)', async () => {
    // Заверение отозвать нечем: поля отзыва в нём нет, срок — год. У человека
    // украли устройство, вор подписывает прежним ключом, прежнее заверение
    // живо — и арбитр получает `ok` на обоих. Развести их можно ТОЛЬКО по
    // дате, значит дата обязана доехать до модели, а не остаться в контейнере.
    const bag = await oneBag(honest);
    const confirmed = bag.messages.filter(m => m.authorConfirmed);
    expect(confirmed.length, 'сцена выродилась — подтверждённых кадров нет').toBe(3);
    for (const m of confirmed) {
      expect(m.attestedAt, 'подтверждено без даты — «автор подтверждён» и всё').not.toBeNull();
      // Дата ЗАВЕРЕНИЯ, а не время сборки контейнера: это разные величины, и
      // подмена одной другой сделала бы улику бессмысленной.
      const att = honest.attestations.find(a => a.address.toLowerCase() === m.sender.toLowerCase());
      expect(att, 'кадр подтверждён заверением, которого в контейнере нет').toBeTruthy();
      expect(m.attestedAt, 'названа дата ДРУГОГО заверения').toBe(att!.issuedAt);
    }

    // Зеркало: заверения нет — датировать нечего, и выдумывать дату нельзя.
    const noPeerAtt = await resign(
      { ...honest, attestations: honest.attestations.filter(a => a.address.toLowerCase() === alice.address.toLowerCase()) },
      alice.session,
    );
    const bare = await oneBag(noPeerAtt);
    const theirs = bare.messages.filter(m => m.sender.toLowerCase() === bob.address.toLowerCase());
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every(m => m.attestedAt === null), 'дата придумана там, где заверения нет').toBe(true);
  }, 60_000);

  it('C5d: две заверённые пары у одной стороны — названа дата ТОЙ, которой подписан кадр (находка 51)', async () => {
    // СЦЕНА КРАЖИ В ЧИСТОМ ВИДЕ. У Боба ДВЕ годные заверённые пары: та, которой
    // подписаны показанные кадры, и более СВЕЖАЯ — заведённая на другом
    // устройстве (в находке 51 это устройство вора). Обе дают `ok`
    // ОДНОВРЕМЕННО: отзыва в заверении нет и завести его нечем. Арбитр обязан
    // увидеть дату ТОЙ пары, которой назван кадр, а не самой свежей у стороны,
    // — иначе развести половины переписки по датам, ради чего поле и заведено,
    // станет нечем, и находка останется закрытой только на словах.
    const { makeActor: mk, attestationOf } = await import('@/lib/__stand__/presentationFixtures');
    const bobReal = honest.attestations.find(a => a.address.toLowerCase() === bob.address.toLowerCase())!;
    // Часы обязаны тикнуть: `signChatKeyAttestation` ставит `Date.now()`, и
    // приманка, совпавшая по миллисекунде, сцену бы выродила.
    await new Promise(r => setTimeout(r, 5));
    // Тот же кошелёк, ДРУГОЙ ключ чата — значит другое заверение, и свежее.
    const decoyActor = await mk(`0x${'22'.repeat(32)}`, 'ab');
    const decoy = await attestationOf(decoyActor);
    expect(decoy.address.toLowerCase(), 'приманка не про того человека').toBe(bob.address.toLowerCase());
    expect(decoy.signKey, 'приманка совпала ключом — сцены нет').not.toBe(bobReal.signKey);
    expect(decoy.issuedAt, 'приманка не свежее настоящего — сцена выродилась')
      .toBeGreaterThan(bobReal.issuedAt);

    const twoPairs = await resign({ ...honest, attestations: [...honest.attestations, decoy] }, alice.session);
    const bag = await oneBag(twoPairs);
    expect(bag.view.container, 'подпись контейнера сломана приманкой').toBe('ok');
    const theirs = bag.messages.filter(m => m.sender.toLowerCase() === bob.address.toLowerCase());
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every(m => m.authorConfirmed), 'кадр проверен ключом ЧУЖОЙ пары').toBe(true);
    for (const m of theirs) {
      expect(m.attestedAt, 'названа дата самой свежей пары, а не той, которой подписан кадр')
        .toBe(bobReal.issuedAt);
    }
  }, 120_000);

  it('C5c: дата заверения для глаз — ISO по UTC, а не местный формат (находка 51)', () => {
    // Арбитр сверяет её со словами человека («устройство украли третьего»).
    // Местный формат разошёлся бы у него и у стороны на пояс и на порядок
    // «день/месяц» — там, где цена ошибки равна вердикту.
    expect(attestationDateLabel(1_754_400_000_000)).toBe('2025-08-05');
    expect(attestationDateLabel(0)).toBe('1970-01-01');
    expect(attestationDateLabel(null), 'нечего датировать — выдумана дата').toBeNull();
    expect(attestationDateLabel(Number.NaN), 'мусор превращён в дату').toBeNull();
    expect(attestationDateLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('C6: вложение — фактом; ни ключа, ни адреса в модели нет', async () => {
    const bag = await oneBag(honest);
    const flat = JSON.stringify(bag.messages);
    for (const forbidden of ['keyHex', 'ivHex', 'sealedKey', 'fileKey', 'url', 'chunkCount']) {
      expect(flat, `в виде арбитра поехало поле ${forbidden}`).not.toContain(forbidden);
    }
    expect(bag.messages.every(m => m.file === null || typeof m.file.name === 'string')).toBe(true);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Цепь и устройство: честное «не знаем»
// ═══════════════════════════════════════════════════════════════════════════

describe('чего мы не знаем', () => {
  it('D1: узел молчит — «не знаем», а НЕ ноль', () => {
    expect(arbitersBefore({ known: false }), '«не знаем» слито с «никого не было»').toBeNull();
    expect(arbitersBefore({ known: true, turn: 1 })).toBe(0);
    expect(arbitersBefore({ known: true, turn: 3 })).toBe(2);
    expect(arbitersBefore({ known: true, turn: 0 }), 'минус один арбитр').toBe(0);
  });

  it('D2: ключ этого устройства разошёлся с цепью — названо, а не «ящик пуст»', () => {
    const chainKey = `0x${'ab'.repeat(32)}`;
    const chain = { boxKey: chainKey, signKey: `0x${'cd'.repeat(32)}`, present: true } as never;
    expect(deviceKeyVerdict(chainKey, chain)).toBe('agree');
    expect(deviceKeyVerdict(chainKey.toUpperCase(), chain), 'регистр — не повод обвинять').toBe('agree');
    expect(deviceKeyVerdict(`0x${'99'.repeat(32)}`, chain)).toBe('differs');
    expect(deviceKeyVerdict(chainKey, null)).toBe('chain_unread');
    expect(deviceKeyVerdict(chainKey, { boxKey: `0x${'00'.repeat(32)}`, signKey: `0x${'00'.repeat(32)}`, present: false } as never))
      .toBe('chain_missing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. ЗАМЕРЫ (не замки — названы вслух): цена окнами подписи и временем
// ═══════════════════════════════════════════════════════════════════════════

describe('цена', () => {
  it('E1: ЗАМЕР — 0 окон на устройстве с ключом, 1 без него, и причина названа', async () => {
    const { installFakeChatDisk } = await import('@/lib/__stand__/fakeChatDisk');
    const disk = installFakeChatDisk();
    try {
      const wallet = new ethers.Wallet(`0x${'5e'.repeat(32)}`);
      const address = wallet.address as `0x${string}`;
      let prompts = 0;
      const sign = createGatedSignChatKey(async (td) => {
        prompts++;
        const types = { ...(td.types as Record<string, unknown>) };
        delete (types as Record<string, unknown>).EIP712Domain;
        return (await wallet.signTypedData(
          td.domain as never, types as never, td.message as never,
        )) as `0x${string}`;
      }, () => { /* отметка ухода в замере не нужна */ });
      expect(CHAT_KEY_TYPED_DATA.primaryType).toBe('ChatKey');

      let absent: unknown = null;
      try {
        await openArbiterBoxSession(address, sign, { mayCreate: false });
      } catch (err) { absent = err; }
      expect(isSessionAbsent(absent), 'причина не названа — человек увидит «сломалось»').toBe(true);
      expect(prompts, 'кошелёк потревожен без нажатия').toBe(0);

      const created = await openArbiterBoxSession(address, sign, { mayCreate: true });
      expect(prompts, 'заведение ключа стоило не одно окно').toBe(1);
      expect(created.prompted).toBe(true);

      const again = await openArbiterBoxSession(address, sign, { mayCreate: false });
      expect(prompts, 'второе открытие ящика снова спросило кошелёк').toBe(1);
      expect(again.prompted).toBe(false);
      console.info(`[замер] окна подписи за ключ чата арбитра: нет ключа → 1, есть → 0`);
    } finally {
      disk.restore();
    }
  }, 120_000);

  it('E3: ЗАМЕР — ДОСТИЖИМЫЙ худший случай: 99 мешков ПРЕДЕЛЬНОГО размера (ревью круг 1)', async () => {
    // ⚠️ ЗАЧЕМ ОТДЕЛЬНО ОТ E2. У E2 мешки по 1 КБ и мусорные: печать не
    // открывается, и до `readPresentation` дело не доходит вовсе — то есть E2
    // меряет цену ПЕРЕБОРА, а не цену РАЗБОРА, и подставлять его как ответ на
    // «долбят нарочно» нельзя. Достижимый худший случай другой: писать в ящик
    // может любая сторона спора, значит она может залить ГОДНЫЕ контейнеры
    // предельного размера, а `readDisputeBox` гоняет `readPresentation`
    // последовательно и своего потолка на объём не имеет (Возражение 5,
    // открытый пункт 50.2). Останавливает арбитра только бюджет чтения —
    // 1 опись + 99 мешков.
    const { installFakeChatDisk } = await import('@/lib/__stand__/fakeChatDisk');
    const { attestationOf, forgeFrames, seedArchive, fitsFromRefusal } =
      await import('@/lib/__stand__/presentationFixtures');
    const { _resetConversationMemoryForTest } = await import('@/lib/chatConversation');
    const { presentationJson } = await import('@/lib/presentationBag');

    // Самый толстый контейнер, который вообще соглашается собрать сборщик:
    // просим заведомо больше, получаем отказ `too_large` с числом влезающих и
    // собираем ровно по нему. Это потолок не наш, а боевой.
    _resetConversationMemoryForTest();
    const disk = installFakeChatDisk();
    let fat: PresentationContainer;
    try {
      const texts = Array.from({ length: 300 }, (_, i) => `сообщение номер ${i} ` + 'ы'.repeat(40));
      const frames = await forgeFrames(alice, bob, texts);
      expect(await seedArchive(alice, bob, frames)).toBe(300);
      const own = await attestationOf(alice);
      const input = (take: number) => ({
        dealId: AGREEMENT, presenter: alice.address, peer: bob.address,
        arbiterBoxKey: toArbiterBoxKeyBytes(judy.publicKey),
        peerBoxKey: toPeerBoxKeyBytes(bob.session.keypair.publicKey),
        selected: frames.slice(0, take).map(f => ({ seq: f.seq, sender: alice.address })),
        session: alice.session,
        ownAttestation: own,
      });
      const tooMuch = await buildPresentation(input(300));
      expect(tooMuch.ok, 'сборщик проглотил 300 сообщений — потолок съехал').toBe(false);
      const fits = fitsFromRefusal(tooMuch);
      expect(fits, 'отказ приехал без числа влезающих').not.toBeNull();
      const built = await buildPresentation(input(fits!));
      if (!built.ok) throw new Error(`и подрезанный не влез: ${built.reason}`);
      fat = built.container;
    } finally { disk.restore(); _resetConversationMemoryForTest(); }

    const containerBytes = presentationJson(fat).byteLength;
    const sealed = await sealPresentation(fat, judy.publicKey);

    // Цена ОДНОГО разбора, замеренная отдельно: если ниже она разделится не в
    // это число, значит что-то кэшируется, и замер надо читать иначе.
    const { readPresentation } = await import('@/lib/presentationRead');
    const tOne = Date.now();
    const oneView = await readPresentation(fat, judy);
    const oneMs = Date.now() - tOne;
    expect(oneView.container).toBe('ok');

    // Ровно столько, сколько успеет забрать бюджет: 1 опись + 99 мешков.
    const bodies = new Map<string, Uint8Array>();
    const bags: DisputeBoxBag[] = [];
    for (let i = 0; i < 99; i++) {
      const b = summary(`fat-${String(i).padStart(3, '0')}.bin`,
        { size: sealed.byteLength, uploadedAt: 3_000 + i });
      bags.push(b); bodies.set(b.key, sealed);
    }
    const s = stand({ bags, arbiter: JUDY, sealedForOthers: 0 }, bodies);
    const started = Date.now();
    const r = await read(s.source);
    const ms = Date.now() - started;

    expect(r.tried).toBe(99);
    expect(r.presentations.length, 'предельные контейнеры не разобрались').toBe(99);
    console.info(
      `[замер] ДОСТИЖИМЫЙ ХУДШИЙ СЛУЧАЙ: контейнер ${containerBytes} Б (${fat.frames.length} сообщений), `
      + `один разбор ${oneMs} мс; 99 таких мешков — ${ms} мс (${Math.round(ms / 99)} мс на мешок). `
      + `Сравнить с E2 (122 мусорных по 1 КБ): там до разбора дело не доходит вовсе.`,
    );
    // Потолка на объём у чтения НЕТ (пункт 50.2) — порог здесь только чтобы
    // замер не висел вечно, а не утверждение, что этого времени достаточно.
    expect(ms, 'разбор предельного ящика упёрся во что-то новое').toBeLessThan(600_000);
  }, 900_000);

  it('E2: ЗАМЕР — 122 мешка в ящике: сколько это стоит времени', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bodies = new Map<string, Uint8Array>();
    const bags: DisputeBoxBag[] = [];
    for (let i = 0; i < 121; i++) {
      const b = summary(`j-${String(i).padStart(3, '0')}.bin`, { sealedFor: REX, uploadedAt: 1_000 + i });
      bags.push(b); bodies.set(b.key, new Uint8Array(1024).fill(9));
    }
    const good = summary('good.bin', { uploadedAt: 2_000 });
    bags.push(good); bodies.set(good.key, sealed);
    const s = stand({ bags, arbiter: JUDY, sealedForOthers: 121 }, bodies);
    const started = Date.now();
    const r = await read(s.source);
    const ms = Date.now() - started;
    console.info(`[замер] ящик из 122 мешков: ${ms} мс, из них предъявлений ${r.presentations.length}`);
    expect(r.tried).toBe(122);
    expect(r.stop).toBe('read_all');
    expect(ms, 'разбор ящика упёрся в алгоритм, а не в мелочи').toBeLessThan(120_000);
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Отпечаток в цепи — сверяется, а не лежит украшением (Задача 7)
//
// ⚠️ ЗАЧЕМ ЭТОТ РАЗДЕЛ. «Отпечаток обязан кем-то сверяться, иначе он
// украшение» (замысел 5.4). Класс бага в проекте известен поимённо: поле
// объявлено, выглядит осмысленно и не проверяется ничем. Здесь у него есть
// читатель, вердикт и число.
//
// ⚠️ ОЖИДАЕМЫЙ ОТПЕЧАТОК СЧИТАЕТСЯ ЗДЕСЬ САМ — `keccak256(canonical…)`, а не
// зовётся `presentationDigest` из проверяемого пути: иначе тест сверял бы
// модуль сам с собой и молчал бы ровно на той беде, ради которой стоит (другой
// пре-образ или другая функция хэша).
// ═══════════════════════════════════════════════════════════════════════════

const anchorsOf = (over: Partial<ChainAnchors> = {}): ChainAnchors => ({
  digests: [], digestsComplete: true, records: [], noResponse: [],
  logsComplete: true, window: null, ...over,
});

const recordOf = (digest: `0x${string}`, block: bigint, over: Partial<DigestRecord> = {}): DigestRecord => ({
  digest, submitter: alice.address, index: BigInt(0), block, txHash: null, ...over,
});

const readAnchored = (source: DisputeBoxSource, anchors: ChainAnchors | null) =>
  readDisputeBox({
    source, own: judy, agreement: AGREEMENT, me: JUDY,
    anchors: anchors === null
      ? async () => { throw new Error('узел не ответил'); }
      : async () => anchors,
  });

describe('сверка отпечатка', () => {
  it('F1: подменили байты мешка при живом отпечатке — «не сходится»', () => {
    const onChain = keccak256(canonicalPresentationBytes(honest));
    const tampered = { ...honest, frames: honest.frames.slice(1) };
    expect(verifyDigest(tampered, onChain)).toBe(false);
  });

  it('F2: нетронутый мешок сходится', () => {
    expect(verifyDigest(honest, keccak256(canonicalPresentationBytes(honest)))).toBe(true);
  });

  it('F3: регистр отпечатка ничего не решает — шов держит и верхний', () => {
    const onChain = keccak256(canonicalPresentationBytes(honest));
    expect(verifyDigest(honest, onChain.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(true);
    // …и при этом длина всё-таки сверяется: обрезанный отпечаток не «сходится».
    expect(verifyDigest(honest, onChain.slice(0, 40) as `0x${string}`)).toBe(false);
  });

  it('F4: мешок из ящика сверяется с цепью — «сходится» и НОМЕР БЛОКА из ленты', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bag = summary('honest.bin');
    const digest = keccak256(canonicalPresentationBytes(honest));
    const s = stand({ bags: [bag], arbiter: JUDY, sealedForOthers: 0 }, new Map([[bag.key, sealed]]));
    const r = await readAnchored(s.source, anchorsOf({
      digests: [digest], records: [recordOf(digest, BigInt(44_700_000))],
    }));
    expect(r.presentations.length).toBe(1);
    expect(r.presentations[0].digest).toBe(digest);
    expect(r.presentations[0].anchor.verdict).toBe('match');
    // ⚠️ БЛОК — ТОЛЬКО ИЗ СОБЫТИЯ. Геттеры его не отдают, а без него порядок
    // («отпечаток на блоке N, запись арбитра на блоке M») показать нечем.
    expect(r.presentations[0].anchor.block).toBe(BigInt(44_700_000));
  });

  it('F5: байты подменили, подпись перевешена честно — цепь ловит то, чего не ловит подпись', async () => {
    // Живой лжец собирает контейнер сам и подписывает СВОЁ враньё: подпись
    // сойдётся, вердикт читалки будет `ok`. Разойдутся только 32 байта,
    // легшие в цепь на своём блоке.
    const anchoredDigest = keccak256(canonicalPresentationBytes(honest));
    const rebuilt = await resign({ ...honest, frames: honest.frames.slice(1) }, alice.session);
    const sealed = await sealPresentation(rebuilt, judy.publicKey);
    const bag = summary('rebuilt.bin');
    const s = stand({ bags: [bag], arbiter: JUDY, sealedForOthers: 0 }, new Map([[bag.key, sealed]]));
    const r = await readAnchored(s.source, anchorsOf({
      digests: [anchoredDigest], records: [recordOf(anchoredDigest, BigInt(44_700_000))],
    }));
    expect(r.presentations.length).toBe(1);
    expect(r.presentations[0].view.container, 'подпись перевешена — читалке претензий нет').toBe('ok');
    expect(r.presentations[0].anchor.verdict).toBe('mismatch');
    expect(r.presentations[0].anchor.total, 'сверять БЫЛО с чем — и это число на экране').toBe(1);
  });

  it('F6: в цепи не отмечено — ЭТО НЕ ОШИБКА и не «не сходится»', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bag = summary('honest.bin');
    const s = stand({ bags: [bag], arbiter: JUDY, sealedForOthers: 0 }, new Map([[bag.key, sealed]]));
    const r = await readAnchored(s.source, anchorsOf({ digests: [] }));
    expect(r.presentations[0].anchor.verdict).toBe('absent');
  });

  it('F7: цепь не ответила — «не знаем», а НЕ «не отмечено», и ящик всё равно прочитан', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bag = summary('honest.bin');
    const s = stand({ bags: [bag], arbiter: JUDY, sealedForOthers: 0 }, new Map([[bag.key, sealed]]));
    const r = await readAnchored(s.source, null);
    expect(r.anchors).toBeNull();
    expect(r.presentations.length, 'отказ узла уронил чтение ящика').toBe(1);
    expect(r.presentations[0].anchor.verdict).toBe('unread');
  });

  it('F8: список отпечатков НЕПОЛОН и не совпало — «не знаем», а не обвинение', () => {
    const digest = keccak256(canonicalPresentationBytes(honest));
    const other = keccak256(new Uint8Array([1, 2, 3]));
    expect(bagAnchor(digest, anchorsOf({ digests: [other], digestsComplete: false })).verdict)
      .toBe('unread');
    // Тот же список, но полный — уже обвинение, и оно законно.
    expect(bagAnchor(digest, anchorsOf({ digests: [other] })).verdict).toBe('mismatch');
  });

  it('F9: дубль отпечатка схлопнут в одну строку, но число записей НЕ спрятано', () => {
    const digest = keccak256(canonicalPresentationBytes(honest));
    const a = bagAnchor(digest, anchorsOf({
      digests: [digest, digest],
      records: [recordOf(digest, BigInt(44_700_010), { index: BigInt(1) }), recordOf(digest, BigInt(44_700_000))],
    }));
    expect(a.verdict).toBe('match');
    expect(a.records, 'дубль спрятан — это не ложь, но и не правда').toBe(2);
    expect(a.block, 'взят поздний блок — спор решает то, что легло РАНЬШЕ').toBe(BigInt(44_700_000));
  });

  it('F10: отметка есть, а блока в ленте нет — «сходится», а не «не отмечено»', () => {
    const digest = keccak256(canonicalPresentationBytes(honest));
    const a = bagAnchor(digest, anchorsOf({ digests: [digest], records: [], logsComplete: false }));
    expect(a.verdict).toBe('match');
    expect(a.block).toBeNull();
  });

  it('F11: ПОРЯДОК — ради него всё и затевалось, и он не угадывается', () => {
    expect(anchorOrder(BigInt(10), BigInt(20))).toBe('digest_first');
    expect(anchorOrder(BigInt(20), BigInt(10))).toBe('record_first');
    expect(anchorOrder(BigInt(10), BigInt(10))).toBe('same_block');
    expect(anchorOrder(null, BigInt(10)), 'блока нет — молчим').toBe('unknown');
    expect(anchorOrder(BigInt(10), null), 'записи нет — молчим').toBe('unknown');
  });

  it('F12: записи арбитров о молчании доезжают до модели с номерами блоков', async () => {
    const sealed = await sealPresentation(honest, judy.publicKey);
    const bag = summary('honest.bin');
    const digest = keccak256(canonicalPresentationBytes(honest));
    const s = stand({ bags: [bag], arbiter: JUDY, sealedForOthers: 0 }, new Map([[bag.key, sealed]]));
    const r = await readAnchored(s.source, anchorsOf({
      digests: [digest],
      records: [recordOf(digest, BigInt(44_700_000))],
      noResponse: [
        { arbiter: REX, at: BigInt(1_760_000_100), block: BigInt(44_700_050), txHash: null },
        { arbiter: JUDY, at: BigInt(1_760_000_000), block: BigInt(44_699_000), txHash: null },
      ],
    }));
    const first = firstNoResponse(r.anchors);
    expect(first, 'записи о молчании потерялись по дороге к экрану').not.toBeNull();
    expect(first!.block, 'взята поздняя запись — сравнивать надо с ПЕРВОЙ').toBe(BigInt(44_699_000));
    expect(anchorOrder(r.presentations[0].anchor.block, first!.block)).toBe('record_first');
  });
});
