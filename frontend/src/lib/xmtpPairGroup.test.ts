import { describe, it, expect } from 'vitest';
import {
  PAIR_PREFIX,
  pairPeerFromName,
  isLegitimatePairMembership,
  pickCanonicalGroup,
  findLastVisibleMessage,
} from './xmtpPairGroup';

const ME   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BOT  = '0xcccccccccccccccccccccccccccccccccccccccc';
const EVIL = '0xdddddddddddddddddddddddddddddddddddddddd';

const pairName = `${PAIR_PREFIX}${ME}-${PEER}`;

describe('pairPeerFromName', () => {
  it('достаёт собеседника из имени', () => {
    expect(pairPeerFromName(pairName, ME)).toBe(PEER);
    expect(pairPeerFromName(pairName, PEER)).toBe(ME);
  });

  it('регистр моего адреса не важен — viem отдаёт checksum', () => {
    expect(pairPeerFromName(pairName, ME.toUpperCase())).toBe(PEER);
  });

  it('чужая пара — не моя переписка', () => {
    expect(pairPeerFromName(`${PAIR_PREFIX}${PEER}-${BOT}`, ME)).toBeNull();
  });

  it('непарное имя игнорируется', () => {
    expect(pairPeerFromName('HSEAL-0x1234', ME)).toBeNull();
    expect(pairPeerFromName(`${PAIR_PREFIX}${ME}`, ME)).toBeNull();
    expect(pairPeerFromName(`${PAIR_PREFIX}${ME}-${PEER}-${BOT}`, ME)).toBeNull();
  });
});

describe('isLegitimatePairMembership', () => {
  const expected = { me: ME, peer: PEER, bot: BOT };

  it('двое и бот — нормальная группа', () => {
    expect(isLegitimatePairMembership([ME, PEER, BOT], expected)).toBe(true);
  });

  it('регистр адресов роли не играет', () => {
    expect(isLegitimatePairMembership([ME.toUpperCase(), PEER, BOT], expected)).toBe(true);
  });

  it('посторонний при известном боте — подделка', () => {
    expect(isLegitimatePairMembership([ME, PEER, BOT, EVIL], expected)).toBe(false);
  });

  it('бот неизвестен — настоящая группа всё равно проходит', () => {
    // Ровно тот отказ, из-за которого при недоступном релеере вся переписка
    // открывалась пустой и первая же отправка заводила вторую группу.
    expect(isLegitimatePairMembership([ME, PEER, BOT], { ...expected, bot: null })).toBe(true);
  });

  it('бот неизвестен — двое лишних всё ещё подделка', () => {
    expect(isLegitimatePairMembership([ME, PEER, BOT, EVIL], { ...expected, bot: null })).toBe(false);
  });

  it('группа без бота легитимна: релеер мог лежать в момент создания', () => {
    expect(isLegitimatePairMembership([ME, PEER], expected)).toBe(true);
  });

  it('группа, где собеседника ещё нет, не считается подделкой', () => {
    // Собеседника молча добавляет самопочинка (lib/xmtpDelivery.ts); гасить
    // такую группу целиком значило бы потерять её историю.
    expect(isLegitimatePairMembership([ME, BOT], expected)).toBe(true);
  });
});

describe('pickCanonicalGroup', () => {
  it('берёт наименьший id', () => {
    expect(pickCanonicalGroup([{ id: 'c' }, { id: 'a' }, { id: 'b' }])).toEqual({ id: 'a' });
  });

  it('пусто — некого выбирать', () => {
    expect(pickCanonicalGroup([])).toBeNull();
  });

  it('правило одно и то же независимо от порядка — иначе список и тред разойдутся', () => {
    const a = { id: 'a', lastAt: 1 };
    const b = { id: 'b', lastAt: 999 };
    expect(pickCanonicalGroup([a, b])).toBe(a);
    expect(pickCanonicalGroup([b, a])).toBe(a);
  });
});

describe('findLastVisibleMessage', () => {
  type Msg = { n: number; visible: boolean };
  const scanOver = (pages: Msg[][], pageSize = 3, maxPages?: number) => {
    let calls = 0;
    const scan = {
      page: async () => (pages[calls++] ?? []) as readonly Msg[],
      parse: (m: Msg) => (m.visible ? `msg-${m.n}` : null),
      cursorOf: (m: Msg) => BigInt(m.n),
      pageSize,
      maxPages,
    };
    return { scan, pages: () => calls };
  };

  it('видимое сообщение на первой странице — второй запрос не нужен', async () => {
    const { scan, pages } = scanOver([[{ n: 3, visible: true }, { n: 2, visible: false }]]);
    expect(await findLastVisibleMessage(scan)).toMatchObject({ parsed: 'msg-3' });
    expect(pages()).toBe(1);
  });

  it('окно расширяется, пока видимое не найдётся', async () => {
    // Именно этот случай и ломал превью: квитанции о прочтении съедали окно
    // целиком, и живая переписка подписывалась «Сообщений пока нет».
    const receipts = [1, 2, 3].map(n => ({ n, visible: false }));
    const { scan, pages } = scanOver([receipts, [{ n: 0, visible: true }]]);
    expect(await findLastVisibleMessage(scan)).toMatchObject({ parsed: 'msg-0' });
    expect(pages()).toBe(2);
  });

  it('короткая страница означает конец истории', async () => {
    const { scan, pages } = scanOver([[{ n: 1, visible: false }]]);
    expect(await findLastVisibleMessage(scan)).toBeNull();
    expect(pages()).toBe(1);
  });

  it('видимых нет вовсе — упираемся в потолок страниц, а не листаем вечно', async () => {
    const full = () => [1, 2, 3].map(n => ({ n, visible: false }));
    const { scan, pages } = scanOver([full(), full(), full(), full(), full()], 3, 2);
    expect(await findLastVisibleMessage(scan)).toBeNull();
    expect(pages()).toBe(2);
  });

  it('без курсора останавливаемся — иначе бесконечный цикл на той же странице', async () => {
    let calls = 0;
    const result = await findLastVisibleMessage({
      page: async () => { calls++; return [{ n: 1, visible: false }, { n: 2, visible: false }]; },
      parse: () => null,
      cursorOf: () => undefined,
      pageSize: 2,
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  it('пустая группа — превью нет', async () => {
    const { scan } = scanOver([[]]);
    expect(await findLastVisibleMessage(scan)).toBeNull();
  });
});
