/**
 * ЗАМЕР ПЕРЕД ПОЧИНКОЙ: сколько обращений к узлу цепи выжимается из дороги
 * оповещения арбитров.
 *
 * Гипотеза координатора (по чтению кода, не замерена): `dealIsDisputed`
 * кэширует «спор есть» и «спора нет», но НЕУДАЧНОЕ чтение возвращается мимо
 * кэша. По выдуманному адресу вызов агримента ревертит — то есть попадает
 * ровно туда. Значит каждый выдуманный адрес стоит нового обращения к узлу,
 * а бюджет, ключуемый сделкой, у выдуманных адресов не срабатывает никогда.
 *
 * Этот файл гипотезу ПРОВЕРЯЕТ. Числа — в выводе; если они с гипотезой не
 * сойдутся, чинить нечего.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

const { app, _resetDisputeProofCache, _resetDisputedSetCache } = await import('../app.js');
const { mockContract } = await import('./mocks/ethersRegistry.js');

const PUSH_SECRET = 'test-push-secret';

/** Счётчик обращений к узлу: каждый getDetails() — одно обращение. */
let chainReads = 0;
/** Отдельно — обращения запасной дороги (список всех спорных сразу). */
let registryReads = 0;
let disputedInRegistry = new Set();
const DIAMOND = process.env.DIAMOND_ADDRESS;

/** Выдуманный адрес: агримента по нему нет, вызов ревертит. */
function mockMissingDeal(deal) {
  mockContract(deal, {
    getDetails: async () => {
      chainReads++;
      throw new Error('call revert exception (no contract at address)');
    },
  });
}

/** Настоящий адрес, спора нет. */
function mockQuietDeal(deal) {
  mockContract(deal, {
    getDetails: async () => { chainReads++; return { status_: 2n }; },   // ACTIVE
  });
}

let _n = 0;
function fakeDeal() { _n++; return '0x' + String(_n).padStart(40, 'f'); }

async function subscribeReal(wallet) {
  const address  = wallet.address.toLowerCase();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${address.slice(2)}`;
  const sig = await wallet.signMessage(`hexseal:push-subscribe:${address}:${endpoint}`);
  await request(app).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) } },
    sig,
  });
  return address;
}

function notify(to, deal) {
  return request(app).post('/push/send')
    .set('X-Push-Secret', PUSH_SECRET)
    .send({ to, kind: 'dispute', deal });
}

describe('ЗАМЕР: усиление обращений к узлу через дорогу спора', () => {
  let arbiter;

  beforeEach(async () => {
    chainReads = 0;
    registryReads = 0;
    _resetDisputeProofCache();
    _resetDisputedSetCache();
    // Запасная дорога по умолчанию НЕ знает ни одной спорной сделки — иначе
    // тесты про мусор проходили бы через неё.
    disputedInRegistry = new Set();
    mockContract(DIAMOND, {
      getDisputed: async () => {
        registryReads++;
        return [...disputedInRegistry].map(a => ({ agreement: a }));
      },
    });
    arbiter = await subscribeReal(ethers.Wallet.createRandom());
  });

  it('замер 1: N РАЗНЫХ выдуманных адресов → сколько обращений к узлу', async () => {
    const N = 50;
    for (let i = 0; i < N; i++) {
      const deal = fakeDeal();
      mockMissingDeal(deal);
      await notify(arbiter, deal);
    }
    console.log(`[замер 1] ${N} разных выдуманных адресов → обращений к узлу: ${chainReads}`);

    // Здесь N меньше общего потолка, поэтому 1:1 — это ЧЕСТНО, и требовать
    // меньшего было бы требованием кэшировать неудачу. Заперто другое: расход
    // не превышает потолка. Границу проверяет замер 4.
    expect(chainReads).toBeLessThanOrEqual(120);
  });

  it('замер 2: ОДИН выдуманный адрес N раз подряд → сколько обращений', async () => {
    const N = 50;
    const deal = fakeDeal();
    mockMissingDeal(deal);
    for (let i = 0; i < N; i++) await notify(arbiter, deal);

    console.log(`[замер 2] один выдуманный адрес ×${N} → обращений к узлу: ${chainReads}`);

    // Придержка по адресу. Это НЕ кэш неудачи: ответ не запомнен, и после
    // DISPUTE_RETRY_COOLDOWN_MS поход в цепь повторится.
    expect(chainReads).toBe(1);
  });

  it('замер 3: настоящий НЕспорный адрес N раз → кэш работает', async () => {
    const N = 50;
    const deal = fakeDeal();
    mockQuietDeal(deal);
    for (let i = 0; i < N; i++) await notify(arbiter, deal);

    console.log(`[замер 3] настоящий неспорный адрес ×${N} → обращений к узлу: ${chainReads}`);
    expect(chainReads).toBe(1);
  });

  it('замер 4: сколько обращений всего выжимается за окно, чем ни спрашивай', async () => {
    // Смесь: выдуманные вперемешку с настоящими, все ключи разные — то есть
    // ровно та нагрузка, против которой бюджет по сделке бессилен.
    const N = 400;
    for (let i = 0; i < N; i++) {
      const deal = fakeDeal();
      if (i % 3 === 0) mockQuietDeal(deal); else mockMissingDeal(deal);
      await notify(arbiter, deal);
    }
    console.log(`[замер 4] ${N} запросов разными адресами → обращений к узлу: ${chainReads}`);

    // Общий потолок держит независимо от того, сколько РАЗНЫХ адресов
    // спросили. Законная нагрузка здесь крошечная — споров единицы.
    expect(chainReads).toBeLessThanOrEqual(120);
  });

  it('ЗАМЕР 5 (главный): потолок не становится оружием — настоящий спор проходит СКВОЗЬ поток мусора', async () => {
    const deal = fakeDeal();
    mockContract(deal, { getDetails: async () => { chainReads++; return { status_: 4n }; } });
    disputedInRegistry = new Set([deal.toLowerCase()]);

    // Выжимаем общий потолок мусором.
    for (let i = 0; i < 400; i++) {
      const junk = fakeDeal();
      mockMissingDeal(junk);
      await notify(arbiter, junk);
    }

    const statuses = [];
    for (let i = 0; i < 50; i++) statuses.push((await notify(arbiter, deal)).status);

    const ok = statuses.filter(s => s === 200).length;
    console.log(
      `[замер 5] веер на 50 арбитров ПОСЛЕ 400 мусорных запросов: доставлено ${ok}; ` +
      `обращений к узлу ${chainReads}, чтений реестра ${registryReads}`,
    );
    // С ОДНИМ ЛИШЬ ПОТОЛКОМ здесь было 0 из 50 — то есть нападающий выключал
    // арбитраж целиком. Запасная дорога (список всех спорных разом) этого не
    // позволяет: её собственный запас поток мусора выесть не может.
    expect(ok).toBe(50);
    // И стоит она немногого: список читается не чаще раза в срок годности.
    expect(registryReads).toBeLessThanOrEqual(2);
  });

  it('запасная дорога не выдумывает споров: незнакомый ей адрес остаётся без уведомления', async () => {
    const deal = fakeDeal();
    mockMissingDeal(deal);
    disputedInRegistry = new Set();   // реестр про эту сделку не знает

    for (let i = 0; i < 400; i++) {
      const junk = fakeDeal();
      mockMissingDeal(junk);
      await notify(arbiter, junk);
    }

    const res = await notify(arbiter, deal);
    expect(res.status).toBe(403);     // «спора нет» — по списку реестра
  });

  it('и реестр не ответил — 503, а не «спора нет»', async () => {
    const deal = fakeDeal();
    mockMissingDeal(deal);
    mockContract(DIAMOND, { getDisputed: async () => { registryReads++; throw new Error('node down'); } });

    for (let i = 0; i < 400; i++) {
      const junk = fakeDeal();
      mockMissingDeal(junk);
      await notify(arbiter, junk);
    }

    const res = await notify(arbiter, deal);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('chain_unavailable');
  });
});
