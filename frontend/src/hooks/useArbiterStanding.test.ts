import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Замок на карточку положения арбитра.
 *
 * Сторожатся три свойства, и каждое ломается молча:
 *
 *  1. ПОРЯДОК ПОЛЕЙ. Тринадцать значений приезжают кортежем, восемь из них
 *     `uint256`. Перестановка любых двух не ревертит ничего, типами не ловится
 *     и на экране выглядит как правдоподобная чужая биография: «снимали 7 раз»
 *     вместо «залог 7 USDC». Ожидаемый порядок берётся ИЗ ABI (а тот заперт на
 *     исходник контракта замком `lib/arbiterAccountabilityAbi.test.ts`), а не
 *     переписывается сюда руками — иначе крючок сверялся бы сам с собой.
 *
 *  2. ОТВЕТ НАРАВНЕ С ОБВИНЕНИЕМ (решение владельца, 17 августа). Карточки не
 *     существует, пока не приехали ОБЕ половины: показать обвинение раньше
 *     ответа — ровно то, что решением запрещено.
 *
 *  3. ПРИЗНАК «ПРОВЕРИЛА ЛИ ЦЕПЬ САМА» доезжает до карточки, а не теряется по
 *     дороге от расшифровки.
 *
 * ⚠️ ЦЕПЬ ЗДЕСЬ ОТВЕЧАЕТ НАРОЧНО СТРАННО — числами 0..12 по местам. Подставь
 * правдоподобные значения, и перестановка соседних полей осталась бы
 * незамеченной: «оба bigint, оба похожи на правду». Различимые по местам числа
 * — единственное, чем позиционную ошибку вообще можно поймать.
 */

type ReadArgs = Record<string, unknown>;
type Answer = { data: unknown; isLoading: boolean; refetch: () => void };

let answers: Record<string, Answer> = {};
const calls: ReadArgs[] = [];
const refetched: string[] = [];

vi.mock('wagmi', () => ({
  useReadContract: (args: ReadArgs) => {
    calls.push(args);
    const name = String(args.functionName);
    return answers[name] ?? { data: undefined, isLoading: true, refetch: () => refetched.push(name) };
  },
}));

/**
 * ⚠️ `useCallback` ПОДМЕНЁН ТОЖДЕСТВОМ, и это не упрощение крючка. Рендерить
 * здесь нечем — у фронта нет jsdom, окружение `node`, и настоящий
 * `useCallback` вне рендера падает на пустом диспетчере React. В боевом
 * рендере он остаётся на месте и делает ровно то, ради чего стоит: держит
 * ссылку на `refetch` неизменной между рендерами (иначе экран, положивший её в
 * зависимости эффекта, закрутился бы). Здесь же важно только, ЧТО он
 * возвращает, — а возвращает он ту же функцию.
 */
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useCallback: <T,>(fn: T) => fn };
});

const { useArbiterStanding } = await import('./useArbiterStanding');
const { CONTRACTS, ARBITER_ACCOUNTABILITY_ABI } = await import('@/config/contracts');

const ARBITER = '0x00000000000000000000000000000000000000a1' as `0x${string}`;
const SEATER = '0x00000000000000000000000000000000000000b2' as `0x${string}`;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as `0x${string}`;
const REPLY = `0x${'5e'.repeat(32)}` as `0x${string}`;

/** Имена возвратов `getArbiterStanding` в ПОРЯДКЕ ABI. */
const ABI_OUTPUT_NAMES = (ARBITER_ACCOUNTABILITY_ABI as readonly {
  type: string; name: string; outputs?: { name: string }[];
}[])
  .find((e) => e.type === 'function' && e.name === 'getArbiterStanding')!
  .outputs!.map((o) => o.name);

function answerStanding(tuple: readonly unknown[]): void {
  answers.getArbiterStanding = { data: tuple, isLoading: false, refetch: () => refetched.push('getArbiterStanding') };
}
function answerReply(digest: `0x${string}`): void {
  answers.getRemovalReply = { data: digest, isLoading: false, refetch: () => refetched.push('getRemovalReply') };
}

/** Кортеж, где значение каждого поля равно его МЕСТУ. */
const POSITIONAL = [
  0n, 1n, 2n, 3n,
  '0x0000000000000000000000000000000000000004' as `0x${string}`,
  5n, 6n, 7n, 8n,
  true,
  10n, 11n, 12,
] as const;

beforeEach(() => {
  answers = {};
  calls.length = 0;
  refetched.length = 0;
});

describe('карточку спрашивают у диамонда и именно теми чтениями', () => {
  // Имя было «ответ снятого» и стало неправдой 19 августа 2026: ответ
  // принимается и во время паузы, то есть у ДЕЙСТВУЮЩЕГО арбитра.
  it('S1 два чтения: положение и ответ обвинённого — оба по адресу арбитра', () => {
    answerStanding(POSITIONAL);
    answerReply(ZERO_DIGEST);
    useArbiterStanding(ARBITER);

    expect(calls.map((c) => c.functionName)).toEqual(['getArbiterStanding', 'getRemovalReply']);
    for (const call of calls) {
      expect(call.address).toBe(CONTRACTS.diamond);
      expect(call.abi).toBe(ARBITER_ACCOUNTABILITY_ABI);
      expect(call.args).toEqual([ARBITER]);
    }
  });

  it('S2 без адреса и при выключенном гейте цепь не опрашивается', () => {
    // Карточку могут поставить на список — это два eth_call на строку. Гейт
    // обязан выключать оба запроса, а не один.
    useArbiterStanding(undefined);
    useArbiterStanding(ARBITER, false);
    expect(calls.every((c) => (c.query as { enabled: boolean }).enabled === false)).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('S3 refetch дёргает ОБЕ половины, а не одну', () => {
    answerStanding(POSITIONAL);
    answerReply(REPLY);
    useArbiterStanding(ARBITER).refetch();
    expect(refetched.sort()).toEqual(['getArbiterStanding', 'getRemovalReply']);
  });
});

describe('тринадцать полей разложены по местам, а не как придётся', () => {
  it('S4 каждое поле стоит на том же месте, что и его возврат в ABI', () => {
    answerStanding(POSITIONAL);
    answerReply(ZERO_DIGEST);
    const { standing } = useArbiterStanding(ARBITER);
    expect(standing).not.toBeNull();

    const seen: Record<string, number> = {
      xp:                     Number(standing!.xp),
      cleanStreak:            Number(standing!.cleanStreak),
      mistakeStreak:          Number(standing!.mistakeStreak),
      bond:                   Number(standing!.bond),
      seatedBy:               Number(standing!.seatedBy),
      suspendedUntil:         standing!.suspendedUntil,
      openClaims:             Number(standing!.openClaims),
      cleanVerdicts:          Number(standing!.cleanVerdicts),
      removedAt:              standing!.removedAt,
      hasLiveRemovalProposal: standing!.hasLiveRemovalProposal ? 9 : -1,
      removalCount:           Number(standing!.removalCount),
      lastRemovalAt:          standing!.lastRemovalAt,
      lastRemovalCause:       standing!.lastRemovalCause.raw,
    };

    // Имена полей, отсортированные по МЕСТУ, которое им досталось, обязаны
    // совпасть с порядком возвратов в ABI. Любая перестановка двух полей ломает
    // именно эту строку, и в сообщении будет видно, что с чем поменялось.
    const byPosition = Object.entries(seen).sort(([, a], [, b]) => a - b).map(([name]) => name);
    expect(byPosition).toEqual(ABI_OUTPUT_NAMES);
  });

  it('S5 ABI действительно отдал тринадцать имён — иначе сверка выше тавтологична', () => {
    expect(ABI_OUTPUT_NAMES).toHaveLength(13);
    expect(ABI_OUTPUT_NAMES[0]).toBe('xp');
    expect(ABI_OUTPUT_NAMES[12]).toBe('lastRemovalCause');
  });

  it('S6 деньги и счётчики остаются bigint, время — секундами', () => {
    answerStanding([
      3_000n, 4n, 0n, 6_000_000n, SEATER, 1_760_000_000n, 2n, 9n,
      1_755_000_000n, false, 1n, 1_755_000_000n, 0,
    ]);
    answerReply(ZERO_DIGEST);
    const { standing } = useArbiterStanding(ARBITER);

    expect(standing!.bond).toBe(6_000_000n);
    expect(standing!.xp).toBe(3_000n);
    expect(standing!.seatedBy).toBe(SEATER);
    expect(standing!.suspendedUntil).toBe(1_760_000_000);
    expect(standing!.lastRemovalAt).toBe(1_755_000_000);
  });
});

describe('ответ обвиняемого показывается наравне с обвинением', () => {
  it('S7 ответ ещё не приехал — карточки НЕТ, а не карточка без ответа', () => {
    // Решение владельца 17 августа. Обвинение, показанное раньше ответа, — то
    // самое «половина дела, выданная за целое», пусть даже на два кадра.
    answerStanding(POSITIONAL);
    const { standing } = useArbiterStanding(ARBITER);
    expect(standing).toBeNull();
  });

  it('S8 положение ещё не приехало — тоже нет карточки', () => {
    answerReply(REPLY);
    expect(useArbiterStanding(ARBITER).standing).toBeNull();
  });

  it('S9 отпечаток ответа доезжает целиком', () => {
    answerStanding(POSITIONAL);
    answerReply(REPLY);
    expect(useArbiterStanding(ARBITER).standing!.answer.digest).toBe(REPLY);
  });

  it('S10 нулевой отпечаток — это «не отвечал», а не пустой ответ', () => {
    answerStanding(POSITIONAL);
    answerReply(ZERO_DIGEST);
    expect(useArbiterStanding(ARBITER).standing!.answer.digest).toBeNull();
  });

  it('S11 момента ответа в цепи нет — и он не подменяется похожим числом', () => {
    // `at` живёт только в событии RemovalAnswered, читателя которому нет.
    // Соблазн подставить сюда lastRemovalAt («примерно тогда же») — это выдумка
    // с видом факта, и тип её не пропустит.
    answerStanding(POSITIONAL);
    answerReply(REPLY);
    expect(useArbiterStanding(ARBITER).standing!.answer.at).toBeNull();
  });
});

describe('признак «проверила ли цепь сама» доезжает до карточки', () => {
  const withCause = (raw: number) => {
    answerStanding([...POSITIONAL.slice(0, 12), raw]);
    answerReply(ZERO_DIGEST);
    // There is no React here. This whole file calls the hook as a PLAIN
    // FUNCTION: `wagmi` and `useCallback` are mocked above precisely because
    // the environment is `node` with no jsdom and nothing to render into. The
    // rule cannot see that, so it reads `withCause` as an ordinary lowercase
    // function calling a hook — which in real component code WOULD be the bug
    // the rule is named for. Hence one narrow exemption on the call itself,
    // not `eslint-disable` for the file: the gate stays armed everywhere else,
    // including the rest of this file. The sibling suites above get away with
    // the same call only because their callers are anonymous `it()` arrows.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useArbiterStanding(ARBITER).standing!.lastRemovalCause;
  };

  it('S12 проверяемый повод приходит с true', () => {
    // 3 = Cause.Silence + сдвиг: цепь видит запись «просил переписку, ответа нет».
    expect(withCause(3)).toMatchObject({ kind: 'declared', cause: 'Silence', verifiedByChain: true });
  });

  it('S13 заверяемый отпечатком повод приходит с false — недоказанное не выдаётся за доказанное', () => {
    // 4 = Cause.Collusion + сдвиг: под отпечатком может быть что угодно, цепь
    // его не читала.
    expect(withCause(4)).toMatchObject({ kind: 'declared', cause: 'Collusion', verifiedByChain: false });
  });

  it('S14 автодемоушен назван автоматом, а не поводом', () => {
    expect(withCause(254)).toMatchObject({ kind: 'automatic', path: 'AgreementTimeout', verifiedByChain: true });
  });

  it('S15 не снимали — ни повода, ни признака', () => {
    expect(withCause(0)).toEqual({ kind: 'never', raw: 0, verifiedByChain: null });
  });
});
