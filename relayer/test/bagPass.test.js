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

// Captured once via issueBagPass(ALICE, 1_700_000_000) with
// SERVER_SECRET='test-server-secret' (the value test/setup.js sets
// unconditionally) and frozen as a literal. Shared by every "golden
// malformed token" test below as a precondition: if THIS stops verifying,
// every golden token in this file was minted under a secret or MAC domain
// that no longer matches the one bagPass.js uses today — and every
// "malformed token rejected" assertion below would then pass for the wrong
// reason (a MAC mismatch, not the specific guard it claims to exercise),
// silently, because the expected verdict ('pass_invalid') is the same
// either way. Assert this first so a broken precondition fails loudly
// instead of hiding behind an assertion that still happens to be true.
const VALID_GOLDEN_TOKEN =
  'v1.MHhhMWNlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBjYWZlLjE3MDAwNDMyMDA.9AzPuOnO3ch-s7H4H_r2Xrs87KgTAOX1qPvOMdcDRig';

function expectGoldenTokensStillValid() {
  expect(verifyBagPass(VALID_GOLDEN_TOKEN, 1_700_000_010)).toEqual({ address: ALICE.toLowerCase() });
}

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

  it('issueBagPass бросает на негодном nowSec — тот же баг I3, с другой стороны', () => {
    // Строка: nowSec + BAG_PASS_TTL_SEC — склейка строк, не арифметика.
    // '99999999999' + 43200 = '9999999999943200' (строка), и пропуск живёт
    // практически вечно — Number.isFinite на verify это пропускает, там
    // всё ещё конечное число, просто огромное.
    expect(() => issueBagPass(ALICE, '99999999999')).toThrow();
    // Дробное: точка дробной части — тот же незаэкранированный разделитель
    // тела, что и в I3, только с другой стороны. '…cafe.43201.5'
    // вставляет лишнее поле, и возвращённый expiresAt (43201.5) расходится
    // с тем, что реально осядет в теле после split('.') на verify (43201).
    expect(() => issueBagPass(ALICE, 1.5)).toThrow();
    // 1e21: Number.isInteger(1e21) === true — литеральная проверка на
    // целое его не поймает. Число вне безопасного диапазона молча теряет
    // точность на +BAG_PASS_TTL_SEC (1e21 + 43200 === 1e21).
    expect(() => issueBagPass(ALICE, 1e21)).toThrow();
  });

  it('verifyBagPass отсекает негодный по форме адрес в теле даже с честным MAC-ом (защита в глубину)', () => {
    // Предусловие: без него смена SERVER_SECRET/домена MAC-а ломает MAC
    // этого золотого токена, verify отвечает 'pass_invalid' по СОВЕРШЕННО
    // ДРУГОЙ причине (MAC не совпал, до ETH_ADDR_RE дело не доходит), а
    // assertion ниже всё равно проходит — тест тихо перестаёт что-либо
    // проверять, не покраснев. Проверено мутацией домена MAC-а: без этой
    // строки падал только тест на домен, этот оставался зелёным.
    expectGoldenTokensStillValid();

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
    // Предусловие — см. комментарий у expectGoldenTokensStillValid(): без
    // него та же тихая дыра, что и у защиты формы адреса (I2).
    expectGoldenTokensStillValid();

    // Золотые токены, захваченные ДО того, как issueBagPass стал проверять
    // форму nowSec (issueBagPass(ALICE, NaN) / issueBagPass(ALICE, 'abc') с
    // SERVER_SECRET='test-server-secret'). После фикса I1 так больше не
    // собрать — путь остаётся только как защита в глубину на verify, и
    // держится только на этой заморозке: Number.isFinite(expiresAt).
    const NAN_GOLDEN_TOKEN =
      'v1.MHhhMWNlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBjYWZlLk5hTg.oWhkY_IwvNmBJ3lVA0Mj8Ip7MiFV4csBwNzDi4G4S0s';
    const ABC_GOLDEN_TOKEN =
      'v1.MHhhMWNlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBjYWZlLmFiYzQzMjAw.SPMNsW9DfTRwiFZqrWr5a4qxywWP6VzZXHoJeMUBS6M';
    expect(verifyBagPass(NAN_GOLDEN_TOKEN, 1_700_000_000).code).toBe('pass_invalid');
    expect(verifyBagPass(ABC_GOLDEN_TOKEN, 1_700_000_000).code).toBe('pass_invalid');
  });

  it('золотой токен: смена домена MAC-а в реализации сломает эту заморозку', () => {
    // Разделение с пропуском журнала спора (app.js) держится на разной
    // строке домена MAC-а ('hexseal:chat-bags-pass:' против
    // 'hexseal:dispute-log-pass:'), не на разном числе полей в теле.
    // Проверено напрямую: посчитан HMAC под обоими доменами над ОДНИМ и
    // тем же двухполевым телом ('<адрес>.<срок>') с одним и тем же
    // секретом — результаты разные. Так что даже если бы оба пропуска
    // когда-нибудь пришли к одинаковой форме тела, домен всё равно не
    // даст токену одного типа пройти как токен другого.
    //
    // Если домен MAC-а когда-нибудь поменяется здесь, эта заморозка первой
    // скажет об этом, ничего заново не пересчитывая — issueBagPass и
    // verifyBagPass всегда пересчитывают MAC заново под текущим доменом и
    // остаются согласованными друг с другом при любом его значении; только
    // внешняя заморозка, ничего не пересчитывающая, ловит расхождение.
    expectGoldenTokensStillValid();
  });

  it('TTL пришпилен к 12 часам буквально, не через символ', () => {
    expect(BAG_PASS_TTL_SEC).toBe(43200);
  });

  it('нужен канонический base64url — паддинг, пробельные символы и вставки принимает Buffer.from молча, но не мы', () => {
    // Buffer.from(x, 'base64url') тихо съедает мусор (padding '=', '\n',
    // пробел, '!') и декодирует всё это в одно и то же тело — сегодня
    // безвредно, но Задача 3 добавит лимитер, и всё, что ключуется строкой
    // токена, поедет вместе с этими дублями одной и той же личности.
    const { token } = issueBagPass(ALICE);
    const [prefix, canonicalBody, mac] = token.split('.');
    const variants = [
      `${canonicalBody}=`,
      `${canonicalBody}==`,
      `${canonicalBody.slice(0, 4)}\n${canonicalBody.slice(4)}`,
      `${canonicalBody.slice(0, 4)} ${canonicalBody.slice(4)}`,
      `${canonicalBody.slice(0, 4)}!${canonicalBody.slice(4)}`,
    ];
    for (const variant of variants) {
      expect(verifyBagPass(`${prefix}.${variant}.${mac}`).code).toBe('pass_invalid');
    }
    // Канонический вид сам по себе остаётся годным.
    expect(verifyBagPass(token)).toEqual({ address: ALICE.toLowerCase() });
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
