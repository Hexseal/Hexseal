import { describe, it, expect, beforeAll } from 'vitest';

let issueBagPass, verifyBagPass, bagPassChallenge, BAG_PASS_TTL_SEC;

beforeAll(async () => {
  process.env.SERVER_SECRET ||= 'test-secret-for-bag-pass';
  ({ issueBagPass, verifyBagPass, bagPassChallenge, BAG_PASS_TTL_SEC } =
    await import('../bagPass.js'));
});

const ALICE = '0xA1ce00000000000000000000000000000000CAfe';
const BOB   = '0xB0b1000000000000000000000000000000005EED';

describe('bagPass', () => {
  it('выпущенный пропуск проверяется и возвращает адрес в нижнем регистре', () => {
    const { token } = issueBagPass(ALICE);
    expect(verifyBagPass(token)).toEqual({ address: ALICE.toLowerCase() });
  });

  it('протухший пропуск отличим от негодного', () => {
    const now = 1_800_000_000;
    const { token } = issueBagPass(ALICE, now);
    expect(verifyBagPass(token, now + BAG_PASS_TTL_SEC + 1))
      .toEqual({ error: expect.any(String), code: 'pass_expired' });
    expect(verifyBagPass('v1.zzzz.zzzz', now))
      .toEqual({ error: expect.any(String), code: 'pass_invalid' });
  });

  it('подделанный MAC не проходит', () => {
    const { token } = issueBagPass(ALICE);
    const [prefix, body] = token.split('.');
    expect(verifyBagPass(`${prefix}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`).code)
      .toBe('pass_invalid');
  });

  it('подменённое тело не проходит: адрес в теле покрыт MAC-ом', () => {
    const { token, expiresAt } = issueBagPass(ALICE);
    const mac = token.split('.')[2];
    const forged = Buffer.from(`${BOB.toLowerCase()}.${expiresAt}`, 'utf8').toString('base64url');
    expect(verifyBagPass(`v1.${forged}.${mac}`).code).toBe('pass_invalid');
  });

  it('протухает ровно на границе expiresAt, не позже', () => {
    const now = 1_800_000_000;
    const { token, expiresAt } = issueBagPass(ALICE, now);
    // За секунду до границы — ещё годен.
    expect(verifyBagPass(token, expiresAt - 1)).toEqual({ address: ALICE.toLowerCase() });
    // Ровно на границе — уже протух. Ловит off-by-one вида `>` вместо `>=`,
    // который существующий тест на TTL+1 не видит: там nowSec на секунду
    // дальше границы, и оба оператора уже согласны, что пропуск мёртв.
    expect(verifyBagPass(token, expiresAt)).toEqual({ error: expect.any(String), code: 'pass_expired' });
  });

  it('собственная ошибка выпуска: негодный по форме адрес в теле не проходит даже с честным MAC-ом', () => {
    // Не подделка снаружи — честный issueBagPass, но с адресом, который не
    // прошёл бы проверку формы. MAC здесь настоящий (посчитан над этим же
    // телом), поэтому единственное, что может отсечь такой пропуск, —
    // проверка формы адреса после проверки MAC.
    const { token } = issueBagPass('не-адрес');
    expect(verifyBagPass(token).code).toBe('pass_invalid');
  });

  it('мусор на входе даёт вердикт, а не исключение', () => {
    for (const bad of [null, undefined, 42, {}, [], '', 'v1', 'v2.a.b', Symbol('x')]) {
      expect(() => verifyBagPass(bad)).not.toThrow();
      expect(verifyBagPass(bad).code).toBe('pass_invalid');
    }
  });

  it('фраза для подписи привязана к адресу и времени', () => {
    expect(bagPassChallenge(ALICE, 1700)).toBe(`hexseal:chat-bags:${ALICE.toLowerCase()}:1700`);
    expect(bagPassChallenge(ALICE, 1700)).not.toBe(bagPassChallenge(BOB, 1700));
    expect(bagPassChallenge(ALICE, 1700)).not.toBe(bagPassChallenge(ALICE, 1701));
  });
});
