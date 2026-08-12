/**
 * ВСЕ РОДЫ УВЕДОМЛЕНИЙ ДОХОДЯТ — по одному замеру на каждый.
 *
 * ЗАЧЕМ. Тринадцать `useWatchContractEvent` в `hooks/useNotifications.ts`
 * складываются в ОДИН цикл опроса (пункт 38, 140 запросов в минуту). Тринадцать
 * отдельных фильтров отбирали логи по адресу пользователя на стороне узла
 * (`args: { client }` и т.п.); один общий фильтр отбирать так не может, и отбор
 * переезжает сюда, в код. Это ровно тот момент, где уведомление можно потерять
 * молча — поэтому здесь перечислены все тринадцать назначений поимённо, и каждое
 * проверено отдельно.
 *
 * ⚠️ Тест сторожит РАБОТУ, а не текст: он подаёт лог и требует конкретное
 * уведомление на выходе. Убрать любую ветку разводки — покраснеет именно её
 * замер, а не «строки нет».
 */

import { describe, expect, it, vi } from 'vitest';
import {
  routeNotifLogs, makeViewer, WIRE_ONLY_EVENT_NAMES, NOTIF_EVENT_NAMES, type Viewer,
} from './notifRouter';

// ⚠️ В адресах ОБЯЗАТЕЛЬНЫ буквы. С `0x1111…` замер на регистр вырождался в
// сравнение строки с собой (у неё нет букв — регистр менять нечему) и оставался
// зелёным даже когда приведение регистра снимали. Замерено мутацией.
const ME = '0xAbCdEf1111111111111111111111111111111111';
const OTHER = '0xFeDcBa2222222222222222222222222222222222';
const DEAL = '0xDEA1000000000000000000000000000000000001';
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';

const USDC = (n: number) => BigInt(n) * BigInt(1_000_000);

function log(eventName: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { eventName, args, transactionHash: TX, blockNumber: BigInt(500), ...over };
}

/** Наблюдатель по умолчанию: подключён я, не арбитр, ничего своего не знаю. */
function viewer(over: Partial<Viewer> = {}): Viewer {
  return { ...makeViewer(ME), ...over };
}

const refundStub = vi.fn(async () => ({ kind: 'refund' as const }));
const deps = { classifyRefund: refundStub };

async function route(logs: unknown[], v: Viewer = viewer()) {
  return routeNotifLogs(logs, v, deps);
}

describe('AgreementRegistered — обе роли', () => {
  it('1. я клиент → «Deal Created»', async () => {
    const r = await route([log('AgreementRegistered', { client: ME, executor: OTHER, agreement: DEAL, amount: USDC(50) })]);
    expect(r.notifs).toHaveLength(1);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: 'Deal Created', link: `/deal/${DEAL}`, txHash: TX });
    expect(r.notifs[0].body).toContain('50');
  });

  it('2. я исполнитель → «You\'ve Been Hired!»', async () => {
    const r = await route([log('AgreementRegistered', { client: OTHER, executor: ME, agreement: DEAL, amount: USDC(7) })]);
    expect(r.notifs).toHaveLength(1);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: "You've Been Hired!" });
  });

  it('чужая сделка — молчим', async () => {
    const r = await route([log('AgreementRegistered', { client: OTHER, executor: OTHER, agreement: DEAL, amount: USDC(7) })]);
    expect(r.notifs).toEqual([]);
  });

  it('сделка попадает в мою карту — иначе следующие события по ней «не мои»', async () => {
    const v = viewer();
    await route([log('AgreementRegistered', { client: ME, executor: OTHER, agreement: DEAL, amount: USDC(50) })], v);
    expect(v.deals.get(DEAL.toLowerCase())).toEqual({ role: 'client', amount: USDC(50) });
  });
});

describe('AgreementStatusUpdated — пять статусов и очередь арбитра', () => {
  const mine = () => viewer({ deals: new Map([[DEAL.toLowerCase(), { role: 'client' as const, amount: USDC(10) }]]) });

  it('3. COMPLETED(1) → «Deal Complete»', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 1 })], mine());
    expect(r.notifs[0]).toMatchObject({ type: 'deal_completed', title: 'Deal Complete' });
  });

  it('4. DISPUTED(3) → «Dispute Raised»', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 3 })], mine());
    expect(r.notifs[0]).toMatchObject({ type: 'deal_disputed', title: 'Dispute Raised' });
  });

  it('5. RESOLVED(4) → «Dispute Resolved»', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 4 })], mine());
    expect(r.notifs[0]).toMatchObject({ type: 'deal_resolved', title: 'Dispute Resolved' });
  });

  it('6. REFUNDED(2) → разбор через classifyRefund, а не «Deal Refunded» вслепую', async () => {
    const classify = vi.fn(async () => ({ kind: 'split' as const, toClient: USDC(5), toExecutor: USDC(5), reason: null }));
    const r = await routeNotifLogs(
      [log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 2 })],
      mine(),
      { classifyRefund: classify },
    );
    expect(classify).toHaveBeenCalledWith(DEAL, TX);
    expect(r.notifs[0].type).toBe('deal_refunded');
    // Дележ без вердикта — не «вернули деньги»; текст обязан прийти из разбора.
    expect(r.notifs[0].title).not.toBe('Deal Refunded');
  });

  it('ACTIVE(0) — уведомления нет, но данные несвежи', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 0 })], mine());
    expect(r.notifs).toEqual([]);
    expect(r.refreshes.some((x) => x.logs.length > 0 && x.topics.chain?.includes('deals'))).toBe(true);
  });

  it('7. ЧУЖАЯ сделка в спор + я арбитр → «New Dispute Available»', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 3 })], viewer({ isArbiter: true }));
    expect(r.notifs[0]).toMatchObject({ type: 'dispute_new', title: 'New Dispute Available', link: '/arbiter' });
  });

  it('чужая сделка в спор, я НЕ арбитр → молчим', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 3 })], viewer({ isArbiter: false }));
    expect(r.notifs).toEqual([]);
  });

  it('чужая сделка ЗАВЕРШИЛАСЬ, я арбитр → молчим (арбитру интересен только спор)', async () => {
    const r = await route([log('AgreementStatusUpdated', { agreement: DEAL, newStatus: 1 })], viewer({ isArbiter: true }));
    expect(r.notifs).toEqual([]);
  });
});

describe('Доска заказов', () => {
  it('8. JobAccepted, я исполнитель → «Application Accepted»', async () => {
    const r = await route([log('JobAccepted', { jobId: BigInt(9), client: OTHER, executor: ME, agreement: DEAL })]);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: 'Application Accepted', link: `/deal/${DEAL}` });
    expect(r.notifs[0].body).toContain('#9');
  });

  it('9. JobAccepted, я клиент → «Executor Accepted»', async () => {
    const r = await route([log('JobAccepted', { jobId: BigInt(9), client: ME, executor: OTHER, agreement: DEAL })]);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: 'Executor Accepted' });
  });

  it('10. JobCancelled, я клиент → сумма возврата в тексте', async () => {
    const r = await route([log('JobCancelled', { jobId: BigInt(4), client: ME, refundAmount: USDC(12) })]);
    expect(r.notifs[0]).toMatchObject({ type: 'job_cancelled', title: 'Job Cancelled', link: '/job/4' });
    expect(r.notifs[0].body).toContain('12');
  });

  it('11. JobApplied, я откликнулся → «Application Submitted»', async () => {
    const r = await route([log('JobApplied', { jobId: BigInt(3), executor: ME })]);
    expect(r.notifs[0]).toMatchObject({ type: 'job_applied', title: 'Application Submitted', link: '/job/3' });
  });

  it('12. JobApplied на МОЙ заказ → «New Applicant»', async () => {
    const r = await route([log('JobApplied', { jobId: BigInt(3), executor: OTHER })], viewer({ jobIds: new Set(['3']) }));
    expect(r.notifs[0]).toMatchObject({ type: 'job_applied', title: 'New Applicant' });
  });

  it('JobApplied на чужой заказ чужим человеком → молчим', async () => {
    const r = await route([log('JobApplied', { jobId: BigInt(77), executor: OTHER })]);
    expect(r.notifs).toEqual([]);
  });
});

describe('Доска услуг', () => {
  it('13. RequestAccepted, я клиент → «Your service request was accepted»', async () => {
    const r = await route([log('RequestAccepted', { requestId: BigInt(1), client: ME, executor: OTHER, agreement: DEAL })]);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: 'Request Accepted' });
    expect(r.notifs[0].body).toContain('Your service request');
  });

  it('14. RequestAccepted, я исполнитель → «You accepted a service request»', async () => {
    const r = await route([log('RequestAccepted', { requestId: BigInt(1), client: OTHER, executor: ME, agreement: DEAL })]);
    expect(r.notifs[0]).toMatchObject({ type: 'deal_new', title: 'Request Accepted' });
    expect(r.notifs[0].body).toContain('You accepted');
  });

  it('15. RequestRejected, я клиент → «Request Declined»', async () => {
    const r = await route([log('RequestRejected', { requestId: BigInt(6), client: ME })]);
    expect(r.notifs[0]).toMatchObject({ type: 'service_rejected', title: 'Request Declined', link: '/request/6' });
  });

  it('16. ServiceRequested, я клиент → «Request Sent»', async () => {
    const r = await route([log('ServiceRequested', { requestId: BigInt(2), serviceId: BigInt(8), client: ME, amount: USDC(30) })]);
    expect(r.notifs[0]).toMatchObject({ type: 'service_requested', title: 'Request Sent', link: '/request/2' });
    expect(r.notifs[0].body).toContain('30');
  });

  it('17. ServiceRequested на МОЮ услугу → «New Service Request»', async () => {
    const r = await route(
      [log('ServiceRequested', { requestId: BigInt(2), serviceId: BigInt(8), client: OTHER, amount: USDC(30) })],
      viewer({ serviceIds: new Set(['8']) }),
    );
    expect(r.notifs[0]).toMatchObject({ type: 'service_requested', title: 'New Service Request' });
  });
});

describe('Спор — арбитр и стороны', () => {
  it('18. DisputeClaimed, я арбитр → «Dispute Claimed»', async () => {
    const r = await route([log('DisputeClaimed', { agreement: DEAL, arbiter: ME })]);
    expect(r.notifs[0]).toMatchObject({ type: 'dispute_claimed', title: 'Dispute Claimed', link: '/arbiter' });
  });

  it('19. DisputeClaimed по МОЕЙ сделке чужим арбитром → «Arbiter Assigned»', async () => {
    const v = viewer({ deals: new Map([[DEAL.toLowerCase(), { role: 'executor' as const, amount: USDC(1) }]]) });
    const r = await route([log('DisputeClaimed', { agreement: DEAL, arbiter: OTHER })], v);
    expect(r.notifs[0]).toMatchObject({ type: 'dispute_arbiter_claimed', title: 'Arbiter Assigned', link: `/deal/${DEAL}` });
  });

  it('свою же заявку арбитр получает ОДИН раз, а не двумя уведомлениями', async () => {
    const v = viewer({ deals: new Map([[DEAL.toLowerCase(), { role: 'client' as const, amount: USDC(1) }]]) });
    const r = await route([log('DisputeClaimed', { agreement: DEAL, arbiter: ME })], v);
    expect(r.notifs.map((n) => n.type)).toEqual(['dispute_claimed']);
  });

  it('чужой спор чужим арбитром → молчим', async () => {
    const r = await route([log('DisputeClaimed', { agreement: DEAL, arbiter: OTHER })]);
    expect(r.notifs).toEqual([]);
  });
});

describe('обстоятельства', () => {
  it('пришёл мусор — вердикт, а не падение', async () => {
    const garbage = [
      null,
      undefined,
      42,
      'строка',
      {},
      { eventName: 'AgreementRegistered' },                       // без args
      { eventName: 'AgreementRegistered', args: null },
      { eventName: 'AgreementRegistered', args: { client: ME } }, // без agreement
      { eventName: 'ЧегоТакогоНетВЦепи', args: { client: ME } },
      { eventName: 'AgreementStatusUpdated', args: { agreement: DEAL, newStatus: 'вовсе не число' } },
      { eventName: 'JobApplied', args: { jobId: undefined, executor: ME } },
      { eventName: 'ServiceRequested', args: { client: ME, amount: 'не bigint' } },
    ];
    const r = await route(garbage);
    expect(r.unknown).toBeGreaterThan(0);
    // Ни одно уведомление из мусора не должно быть ЛОЖНЫМ про деньги.
    for (const n of r.notifs) expect(n.body).not.toContain('NaN');
  });

  it('мусор в середине пачки не съедает исправные логи после себя', async () => {
    const r = await route([
      { eventName: 'AgreementRegistered', args: null },
      log('JobApplied', { jobId: BigInt(3), executor: ME }),
    ]);
    expect(r.notifs.map((n) => n.title)).toEqual(['Application Submitted']);
  });

  it('кошелёк не подключён — ни одного уведомления', async () => {
    const r = await route(
      [log('AgreementRegistered', { client: ME, executor: OTHER, agreement: DEAL, amount: USDC(1) })],
      makeViewer(undefined),
    );
    expect(r.notifs).toEqual([]);
  });

  it('регистр адреса не влияет — в обе стороны', async () => {
    // wagmi отдаёт `address` в checksum-регистре, узел логи — как придётся.
    // Приведение регистра обязано стоять на ОБЕИХ сторонах сравнения.
    const lowerLog = await route(
      [log('AgreementRegistered', { client: ME.toLowerCase(), executor: OTHER, agreement: DEAL, amount: USDC(1) })],
      makeViewer(ME), // кошелёк в checksum
    );
    expect(lowerLog.notifs, 'checksum-кошелёк не узнал себя в логе нижнего регистра').toHaveLength(1);

    const upperLog = await route(
      [log('AgreementRegistered', { client: ME.toUpperCase().replace('0X', '0x'), executor: OTHER, agreement: DEAL, amount: USDC(1) })],
      makeViewer(ME.toLowerCase()),
    );
    expect(upperLog.notifs, 'кошелёк нижнего регистра не узнал себя в логе верхнего').toHaveLength(1);
  });

  it('курсор догона — самый поздний блок пачки', async () => {
    const r = await route([
      log('JobApplied', { jobId: BigInt(1), executor: ME }, { blockNumber: BigInt(10) }),
      log('JobApplied', { jobId: BigInt(2), executor: ME }, { blockNumber: BigInt(40) }),
      log('JobApplied', { jobId: BigInt(3), executor: ME }, { blockNumber: BigInt(25) }),
    ]);
    expect(r.maxBlock).toBe(BigInt(40));
  });

  it('пачка из тысячи логов чужой биржи не порождает ни одного моего уведомления', async () => {
    const flood = Array.from({ length: 1000 }, (_, i) =>
      log('JobApplied', { jobId: BigInt(1000 + i), executor: OTHER }),
    );
    const r = await route(flood);
    expect(r.notifs).toEqual([]);
    // И ни одного похода за перечитыванием: чужая активность экрана не касается.
    expect(r.refreshes.every((x) => x.logs.length === 0)).toBe(true);
  });
});

describe('перечитывание данных — по темам, только по своим логам', () => {
  it('свой AgreementRegistered тянет кошелёк и сделки', async () => {
    const r = await route([log('AgreementRegistered', { client: ME, executor: OTHER, agreement: DEAL, amount: USDC(1) })]);
    const topics = r.refreshes.filter((x) => x.logs.length > 0).flatMap((x) => x.topics.chain ?? []);
    expect(topics).toContain('wallet');
    expect(topics).toContain('deals');
  });

  it('чужой JobApplied не тянет ничего', async () => {
    const r = await route([log('JobApplied', { jobId: BigInt(99), executor: OTHER })]);
    expect(r.refreshes.every((x) => x.logs.length === 0)).toBe(true);
  });
});

/**
 * РОДА «ТОЛЬКО НА ПРОВОД»: приезжают, но человеку не показываются.
 *
 * ЗАЧЕМ ЭТИ ЗАМКИ. Три рода слежения за сменой арбитра едут по ОБЩЕМУ фильтру
 * уведомлений — иначе понадобился бы третий цикл опроса, а бюджет опроса цепи
 * выбран (`hooks/chainPollBudget.test.ts`). Плата за это — чужие логи в пачке
 * разводки, и у них ровно два способа навредить:
 *
 *  1. стать уведомлением — человеку прилетит колокольчик «арбитр повернул ключ»,
 *     чего мы не обещали и обещать не хотим;
 *  2. попасть в счётчик `unknown` как мусор — тогда «приехало нарочно» и
 *     «приехала дрянь» станут неотличимы, и настоящий мусор перестанет быть виден.
 *
 * Что исчезнет из поведения, если снять эти замки: ничто не помешает добавить
 * роду ветку в разводку (и начать слать пуши о внутренней кухне арбитража) или
 * убрать его из `WIRE_ONLY_EVENT_NAMES` (и утопить счётчик мусора).
 */
describe('рода «только на провод» — приезжают, но уведомлениями не становятся', () => {
  const ARB = '0xArB1000000000000000000000000000000000001'.replace('r', 'a');

  it('DisputeReleased не превращается в уведомление', async () => {
    const r = await route([log('DisputeReleased', { agreement: DEAL, prevArbiter: ME })]);
    expect(r.notifs, 'освобождение спора уехало человеку колокольчиком').toEqual([]);
  });

  it('ArbiterChatKeySet не превращается в уведомление — даже мой собственный', async () => {
    // ⚠️ Сцена нарочно «мой»: если бы разводка когда-нибудь получила ветку по
    // этому роду, сработала бы она именно на своём адресе.
    const r = await route([log('ArbiterChatKeySet', { arbiter: ME, boxKey: '0x01', signKey: '0x02' })]);
    expect(r.notifs, 'смена ключа арбитра уехала человеку колокольчиком').toEqual([]);
  });

  it('рода с провода НЕ считаются мусором', async () => {
    // Счётчик `unknown` означает «мусор либо новое событие». Нарочно везомый род
    // не то и не другое.
    const r = await route([
      log('DisputeReleased', { agreement: DEAL, prevArbiter: ARB }),
      log('ArbiterChatKeySet', { arbiter: ARB, boxKey: '0x01', signKey: '0x02' }),
    ]);
    expect(r.unknown, 'нарочно везомый род посчитан мусором').toBe(0);
    expect(r.notifs).toEqual([]);
  });

  it('настоящий мусор по-прежнему считается — счётчик не оглох', async () => {
    // ⚠️ Обратная сторона предыдущего: если бы «не считать мусором» сделали
    // огульно, счётчик замолчал бы на всём подряд.
    const r = await route([log('ЧтоТоНеизвестное', { agreement: DEAL }), null, 42]);
    expect(r.unknown).toBe(3);
  });

  it('рода с провода не тянут перечитывание — они не про экран', async () => {
    const r = await route([log('ArbiterChatKeySet', { arbiter: ME, boxKey: '0x01', signKey: '0x02' })]);
    expect(r.refreshes.every((x) => x.logs.length === 0)).toBe(true);
  });

  it('списки объявлены врозь и не пересекаются', () => {
    // Замок на имя: род, попавший в оба списка, был бы и уведомлением, и
    // «только проводом» одновременно — то есть имя врало бы.
    const bell = new Set<string>(NOTIF_EVENT_NAMES);
    expect(WIRE_ONLY_EVENT_NAMES.filter((n) => bell.has(n))).toEqual([]);
  });
});
