/**
 * adminArbiterAccountability.test.tsx — экран сноса арбитра в админке.
 *
 * ⚠️ ГЛАВНОЕ, РАДИ ЧЕГО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ — СЦЕНА «ФАСЕТА В ЦЕПИ ЕЩЁ НЕТ».
 * Разрез `script/UpgradeArbiterAccountability.s.sol` не сделан: сегодня каждая
 * функция, которую зовёт эта панель, отсутствует в даймонде, и вызов ревертит в
 * его fallback. Экран обязан сказать это словами — иначе владелец откроет
 * страницу, увидит непонятные отказы и пойдёт искать поломку, которой нет. У
 * нас это уже было.
 *
 * ⚠️ РОД ДОВЕРИЯ НАЗЫВАЮ ВСЛУХ. У фронта нет ни jsdom, ни `@testing-library`
 * (`environment: 'node'`), поэтому НАЖАТИЕ здесь не проверяется ничем.
 * Проверяется структурно, через `renderToStaticMarkup`: что решённое доехало до
 * разметки и что запрещённое в ней не появилось. Решения при этом заперты
 * ВЫЗОВОМ в `arbiterRemovalFlow.test.ts` и `facetPresence.test.ts` — здесь шов
 * «цепь ответила → человек прочитал».
 *
 * ⚠️ ЧИСЛА ЦЕПИ ЗДЕСЬ НАРОЧНО НЕ БОЕВЫЕ: потолок слов 700, а не 512; пауза 700
 * секунд, а не 48 часов. Подставь настоящие — и разметка сошлась бы одинаково и
 * на честном чтении цепи, и на литерале, зашитом во фронт.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ────────────────────────── подставная цепь ────────────────────────── */

type Answer = { data?: unknown; isLoading?: boolean; error?: { message?: string } | null };

let chain: Record<string, Answer> = {};
const reads: Array<Record<string, unknown>> = [];

vi.mock('wagmi', () => ({
  useReadContract: (args: Record<string, unknown>) => {
    reads.push(args);
    const a = chain[String(args.functionName)];
    return {
      data: a?.data,
      isLoading: a?.isLoading ?? (a === undefined),
      error: a?.error ?? null,
      refetch: () => {},
    };
  },
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn() }),
}));

/* ───────────────────────── подставная лента ────────────────────────── */

let graph: { data?: unknown; error?: unknown; fetching?: boolean } = {};
vi.mock('urql', () => ({
  useQuery: () => [{ data: graph.data, error: graph.error, fetching: graph.fetching ?? false }],
}));

vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * ⚠️ АДРЕС ЛЕНТЫ ВЫСТАВЛЯЕТСЯ ДО ЗАГРУЗКИ МОДУЛЕЙ, И ЭТО НЕ ФОРМАЛЬНОСТЬ.
 * `lib/graph.ts` вычисляет `SUBGRAPH_URL` НА ЗАГРУЗКЕ, а пустой адрес крючок
 * честно читает как «спросить не у кого» — то есть без этой строки ВСЕ сцены
 * про споры серии проверяли бы одну и ту же ветку «лента недоступна», включая
 * ту, что должна показывать три договора. Ровно та пустая мутация, где красное
 * ничего не значит.
 */
process.env.SUBGRAPH_URL = 'https://subgraph.test/hexseal';

const {
  ArbiterAccountabilityNotice, ArbiterAccountabilityCard,
  ArbiterRemovalFlow, ReasonField,
} = await import('./AdminArbiterAccountability');
const { useRemovalRules } = await import('@/hooks/useRemovalRules');

const ARBITER = '0x00000000000000000000000000000000000000a1' as `0x${string}`;
const HUMAN = '0x00000000000000000000000000000000000000b2' as `0x${string}`;
const CHAIN_AUTHOR = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as `0x${string}`;

/** Кортеж `getArbiterStanding` в порядке ABI. */
function standingTuple(over: Partial<Record<string, bigint | number | boolean | string>> = {}) {
  return [
    BigInt((over.xp as bigint) ?? 40n),
    BigInt((over.cleanStreak as bigint) ?? 5n),
    BigInt((over.mistakeStreak as bigint) ?? 1n),
    BigInt((over.bond as bigint) ?? 10_000_000n),
    HUMAN,
    BigInt((over.suspendedUntil as bigint) ?? 0n),
    BigInt((over.openClaims as bigint) ?? 0n),
    BigInt((over.cleanVerdicts as bigint) ?? 17n),
    BigInt((over.overturnedVerdicts as bigint) ?? 2n),
    0n, false, 0n, 0n, 0,
  ];
}

/** Правила цепи — числа НЕ боевые, см. шапку. */
const RULES_READY = {
  removalDelay: 700, proposalTTL: 9_000, maxReasonBytes: 700,
  mistakeThreshold: 2, maxMistakes: 3, presence: 'ready' as const,
};

/** Страница, как её собирает `admin/page.tsx`: одна проба на весь список. */
function Panel() {
  const rules = useRemovalRules();
  return (
    <>
      <ArbiterAccountabilityNotice presence={rules.presence} />
      <ArbiterAccountabilityCard arbiter={ARBITER} isChief={false} rules={rules} onChanged={() => {}} />
    </>
  );
}

beforeEach(() => {
  chain = {};
  graph = {};
  reads.length = 0;
});

/* ══════════ 1. фасета в цепи ещё нет ══════════ */

describe('до разреза экран говорит понятное, а не сыплет отказами', () => {
  const notMounted = {
    data: undefined, isLoading: false,
    error: { message: 'execution reverted: Diamond: function not found' },
  };

  it('панель говорит, что этой части ещё нет в цепи и она появится после разреза', () => {
    chain = {
      getRemovalDelay: notMounted, getProposalTTL: notMounted,
      getMaxReasonBytes: notMounted, getMistakeThreshold: notMounted,
      getMaxArbiterMistakesMirror: notMounted,
      getArbiterStanding: notMounted, getRemovalReply: notMounted,
      getRemovalProposal: notMounted,
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).toContain('not on chain yet');
    expect(html).toContain('after the cut');
    // Причина названа дословно — иначе владельцу нечем сверить свою догадку.
    expect(html).toContain('Diamond: function not found');
  });

  it('и ни одной кнопки, которая сегодня не может сработать', () => {
    chain = {
      getRemovalDelay: notMounted, getProposalTTL: notMounted,
      getMaxReasonBytes: notMounted, getArbiterStanding: notMounted,
      getRemovalReply: notMounted, getRemovalProposal: notMounted,
      getMistakeThreshold: notMounted, getMaxArbiterMistakesMirror: notMounted,
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).not.toContain('Propose removal');
    expect(html).not.toContain('Execute removal');
    // Именно КНОПКА-раскрывашка: слово «Accountability» есть и в имени фасета
    // внутри объяснения, и сверять надо не его.
    expect(html).not.toContain('>Accountability<');
    // ⚠️ Кнопка, которую разрез убивает, ушла со страницы целиком.
    expect(html).not.toContain('>Remove<');
  });

  it('«сеть не ответила» — ДРУГАЯ новость и другой совет', () => {
    const down = { data: undefined, isLoading: false, error: { message: 'HTTP request failed. Status: 502' } };
    chain = {
      getRemovalDelay: down, getProposalTTL: down, getMaxReasonBytes: down,
      getArbiterStanding: down, getRemovalReply: down, getRemovalProposal: down,
      getMistakeThreshold: down, getMaxArbiterMistakesMirror: down,
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).toContain('The chain did not answer');
    expect(html).toContain('Reload the page');
    // Ждать разреза тому, у кого отвалился RPC, советовать нельзя.
    expect(html).not.toContain('not on chain yet');
  });

  it('пока цепь не ответила — «спрашиваем», а не пустота и не приговор', () => {
    chain = {};
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('Asking the chain');
    expect(html).not.toContain('not on chain yet');
  });
});

/* ══════════ 2. пара чисел и «станет N из M» ══════════ */

describe('карточка арбитра показывает пару чисел и предупреждает заранее', () => {
  beforeEach(() => {
    chain = {
      getRemovalDelay: { data: 700n }, getProposalTTL: { data: 9_000n },
      getMaxReasonBytes: { data: 700n }, getMistakeThreshold: { data: 2n },
      getMaxArbiterMistakesMirror: { data: 3n },
      getArbiterStanding: { data: standingTuple() },
      getRemovalReply: { data: ZERO_DIGEST },
      getRemovalProposal: { data: [0, ZERO_DIGEST, 0n, CHAIN_AUTHOR, false] },
    };
  });

  it('разобрано и перевёрнуто — рядом, порознь и без порога', () => {
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('judged');
    expect(html).toContain('>17<');
    expect(html).toContain('overturned');
    expect(html).toContain('>2<');
    // Порогов и последствий у пары нет: ни процента, ни оценки.
    expect(html).not.toMatch(/\d+\s*%/);
  });

  it('третья ошибка названа заранее — числами цепи, а не своими', () => {
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('Judicial mistakes in a row');
    expect(html).toContain('of 3');
    expect(html).toContain('resets the row to zero');
  });

  it('на второй из трёх сказано прямо, что следующая — последняя', () => {
    chain.getArbiterStanding = { data: standingTuple({ mistakeStreak: 2n }) };
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('the chain suspends him on the spot and opens an accusation');
  });

  /* ── окно счётчиков: сноска появляется только при расхождении ── */

  /**
   * ⚠️ ТРИ СЦЕНЫ, И ТРЕТЬЯ — ВСТРЕЧНАЯ. Сноску, которую не показывают
   * НИКОГДА, сцена «молчим» проходит с блеском: она проверяет отсутствие.
   * Поэтому первая сцена обязана быть, и она обязана требовать текст, а не
   * его отсутствие — иначе замер «убрать условие» покраснел бы только с
   * одной стороны.
   *
   * ⚠️ И ЧЕТВЁРТАЯ ПРОВЕРКА ВНУТРИ ПЕРВОЙ — ЧЕГО В ТЕКСТЕ БЫТЬ НЕ ДОЛЖНО.
   * Причину единицы цепь не хранит, «просрочка» — вывод исключением. Стоит
   * кому-нибудь дописать сюда правдоподобное объяснение, и надпись начнёт
   * врать в тот день, когда произойдёт первый настоящий переворот.
   */
  it('серия длиннее пары — карточка объясняет границу счётчиков на месте', () => {
    chain.getArbiterStanding = {
      data: standingTuple({ mistakeStreak: 1n, overturnedVerdicts: 0n, cleanVerdicts: 0n }),
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).toContain('younger than the arbiter');
    expect(html).toContain('display error');
    expect(html).toContain('never filled in backwards');
    expect(html).toContain('stores the counters, not the history behind them');
    // Причина НЕ названа: цепь её не хранит.
    expect(html).not.toContain('timeout');
    expect(html).not.toContain('Timeout');
  });

  it('числа сходятся — сноски нет, объяснять нечего', () => {
    chain.getArbiterStanding = {
      data: standingTuple({ mistakeStreak: 2n, overturnedVerdicts: 2n }),
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).toContain('Judicial mistakes in a row');  // строка ошибок на месте
    expect(html).not.toContain('younger than the arbiter');
  });

  it('серии нет вовсе — сноски нет, даже при нулевой паре', () => {
    chain.getArbiterStanding = {
      data: standingTuple({ mistakeStreak: 0n, overturnedVerdicts: 0n, cleanVerdicts: 0n }),
    };
    const html = renderToStaticMarkup(<Panel />);

    expect(html).not.toContain('younger than the arbiter');
  });

  it('приостановка видна на карточке', () => {
    chain.getArbiterStanding = { data: standingTuple({ suspendedUntil: 4_000_000_000n }) };
    const html = renderToStaticMarkup(<Panel />);
    expect(html).toContain('suspended until');
  });
});

/* ══════════ 3. форма предложения ══════════ */

describe('форма предложения говорит правду про повод, доказательство и слова', () => {
  const flow = (over: Partial<typeof RULES_READY> = {}) => {
    chain.getRemovalProposal = { data: [0, ZERO_DIGEST, 0n, CHAIN_AUTHOR, false] };
    return renderToStaticMarkup(
      <ArbiterRemovalFlow
        arbiter={ARBITER} rules={{ ...RULES_READY, ...over }} standing={null} onChanged={() => {}}
      />,
    );
  };

  it('про каждый повод сказано, проверяет ли его цепь сама', () => {
    const html = flow();
    expect(html).toContain('the chain verifies this itself');
    expect(html).toContain('the chain does not verify this');
  });

  it('доказательство уходит в ПОСТОЯННОЕ хранилище, в цепь — только отпечаток', () => {
    const html = flow();
    expect(html).toContain('Only the digest goes on chain');
    expect(html).toContain('permanent storage');
    // Обещать вечность и класть в корзину с недельным TTL — то самое «что мы
    // обещаем, чего не делаем».
    expect(html).not.toContain('7 days');
  });

  it('счётчик слов подписан БАЙТАМИ и берёт потолок у цепи', () => {
    const html = flow();
    expect(html).toContain('0 / 700 bytes');
    expect(html).toContain('bytes, not characters');
  });

  it('потолка ещё нет — форма честно молчит про число и не пускает', () => {
    const html = flow({ maxReasonBytes: null });
    expect(html).toContain('has not told us the cap');
    expect(html).not.toContain('/ 512 bytes');
  });

  it('предложение ничего не отнимает — и это сказано рядом с кнопкой', () => {
    const html = flow();
    expect(html).toContain('Propose removal');
    expect(html).toContain('takes nothing away by itself');
    expect(html).toContain('48 hours');
  });
});

/* ══════════ 4. счётчик слов на кириллице ══════════ */

/**
 * ⚠️ СЦЕНА, РАДИ КОТОРОЙ СЧЁТЧИК ВООБЩЕ ЗАМЕРЯЕТСЯ. 256 кириллических букв —
 * это 512 байт и 256 символов. Считай поле символы, здесь стояло бы
 * «256 / 512», то есть «осталось ещё столько же» ровно там, где у цепи не
 * осталось ни байта.
 */
describe('счётчик слов на кириллице говорит правду', () => {
  it('256 кириллических букв выбирают потолок 512 полностью', () => {
    const html = renderToStaticMarkup(
      <ReasonField value={'я'.repeat(256)} onChange={() => {}} maxBytes={512} />,
    );
    expect(html).toContain('512 / 512 bytes');
    expect(html).not.toContain('256 / 512');
  });

  it('перебор назван перебором, а не остатком', () => {
    const html = renderToStaticMarkup(
      <ReasonField value={'я'.repeat(300)} onChange={() => {}} maxBytes={512} />,
    );
    expect(html).toContain('600 / 512 bytes');
    expect(html).toContain('88 over');
  });
});

/* ══════════ 5. живое обвинение ══════════ */

describe('живое обвинение: часы, автор и дверь исполнения', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const withProposal = (by: `0x${string}`, ageSec: number) => {
    chain.getRemovalProposal = {
      data: [3, `0x${'11'.repeat(32)}`, BigInt(nowSec - ageSec), by, true],
    };
    return renderToStaticMarkup(
      <ArbiterRemovalFlow arbiter={ARBITER} rules={RULES_READY} standing={null} onChanged={() => {}} />,
    );
  };

  it('пауза идёт — сказано, сколько ждать, и что ответ её не двигает', () => {
    const html = withProposal(HUMAN, 100);
    expect(html).toContain('Execution opens in');
    expect(html).toContain('an answer does not move them');
    expect(html).not.toContain('Execute removal');
  });

  it('пауза вышла — кнопка исполнения появилась, повод повторяется', () => {
    const html = withProposal(HUMAN, 800);
    expect(html).toContain('Execute removal');
    expect(html).toContain('CauseDiffersFromProposal');
  });

  it('обвинение цепи исполняется ДРУГОЙ дверью и названо её словами', () => {
    graph = { data: { arbiter: { openChainAccusation: { disputes: [], disputeCount: 0 } } } };
    const html = withProposal(CHAIN_AUTHOR, 800);
    expect(html).toContain('laid by the chain itself');
    // Апостроф в разметке уезжает сущностью — сверяем часть без него.
    expect(html).toContain('Execute the chain');
    // Общая дверь на нём ревертит `ChainProposalNeedsTheChainDoor`, и её
    // подписи здесь быть не должно вовсе.
    expect(html).not.toContain('Execute removal');
  });

  /**
   * ⚠️ КРУГ ПРАВОК 1. Кнопка исполнения гейтилась только занятостью: нажатие с
   * пустыми словами уходило в цепь и ревертило `ReasonRequired` — за деньги
   * подписавшего и молча.
   */
  it('кнопка исполнения заперта, пока обязательные слова пусты', () => {
    const html = withProposal(HUMAN, 800);   // повод 3 — Collusion, цепь его не проверяет
    expect(html).toContain('the words are required');
    expect(html).toMatch(/Execute removal[\s\S]{0,80}?<\/button>/);
    // Разметка кнопки несёт `disabled` — иначе она нажимаема.
    expect(html).toContain('disabled=""');
  });

  it('Silence просит договор спора и запирает кнопку без него', () => {
    chain.getRemovalProposal = {
      data: [2, ZERO_DIGEST, BigInt(nowSec - 800), HUMAN, true],
    };
    const html = renderToStaticMarkup(
      <ArbiterRemovalFlow arbiter={ARBITER} rules={RULES_READY} standing={null} onChanged={() => {}} />,
    );
    expect(html).toContain('dispute (agreement) address');
    expect(html).toContain('Silence needs the dispute it happened in');
    expect(html).toContain('disabled=""');
  });

  it('отзыв доступен всегда и записывается — это сказано', () => {
    const html = withProposal(HUMAN, 100);
    expect(html).toContain('Withdraw');
    expect(html).toContain('was accused and it was withdrawn');
  });
});

/* ══════════ 6. все споры серии ══════════ */

describe('у обвинения цепи показываются ВСЕ споры серии', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const D1 = '0xdead000000000000000000000000000000000001';
  const D2 = '0xdead000000000000000000000000000000000002';
  const D3 = '0xdead000000000000000000000000000000000003';

  const render = () => {
    chain.getRemovalProposal = {
      data: [0, ZERO_DIGEST, BigInt(nowSec - 800), CHAIN_AUTHOR, true],
    };
    return renderToStaticMarkup(
      <ArbiterRemovalFlow arbiter={ARBITER} rules={RULES_READY} standing={null} onChanged={() => {}} />,
    );
  };

  it('все три, а не только тот, что перевесил', () => {
    graph = {
      data: {
        arbiter: {
          openChainAccusation: {
            agreement: D3, disputes: [D1, D2, D3], disputeCount: 3, proposedAt: '1',
          },
        },
      },
    };
    const html = render();
    expect(html).toContain(D1);
    expect(html).toContain(D2);
    expect(html).toContain(D3);
    expect(html).toContain('oldest first');
  });

  it('лента насчитала меньше, чем цепь, — это названо пропажей, а не пустяком', () => {
    graph = {
      data: {
        arbiter: {
          openChainAccusation: {
            agreement: D3, disputes: [D3], disputeCount: 1, proposedAt: '1',
          },
        },
      },
    };
    const html = render();
    expect(html).toContain('something was');
  });

  /**
   * ⚠️ САБГРАФ С ЭТОЙ СУЩНОСТЬЮ СЕГОДНЯ НЕ ВЫКАЧЕН — в цепи v2.3.0. Значит эта
   * ветка и есть боевая до выкатки, и молчание вместо неё читалось бы как
   * «обвинение стоит ни на чём».
   */
  it('лента не ответила — сказано именно это, а не «споров нет»', () => {
    graph = { error: new Error('Type `Arbiter` has no field `openChainAccusation`') };
    const html = render();
    expect(html).toContain('not deployed yet');
    expect(html).not.toContain('No disputes recorded');
  });
});

/* ══════════ 7. селектор, который удаляет разрез, не зовётся ниоткуда ══════════ */

/**
 * ⚠️ КНОПОК БЫЛО ДВЕ, И ПЕРВЫЙ ЗАХОД СНЯЛ ОДНУ (найдено ревью, круг правок 1).
 * `removeArbiter(address)` жила и в `app/admin/page.tsx`, и в
 * `app/arbiter/page.tsx` (вкладка «Управление», под `isOwner`). Замысел назвал
 * только первую — вторая осталась бы живой ровно до разреза, а после него
 * умерла бы молча: селектор `0x3487e08c` уходит из даймонда единственным
 * элементом `Remove` в `script/UpgradeArbiterAccountability.s.sol`.
 *
 * Отсюда замок не на страницу, а на ВЕСЬ `src/`: третья такая кнопка не должна
 * появиться незамеченной. Что исчезнет из поведения, если снять правку? Кнопка,
 * которая после разреза ревертит.
 *
 * ⚠️ Граница слова обязательна: `removeArbiterForCause` — ЖИВАЯ дверь и
 * начинается с той же строки. Замок, ищущий подстроку, запретил бы замену
 * вместе с заменяемым.
 */
describe('удаляемый разрезом removeArbiter не зовётся ни из одного экрана', () => {
  const SRC = fileURLToPath(new URL('../', import.meta.url));

  const sources = (function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  })(SRC);

  /** Литерал имени функции: `functionName: 'removeArbiter'` и ничего длиннее. */
  const CALL = /functionName\s*:\s*['"`]removeArbiter['"`]/;

  it('ни одного вызова во всём src/', () => {
    const guilty = sources
      .filter((f) => CALL.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length));
    expect(guilty, `зовут removeArbiter: ${guilty.join(', ')}`).toEqual([]);
  });

  it('разбор при этом видит настоящий вызов — иначе проверка выше тавтологична', () => {
    expect(CALL.test(`functionName: 'removeArbiter', args: [addr]`)).toBe(true);
  });

  it('и НЕ путает его с живой заменой removeArbiterForCause', () => {
    expect(CALL.test(`functionName: 'removeArbiterForCause', args: [addr]`)).toBe(false);
  });

  it('замена при этом в дереве есть — значит поток на месте, а не просто вырезан', () => {
    const hasReplacement = sources.some((f) =>
      /functionName\s*:\s*['"`]proposeRemoval['"`]/.test(readFileSync(f, 'utf8')));
    expect(hasReplacement).toBe(true);
  });
});
