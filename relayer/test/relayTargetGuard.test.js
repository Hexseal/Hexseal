/**
 * Пункт 44, релеерная половина: за чей контракт релеер платит газ.
 *
 * Подпись ForwardRequest доказывает «этот человек подписал этот запрос», а НЕ
 * «этот запрос про Hexseal». До этой правки `to` сверялся только с формой
 * адреса (app.js:1928) — то есть любой желающий подписывал своим ключом вызов
 * ЧУЖОГО контракта, и газ платили мы.
 *
 * ⚠️ Существующий relayer/test/relay.test.js остаётся зелёным целиком, и это не
 * везение: его VALID_BODY.to — '0x2222…2222', то есть ровно DIAMOND_ADDRESS из
 * test/setup.js. Законный трафик диамонда замок не трогает; проверяется это
 * мутацией 5 (снять короткое замыкание на диамонд → 7 красных В СУЩЕСТВУЮЩЕМ
 * файле).
 *
 * ⚠️ Половина сцен здесь не своя, а взята из shared/relay-target-scenes.json —
 * общего договора с Next-путём. Так и задумано: у шва между двумя рантаймами
 * нет хозяина, и единственный способ его сторожить — заставить обе стороны
 * отвечать на один список сцен ПОВЕДЕНИЕМ (статус, код, число чтений цепи,
 * отправлена ли транзакция).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { app, relayTargetVerdict, _resetRelayTargetCacheForTest } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';

const FORWARDER = process.env.TRUSTED_FORWARDER;
const DIAMOND   = process.env.DIAMOND_ADDRESS;

const ZERO      = '0x0000000000000000000000000000000000000000';
const AGREEMENT = '0xa9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9';
// Настоящий чужой контракт, а не выдумка: тестовый USDC Base Sepolia. Именно
// такой адрес и подставил бы тот, кто хочет, чтобы мы оплатили его перевод.
const FOREIGN   = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const EOA       = '0xee01ee01ee01ee01ee01ee01ee01ee01ee01ee01';
const CLIENT    = '0xc11e1700000000000000000000000000000000c1';
const EXECUTOR  = '0xe8ec0000000000000000000000000000000000e8';

const ДОГОВОР = JSON.parse(
  readFileSync(new URL('../../shared/relay-target-scenes.json', import.meta.url), 'utf8'),
);
const СЦЕНЫ = ДОГОВОР.сцены;
const ЦЕЛЬ = { diamond: DIAMOND, agreement: AGREEMENT, foreign: FOREIGN, eoa: EOA };

// Пустая запись реестра — ровно то, что getRecord отдаёт у НЕЗНАКОМОГО адреса.
// Обратите внимание на status: 0. В RegistryStorage.AgreementStatus это ACTIVE.
// Поэтому существование сверяется адресом, а не статусом (мутация 8).
const ПУСТАЯ = {
  agreement: ZERO, client: ZERO, executor: ZERO,
  amount: 0n, status: 0n, createdAt: 0n, resolvedAt: 0n,
};
const НАША = {
  agreement: AGREEMENT, client: CLIENT, executor: EXECUTOR,
  amount: 1_000_000n, status: 0n, createdAt: 1n, resolvedAt: 0n,
};

let счёт;

/**
 * Поднимает подставную цепь и обнуляет счётчики.
 * `запись` — что отдаёт getRecord на данный адрес; `молчит` — узел не отвечает.
 */
function поднятьЦепь({
  молчит = false,
  запись = (addr) => (String(addr).toLowerCase() === AGREEMENT ? НАША : ПУСТАЯ),
} = {}) {
  счёт = { чтенийРеестра: 0, нонсов: 0, проверокПодписи: 0, отправок: 0 };

  mockContract(DIAMOND, {
    getRecord: async (addr) => {
      счёт.чтенийРеестра += 1;
      if (молчит) throw new Error('узел молчит');
      return запись(addr);
    },
  });

  // Настоящий ethers.Contract носит .staticCall на каждой функции сам;
  // FakeContract из test/setup.js — нет, поэтому подвешиваем руками (тот же
  // приём, что в test/relay.test.js).
  const execute = async () => {
    счёт.отправок += 1;
    return {
      wait: async () => ({ status: 1, hash: '0xdeadbeef', blockNumber: 42, logs: [] }),
    };
  };
  execute.staticCall = async () => [true, '0x'];

  mockContract(FORWARDER, {
    getNonce: async () => { счёт.нонсов += 1; return 0n; },
    verify:   async () => { счёт.проверокПодписи += 1; return true; },
    execute,
  });
}

function тело(to) {
  return {
    from: '0x1111111111111111111111111111111111111111',
    to,
    gas: '100000',
    data: '0xabcdef',
    signature: '0x' + '11'.repeat(65),
  };
}

// Свой X-Forwarded-For на каждый запрос: ограничитель /relay — 10/мин ПО IP
// (RATE_MAX, app.js:1401), и без этого файл упёрся бы в 429 на одиннадцатом
// запросе, покраснев не по той причине. TRUST_PROXY=true стоит в test/setup.js.
let счётчикIP = 0;
function послать(to, extra = {}) {
  счётчикIP += 1;
  return request(app)
    .post('/relay')
    .set('X-Forwarded-For', `target-guard-${счётчикIP}`)
    .send({ ...тело(to), ...extra });
}

describe('Пункт 44 (релеер): платим газ только за свои контракты', () => {
  beforeEach(() => {
    _resetRelayTargetCacheForTest();
  });

  it('договор двух путей на месте, и в нём ровно шесть сцен', () => {
    // Число написано РУКАМИ и не берётся из проверяемого файла: добавивший
    // сцену обязан прийти сюда — и во второй тест, на другой стороне шва.
    expect(Array.isArray(СЦЕНЫ)).toBe(true);
    expect(СЦЕНЫ.length).toBe(6);
  });

  for (const сцена of СЦЕНЫ) {
    it(`шов: ${сцена.имя}`, async () => {
      поднятьЦепь({ молчит: сцена.цепь === 'молчит' });

      const res = await послать(ЦЕЛЬ[сцена.цель]);

      expect(res.status).toBe(сцена.статус);
      if (сцена.исход === 'пропуск') {
        expect(res.body.success).toBe(true);
        expect(счёт.отправок).toBe(1);
      } else {
        expect(res.body.code).toBe(сцена.код);
        expect(счёт.отправок).toBe(0);
      }
      expect(счёт.чтенийРеестра).toBe(сцена.чтенийРеестра);
    });
  }

  it('мусор вместо записи реестра — 503 и ни одной транзакции, а не падение', async () => {
    // Узел ответил, но ответ не разбирается как запись сделки (сменили ABI,
    // прокси отдал заглушку, диамонд потерял селектор). «Не смогли прочитать»
    // — это не «не наш»: код тот же, что у молчания, статус тот же.
    поднятьЦепь({ запись: () => 'нет' });

    const res = await послать(AGREEMENT);

    expect(res.status).toBe(503);
    expect(счёт.отправок).toBe(0);
  });

  it('второй вызов к тому же агрименту цепи не спрашивает, а после перезапуска — спрашивает снова', async () => {
    поднятьЦепь();

    await послать(AGREEMENT);
    expect(счёт.чтенийРеестра).toBe(1);

    await послать(AGREEMENT);
    expect(счёт.чтенийРеестра).toBe(1);   // взято из кэша

    // Перезапуск процесса: карта в памяти пуста, поведение то же, цена — одно
    // чтение на адрес. Ни один пропуск при этом не теряется и ни один отказ не
    // появляется — проверяется тем, что третий запрос всё так же 200.
    _resetRelayTargetCacheForTest();
    const res = await послать(AGREEMENT);
    expect(res.status).toBe(200);
    expect(счёт.чтенийРеестра).toBe(2);
  });

  it('чужой адрес НЕ запоминается: оба раза 403 и оба раза чтение цепи', async () => {
    // Кэшировать отказ нельзя: адрес станет нашим в ту секунду, когда
    // acceptApplicant/acceptRequest/deployAndFund создадут и зарегистрируют
    // сделку. Закэшированный отказ запер бы свежую сделку на срок кэша.
    поднятьЦепь();

    const первый = await послать(FOREIGN);
    const второй = await послать(FOREIGN);

    expect(первый.status).toBe(403);
    expect(второй.status).toBe(403);
    expect(счёт.чтенийРеестра).toBe(2);
  });

  it('замок стоит ДО нонса, подписи и симуляции — у чужой цели их не спрашивали', async () => {
    поднятьЦепь();

    const res = await послать(FOREIGN);

    expect(res.status).toBe(403);
    expect(счёт.нонсов).toBe(0);
    expect(счёт.проверокПодписи).toBe(0);
    expect(счёт.отправок).toBe(0);
  });

  it('ЗАМЕР «долбят нарочно»: сто отказанных запросов — ноль транзакций и ноль газа', async () => {
    поднятьЦепь();

    let отказов = 0;
    for (let i = 0; i < 100; i++) {
      const res = await послать(FOREIGN);
      if (res.status === 403) отказов += 1;
    }

    expect(отказов).toBe(100);
    expect(счёт.отправок).toBe(0);
    expect(счёт.нонсов).toBe(0);
    // Цена спама после замка: одно чтение цепи за запрос и НОЛЬ газа. Кому
    // больно — не нам кошельком, а соседям по узлу: чтения идут в общий RPC.
    expect(счёт.чтенийРеестра).toBe(100);
    // eslint-disable-next-line no-console
    console.info(
      `[замер] 100 отказанных запросов: транзакций ${счёт.отправок}, ` +
      `чтений реестра ${счёт.чтенийРеестра}, нонсов ${счёт.нонсов}`,
    );
  });

  it('пятьдесят одновременных вопросов об одном агрименте — одно чтение цепи', async () => {
    // Прямой вызов, а не пятьдесят HTTP-запросов: те упёрлись бы в 10/мин по IP
    // и померили бы ограничитель вместо склейки. Проводку замка в маршрут
    // меряют сцены выше.
    поднятьЦепь();

    const ответы = await Promise.all(
      Array.from({ length: 50 }, () => relayTargetVerdict(AGREEMENT)),
    );

    expect(ответы.every((v) => v.ok === true)).toBe(true);
    expect(счёт.чтенийРеестра).toBe(1);
    // eslint-disable-next-line no-console
    console.info(`[замер] 50 одновременных вопросов → чтений цепи: ${счёт.чтенийРеестра}`);
  });

  it('кэш ограничен размером: 1001-й адрес вытесняет самый первый', async () => {
    поднятьЦепь({ запись: (addr) => ({ ...НАША, agreement: String(addr).toLowerCase() }) });

    const адрес = (i) => `0x${String(i).padStart(40, '0')}`;

    for (let i = 1; i <= 1001; i++) await relayTargetVerdict(адрес(i));
    const после = счёт.чтенийРеестра;
    expect(после).toBe(1001);

    // Свежий — лежит в кэше, чтения не будет.
    await relayTargetVerdict(адрес(1001));
    expect(счёт.чтенийРеестра).toBe(после);

    // Самый первый — вытеснен, значит цепь спросим снова.
    await relayTargetVerdict(адрес(1));
    expect(счёт.чтенийРеестра).toBe(после + 1);
  });
});
