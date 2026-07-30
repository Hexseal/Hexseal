import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import webpush from 'web-push';
import { app, findDisputeRaised, disputeRaisedWarningMsg, utcMinuteLabel } from '../app.js';
import { mockContract, mockProviderReceipt } from './mocks/ethersRegistry.js';
import { signMessage } from './helpers/signing.js';

/**
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * `raiseDispute` ставит флаг явки ПОДНЯВШЕМУ (`src/Agreement.sol`). Поэтому
 * `respondToDispute()` физически может позвать только второй участник — у
 * поднявшего он ревертит `AlreadyResponded`. Из этого следует всё остальное:
 *
 *  • срок молчания идёт у ВТОРОЙ стороны, и только у неё;
 *  • тот, кто откликается, — всегда НЕ поднявший;
 *  • значит «противоположная сторона» относительно откликнувшегося — всегда
 *    поднявший, то есть уже откликнувшийся и ничем не рискующий.
 *
 * До этой правки предупреждение уходило именно ему (`DisputeResponded` →
 * противоположная сторона → «Answer it too»), а сторона под риском не получала
 * предупреждения ни по одному каналу: её единственным пушем был AGR_PUSH_MSG[3],
 * один на двоих, без срока и без цены молчания.
 *
 * `disputeResponsePush.test.js` этого не поймал, потому что проверял только «не
 * тому, кто откликнулся». Свойство «получатель ещё МОЖЕТ действовать» не
 * проверял никто — оно и проверяется здесь.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

const raisedIface = new ethers.Interface([
  'event DisputeRaised(address indexed by)',
]);
const statusIface = new ethers.Interface([
  'event AgreementStatusUpdated(address indexed agreement, uint8 newStatus)',
]);

/** Лог агримента ровно той формы, в какой его выпускает `raiseDispute`. */
function raisedLog(address, by) {
  const { data, topics } = raisedIface.encodeEventLog('DisputeRaised', [by]);
  return { address, data, topics };
}

/**
 * Диамондовый `AgreementStatusUpdated(agreement, DISPUTED)`. В одном чеке с
 * `DisputeRaised` он лежит всегда: `raiseDispute` зовёт `_updateRegistry`.
 * Именно он и приводит в действие таблицу AGR_PUSH_MSG.
 */
function disputedStatusLog(agreement) {
  const { data, topics } = statusIface.encodeEventLog('AgreementStatusUpdated', [agreement, 3]);
  return { address: process.env.DIAMOND_ADDRESS, data, topics };
}

const SOMEONE_ELSE = ethers.Wallet.createRandom().address;

// Спор поднят 2026-07-30 09:41:00 UTC. Дата и оба ожидаемых срока ниже выписаны
// руками, а не посчитаны тем же выражением, что в коде: иначе тест подтвердил бы
// сам себя и пропустил бы сдвиг формата или часового пояса.
const DISPUTED_AT = 1_785_404_460n;
const FOUR_DAYS   = 4n * 24n * 60n * 60n;
const SEVEN_DAYS  = 7n * 24n * 60n * 60n;
const DEADLINE_4D = '2026-08-03 09:41 UTC';
const DEADLINE_7D = '2026-08-06 09:41 UTC';

describe('findDisputeRaised', () => {
  it('finds who raised the dispute in the receipt', () => {
    const agreement = ethers.Wallet.createRandom().address;
    const logs = [disputedStatusLog(agreement), raisedLog(agreement, SOMEONE_ELSE)];
    expect(findDisputeRaised(logs, agreement)).toEqual({ by: SOMEONE_ELSE });
  });

  it('matches the agreement address case-insensitively', () => {
    const agreement = ethers.Wallet.createRandom().address;
    const logs = [raisedLog(agreement.toLowerCase(), SOMEONE_ELSE)];
    expect(findDisputeRaised(logs, agreement)).toEqual({ by: SOMEONE_ELSE });
  });

  it('ignores a DisputeRaised emitted by a different agreement in the same tx', () => {
    const agreement = ethers.Wallet.createRandom().address;
    expect(findDisputeRaised([raisedLog(SOMEONE_ELSE, SOMEONE_ELSE)], agreement)).toBeNull();
  });

  it('returns null when this receipt raised nothing', () => {
    const agreement = ethers.Wallet.createRandom().address;
    expect(findDisputeRaised([disputedStatusLog(agreement)], agreement)).toBeNull();
    expect(findDisputeRaised([], agreement)).toBeNull();
    expect(findDisputeRaised(undefined, agreement)).toBeNull();
  });
});

describe('utcMinuteLabel', () => {
  it('prints an unambiguous instant to the minute', () => {
    expect(utcMinuteLabel(new Date(Number(DISPUTED_AT + FOUR_DAYS) * 1000))).toBe(DEADLINE_4D);
  });
});

describe('disputeRaisedWarningMsg', () => {
  it('names the deadline and the price of silence', () => {
    const msg = disputeRaisedWarningMsg(new Date(Number(DISPUTED_AT + FOUR_DAYS) * 1000));
    expect(msg.body).toContain(DEADLINE_4D);
    expect(msg.body.toLowerCase()).toMatch(/quarter/);
  });

  // Молчать целиком было бы хуже: цена молчания остаётся полезной и без даты,
  // а точный срок виден на странице сделки.
  it('still names the price when the window could not be read', () => {
    const msg = disputeRaisedWarningMsg(null);
    expect(msg.body.toLowerCase()).toMatch(/quarter/);
    expect(msg.body).not.toMatch(/undefined|null|NaN|Invalid/);
  });
});

// ─── End to end, через тот же эндпоинт, который реально рассылает пуши ────────

async function subscribePush(wallet, endpoint) {
  const address = (await wallet.getAddress()).toLowerCase();
  const sig = await signMessage(wallet, `hexseal:push-subscribe:${address}:${endpoint}`);
  const res = await request(app).post('/push/subscribe').send({
    address,
    subscription: { endpoint, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
    sig,
  });
  expect(res.status).toBe(200);
  return address;
}

/**
 * Свежая пара клиент/исполнитель со своими подписками на пуш.
 * `disputeWindow` — то, что отдаст `DISPUTE_WINDOW()`; `null` означает, что
 * чтение ревертит (старый клон или сбой RPC).
 */
async function makePair({ disputeWindow = FOUR_DAYS, disputedAt = DISPUTED_AT } = {}) {
  const clientWallet = ethers.Wallet.createRandom();
  const executorWallet = ethers.Wallet.createRandom();
  const agreement = ethers.Wallet.createRandom().address;

  const client = await subscribePush(
    clientWallet,
    `https://fcm.googleapis.com/fcm/send/${clientWallet.address}`,
  );
  const executor = await subscribePush(
    executorWallet,
    `https://fcm.googleapis.com/fcm/send/${executorWallet.address}`,
  );

  mockContract(agreement, {
    getDetails: async () => ({
      client_: client,
      executor_: executor,
      arbiter_: ZERO,
      disputedAt_: disputedAt,
    }),
    DISPUTE_WINDOW: async () => {
      if (disputeWindow === null) throw new Error('execution reverted');
      return disputeWindow;
    },
  });

  return { client, executor, agreement };
}

async function notifyRaise(agreement, by, salt) {
  mockProviderReceipt({ logs: [disputedStatusLog(agreement), raisedLog(agreement, by)] });
  webpush.sendNotification.mockClear();
  const res = await request(app)
    .post('/relay/notify')
    .set('X-Push-Secret', 'test-push-secret')
    .send({ txHash: '0x' + salt.repeat(32), agreement, calldata: '0xdeadbeef' });
  expect(res.status).toBe(200);
}

/** Полезная нагрузка, доставленная на конкретный адрес, или undefined. */
function payloadFor(address) {
  const call = webpush.sendNotification.mock.calls.find(
    ([sub]) => sub.endpoint.toLowerCase().includes(address),
  );
  return call ? JSON.parse(call[1]) : undefined;
}

describe('POST /relay/notify — при поднятии спора предупреждается сторона под риском', () => {
  beforeEach(() => {
    webpush.sendNotification.mockClear();
  });

  it('client raises — the EXECUTOR gets the warning, and it is not the raiser', async () => {
    const { client, executor, agreement } = await makePair();
    await notifyRaise(agreement, client, '66');

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));

    const toExecutor = payloadFor(executor);
    const toClient   = payloadFor(client);

    // Тот, у кого идёт срок, — исполнитель: поднявшему клиенту флаг явки уже
    // поставил сам raiseDispute, и respondToDispute() у него ревертит.
    expect(toExecutor.title).toBe('Answer the Dispute');
    expect(toExecutor.body).toContain(DEADLINE_4D);
    expect(toExecutor.body.toLowerCase()).toMatch(/quarter/);
    expect(toExecutor.url).toBe(`/deal/${agreement}`);

    // Поднявший получает прежнее сообщение и НИКАКОГО требования откликнуться.
    expect(toClient.title).toBe('Dispute Raised');
    expect(toClient.body).not.toContain(DEADLINE_4D);
    expect(toClient.body.toLowerCase()).not.toMatch(/quarter/);
  });

  it('executor raises — the CLIENT gets the warning (symmetry)', async () => {
    const { client, executor, agreement } = await makePair();
    await notifyRaise(agreement, executor, '77');

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));

    expect(payloadFor(client).title).toBe('Answer the Dispute');
    expect(payloadFor(client).body).toContain(DEADLINE_4D);
    expect(payloadFor(executor).title).toBe('Dispute Raised');
  });

  /**
   * Гвоздь: срок читается с контракта, а не считается от «сегодня плюс четыре
   * дня». DISPUTE_WINDOW уже менялась однажды (7 дней → 4); захардкоженное число
   * начало бы врать молча, а пуш живёт в шторке, его не отзовёшь. Тот же спор,
   * та же дата поднятия, другое окно — и в тексте обязана стоять другая дата.
   */
  it('the deadline comes from DISPUTE_WINDOW(), not from a hardcoded four days', async () => {
    const four = await makePair({ disputeWindow: FOUR_DAYS });
    await notifyRaise(four.agreement, four.client, '88');
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));
    expect(payloadFor(four.executor).body).toContain(DEADLINE_4D);

    const seven = await makePair({ disputeWindow: SEVEN_DAYS });
    await notifyRaise(seven.agreement, seven.client, '99');
    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));
    const body = payloadFor(seven.executor).body;
    expect(body).toContain(DEADLINE_7D);
    expect(body).not.toContain(DEADLINE_4D);
  });

  it('window unreadable — the warning still goes out, just without a date', async () => {
    const { client, executor, agreement } = await makePair({ disputeWindow: null });
    await notifyRaise(agreement, client, 'aa');

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));
    const body = payloadFor(executor).body;
    expect(payloadFor(executor).title).toBe('Answer the Dispute');
    expect(body.toLowerCase()).toMatch(/quarter/);
    expect(body).not.toMatch(/undefined|null|NaN|Invalid Date/);
    expect(payloadFor(client).title).toBe('Dispute Raised');
  });

  /**
   * DISPUTED(3) без `DisputeRaised` в чеке — это отдельная транзакция
   * `syncRegistry()`, догоняющая статус после того, как `updateStatus` упал при
   * поднятии. Поднявшего в ней нет, сравнивать не с чем, и единственное честное
   * сообщение — прежнее, одно на двоих.
   */
  it('status DISPUTED without a DisputeRaised log falls back to the role-blind message', async () => {
    const { client, executor, agreement } = await makePair();
    mockProviderReceipt({ logs: [disputedStatusLog(agreement)] });
    webpush.sendNotification.mockClear();

    const res = await request(app)
      .post('/relay/notify')
      .set('X-Push-Secret', 'test-push-secret')
      .send({ txHash: '0x' + 'bb'.repeat(32), agreement, calldata: '0xdeadbeef' });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));
    expect(payloadFor(client).title).toBe('Dispute Raised');
    expect(payloadFor(executor).title).toBe('Dispute Raised');
  });

  /**
   * Поднявший, которого нет среди сторон сделки: лог и цель транзакции спорят о
   * том, чья это сделка. Гадать, кто под риском, нельзя — уходит прежнее
   * сообщение обоим, и ни одному не обещается срок.
   */
  it('a raiser who is neither party falls back to the role-blind message', async () => {
    const { client, executor, agreement } = await makePair();
    await notifyRaise(agreement, SOMEONE_ELSE, 'cc');

    await vi.waitFor(() => expect(webpush.sendNotification).toHaveBeenCalledTimes(2));
    expect(payloadFor(client).title).toBe('Dispute Raised');
    expect(payloadFor(executor).title).toBe('Dispute Raised');
  });
});
