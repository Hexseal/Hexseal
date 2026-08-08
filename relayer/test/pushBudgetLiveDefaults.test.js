/**
 * К-3 на БОЕВЫХ умолчаниях — ни одна переменная бюджета здесь не
 * переопределяется.
 *
 * Отдельный файл, а не кейс в pushBudgetPerSender.test.js, ровно по той же
 * причине, что у bagRoutesLiveDefaults.test.js: тот файл ставит
 * `PUSH_SEND_RATE_MAX=10` до импорта, и вместе с ним мерил бы СВОЁ число, а
 * не то, с которым площадка живёт. Правило проекта («докажи замером на
 * настоящих умолчаниях») введено 4 августа именно после случая, когда
 * правка ограничителя прошла с зелёными тестами и не изменила ничего:
 * тесты подставляли свои значения, а впереди стоял старый лимит.
 *
 * Vitest изолирует файлы по процессам, поэтому переменные соседа сюда не
 * доезжают — на этом же держится bagRoutesLiveDefaults.test.js.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

const { app } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');

const PUSH_SECRET = 'test-push-secret';

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

function send(pass, payload) {
  return request(app)
    .post('/push/send')
    .set('X-Push-Secret', PUSH_SECRET)
    .set('x-bag-pass', pass)
    .send(payload);
}

describe('К-3 на боевых умолчаниях', () => {
  it('ЗАМЕР: минута живого разговора (40 сообщений) — ноль отказов', async () => {
    const pass = issueBagPass('0x' + 'a1'.repeat(20)).token;
    const to   = await subscribeReal(ethers.Wallet.createRandom());

    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await send(pass, { to })).status);

    const refused = statuses.filter(s => s === 429).length;
    console.log(`[замер К-3, боевые умолчания] 40 сообщений одной пары: отказов ${refused}`);
    expect(refused).toBe(0);
  });

  it('ЗАМЕР: полный веер по спору (50 арбитров) уходит целиком и не съедает переписку', async () => {
    const pass = issueBagPass('0x' + 'b2'.repeat(20)).token;
    const deal = '0xdea1000000000000000000000000000000000004';

    // ARBITER_FANOUT_CAP во фронте — 50. Бюджет спора обязан вмещать один
    // полный веер: иначе часть арбитров о споре не узнает молча.
    const statuses = [];
    const arb = await subscribeReal(ethers.Wallet.createRandom());
    for (let i = 0; i < 50; i++) statuses.push((await send(pass, { to: arb, kind: 'dispute', deal })).status);

    const refused = statuses.filter(s => s === 429).length;
    console.log(`[замер К-3, боевые умолчания] веер по спору на 50 арбитров: отказов ${refused}`);
    expect(refused).toBe(0);

    const peer = await subscribeReal(ethers.Wallet.createRandom());
    expect((await send(pass, { to: peer })).status).toBe(200);
  });

  it('ЗАМЕР: разговорчивый сосед не гасит уведомления никому больше', async () => {
    const loud = issueBagPass('0x' + 'c3'.repeat(20)).token;
    const to   = await subscribeReal(ethers.Wallet.createRandom());
    let loudRefusals = 0;
    for (let i = 0; i < 200; i++) {
      if ((await send(loud, { to })).status === 429) loudRefusals++;
    }

    const quiet   = issueBagPass('0x' + 'd4'.repeat(20)).token;
    const quietTo = await subscribeReal(ethers.Wallet.createRandom());
    const quietStatus = (await send(quiet, { to: quietTo })).status;

    console.log(`[замер К-3, боевые умолчания] 200 подряд от одного: отказов ${loudRefusals}; посторонний после них: ${quietStatus}`);
    expect(loudRefusals).toBeGreaterThan(0);   // сам себя всё-таки ограничил
    expect(quietStatus).toBe(200);             // а соседа не тронул
  });
});
