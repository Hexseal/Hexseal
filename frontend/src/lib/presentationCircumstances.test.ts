/**
 * presentationCircumstances.test.ts — пять вопросов про обстоятельства,
 * приложенные к предъявлению переписки арбитру. Ответ числом, не рассуждением.
 *
 * `docs/PROCESS.md`: про логику думают всегда, потому что она в задаче
 * написана; про обстоятельства не думает никто, потому что их в задаче нет.
 *
 * Здесь четыре вопроса из пяти и пятый в своём виде: у предъявления «кончилось
 * место» — это ПОТОЛОК МЕШКА, 256 КиБ (`relayer/bagStore.js:244`). Пятый
 * вопрос про нарочную нагрузку — на настоящем складе, `__stand__/presentationFlood.test.ts`.
 *
 * ⚠️ Поддельный диск здесь ОДИН на все базы: `installFakeChatDisk` подделывает
 * `indexedDB.open` без разбора имени, то есть архив переписки
 * (`hexseal-chat-conv`) и черновики предъявления (`hexseal-presentation`)
 * лежат в одной `Map`. Ключи не пересекаются (`0x..|0x..#i` против
 * `drafts|0x..`), и это ровно то, что нужно замеру «что осталось на диске».
 *
 * ⚠️ ОТСТУПЛЕНИЕ ОТ ПЛАНА (задание задачи 8, разбор в отчёте): `buildPresentation`
 * после слияния задачи 5 принимает `arbiterBoxKey`/`peerBoxKey` как ФИРМЕННЫЕ
 * (branded) типы `ArbiterBoxKeyBytes`/`PeerBoxKeyBytes`, не голый `Uint8Array` —
 * см. `presentation.ts:232-247`. Плоский `Uint8Array` не проходит проверку типов.
 * Клеймение — `toArbiterBoxKeyBytes`/`toPeerBoxKeyBytes` из того же модуля,
 * тем же приёмом, что уже применяют `presentation.test.ts:179-180` и
 * `__stand__/presentationStand.test.ts:156-157`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FRAME_HEADER_LEN, _resetConversationMemoryForTest } from '@/lib/chatConversation';
import { recoverOneTimeKey } from '@/lib/chatEnvelope';
import {
  buildPresentation, b64FromBytes,
  PRESENTATION_MAX_BYTES, PRESENTATION_SEAL_OVERHEAD,
  toArbiterBoxKeyBytes, toPeerBoxKeyBytes,
  type PresentationContainer,
} from '@/lib/presentation';
import { readPresentation } from '@/lib/presentationRead';
import type { ChatKeyAttestation } from '@/lib/chatKeyAttestation';
import {
  presentationWireBytes, sealPresentation, lookIntoBag, findPresentations, fittingMessageCount,
} from '@/lib/presentationBag';
import {
  draftFromContainer, savePresentationDraft, readPresentationDrafts,
  unsentPresentationDrafts, markPresentationSent, LOCK_TIMEOUT_MS,
} from '@/lib/presentationDraft';
import {
  makeActor, attestationOf, forgeFrames, seedArchive, fitsFromRefusal,
  type Actor, type ForgedFrame,
} from '@/lib/__stand__/presentationFixtures';
import { installFakeChatDisk, type FakeChatDisk, type FakeDiskControl } from '@/lib/__stand__/fakeChatDisk';

/** Адреса агриментов — как везде в проекте: адрес контракта, не bytes32. */
const DEAL = '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as const;
const OTHER_DEAL = '0x4C3E4AFd5707Aee625F01B0042D8dA9dd1Ac689C' as const;

const PK_ALICE = `0x${'11'.repeat(32)}`;
const PK_BOB = `0x${'22'.repeat(32)}`;
const PK_JUDY = `0x${'33'.repeat(32)}`;
const PK_EVE = `0x${'44'.repeat(32)}`;

type BuildInput = Parameters<typeof buildPresentation>[0];

let alice: Actor; let bob: Actor; let judy: Actor; let eve: Actor;
let aliceAtt: ChatKeyAttestation; let bobAtt: ChatKeyAttestation;
let disk: FakeChatDisk;
let control: FakeDiskControl;
let frames: ForgedFrame[];
let fetches = 0;

/** Выбор «весь диалог»: по два сообщения с каждой стороны, вперемежку. */
function selectAll(): BuildInput['selected'] {
  // Адреса — С КОНТРОЛЬНОЙ СУММОЙ, как отдаёт кошелёк. Правило куплено
  // находкой, где 650 зелёных тестов означали нерабочий вход
  // (`chatConversation.test.ts:35-45`).
  return [
    { seq: 0, sender: alice.address }, { seq: 0, sender: bob.address },
    { seq: 1, sender: alice.address }, { seq: 1, sender: bob.address },
  ];
}

function inputFor(selected: BuildInput['selected'], over: Partial<BuildInput> = {}): BuildInput {
  return {
    dealId: DEAL,
    presenter: alice.address,
    // ⚠️ `peer` ОБЯЗАТЕЛЕН (договор v2, исправление 6): архив кадров лежит под парой
    // `${own}|${peer}`, и выводить собеседника из `selected` больше не нужно.
    peer: bob.address,
    arbiterBoxKey: toArbiterBoxKeyBytes(judy.session.keypair.publicKey),
    peerBoxKey: toPeerBoxKeyBytes(bob.session.keypair.publicKey),
    selected,
    session: alice.session,
    ownAttestation: aliceAtt,
    peerAttestation: bobAtt,
    ...over,
  };
}

const buildFor = (selected: BuildInput['selected'], over: Partial<BuildInput> = {}) =>
  buildPresentation(inputFor(selected, over));

/** Собрать и не упасть молча: отказ сборки обязан назвать себя в сообщении. */
async function mustBuild(
  selected: BuildInput['selected'], over: Partial<BuildInput> = {},
): Promise<PresentationContainer> {
  const built = await buildFor(selected, over);
  if (!built.ok) throw new Error(`сборка отказала: ${built.reason}`);
  return built.container;
}

beforeEach(async () => {
  _resetConversationMemoryForTest();
  control = { failPut: false };
  disk = installFakeChatDisk(control);
  fetches = 0;
  // Склад в этом файле НЕ участвует вовсе: любое обращение к сети — находка.
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetches++;
    throw new Error('склад в этом замере звучать не должен');
  }));

  alice = await makeActor(PK_ALICE, '1c');
  bob = await makeActor(PK_BOB, '7f');
  judy = await makeActor(PK_JUDY, '3d');
  eve = await makeActor(PK_EVE, '5a');
  aliceAtt = await attestationOf(alice);
  bobAtt = await attestationOf(bob);

  const mine = await forgeFrames(alice, bob, ['сроки прошли, где работа', 'жду до вечера']);
  const theirs = await forgeFrames(bob, alice, ['да ты хуйню намутил', 'файл отправил вчера'], 1_754_400_500_000);
  frames = [...mine, ...theirs];
  const seeded = await seedArchive(alice, bob, frames);
  expect(seeded, 'посев архива не лёг — дальше мерить нечего').toBe(frames.length);
}, 30_000);

afterEach(() => {
  disk.restore();
  vi.unstubAllGlobals();
  _resetConversationMemoryForTest();
});

/* ═══════════════════ 1. БРОСИЛ НА СЕРЕДИНЕ ══════════════════════════════ */

describe('1. Бросил на середине: собрал предъявление и не отправил', () => {
  it('на складе ноль, черновик один, состояние названо, число сообщений то самое', async () => {
    const container = await mustBuild(selectAll());
    const wire = presentationWireBytes(container);

    expect(await savePresentationDraft(draftFromContainer(container, wire))).toBe('saved');
    expect(fetches, 'сборка сама сходила на склад — предъявление уехало без человека').toBe(0);

    const unsent = await unsentPresentationDrafts(alice.address);
    expect(unsent.length, 'незаконченное предъявление потеряно тихо').toBe(1);
    expect(unsent[0].state).toBe('built');
    expect(unsent[0].messageCount).toBe(4);
    expect(unsent[0].wireBytes).toBe(wire);
    expect(unsent[0].dealId.toLowerCase()).toBe(DEAL.toLowerCase());
  }, 30_000);

  it('в черновике на диске нет ни одного разового ключа открытым', async () => {
    const container = await mustBuild(selectAll());
    expect(await savePresentationDraft(draftFromContainer(container, presentationWireBytes(container))))
      .toBe('saved');

    // Весь диск целиком, как он лёг — включая архив.
    const onDisk = JSON.stringify([...disk.disk.entries()]);
    let checked = 0;
    for (const f of frames) {
      // ⚠️ `await` НЕСУЩИЙ (договор v2, исправление 1): без него `key` — это
      // `Promise`, и `not.toBeNull()` не может упасть ни при какой утечке.
      const key = await recoverOneTimeKey(f.frame.slice(FRAME_HEADER_LEN), alice.session.keypair);
      expect(key, 'разовый ключ не добывается — замер потерял смысл').not.toBeNull();
      if (!key) continue; // сужение типа; строка выше уже уронила замер
      const raw = Buffer.from(key);
      expect(onDisk.includes(raw.toString('hex')), 'разовый ключ лежит на диске открытым').toBe(false);
      expect(onDisk.includes(raw.toString('base64')), 'разовый ключ лежит на диске в base64').toBe(false);
      // ⚠️ И тем же алфавитом, каким пишет контейнер (исправление 2): свой разбор
      // base64 однажды уже сделал стык мёртвым при двух зелёных замерах.
      expect(onDisk.includes(b64FromBytes(key)), 'разовый ключ лежит на диске в base64 контейнера').toBe(false);
      checked++;
    }
    expect(checked, 'проверены не все четыре ключа').toBe(4);
  }, 30_000);
});

/* ═══════════════════ 2. ПЕРЕЗАПУСТИЛИ ПОСРЕДИ ═══════════════════════════ */

describe('2. Перезапустили посреди: закрыл вкладку между сборкой и отправкой', () => {
  it('черновик цел, контейнер тот же — байт в байт', async () => {
    const container = await mustBuild(selectAll());
    const before = JSON.stringify(container);
    expect(await savePresentationDraft(draftFromContainer(container, presentationWireBytes(container))))
      .toBe('saved');

    // ─── перезапуск: реестр модулей пуст, диск остался ───
    vi.resetModules();
    const fresh = await import('@/lib/presentationDraft');
    const after = await fresh.unsentPresentationDrafts(alice.address);

    expect(after.length, 'после перезапуска черновика нет').toBe(1);
    expect(JSON.stringify(after[0].container), 'контейнер пережил перезапуск изменённым').toBe(before);
  }, 30_000);

  it('после перезапуска предъявление уезжает ИЗ ЧЕРНОВИКА: 0 окон кошелька', async () => {
    const container = await mustBuild(selectAll());
    await savePresentationDraft(draftFromContainer(container, presentationWireBytes(container)));
    const promptsBefore = alice.prompts();

    vi.resetModules();
    const freshDraft = await import('@/lib/presentationDraft');
    const freshBag = await import('@/lib/presentationBag');
    const [draft] = await freshDraft.unsentPresentationDrafts(alice.address);
    expect(draft, 'черновика после перезапуска нет — отправлять нечего').toBeDefined();

    const sealed = await freshBag.sealPresentation(draft.container, judy.session.keypair.publicKey);
    expect(sealed.length, 'счёт байтов расходится с тем, что реально уходит').toBe(
      freshBag.presentationWireBytes(draft.container),
    );
    const look = await freshBag.lookIntoBag(sealed, judy.session.keypair);
    expect(look.kind, 'арбитр не узнал в этом предъявления').toBe('presentation');

    expect(await freshDraft.markPresentationSent(alice.address, DEAL, draft.issuedAt, 'k/1-a.bin'))
      .toBe('saved');
    expect((await freshDraft.unsentPresentationDrafts(alice.address)).length).toBe(0);
    const all = await freshDraft.readPresentationDrafts(alice.address);
    expect(all[0].state).toBe('sent');
    expect(all[0].bagKey).toBe('k/1-a.bin');
    expect(alice.prompts() - promptsBefore, 'перезапуск стоил окна кошелька').toBe(0);
  }, 30_000);

  it('диск не пишет: вердикт disk_unavailable, не падение — и черновик не выдуман', async () => {
    const container = await mustBuild(selectAll());
    // Квота кончилась ПОСЛЕ посева архива: подделка читает флаг на каждой
    // записи, поэтому кладовую можно закрыть на середине жизни теста.
    control.failPut = true;

    const verdict = await savePresentationDraft(
      draftFromContainer(container, presentationWireBytes(container)),
    );
    expect(verdict, 'отказ записи выдан за успех — человек уверен, что черновик есть').toBe('disk_unavailable');
    expect(await readPresentationDrafts(alice.address)).toEqual([]);
  }, 30_000);
});

/* ═══════════════════ 3. ДВА ПРОЦЕССА РАЗОМ ══════════════════════════════ */

describe('3. Два процесса разом: две вкладки, две стороны, повторная просьба', () => {
  it('две вкладки, два дела разом — уцелели ОБА черновика', async () => {
    const one = await mustBuild(selectAll());
    const two = await mustBuild(selectAll(), { dealId: OTHER_DEAL });

    await Promise.all([
      savePresentationDraft(draftFromContainer(one, presentationWireBytes(one))),
      savePresentationDraft(draftFromContainer(two, presentationWireBytes(two))),
    ]);

    const all = await readPresentationDrafts(alice.address);
    expect(all.length, 'одна вкладка затёрла черновик другой').toBe(2);
    expect(new Set(all.map((d) => d.dealId.toLowerCase())))
      .toEqual(new Set([DEAL.toLowerCase(), OTHER_DEAL.toLowerCase()]));
  }, 30_000);

  it('две вкладки, ОДНО дело — два черновика, свежий первым', async () => {
    const container = await mustBuild(selectAll());
    const first = draftFromContainer(container, presentationWireBytes(container));
    // Вторая вкладка собрала минутой позже. Подпись контейнера здесь ни при
    // чём: черновик — СВОЁ, и `presentationDraft` подписей не проверяет
    // (проверять свою же подпись значило бы мерить задачу 5, а не диск).
    const later: typeof first = {
      ...first,
      issuedAt: first.issuedAt + 60_000,
      container: { ...container, issuedAt: container.issuedAt + 60_000 },
    };

    await Promise.all([savePresentationDraft(first), savePresentationDraft(later)]);

    const all = await readPresentationDrafts(alice.address);
    expect(all.length, 'два предъявления по одному делу — норма, а осталось одно').toBe(2);
    expect(all[0].issuedAt, 'свежее не первое').toBe(later.issuedAt);
  }, 30_000);

  it('отправленное не понижается до неотправленного опоздавшей вкладкой', async () => {
    const container = await mustBuild(selectAll());
    const draft = draftFromContainer(container, presentationWireBytes(container));
    await savePresentationDraft(draft);
    expect(await markPresentationSent(alice.address, DEAL, draft.issuedAt, 'k/2-b.bin')).toBe('saved');

    // Опоздавшая вкладка пишет своё «собрано, не отправлено».
    expect(await savePresentationDraft(draft)).toBe('saved');

    const all = await readPresentationDrafts(alice.address);
    expect(all.length).toBe(1);
    expect(all[0].state, 'опоздавшая вкладка понизила отправленное').toBe('sent');
    expect(all[0].bagKey).toBe('k/2-b.bin');
  }, 30_000);

  it('пометить отправленным то, чего в черновиках нет — not_found, а не тихое «готово»', async () => {
    expect(await markPresentationSent(alice.address, DEAL, 1_754_000_000_000, 'k/3-c.bin'))
      .toBe('not_found');
  }, 30_000);

  it('арбитр: два предъявления по одному делу — оба, и оба читаются', async () => {
    const one = await mustBuild(selectAll());
    const two = await mustBuild(selectAll().slice(0, 2));
    const bags = [
      { key: 'j/1-one.bin', sender: alice.address.toLowerCase() as `0x${string}`, uploadedAt: 1_000,
        body: await sealPresentation(one, judy.session.keypair.publicKey) },
      { key: 'j/2-two.bin', sender: alice.address.toLowerCase() as `0x${string}`, uploadedAt: 2_000,
        body: await sealPresentation(two, judy.session.keypair.publicKey) },
    ];

    const triage = await findPresentations(bags, judy.session.keypair, DEAL);
    expect(triage.presentations.length, 'одно из двух предъявлений исчезло').toBe(2);
    expect(triage.skipped).toEqual([]);
    expect(
      triage.presentations[0].issuedAt >= triage.presentations[1].issuedAt,
      'порядок не «свежее первым»',
    ).toBe(true);

    for (const p of triage.presentations) {
      const view = await readPresentation(p.container, judy.session.keypair);
      expect(view.container, `предъявление ${p.bagKey} не прочиталось`).toBe('ok');
      expect(view.messages.length).toBe(p.messages);
    }
  }, 60_000);

  it('порядок берётся из ПОДПИСАННОГО времени, а не из свидетельства склада', async () => {
    const container = await mustBuild(selectAll());
    const older = { ...container, issuedAt: container.issuedAt - 60_000 };
    // Склад врёт наоборот: свежее «пришло раньше».
    const bags = [
      { key: 'j/9-old.bin', sender: alice.address.toLowerCase() as `0x${string}`, uploadedAt: 9_000,
        body: await sealPresentation(older, judy.session.keypair.publicKey) },
      { key: 'j/1-new.bin', sender: alice.address.toLowerCase() as `0x${string}`, uploadedAt: 1_000,
        body: await sealPresentation(container, judy.session.keypair.publicKey) },
    ];

    const triage = await findPresentations(bags, judy.session.keypair, DEAL);
    expect(triage.presentations.map((p) => p.bagKey), 'порядок взят у склада').toEqual(
      ['j/1-new.bin', 'j/9-old.bin'],
    );
  }, 30_000);
});

/* ═══════════════════ 4. ПРИШЁЛ МУСОР ════════════════════════════════════ */

describe('4. Пришёл мусор: вердикт, не падение, и у каждого случая своё имя', () => {
  it('случайные байты и обрубок в ящике — sealed_for_other, без броска', async () => {
    for (const body of [new Uint8Array(1024).fill(7), new Uint8Array(10).fill(1), new Uint8Array(0)]) {
      const look = await lookIntoBag(body, judy.session.keypair);
      expect(look.kind, `байты длиной ${body.length}`).toBe('sealed_for_other');
    }
  }, 30_000);

  it('обычный кадр переписки арбитра не выдаётся за предъявление', async () => {
    const own = await forgeFrames(judy, bob, ['это моя переписка, не предъявление']);
    const look = await lookIntoBag(own[0].frame, judy.session.keypair);
    expect(look.kind).toBe('sealed_for_other');
  }, 30_000);

  it('запечатано нам, но внутри не JSON — not_json', async () => {
    const { sealForRecipient } = await import('@/lib/chatCrypto');
    const sealed = await sealForRecipient(judy.session.keypair.publicKey, new Uint8Array([0xff, 0xfe, 0x00, 0x42]));
    expect((await lookIntoBag(sealed, judy.session.keypair)).kind).toBe('not_json');
  }, 30_000);

  it('JSON не того рода или не той формы — not_presentation', async () => {
    const { sealForRecipient } = await import('@/lib/chatCrypto');
    const enc = new TextEncoder();
    const junks = [
      '{"kind":"hexseal.chat.something.v1"}',
      '{"kind":"hexseal.presentation.v1"}',
      `{"kind":"hexseal.presentation.v1","dealId":"нет","presenter":"${alice.address}","issuedAt":1,"frames":[]}`,
      '[1,2,3]',
      'null',
    ];
    for (const junk of junks) {
      const sealed = await sealForRecipient(judy.session.keypair.publicKey, enc.encode(junk));
      const look = await lookIntoBag(sealed, judy.session.keypair);
      expect(look.kind, junk).toBe('not_presentation');
    }
  }, 30_000);

  it('предъявление по ДРУГОМУ делу не подмешивается к этому', async () => {
    const other = await mustBuild(selectAll(), { dealId: OTHER_DEAL });
    const triage = await findPresentations(
      [{ key: 'j/5-other.bin', sender: alice.address.toLowerCase() as `0x${string}`, uploadedAt: 5_000,
        body: await sealPresentation(other, judy.session.keypair.publicKey) }],
      judy.session.keypair, DEAL,
    );
    expect(triage.presentations).toEqual([]);
    expect(triage.skipped).toEqual([{ bagKey: 'j/5-other.bin', why: 'other_deal' }]);
  }, 30_000);

  it('контейнер тронут после подписи — bad_signature: содержимое закрыто, вердикты видны', async () => {
    const container = await mustBuild(selectAll());
    const forged = { ...container, frames: container.frames.slice(0, -1) };
    const view = await readPresentation(forged, judy.session.keypair);
    expect(view.container).toBe('bad_signature');
    // ⚠️ Решение договора v2 (исправление 10): кто предъявил — неизвестно, значит
    // содержимое показывать нельзя; но вердикты по кадрам и заверениям
    // САМОПРОВЕРЯЕМЫ и от подписи контейнера не зависят — их видно.
    // ⚠️ Список обязан быть НЕПУСТЫМ: `every` на пустом массиве — `true`, и
    // прежняя редакция этого замера была зелена от того, что мерить было нечего.
    // Сообщение — на каждый ПОЛОЖЕННЫЙ кадр; неподготовленные лежат отдельным
    // списком `notPrepared` (§15.5, исправление 8), в `messages` их нет.
    //
    // ⚠️ ЗАМЕРЕННОЕ РАСХОЖДЕНИЕ С ПЛАНОМ (отчёт задачи 8, шаг «главный замер»):
    // читалка строит `messages` из `chains[].links`, а НЕ из `container.frames`
    // (`presentationRead.ts:630-674`) — звено кадра остаётся в цепочке, даже
    // когда сам кадр из массива `frames` исчез (ровно то же правило, что держит
    // §15.5 сходящимся при `notPrepared`). Мутация здесь режет ТОЛЬКО `frames`,
    // цепочки (`chains`) не трогает, поэтому число сообщений — число звеньев в
    // ДОСОБРАННОМ контейнере (`container.frames.length`, 4), а не число кадров
    // ПОСЛЕ порчи (`forged.frames.length`, 3). Один из четырёх выйдет с разбитым
    // вердиктом кадра — сам факт остался, просто именем другого числа.
    expect(view.messages.length, 'вердикты по кадрам стёрты вместе с подписью контейнера')
      .toBe(container.frames.length);
    for (const m of view.messages) {
      expect(m.state, 'у неопознанного предъявителя что-то «прочитано»').toBe('unopened');
      expect(m.payload, 'содержимое показано при несошедшейся подписи контейнера').toBeUndefined();
      expect(typeof m.attestation, 'вердикт заверения пропал').toBe('string');
      expect(m.frame, 'вердикт кадра пропал').toBeDefined();
    }
    expect(view.counts.read, 'при неизвестном предъявителе что-то посчитано прочитанным').toBe(0);
    expect(view.counts.unopened).toBe(container.frames.length);
  }, 30_000);

  it('заверение не сходится — сказано прямо, а не молча «ок»', async () => {
    // Заверение собеседника подписано им, но названо чужим адресом.
    const container = await mustBuild(selectAll(), {
      peerAttestation: { ...bobAtt, address: eve.address },
    });
    const view = await readPresentation(container, judy.session.keypair);
    expect(view.container).toBe('ok');
    const his = view.messages.filter((m) => m.sender.toLowerCase() === bob.address.toLowerCase());
    expect(his.length, 'сообщений собеседника в предъявлении нет — мерить нечего').toBeGreaterThan(0);
    for (const m of his) {
      expect(m.attestation, 'несошедшееся заверение выдано за проверенное').not.toBe('ok');
    }
    // Своё заверение при этом в порядке — и это тоже видно.
    const mine = view.messages.filter((m) => m.sender.toLowerCase() === alice.address.toLowerCase());
    expect(mine.every((m) => m.attestation === 'ok')).toBe(true);
  }, 30_000);

  it('заверения собеседника нет вовсе — absent, а не malformed и не «ок»', async () => {
    // `peerAttestation` необязателен: собеседник мог не объявлять ключ ключом
    // кошелька. Это ШТАТНЫЙ случай, и он обязан называться своим именем —
    // «не приложено» и «приложен мусор» для арбитра разные новости
    // (договор v2, исправление 5: вердикт `absent` попросили три задачи порознь).
    const container = await mustBuild(selectAll(), { peerAttestation: undefined });
    const view = await readPresentation(container, judy.session.keypair);
    expect(view.container, 'без заверения собеседника предъявление вообще не читается').toBe('ok');

    const his = view.messages.filter((m) => m.sender.toLowerCase() === bob.address.toLowerCase());
    expect(his.length, 'сообщений собеседника нет — мерить нечего').toBeGreaterThan(0);
    for (const m of his) {
      expect(m.attestation, 'отсутствие заверения выдано за мусор или за проверенное').toBe('absent');
    }
    // Своё — на месте: `absent` не расползается на всех.
    const mine = view.messages.filter((m) => m.sender.toLowerCase() === alice.address.toLowerCase());
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.attestation === 'ok'), 'своё заверение тоже потеряли').toBe(true);
  }, 30_000);

  it('кадр с чужой подписью — назван, а не показан как проверенный', async () => {
    _resetConversationMemoryForTest();
    disk.restore();
    control = { failPut: false };
    disk = installFakeChatDisk(control);

    const mine = await forgeFrames(alice, bob, ['раз', 'два']);
    const theirs = await forgeFrames(bob, alice, ['три', 'четыре'], 1_754_400_500_000);
    // Портим один байт ВНУТРИ подписи (смещение 33..96 кадра): звено и
    // `bodyHash` остаются сходящимися, подпись — нет.
    const broken = new Uint8Array(theirs[1].frame);
    broken[40] ^= 0xff;
    theirs[1] = { ...theirs[1], frame: broken };
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(4);

    const container = await mustBuild(selectAll());
    const view = await readPresentation(container, judy.session.keypair);
    const shown = view.messages.find(
      (m) => m.seq === 1 && m.sender.toLowerCase() === bob.address.toLowerCase(),
    );
    if (shown) {
      expect(shown.frame.ok, 'кадр с чужой подписью прошёл как проверенный').toBe(false);
      if (!shown.frame.ok) {
        expect(['malformed', 'body_mismatch', 'bad_signature']).toContain(shown.frame.reason);
      }
    } else {
      expect(
        container.notPrepared.some((n) => n.seq === 1),
        'кадр не показан и не назван — исчез молча',
      ).toBe(true);
    }
  }, 60_000);

  it('вместо контейнера мусор — malformed, ни одного броска', async () => {
    for (const junk of [null, undefined, 42, 'строка', [], {}, { kind: 'x' }]) {
      const view = await readPresentation(junk, judy.session.keypair);
      expect(view.container, JSON.stringify(junk ?? String(junk))).toBe('malformed');
      expect(view.messages).toEqual([]);
    }
  }, 30_000);

  it('в записи черновика мусор — «черновиков нет», а не «вот черновик»', async () => {
    const key = `drafts|${alice.address.toLowerCase()}`;
    for (const junk of [
      'строка вместо записи',
      { v: 1, drafts: 'не массив' },
      { v: 99, drafts: [] },
      { v: 1, drafts: ['мусор', 42, { dealId: 'нет' }, { dealId: DEAL, presenter: alice.address }] },
    ]) {
      disk.disk.set(key, junk);
      expect(await readPresentationDrafts(alice.address), JSON.stringify(junk)).toEqual([]);
    }
  }, 30_000);
});

/* ═══════════════ 5-Й ВОПРОС В СВОЁМ ВИДЕ: ПОТОЛОК МЕШКА ════════════════ */

describe('Потолок мешка: 256 КиБ — отказ с числом влезающих кадров, не тихая обрезка', () => {
  /** Шесть тяжёлых сообщений: 20 000 «я» = 40 000 байт utf-8 на сообщение. */
  async function seedHeavy(): Promise<BuildInput['selected']> {
    _resetConversationMemoryForTest();
    disk.restore();
    control = { failPut: false };
    disk = installFakeChatDisk(control);
    const big = 'я'.repeat(20_000);
    const mine = await forgeFrames(alice, bob, [big, `${big}!`, `${big}?`]);
    const theirs = await forgeFrames(bob, alice, [big, `${big}!`, `${big}?`], 1_754_400_500_000);
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(6);
    return [
      { seq: 0, sender: alice.address }, { seq: 0, sender: bob.address },
      { seq: 1, sender: alice.address }, { seq: 1, sender: bob.address },
      { seq: 2, sender: alice.address }, { seq: 2, sender: bob.address },
    ];
  }

  it('потолок и накладные — числами, записанными РУКАМИ', () => {
    // ⚠️ Исправление 12 договора v2: ожидаемое написано ЗДЕСЬ, а не взято из
    // проверяемого модуля. Иначе замер сравнивал бы значение с самим собой, и
    // смена боевой константы переписывала бы его смысл молча. Теперь — краснит.
    expect(PRESENTATION_MAX_BYTES).toBe(262144); // мешок склада, `relayer/bagStore.js:244`
    expect(PRESENTATION_SEAL_OVERHEAD).toBe(48); // `crypto_box_SEALBYTES`: 32 + 16
  });

  it('шесть тяжёлых: сборка отказывает too_large, число влезающих даёт САМ СБОРЩИК', async () => {
    const selected = await seedHeavy();

    const whole = await buildFor(selected);
    expect(whole.ok, 'предъявление на ~320 КиБ собралось — потолок не сработал').toBe(false);
    if (whole.ok) return;
    expect(whole.reason).toBe('too_large');
    // ⚠️ СУЖЕНИЕ, А НЕ `whole.fits!`. Отказ — размеченный союз (договор v3), поэтому
    // после этой строки `fits` есть у типа сам, без восклицательного знака. Знак
    // здесь был бы способом пройти проверку типов при отсутствующем поле — то есть
    // тем же шестнадцатым случаем, только в замере.
    if (whole.reason !== 'too_large') return;
    // ⚠️ Число влезающих живёт В ОТКАЗЕ СБОРЩИКА (исправление 11): своего счёта у
    // меня нет вовсе, разойтись нечему.
    expect(whole.fits, 'сборщик отказал, но числа влезающих не назвал').toBeGreaterThanOrEqual(1);
    expect(whole.fits, 'влезло всё — отказ не про потолок').toBeLessThan(6);
    // ⚠️ Тот же ответ, взятый ФОРМОЙ — тип-замок `fitsFromRefusal` из оснастки. Он
    // не только компилируется, но и исполняется: «починят» замок, заставив его
    // молча отдавать `null`, — покраснеет здесь (мутация 20).
    expect(fitsFromRefusal(whole), 'тип-замок на `fits` отдал не то число, что отказ')
      .toBe(whole.fits);
    // ⚠️ У ПОТОЛКА ПОСЛЕ v3 ДВА ПРЕДЪЯВИТЕЛЯ: `PRESENTATION_MAX_BYTES`, из которого
    // я считаю `limit`, и `limitBytes` самого отказа. Число записано РУКАМИ
    // (исправление 12) — разойдись они, и `fittingMessageCount` называла бы один
    // потолок, а сборщик отказывал бы по другому, оба «зелёные» (мутация 19).
    //
    // ⚠️ ЗАМЕРЕННОЕ РАСХОЖДЕНИЕ С ПЛАНОМ (отчёт задачи 8): план ожидал, что
    // `limitBytes` отказа СОВПАДЁТ с `PRESENTATION_MAX_BYTES` (262144) — то есть
    // что это два имени одного числа. Реальный `buildPresentation`
    // (`presentation.ts:611,627`) считает `limitBytes` как
    // `PRESENTATION_MAX_BYTES − PRESENTATION_SEAL_OVERHEAD` = 262144 − 48 =
    // 262096: это бюджет ДЛЯ JSON, оставляющий место для 48 байт печати,
    // добавляемых уже ПОСЛЕ отказа/сборки при `sealPresentation`. Числа не
    // совпадают НАМЕРЕННО и оба верны — только имя другое: `limitBytes` —
    // бюджет полезной нагрузки, `PRESENTATION_MAX_BYTES` — потолок мешка
    // склада целиком, включая печать. Записано руками здесь как найденное, а
    // не подогнано под ожидание плана.
    expect(whole.limitBytes, 'отказ отказал по другому потолку, чем я считаю').toBe(262096);

    const fit = await fittingMessageCount(inputFor(selected));
    expect(fit.ok, `счёт влезающих отказал: ${fit.ok ? '' : fit.reason}`).toBe(true);
    if (!fit.ok) return;
    expect(fit.fit.fits, 'моё число разошлось с числом сборщика — завёлся второй счёт')
      .toBe(whole.fits);
    expect(fit.fit.limit, 'потолок не 256 КиБ').toBe(262144);

    const atFit = await buildFor(selected.slice(0, fit.fit.fits));
    expect(atFit.ok, 'названное число кадров не собирается — счёт врёт').toBe(true);
    const oneMore = await buildFor(selected.slice(0, fit.fit.fits + 1));
    expect(oneMore.ok, 'на кадр больше тоже влезло — граница не там, где названа').toBe(false);
  }, 120_000);

  it('то, что влезло, влезло ПО БАЙТАМ — счёт равен длине запечатанного', async () => {
    const selected = await seedHeavy();
    const fit = await fittingMessageCount(inputFor(selected));
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    const container = await mustBuild(selected.slice(0, fit.fit.fits));
    const sealed = await sealPresentation(container, judy.session.keypair.publicKey);
    expect(sealed.length, 'счёт байтов расходится с тем, что уходит на склад').toBe(
      presentationWireBytes(container),
    );
    expect(sealed.length, 'предъявление не влезает в мешок склада').toBeLessThanOrEqual(262144);
    expect(fit.fit.bytesAtFits).toBe(sealed.length);
  }, 120_000);

  it('обрезка видна арбитру числом: скрытых ровно столько, сколько не влезло', async () => {
    const selected = await seedHeavy();
    const fit = await fittingMessageCount(inputFor(selected));
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;

    const container = await mustBuild(selected.slice(0, fit.fit.fits));
    const view = await readPresentation(container, judy.session.keypair);
    expect(view.container).toBe('ok');
    // ⚠️ Числа ЗДЕСЬ — `MeasuredCounts` (исправление 7; объявлен задачей 5 рядом с
    // `DeclaredCounts` — договор v3, до него у типа не было дома ни у кого): их посчитал
    // арбитр, а не предъявитель. `unopened` у предъявителя быть не может вовсе.
    expect(view.counts.read, 'прочитано не то число, что влезло').toBe(fit.fit.fits);
    expect(view.counts.unopened, 'арбитр не открыл то, что ему предъявили').toBe(0);
    // Скрытое считается по §15.5 (исправление 8): `expectedMessageCount` якоря
    // минус длина `links`. В посеве у каждой стороны по три сообщения, значит
    // ожидается 6, и суммы обязаны сойтись: read + hidden + notPrepared = 6.
    expect(view.counts.hidden, 'не влезшее не показано как скрытое — обрезка молчит').toBe(
      6 - fit.fit.fits,
    );
    expect(view.counts.notPrepared).toBe(0);
    expect(
      view.counts.read + view.counts.hidden + view.counts.notPrepared,
      'суммы §15.5 не сходятся — часть переписки пропала из счёта',
    ).toBe(6);
  }, 120_000);
});

/* ═══════ ПРЕДЕЛЬНЫЙ СРОК ЗАМКА ЧЕРНОВИКОВ (круг доработки 2) ═══════════ */

describe('Предельный срок замка черновиков: названный отказ, не вечная крутилка', () => {
  it('другая вкладка держит замок вечно (та же мутация 7, но снаружи) — свой lock_timeout, не зависание', async () => {
    // ⚠️ Тот же приём, что `chatConversation.test.ts` («боевой потолок реально
    // ПРОВОДИТСЯ, а не только объявлен»): реальный `setTimeout` подменяется, но
    // сжимается ТОЛЬКО тот вызов, чья задержка равна боевой константе — всё
    // остальное (микрозадачи libsodium, прочие таймеры) идёт как есть. Значит
    // зелёный результат доказывает, что именно ЭТОТ срок реально дошёл до
    // `setTimeout`, а не то, что тест сам себя подождал.
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    vi.stubGlobal('setTimeout', ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms === LOCK_TIMEOUT_MS ? 0 : ms, ...rest);
    }) as typeof setTimeout);

    let taken!: () => void;
    const takenP = new Promise<void>((resolve) => { taken = resolve; });
    // Держим НАСТОЯЩИЙ замок (то же имя, что `presentationDraft.ts:LOCK_NAME`)
    // снаружи, колбэк не разрешается НИКОГДА — ровно то, что делает мутация 7
    // изнутри `idbPut`, только источник повисания теперь чужая вкладка, а не
    // наша собственная работа.
    void navigator.locks.request('hexseal.presentation.drafts', () => {
      taken();
      return new Promise<void>(() => {});
    });
    await takenP;

    const container = await mustBuild(selectAll());
    const verdict = await savePresentationDraft(
      draftFromContainer(container, presentationWireBytes(container)),
    );
    expect(verdict, 'чужая вкладка держит замок вечно, а мы не отказали по сроку').toBe('lock_timeout');
    expect(delays, 'боевой LOCK_TIMEOUT_MS не был передан в реальный setTimeout').toContain(LOCK_TIMEOUT_MS);

    // markPresentationSent зовёт тот же withLock — тот же отказ, тем же именем.
    const markVerdict = await markPresentationSent(
      container.presenter, container.dealId, container.issuedAt, 'k/x.bin',
    );
    expect(markVerdict, 'markPresentationSent повис вместо отказа по сроку').toBe('lock_timeout');
  }, 30_000);

  it('боевой срок — не тестовое значение', () => {
    expect(LOCK_TIMEOUT_MS).toBe(10_000);
  });
});
