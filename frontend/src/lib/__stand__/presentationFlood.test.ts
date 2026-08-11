/**
 * presentationFlood.test.ts — пятый вопрос: долбят нарочно. И потолок мешка на
 * НАСТОЯЩЕМ складе, а не на подделке.
 *
 * ⚠️ ЭТО ЗАМЕР, А НЕ СПЕЦИФИКАЦИЯ. Три из шести здешних чисел (60/40,
 * 60 файлов, 413) описывают поведение склада, которое эта задача не меняет — их
 * ценность в том, что теперь оно ЗАМЕРЕНО применительно к предъявлению, а не
 * предполагается. Красными от нашей правки становятся замеры потолка и байтов
 * (см. шаг мутаций: М1, М10, М11, М15).
 *
 * ⚠️ ЧИСЛА СКЛАДА ЗАПИСАНЫ РУКАМИ (исправление 12 договора): 60, 40, 122, 99,
 * 100, 262144, 262145, 413. Ни одно не берётся из проверяемого модуля — иначе
 * замер сравнивал бы значение с самим собой и молчал бы при смене боевого
 * умолчания. Боевое умолчание сверяется отдельной строкой
 * `expect(t.BAG_READ_BUDGET_PER_MIN).toBe(100)`.
 *
 * ⚠️ ЗАМЕРЕННОЕ РАСХОЖДЕНИЕ С ПЛАНОМ (отчёт задачи 8): план ожидал 121 мешок в
 * ящике арбитра к моменту четвёртого теста этого блока (60 + 60 + 1) — то есть
 * предполагал, что бэйдж «прочитано» (`fetched`) в описи убирает мешок из
 * `inbox` после того, как арбитр его уже забрал (тест «сосед» скачивает один
 * мешок раньше). Реальный `GET /bags` (`relayer/app.js:3418-3419`) отдаёт в
 * `inbox` ВСЁ, что когда-либо адресовано этому пропуску — `fetched` вообще не
 * поле `BagSummary` (recipient), а поле `SentBagSummary` (отправителя, квитанция
 * о доставке своего письма). Значит мешок, прочитанный тестом «сосед», из
 * `inbox` не исчезает, и итог — 60 (потоп 1) + 1 (сосед) + 60 (потоп 2) + 1
 * (честное предъявление этого теста) = 122, не 121.
 *
 * ⚠️ IP-ЛИМИТ ПОДНЯТ НАРОЧНО. `BAG_IP_RATE_MAX` умолчанием 300/мин на IP, а
 * здесь с одного 127.0.0.1 идут четыре участника и три с лишним сотни
 * запросов: он сработал бы ПЕРВЫМ, и замер адресного бюджета записи (60/мин)
 * мерил бы не то. Сам IP-лимит на боевых умолчаниях заперт в
 * `relayer/test/bagRoutesLiveDefaults.test.js` — задваивать его здесь незачем.
 *
 * ⚠️ ОТСТУПЛЕНИЕ ОТ ПЛАНА (задание задачи 8, разбор в отчёте): `buildPresentation`
 * принимает `arbiterBoxKey`/`peerBoxKey` фирменными (branded) типами
 * `ArbiterBoxKeyBytes`/`PeerBoxKeyBytes` — см. `presentation.ts:232-247`. Клеймение
 * — `toArbiterBoxKeyBytes`/`toPeerBoxKeyBytes` на границе вызова, тем же приёмом,
 * что и `presentationCircumstances.test.ts` и `__stand__/presentationStand.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatStand } from './chatStand';
import type { PresentationContainer } from '@/lib/presentation';

let stand: ChatStand;
let arbiterAddr: `0x${string}`;
let arbiterPass = '';
let presenterPass = '';
/** Пара ключей чата арбитра — та же оснастка, что и в обычном замере. */
let judyKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };

beforeAll(async () => {
  process.env.BAG_IP_RATE_MAX = '5000';
  const { startChatStand } = await import('./chatStand');
  stand = await startChatStand();
  process.env.NEXT_PUBLIC_RELAYER_URL = stand.url;
  vi.resetModules();

  const t = await import('../chatTransport');
  t._resetBagPassCacheForTest();
  const { makeActor } = await import('./presentationFixtures');
  const judy = await makeActor(`0x${'33'.repeat(32)}`, '3d');
  judyKeypair = judy.session.keypair;

  // Арбитр — третий кошелёк, к стенду отношения не имеющий (у стенда их два).
  const arbiterWallet = ethers.Wallet.createRandom();
  arbiterAddr = arbiterWallet.address.toLowerCase() as `0x${string}`;
  arbiterPass = (await t.requestBagPass((m) => arbiterWallet.signMessage(m), arbiterAddr)).pass;
  const presenter = stand.wallets[0];
  presenterPass = (
    await t.requestBagPass(
      (m) => presenter.signMessage(m),
      presenter.address.toLowerCase() as `0x${string}`,
    )
  ).pass;
}, 120_000);

afterAll(async () => {
  await stand?.stop();
  delete process.env.NEXT_PUBLIC_RELAYER_URL;
  delete process.env.BAG_IP_RATE_MAX;
});

const bagsDir = (): string => path.join(stand.storageDir, 'bags', arbiterAddr);

/** Настоящее предъявление: актёры, кадры, архив, сборка. */
async function makePresentation(heavy: boolean): Promise<PresentationContainer> {
  const { installFakeChatDisk } = await import('./fakeChatDisk');
  const { makeActor, attestationOf, forgeFrames, seedArchive } = await import('./presentationFixtures');
  const { buildPresentation, toArbiterBoxKeyBytes, toPeerBoxKeyBytes } = await import('@/lib/presentation');
  const { fittingMessageCount } = await import('@/lib/presentationBag');
  const { _resetConversationMemoryForTest } = await import('@/lib/chatConversation');

  _resetConversationMemoryForTest();
  const disk = installFakeChatDisk();
  try {
    const alice = await makeActor(stand.wallets[0].privateKey, '1c');
    const bob = await makeActor(`0x${'22'.repeat(32)}`, '7f');
    const body = heavy ? 'я'.repeat(20_000) : 'сроки прошли, где работа';
    const mine = await forgeFrames(alice, bob, [body, `${body}!`, `${body}?`]);
    const theirs = await forgeFrames(bob, alice, [body, `${body}!`, `${body}?`], 1_754_400_500_000);
    expect(await seedArchive(alice, bob, [...mine, ...theirs])).toBe(6);

    const selected = [0, 1, 2].flatMap((seq) => [
      { seq, sender: alice.address }, { seq, sender: bob.address },
    ]);
    const input = {
      dealId: '0x2e7a7A0515bfDC0006A812EBb3E55d32800Bc660' as `0x${string}`,
      presenter: alice.address,
      // `peer` обязателен по договору v2 (исправление 6).
      peer: bob.address,
      arbiterBoxKey: toArbiterBoxKeyBytes(judyKeypair.publicKey),
      peerBoxKey: toPeerBoxKeyBytes(bob.session.keypair.publicKey),
      selected,
      session: alice.session,
      ownAttestation: await attestationOf(alice),
      peerAttestation: await attestationOf(bob),
    };
    const fit = await fittingMessageCount(input);
    expect(fit.ok, `счёт влезающих отказал: ${fit.ok ? '' : fit.reason}`).toBe(true);
    if (!fit.ok) throw new Error(fit.reason);
    expect(fit.fit.fits, 'не влезает ни одно сообщение').toBeGreaterThanOrEqual(1);
    const built = await buildPresentation({ ...input, selected: selected.slice(0, fit.fit.fits) });
    if (!built.ok) throw new Error(`сборка отказала: ${built.reason}`);
    return built.container;
  } finally {
    disk.restore();
    _resetConversationMemoryForTest();
  }
}

describe('5. Долбят нарочно: сто предъявлений подряд в ящик арбитра', () => {
  it('сто попыток одним адресом: 60 легло, 40 отбито, у отказа своё имя и свой Retry-After', async () => {
    const t = await import('../chatTransport');
    const flooder = ethers.Wallet.createRandom();
    const pass = (
      await t.requestBagPass(
        (m) => flooder.signMessage(m),
        flooder.address.toLowerCase() as `0x${string}`,
      )
    ).pass;

    const body = new Uint8Array(1024).fill(7);
    let stored = 0;
    let refused = 0;
    const codes = new Set<string>();
    const waits = new Set<number>();
    for (let i = 0; i < 100; i++) {
      try {
        await t.putBag(pass, arbiterAddr, body);
        stored++;
      } catch (err) {
        refused++;
        expect(err, `отказ №${i} не того рода`).toBeInstanceOf(t.BagRateLimitError);
        const e = err as InstanceType<typeof t.BagRateLimitError>;
        codes.add(e.code ?? '—');
        waits.add(e.retryAfterSec);
      }
    }
    expect(stored, 'склад принял не 60 мешков за минуту').toBe(60);
    expect(refused).toBe(40);
    expect([...codes]).toEqual(['rate_limited_write']);
    expect([...waits]).toEqual([60]);
  }, 180_000);

  it('на диске склада ровно 60 файлов: количество держит ТОЛЬКО частота, квоты нет', async () => {
    const files = fs.readdirSync(bagsDir());
    expect(files.length, 'на диске не 60 мешков — сложилось не то, что мерили').toBe(60);
    const bytes = files.reduce((n, f) => n + fs.statSync(path.join(bagsDir(), f)).size, 0);
    expect(bytes).toBe(60 * 1024);
    // Числом, чтобы не забылось: 60 мешков/мин × 256 КиБ = 15 МиБ/мин ≈ 21 ГиБ
    // в сутки с ОДНОГО адреса, в ящик, которого никто не просил. Замок
    // получателя (§8 замысла, пункт 44 открытых вопросов) — это 4в-2, и в этой
    // задаче он не делается: здесь его цена ЗАМЕРЕНА, а не вылечена.
  }, 60_000);

  it('сосед: честное предъявление после потопа доезжает и читается арбитром', async () => {
    const t = await import('../chatTransport');
    const bag = await import('@/lib/presentationBag');
    const container = await makePresentation(false);
    const sealed = await bag.sealPresentation(container, judyKeypair.publicKey);
    const { key } = await t.putBag(presenterPass, arbiterAddr, sealed);

    t._resetReadBudgetForTest();
    const bytes = await t.fetchBag(arbiterPass, key);
    expect(bytes, 'честное предъявление со склада не вернулось').not.toBeNull();
    const look = await bag.lookIntoBag(bytes as Uint8Array, judyKeypair);
    expect(look.kind, 'после потопа честное предъявление не опознано').toBe('presentation');
  }, 180_000);

  it('кому больно: 122 мешка в ящике — свой бюджет чтения кончается на 99-м, часть ящика не прочитана', async () => {
    const t = await import('../chatTransport');
    const bag = await import('@/lib/presentationBag');

    // Второй потоп — ДРУГИМ адресом: у первого адресный бюджет записи выбран.
    const flooder2 = ethers.Wallet.createRandom();
    const p2 = (
      await t.requestBagPass(
        (m) => flooder2.signMessage(m),
        flooder2.address.toLowerCase() as `0x${string}`,
      )
    ).pass;
    for (let i = 0; i < 60; i++) await t.putBag(p2, arbiterAddr, new Uint8Array(1024).fill(9));

    // Честное предъявление кладётся ПОСЛЕДНИМ — как в жизни: сторона
    // предъявляет, когда её попросили, а не первой.
    const container = await makePresentation(false);
    const sealed = await bag.sealPresentation(container, judyKeypair.publicKey);
    const { key: honestKey } = await t.putBag(presenterPass, arbiterAddr, sealed);

    t._resetReadBudgetForTest();
    const list = await t.listBags(arbiterPass); // 1 чтение из 100
    expect(list.inbox.length, 'в ящике не 122 мешка').toBe(122);

    let read = 0;
    let budgetRefusals = 0;
    for (const b of list.inbox) {
      try {
        await t.fetchBag(arbiterPass, b.key);
        read++;
      } catch (err) {
        expect(err, 'отказал не свой бюджет, а что-то ещё').toBeInstanceOf(t.BagBudgetError);
        expect((err as InstanceType<typeof t.BagBudgetError>).code).toBe('local_read_budget');
        budgetRefusals++;
        break;
      }
    }
    // ⚠️ Исправление 12: боевое умолчание сверяется руками ОТДЕЛЬНОЙ строкой, а
    // ожидаемое число прочитанных записано числом. Прежняя редакция писала
    // `toBe(t.BAG_READ_BUDGET_PER_MIN - 1)` — то есть брала ожидаемое из того же
    // модуля, который мерила: поставь бюджет 10, и замер остался бы зелёным,
    // сообщив ровно ничего.
    expect(t.BAG_READ_BUDGET_PER_MIN, 'боевой бюджет чтения больше не 100').toBe(100);
    expect(read, 'прочитано не 99 (одно чтение ушло на опись)').toBe(99);
    expect(budgetRefusals).toBe(1);
    expect(
      list.inbox.length - read,
      'непрочитанных мешков не осталось — потоп ничего не стоил',
    ).toBeGreaterThanOrEqual(23);

    // Минутой позже — доезжает. Больно арбитру (его бюджету и его глазам), не
    // складу: склад отдал всё, что просили, и ничего не потерял.
    t._resetReadBudgetForTest();
    expect(await t.fetchBag(arbiterPass, honestKey)).not.toBeNull();
  }, 180_000);
});

describe('Потолок мешка на настоящем складе', () => {
  it('мешок на байт больше потолка — 413 payload_too_large, обрезок на диске не остался', async () => {
    const t = await import('../chatTransport');
    const before = fs.readdirSync(bagsDir()).length;
    let caught: unknown = null;
    try {
      await t.putBag(presenterPass, arbiterAddr, new Uint8Array(262_145).fill(3));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'склад принял мешок больше потолка').toBeInstanceOf(t.BagTransportError);
    const e = caught as InstanceType<typeof t.BagTransportError>;
    expect(e.status).toBe(413);
    expect(e.code).toBe('payload_too_large');
    expect(fs.readdirSync(bagsDir()).length, 'обрезок остался на диске').toBe(before);
  }, 120_000);

  it('тяжёлое предъявление, урезанное до потолка: склад принял, size описи равен нашему счёту', async () => {
    const t = await import('../chatTransport');
    const bag = await import('@/lib/presentationBag');
    const container = await makePresentation(true);
    const sealed = await bag.sealPresentation(container, judyKeypair.publicKey);

    expect(sealed.length, 'счёт байтов расходится с тем, что уходит').toBe(
      bag.presentationWireBytes(container),
    );
    expect(sealed.length, 'урезанное предъявление всё равно больше мешка').toBeLessThanOrEqual(262_144);

    const { key } = await t.putBag(presenterPass, arbiterAddr, sealed);
    t._resetReadBudgetForTest();
    const list = await t.listBags(arbiterPass);
    const meta = list.inbox.find((b) => b.key === key);
    expect(meta, 'предъявление не появилось в описи').toBeDefined();
    expect(meta?.size, 'склад записал не то число байтов, что мы посчитали').toBe(sealed.length);
  }, 180_000);
});
