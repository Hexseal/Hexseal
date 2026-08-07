/**
 * К-3 — потолок уведомлений был 10 в минуту НА ВСЮ ПЛОЩАДКУ.
 *
 * `/push/send` считал бюджет `checkRateLimit(clientIp(req))` — по адресу
 * ИСТОЧНИКА ЗАПРОСА. А приходит туда только наш собственный Next-сервер:
 * гейт `X-Push-Secret` другого вызывающего не пускает вовсе. Значит ключ у
 * всей площадки один, а потолок — общий десяток (`RATE_MAX`), рассчитанный
 * на ОДНОГО человека у `/relay`.
 *
 * ⚠️ TRUST_PROXY ЗДЕСЬ НИ ПРИ ЧЁМ, и это проверено, а не предположено:
 * сервер-серверный запрос заголовков источника не шлёт вообще, поэтому и с
 * `TRUST_PROXY=true` (боевая настройка) адрес проваливается в адрес
 * контейнера — один на всех. Поэтому запросы ниже идут БЕЗ `CF-Connecting-IP`,
 * в отличие от всех остальных тестов мешков: так выглядит боевая дорога.
 *
 * Один разговорчивый разговор гасил уведомления ВСЕМ до конца минуты.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';

// Маленькие бюджеты — до импорта app.js (тот читает окружение на уровне
// модуля). Боевые умолчания меряет отдельный файл, см. ниже.
process.env.PUSH_SEND_RATE_MAX    = '10';
process.env.PUSH_DISPUTE_RATE_MAX = '10';

const { app } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');

const PUSH_SECRET = 'test-push-secret';

async function subscribeReal(wallet) {
  const address  = wallet.address.toLowerCase();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${address.slice(2)}`;
  const sig = await wallet.signMessage(`hexseal:push-subscribe:${address}:${endpoint}`);
  const res = await request(app).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) } },
    sig,
  });
  expect(res.status).toBe(200);
  return address;
}

/** БЕЗ CF-Connecting-IP — ровно как ходит наш собственный сервер. */
function send(pass, payload) {
  return request(app)
    .post('/push/send')
    .set('X-Push-Secret', PUSH_SECRET)
    .set('x-bag-pass', pass)
    .send(payload);
}

let counter = 0;
function freshSender() {
  counter++;
  return issueBagPass('0x' + String(counter).padStart(40, 'e')).token;
}

describe('К-3: бюджет уведомлений считается по тому, ЗА КОГО шлём', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('ЗАМЕР ДО ПОЧИНКИ: разговорчивая пара гасила уведомления ПОСТОРОННЕЙ паре', async () => {
    const chatty  = freshSender();
    const to      = await subscribeReal(ethers.Wallet.createRandom());

    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await send(chatty, { to })).status);

    // Своя половина: свой бюджет — десять, потом отказ. Это правильно.
    expect(statuses.filter(s => s === 200).length).toBe(10);
    expect(statuses.slice(10)).toEqual([429, 429]);

    // ГЛАВНОЕ: посторонняя пара, ни разу не слав ни одного уведомления,
    // обязана пройти. До починки здесь было 429 — общий десяток на всех.
    const stranger   = freshSender();
    const strangerTo = await subscribeReal(ethers.Wallet.createRandom());
    expect((await send(stranger, { to: strangerTo })).status).toBe(200);
  });

  it('исчерпавший бюджет мешает ТОЛЬКО себе — десять посторонних проходят подряд', async () => {
    const chatty = freshSender();
    const to     = await subscribeReal(ethers.Wallet.createRandom());
    for (let i = 0; i < 12; i++) await send(chatty, { to });

    const others = [];
    for (let i = 0; i < 10; i++) {
      const pass   = freshSender();
      const target = await subscribeReal(ethers.Wallet.createRandom());
      others.push((await send(pass, { to: target })).status);
    }
    expect(others).toEqual(Array(10).fill(200));
  });

  it('отказ называет СЕБЯ — код, а не только 429', async () => {
    const chatty = freshSender();
    const to     = await subscribeReal(ethers.Wallet.createRandom());
    for (let i = 0; i < 10; i++) await send(chatty, { to });

    const res = await send(chatty, { to });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited_push');
    expect(res.headers['retry-after']).toBe('60');
  });

  it('оповещение арбитров тратит СВОЙ бюджет, а не бюджет переписки', async () => {
    const me = freshSender();
    const deal = '0xdea1000000000000000000000000000000000004';

    // Полный веер по спору: десять арбитров — весь бюджет спора.
    for (let i = 0; i < 10; i++) {
      const arb = await subscribeReal(ethers.Wallet.createRandom());
      expect((await send(me, { to: arb, kind: 'dispute', deal })).status).toBe(200);
    }
    expect((await send(me, { to: await subscribeReal(ethers.Wallet.createRandom()), kind: 'dispute', deal })).status).toBe(429);

    // Переписка того же человека при этом цела: веер по спору её не съел.
    const peer = await subscribeReal(ethers.Wallet.createRandom());
    expect((await send(me, { to: peer })).status).toBe(200);
  });

  it('бюджет тратится только на РЕАЛЬНУЮ отправку: отказ на негодном роде его не жжёт', async () => {
    const me = freshSender();
    const to = await subscribeReal(ethers.Wallet.createRandom());

    for (let i = 0; i < 20; i++) {
      expect((await send(me, { to, kind: 'нет такого' })).status).toBe(400);
    }
    // Двадцать отказов подряд не должны стоить человеку его же переписки.
    expect((await send(me, { to })).status).toBe(200);
  });

  it('эхо самому себе бюджета не тратит', async () => {
    const wallet = ethers.Wallet.createRandom();
    const me     = await subscribeReal(wallet);
    const pass   = issueBagPass(me).token;

    for (let i = 0; i < 20; i++) {
      expect((await send(pass, { to: me })).status).toBe(200);
    }
    const peer = await subscribeReal(ethers.Wallet.createRandom());
    expect((await send(pass, { to: peer })).status).toBe(200);
  });
});
