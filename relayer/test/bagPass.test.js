import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Spy on node:crypto's timingSafeEqual without changing its behavior — the
// wrapper always delegates to the real implementation, so every other test
// in this file still gets a genuinely constant-time compare. This exists to
// lock the one property a timing test can't: that the comparison actually
// goes through timingSafeEqual (not a plain `===`), and only after the
// length check runs.
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    timingSafeEqual: (...args) => {
      timingSafeEqualSpy(...args);
      return actual.timingSafeEqual(...args);
    },
  };
});

let issueBagPass, verifyBagPass, bagPassChallenge, assertBagPassReady, BAG_PASS_TTL_SEC;

beforeAll(async () => {
  ({ issueBagPass, verifyBagPass, bagPassChallenge, assertBagPassReady, BAG_PASS_TTL_SEC } =
    await import('../bagPass.js'));
});

beforeEach(() => {
  timingSafeEqualSpy.mockClear();
});

const ALICE = '0xA1ce00000000000000000000000000000000CAfe';
const BOB   = '0xB0b1000000000000000000000000000000005EED';

describe('bagPass', () => {
  it('секрет читается лениво: импорт без SERVER_SECRET не бросает, assertBagPassReady — бросает', async () => {
    const saved = process.env.SERVER_SECRET;
    delete process.env.SERVER_SECRET;
    vi.resetModules();

    // finally, not just cleanup after — a fresh import throwing here (the
    // exact regression this test exists to catch) must not leave every
    // later test in this file running without SERVER_SECRET.
    try {
      const fresh = await import('../bagPass.js'); // must not throw at import time
      expect(() => fresh.assertBagPassReady()).toThrow(/SERVER_SECRET/);
    } finally {
      process.env.SERVER_SECRET = saved;
      vi.resetModules();
    }
  });

  it('assertBagPassReady молчит, когда секрет на месте', () => {
    expect(() => assertBagPassReady()).not.toThrow();
  });

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

  it('верный токен идёт через timingSafeEqual ровно один раз', () => {
    const { token } = issueBagPass(ALICE);
    expect(verifyBagPass(token)).toEqual({ address: ALICE.toLowerCase() });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('неверный MAC той же длины идёт через timingSafeEqual, а не через ===', () => {
    const { token } = issueBagPass(ALICE);
    const [prefix, body, realMac] = token.split('.');
    const sameLengthBadMac = 'A'.repeat(realMac.length);
    expect(verifyBagPass(`${prefix}.${body}.${sameLengthBadMac}`).code).toBe('pass_invalid');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('MAC другой длины отклоняется без вызова timingSafeEqual — сначала длина', () => {
    const { token } = issueBagPass(ALICE);
    const [prefix, body] = token.split('.');
    expect(verifyBagPass(`${prefix}.${body}.short`).code).toBe('pass_invalid');
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
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

  it('nowSec не число — вердикт invalid, а не вечный пропуск', () => {
    // Сравнение с не-числом в JS всегда false, поэтому единственная
    // временная граница (nowSec >= expiresAt) молча исчезает и пропуск
    // становится вечным. undefined безопасен — срабатывает умолчание, —
    // но null, NaN, строка и объект таковыми не являются.
    const { token } = issueBagPass(ALICE);
    for (const bad of [null, NaN, 'abc', {}]) {
      expect(verifyBagPass(token, bad).code).toBe('pass_invalid');
    }
  });

  it('issueBagPass бросает на негодном по форме адресе — точка не должна протащить лишнее поле в тело', () => {
    // '.' — незаэкранированный разделитель тела. Без проверки формы на
    // выпуске это не только пропускало плохой адрес, но и врало в
    // возвращённом expiresAt: он не совпадал бы со сроком, реально зашитым
    // в токен, потому что "адрес" здесь на самом деле "адрес.секунды".
    expect(() => issueBagPass(`${BOB.toLowerCase()}.99999999999`, 1_800_000_000)).toThrow();
  });

  it('verifyBagPass отсекает негодный по форме адрес в теле даже с честным MAC-ом (защита в глубину)', () => {
    // Золотой токен, захваченный ДО того, как issueBagPass стал проверять
    // форму адреса на выпуске (issueBagPass('не-адрес', 1_700_000_000) с
    // SERVER_SECRET='test-server-secret' — тем же, что ставит test/setup.js).
    // После фикса issueBagPass так больше не собрать — путь остаётся только
    // как защита в глубину на verify, и держится только на этой заморозке.
    const MALFORMED_GOLDEN_TOKEN =
      'v1.0L3QtS3QsNC00YDQtdGBLjE3MDAwNDMyMDA.HLDcCsknyyvgyFq3TsoET5pTLLiiEyKR13CdezGG9rI';
    expect(verifyBagPass(MALFORMED_GOLDEN_TOKEN, 1_700_000_000).code).toBe('pass_invalid');
  });

  it('чужой префикс версии отклоняется, даже когда тело и MAC — настоящие v1', () => {
    // verify всегда считает MAC под своим собственным жёстким доменом v1,
    // независимо от того, что написано в первом сегменте токена, — значит
    // единственное, что вообще проверяет заявленную версию, это сравнение
    // parts[0] с BAG_PASS_PREFIX. Без него ротация версии неисполнима:
    // подмена префикса на новый не отзывает старые тело+MAC.
    const { token } = issueBagPass(ALICE);
    const [, body, mac] = token.split('.');
    expect(verifyBagPass(`v2.${body}.${mac}`).code).toBe('pass_invalid');
    expect(verifyBagPass(`whatever.${body}.${mac}`).code).toBe('pass_invalid');
  });

  it('лишний сегмент после MAC отклоняется', () => {
    const { token } = issueBagPass(ALICE);
    expect(verifyBagPass(`${token}.garbage`).code).toBe('pass_invalid');
  });

  it('срок в теле, который не парсится в число, отклоняется — не живёт вечно', () => {
    // NaN/строка просачивается в expiresAt изнутри issueBagPass (не через
    // подделку тела), поэтому MAC у такого тела честный: единственное, что
    // может отсечь такой пропуск, — Number.isFinite(expiresAt) на verify.
    expect(verifyBagPass(issueBagPass(ALICE, NaN).token).code).toBe('pass_invalid');
    expect(verifyBagPass(issueBagPass(ALICE, 'abc').token).code).toBe('pass_invalid');
  });

  it('золотой токен: смена домена MAC-а в реализации сломает эту заморозку', () => {
    // Захвачен один раз через issueBagPass(ALICE, 1_700_000_000) с
    // SERVER_SECRET='test-server-secret' (тем же, что ставит test/setup.js)
    // и вбит литералом. Сегодня разделение с пропуском журнала спора
    // (app.js) держится только на разной арности тела (два поля здесь,
    // три там) — не на замке. Если домен MAC-а когда-нибудь поменяется, эта
    // заморозка первой скажет об этом, ничего заново не пересчитывая.
    const GOLDEN_TOKEN =
      'v1.MHhhMWNlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBjYWZlLjE3MDAwNDMyMDA.9AzPuOnO3ch-s7H4H_r2Xrs87KgTAOX1qPvOMdcDRig';
    expect(verifyBagPass(GOLDEN_TOKEN, 1_700_000_010)).toEqual({ address: ALICE.toLowerCase() });
  });

  it('TTL пришпилен к 12 часам буквально, не через символ', () => {
    expect(BAG_PASS_TTL_SEC).toBe(43200);
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
