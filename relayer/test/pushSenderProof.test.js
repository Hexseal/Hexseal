/**
 * К-2 — открытое реле уведомлений.
 *
 * `/push/send` гейтился ОДНИМ общим секретом `X-Push-Secret`, который наш же
 * фронт (`frontend/src/app/api/push/route.ts`) подставлял сам, никого ни о
 * чём не спрашивая. То есть посторонний без кошелька и без подписи слал
 * настоящее уведомление от Hexseal любому адресу — с текстом и, что хуже,
 * СО ССЫЛКОЙ по своему выбору. Служебный работник (`public/sw.js`) уводил по
 * ней открытую вкладку.
 *
 * Здесь заперта серверная половина: право слать доказывается тем же
 * пропуском, что и склад мешков, а ссылка, текст и метка строятся СЕРВЕРОМ
 * из доказанного отправителя — из запроса не берутся вовсе.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';

const { app } = await import('../app.js');
const { issueBagPass } = await import('../bagPass.js');
const { mockContract, mockProviderReceipt } = await import('./mocks/ethersRegistry.js');

const PUSH_SECRET = 'test-push-secret';   // тот же, что ставит test/setup.js

const ALICE  = '0xa11ce00000000000000000000000000000000001';
const BOB    = '0xb0b0000000000000000000000000000000000002';
const VICTIM = '0xc1c1000000000000000000000000000000000003';

/** Подписка жертвы на пуши — иначе слать некуда и sendNotification не позовут. */
async function subscribe(address) {
  const wallet = new ethers.Wallet('0x' + '22'.repeat(31) + '33');
  const endpoint = `https://fcm.googleapis.com/fcm/send/${address.slice(2)}`;
  const sig = await wallet.signMessage(`hexseal:push-subscribe:${address.toLowerCase()}:${endpoint}`);
  // Подпись должна быть кошелька самого адреса — подписываем настоящим.
  return { endpoint, sig };
}

/** Реальная подписка: генерим кошелёк, чей адрес и есть подписчик. */
async function subscribeReal(app_, wallet) {
  const address  = wallet.address.toLowerCase();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${address.slice(2)}`;
  const sig = await wallet.signMessage(`hexseal:push-subscribe:${address}:${endpoint}`);
  const res = await request(app_).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) } },
    sig,
  });
  expect(res.status).toBe(200);
  return address;
}

function sentPayloads() {
  return webpush.sendNotification.mock.calls.map(([, payload]) => JSON.parse(payload));
}

describe('К-2: право слать уведомление доказывается пропуском', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('ЗАМЕР ДО ПОЧИНКИ: посторонний с одним лишь секретом слал что угодно и куда угодно', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);

    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .send({
        to: victim,
        body: 'Спор решён не в вашу пользу. Подтвердите кошелёк, чтобы вернуть депозит.',
        url: 'https://evil.example/drain',
        tag: 'deal',
      });

    // ПОСЛЕ починки: без пропуска — 401, и ни одного отправленного уведомления.
    expect(res.status).toBe(401);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('пропуск есть — уведомление уходит', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);
    const { token } = issueBagPass(ALICE);

    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .set('x-bag-pass', token)
      .send({ to: victim });

    expect(res.status).toBe(200);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('ссылка из запроса НЕ БЕРЁТСЯ ВОВСЕ — уведомление ведёт на наш экран чата с отправителем', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);
    const { token } = issueBagPass(ALICE);

    await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .set('x-bag-pass', token)
      .send({
        to: victim,
        url: 'https://evil.example/drain',
        body: 'Спор решён не в вашу пользу.',
        tag: 'deal',
        title: 'Hexseal Support',
      });

    const [payload] = sentPayloads();
    expect(payload.url).toBe(`/chat?peer=${ALICE}`);
    expect(payload.tag).toBe(`/chat?peer=${ALICE}`);
    expect(JSON.stringify(payload)).not.toContain('evil.example');
    expect(JSON.stringify(payload)).not.toContain('Спор решён');
    expect(JSON.stringify(payload)).not.toContain('Hexseal Support');
  });

  it('отправителя берут из ПРОПУСКА, а не из тела — подменить нельзя', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);
    const { token } = issueBagPass(ALICE);

    await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .set('x-bag-pass', token)
      .send({ to: victim, from: BOB });

    const [payload] = sentPayloads();
    expect(payload.url).toBe(`/chat?peer=${ALICE}`);
    expect(payload.url).not.toContain(BOB.slice(2));
  });

  it('мёртвый пропуск не годится', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);
    // Выпущен так давно, что уже истёк.
    const { token } = issueBagPass(ALICE, 1_700_000_000);

    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .set('x-bag-pass', token)
      .send({ to: victim });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('pass_expired');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('секрет по-прежнему обязателен: пропуск сам по себе с улицы не годится', async () => {
    const wallet = ethers.Wallet.createRandom();
    const victim = await subscribeReal(app, wallet);
    const { token } = issueBagPass(ALICE);

    const res = await request(app)
      .post('/push/send')
      .set('x-bag-pass', token)
      .send({ to: victim });

    expect(res.status).toBe(403);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('себе самому уведомление не шлётся (эхо собственной отправки)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const me = await subscribeReal(app, wallet);
    const { token } = issueBagPass(me);

    const res = await request(app)
      .post('/push/send')
      .set('X-Push-Secret', PUSH_SECRET)
      .set('x-bag-pass', token)
      .send({ to: me });

    expect(res.status).toBe(200);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  describe('вторая дорога: оповещение арбитров о споре', () => {
    // ⚠️ У ЭТОЙ ДОРОГИ ДРУГОЕ ДОКАЗАТЕЛЬСТВО — не пропуск, а статус сделки на
    // цепи. Пропуск здесь требовать нельзя: спор открывает человек, который
    // мог не заходить в чат ни разу (блокер сквозной проверки, разбор и
    // замеры — test/pushDisputeChainProof.test.js). Ниже проверяется только
    // то, что ссылка и текст всё равно НАШИ.
    it('ведёт на экран арбитра по проверенному адресу сделки, текст — наш', async () => {
      const wallet = ethers.Wallet.createRandom();
      const arbiter = await subscribeReal(app, wallet);
      const deal = '0xdea1000000000000000000000000000000000004';
      mockContract(deal, { getDetails: async () => ({ status_: 4n }) });   // DISPUTED
      webpush.sendNotification.mockClear();

      const res = await request(app)
        .post('/push/send')
        .set('X-Push-Secret', PUSH_SECRET)
        .send({ to: arbiter, kind: 'dispute', deal, url: 'https://evil.example/drain', body: 'жми сюда' });

      expect(res.status).toBe(200);
      const [payload] = sentPayloads();
      expect(payload.url).toBe(`/arbiter?deal=${deal}`);
      expect(JSON.stringify(payload)).not.toContain('evil.example');
      expect(JSON.stringify(payload)).not.toContain('жми сюда');
    });

    it('негодный адрес сделки — 400, не «слепим ссылку из чего дали»', async () => {
      const wallet = ethers.Wallet.createRandom();
      const arbiter = await subscribeReal(app, wallet);
      const { token } = issueBagPass(ALICE);

      const res = await request(app)
        .post('/push/send')
        .set('X-Push-Secret', PUSH_SECRET)
        .set('x-bag-pass', token)
        .send({ to: arbiter, kind: 'dispute', deal: '../../evil', body: 'x' });   // форма адреса — до всякой цепи

      expect(res.status).toBe(400);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('неизвестный род — 400, а не молчаливая подстановка чата', async () => {
      const wallet = ethers.Wallet.createRandom();
      const arbiter = await subscribeReal(app, wallet);
      const { token } = issueBagPass(ALICE);

      const res = await request(app)
        .post('/push/send')
        .set('X-Push-Secret', PUSH_SECRET)
        .set('x-bag-pass', token)
        .send({ to: arbiter, kind: 'whatever', body: 'x' });

      expect(res.status).toBe(400);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });
  });
});

/**
 * ЗАМЕР для К-2: доски НЕ теряют уведомления, если убрать их клиентский вызов
 * `notifyPush`. Сервер шлёт те же два уведомления САМ, из квитанции — то есть
 * клиентские были ВТОРЫМИ, а не единственными.
 */
describe('К-2 (замер): отклик на работу и запрос услуги сервер шлёт САМ', () => {
  const boardIface = new ethers.Interface([
    'event JobApplied(uint256 indexed jobId, address indexed executor)',
    'event ServiceRequested(uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount)',
  ]);
  const DIAMOND = '0x2222222222222222222222222222222222222222'; // как в test/setup.js
  const AGREEMENT = '0xaaaa000000000000000000000000000000000005';

  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  async function relayNotifyWith(log) {
    mockProviderReceipt({ hash: '0xfeed', logs: [log] });
    // getDetails() на «агрименте» здесь не нужен — ветка досок от него не зависит.
    mockContract(AGREEMENT, { getDetails: async () => { throw new Error('not an agreement'); } });
    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', PUSH_SECRET)
      .send({ txHash: '0xfeed', agreement: AGREEMENT });
    expect(res.status).toBe(200);
    // Ответ отдаётся до рассылки — дать ей случиться.
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalled(), { timeout: 2000 });
  }

  it('JobApplied → «New Applicant» клиенту работы, ссылка /job/<id>', async () => {
    const wallet = ethers.Wallet.createRandom();
    const client = await subscribeReal(app, wallet);
    webpush.sendNotification.mockClear();

    mockContract(DIAMOND, { getJob: async () => ({ client }) });
    const { data, topics } = boardIface.encodeEventLog('JobApplied', [7n, ALICE]);
    await relayNotifyWith({ address: DIAMOND, data, topics });

    const [payload] = sentPayloads();
    expect(payload.title).toBe('New Applicant');
    expect(payload.url).toBe('/job/7');
  });

  it('ServiceRequested → «New Service Request» исполнителю, ссылка /request/<id>', async () => {
    const wallet = ethers.Wallet.createRandom();
    const executor = await subscribeReal(app, wallet);
    webpush.sendNotification.mockClear();

    mockContract(DIAMOND, { getService: async () => ({ executor }) });
    const { data, topics } = boardIface.encodeEventLog('ServiceRequested', [11n, 3n, ALICE, 5_000_000n]);
    await relayNotifyWith({ address: DIAMOND, data, topics });

    const [payload] = sentPayloads();
    expect(payload.title).toBe('New Service Request');
    expect(payload.url).toBe('/request/11');
  });
});
