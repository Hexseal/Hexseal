/**
 * БЛОКИРУЮЩАЯ НАХОДКА СКВОЗНОЙ ПРОВЕРКИ: веер по спору молча уходит в ноль.
 *
 * Оповещение арбитров о новом споре я посадил за пропуск склада вместе с
 * уведомлениями чата. Для чата это верно: там отправитель — участник
 * переписки, и пропуск у него есть по определению.
 *
 * Для СПОРА это неверно, и цена ошибки не «неудобно», а «спор завис».
 * Спор открывает человек, который мог не заходить в чат ни разу: пропуска у
 * него нет, значит запрос не уходит вовсе, значит арбитры о споре НЕ УЗНАЮТ.
 * Молча.
 *
 * Правильное доказательство для этой дороги — НЕ «кто ты», а «спор
 * действительно есть». Оно лежит в цепи и не зависит от того, пользуется ли
 * человек чатом. Оно же снимает вопрос о злоупотреблении: единственное, чего
 * добьётся посторонний, — арбитры узнают о НАСТОЯЩЕМ споре, то есть ровно то,
 * что и должно случиться.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';

// Меньше боевых 120, но НЕ меньше полного веера на 50 арбитров: тест
// «одно чтение цепи на веер» обязан гонять настоящий веер, а не обрезок.
process.env.PUSH_DISPUTE_RATE_MAX = '60';

const { app } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');
const { mockContract } = await import('./mocks/ethersRegistry.js');

const PUSH_SECRET = 'test-push-secret';
const DEAL = '0xdea1000000000000000000000000000000000004';

const STATUS_ACTIVE   = 2;
const STATUS_DISPUTED = 4;   // src/Agreement.sol, enum Status

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

/** Сделка на цепи: `status` — из enum Status агримента. */
function mockDeal(deal, status, onCall) {
  mockContract(deal, {
    getDetails: async () => {
      onCall?.();
      return { status_: BigInt(status) };
    },
  });
}

let _deal = 0;
function freshDeal() { _deal++; return '0x' + String(_deal).padStart(40, 'd'); }

function notifyArbiter(to, deal, headers = {}) {
  const r = request(app).post('/push/send').set('X-Push-Secret', PUSH_SECRET);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send({ to, kind: 'dispute', deal });
}

function sentPayloads() {
  return webpush.sendNotification.mock.calls.map(([, p]) => JSON.parse(p));
}

describe('Блокер: доказательство для веера по спору — цепь, а не пропуск', () => {
  beforeEach(() => { webpush.sendNotification.mockClear(); });

  it('ЗАМЕР ДО ПОЧИНКИ: человек без сеанса чата не оповещает арбитров ВООБЩЕ', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockDeal(deal, STATUS_DISPUTED);
    webpush.sendNotification.mockClear();

    // Ни одного заголовка: у открывшего спор пропуска нет и взять его негде.
    const res = await notifyArbiter(arbiter, deal);

    expect(res.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('спор настоящий — ссылка ведёт на экран арбитра, текст наш', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockDeal(deal, STATUS_DISPUTED);
    webpush.sendNotification.mockClear();

    await notifyArbiter(arbiter, deal, { 'x-push-url': 'https://evil.example/drain' });

    const [payload] = sentPayloads();
    expect(payload.url).toBe(`/arbiter?deal=${deal}`);
    expect(JSON.stringify(payload)).not.toContain('evil.example');
  });

  it('спора НЕТ — уведомление не уходит, и сказано почему', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockDeal(deal, STATUS_ACTIVE);
    webpush.sendNotification.mockClear();

    const res = await notifyArbiter(arbiter, deal);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_disputed');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('такого агримента нет вовсе — отказ, а не падение', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockContract(deal, { getDetails: async () => { throw new Error('call revert exception'); } });
    webpush.sendNotification.mockClear();

    const res = await notifyArbiter(arbiter, deal);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('chain_unavailable');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('пропуск, если он ЕСТЬ, этой дороге не мешает и не требуется', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockDeal(deal, STATUS_DISPUTED);
    webpush.sendNotification.mockClear();

    const res = await notifyArbiter(arbiter, deal, {
      'x-bag-pass': issueBagPass('0x00000000000000000000000000000000000000aa').token,
    });
    expect(res.status).toBe(200);
  });

  it('ЗАМЕР: полный веер на 50 арбитров — ОДНО чтение цепи, не пятьдесят', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    let reads = 0;
    mockDeal(deal, STATUS_DISPUTED, () => { reads++; });
    webpush.sendNotification.mockClear();

    for (let i = 0; i < 50; i++) {
      expect((await notifyArbiter(arbiter, deal)).status).toBe(200);
    }

    console.log(`[замер блокера] веер на 50 арбитров: чтений цепи ${reads}`);
    expect(reads).toBe(1);
  });

  it('бюджет — по СДЕЛКЕ, и исчерпать его можно только реально разослав', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    const deal = freshDeal();
    mockDeal(deal, STATUS_DISPUTED);
    webpush.sendNotification.mockClear();

    const statuses = [];
    for (let i = 0; i < 63; i++) statuses.push((await notifyArbiter(arbiter, deal)).status);

    // PUSH_DISPUTE_RATE_MAX=60 (выставлен выше файла)
    expect(statuses.filter(s => s === 200).length).toBe(60);
    expect(statuses.slice(60).every(s => s === 429)).toBe(true);
    // Каждый из шестидесяти УЖЕ доставил уведомление — то есть «исчерпал бюджет»
    // и «оповестил арбитров» здесь одно и то же действие.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(60);

    // Соседняя сделка не задета.
    const other = freshDeal();
    mockDeal(other, STATUS_DISPUTED);
    expect((await notifyArbiter(arbiter, other)).status).toBe(200);
  });

  it('переписка по-прежнему требует пропуска — послабление касается ТОЛЬКО спора', async () => {
    const peer = await subscribeReal(ethers.Wallet.createRandom());
    const res = await request(app).post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .send({ to: peer });
    expect(res.status).toBe(401);
  });

  it('негодный адрес сделки — 400 и НИ ОДНОГО чтения цепи', async () => {
    const arbiter = await subscribeReal(ethers.Wallet.createRandom());
    let reads = 0;
    mockContract('0x0', { getDetails: async () => { reads++; return { status_: 4n }; } });

    const res = await notifyArbiter(arbiter, '../../evil');
    expect(res.status).toBe(400);
    expect(reads).toBe(0);
  });
});
