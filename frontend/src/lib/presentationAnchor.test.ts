/**
 * presentationAnchor.test.ts — единственное чтение цепи про отпечатки, и обе
 * его стороны (Задача 7).
 *
 * ⚠️ КОНТЕЙНЕР ЗДЕСЬ ПОДДЕЛЬНЫЙ, И ЭТО ОСОЗНАННО. Настоящие контейнеры со
 * всей криптографией живут в `arbiterPresentations.test.ts` — там и стоят оба
 * замка на сверку байтов (F1/F2). Здесь предмет другой: что именно спрашивается
 * у цепи, сколько это стоит запросов, и что видит человек на ПЕРЕЗАГРУЖЕННОЙ
 * вкладке. Собирать ради этого настоящее предъявление значило бы платить
 * секунды за то, что к предмету не относится.
 *
 * ⚠️ УЗЕЛ ПОДДЕЛЬНЫЙ, НО СЧИТАЮЩИЙ. Каждый стенд считает обращения — числа в
 * утверждениях это счётчик, а не описание.
 */
import { describe, it, expect } from 'vitest';
import { keccak256, type Hex, type PublicClient } from 'viem';
import { canonicalPresentationBytes, type PresentationContainer } from '@/lib/presentation';
import type { PresentationDraft } from '@/lib/presentationDraft';
import type { AnchorState } from '@/lib/presentToArbiter';
import {
  ANCHOR_DIGEST_MAX_PAGES, ANCHOR_DIGEST_PAGE, ANCHOR_EVENTS,
  ANCHOR_LOG_CHUNK_BLOCKS, ANCHOR_LOG_WINDOW_BLOCKS,
  anchorFromChain, anchorOrder, keepKnownAnchor, readChainAnchors, restoreAnchorImpl,
  sameDigest, verifyDigest,
} from '@/lib/presentationAnchor';

const DEAL = '0x2e7a7a0515bfdc0006a812ebb3e55d32800bc660' as `0x${string}`;
const OTHER_DEAL = '0x760f07367888c62f7c2dfb619a5e534132855ce5' as `0x${string}`;
const ALICE = '0x268dcfa7ab0dc134d01c5cbcaa7d2834d6dd0f0f' as `0x${string}`;
const REX = '0x4c3e4afd5707aee625f01b0042d8da9dd1ac689c' as `0x${string}`;

/** Пустой, но ПОЛНОФОРМЕННЫЙ контейнер: `canonicalPresentationBytes` читает
 *  каждое из этих полей, и без любого из них он бросит. */
function containerOf(issuedAt: number): PresentationContainer {
  return {
    kind: 'hexseal.presentation.v1',
    dealId: DEAL,
    presenter: ALICE,
    issuedAt,
    attestations: [],
    chains: [],
    frames: [],
    keys: [],
    counts: { read: 0, hidden: 0, notPrepared: 0 },
    notPrepared: [],
    signature: 'нет-и-не-нужна',
  } as unknown as PresentationContainer;
}

const digestOf = (c: PresentationContainer): Hex => keccak256(canonicalPresentationBytes(c));

const draftOf = (c: PresentationContainer, over: Partial<PresentationDraft> = {}): PresentationDraft => ({
  dealId: DEAL, presenter: ALICE, issuedAt: c.issuedAt, messageCount: 0, wireBytes: 100,
  state: 'sent', sentAt: 1_760_000_000_000, bagKey: `${DEAL}/a.bin`, container: c, ...over,
});

interface FakeLog {
  eventName: string;
  blockNumber: bigint;
  transactionHash?: Hex;
  args: Record<string, unknown>;
}

interface Node {
  client: PublicClient;
  calls: { pages: number; head: number; logs: number };
  ranges: { fromBlock: bigint; toBlock: bigint }[];
}

/**
 * Узел: отвечает страницами геттера и логами из окна.
 * `logsFail` — лента отказывает (узел жив, `eth_getLogs` нет).
 */
function node(opts: {
  digests?: Hex[]; logs?: FakeLog[]; head?: bigint; logsFail?: boolean;
}): Node {
  const digests = opts.digests ?? [];
  const logs = opts.logs ?? [];
  const head = opts.head ?? BigInt(44_700_000);
  const n: Node = { calls: { pages: 0, head: 0, logs: 0 }, ranges: [], client: null as unknown as PublicClient };
  n.client = {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName !== 'getPresentationDigestsPage') throw new Error(`лишний вызов: ${functionName}`);
      n.calls.pages++;
      const offset = Number(args[1]); const limit = Number(args[2]);
      return digests.slice(offset, offset + limit);
    },
    getBlockNumber: async () => { n.calls.head++; return head; },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      n.calls.logs++;
      n.ranges.push({ fromBlock, toBlock });
      if (opts.logsFail) throw new Error('eth_getLogs: диапазон отклонён');
      return logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  } as unknown as PublicClient;
  return n;
}

const digestLog = (digest: Hex, block: bigint, over: Partial<FakeLog> = {}): FakeLog => ({
  eventName: 'PresentationDigestRecorded',
  blockNumber: block,
  transactionHash: `0x${'ab'.repeat(32)}` as Hex,
  args: { agreement: DEAL, submitter: ALICE, digest, index: BigInt(0) },
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Что спрашивается у цепи и почём
// ═══════════════════════════════════════════════════════════════════════════

describe('чтение цепи про отпечатки', () => {
  it('G0: оба события НАЙДЕНЫ в ABI — иначе фильтр не поймает ничего и молча', () => {
    // ⚠️ ЗАМОК НА ШОВ, А НЕ НА ОБЪЯВЛЕНИЕ. Что подпись события совпадает с
    // исходником фасета (включая `indexed`), сторожит `presentationDigestAbi`
    // (Задача 5). Здесь другое: что ЭТОТ модуль их оттуда достал. Переименуют
    // событие в ABI — фильтр `getLogs` останется пустым, номера блока не
    // появится ни у чего, и ни один вердикт при этом не покраснеет: «сходится»
    // считается по геттеру и продолжит работать.
    expect(ANCHOR_EVENTS.length, 'фильтр ленты собран из пустого набора').toBe(2);
    expect(ANCHOR_EVENTS.map(e => (e as { name: string }).name).sort())
      .toEqual(['DisputeNoResponseRecorded', 'PresentationDigestRecorded']);
  });

  it('G1: отпечатков по сделке нет — ЛЕНТА НЕ СПРАШИВАЕТСЯ ВОВСЕ', async () => {
    const n = node({ digests: [] });
    const a = await readChainAnchors(n.client, DEAL);
    expect(a.digests).toEqual([]);
    expect(a.digestsComplete).toBe(true);
    // Двенадцать запросов `eth_getLogs` ради пустого ответа платил бы каждый,
    // кто открыл ящик по обычной сделке.
    expect(n.calls.logs, 'лента спрошена там, где упорядочивать нечего').toBe(0);
    expect(n.calls.head).toBe(0);
    expect(n.calls.pages).toBe(1);
  });

  it('G2: список берётся страницами — до короткой страницы, а не «всё разом»', async () => {
    const many = Array.from({ length: ANCHOR_DIGEST_PAGE + 7 },
      (_, i) => keccak256(new Uint8Array([i, 1])));
    const n = node({ digests: many, logs: [] });
    const a = await readChainAnchors(n.client, DEAL);
    expect(a.digests.length).toBe(ANCHOR_DIGEST_PAGE + 7);
    expect(a.digestsComplete).toBe(true);
    expect(n.calls.pages, 'полный геттер вернулся бы одним вызовом и упёрся бы в газ').toBe(2);
  });

  it('G3: ЗАМЕР — окно ленты режется на куски, и куски накрывают его целиком', async () => {
    const d = digestOf(containerOf(1));
    const head = BigInt(44_700_000);
    const n = node({ digests: [d], logs: [digestLog(d, head - BigInt(5))], head });
    const a = await readChainAnchors(n.client, DEAL);
    const expectedChunks = Number(ANCHOR_LOG_WINDOW_BLOCKS / ANCHOR_LOG_CHUNK_BLOCKS);
    expect(n.calls.logs, `запросов на окно: ${n.calls.logs}`).toBe(expectedChunks);
    expect(a.window!.toBlock).toBe(head);
    // Ни одного пропуска между кусками: дыра проглотила бы отпечаток молча.
    const sorted = [...n.ranges].sort((x, y) => (x.fromBlock < y.fromBlock ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].fromBlock, 'между кусками окна дыра').toBe(sorted[i - 1].toBlock + BigInt(1));
    }
    expect(a.records.length).toBe(1);
    expect(a.logsComplete).toBe(true);
  });

  it('G4: событие ЧУЖОЙ сделки отброшено — иначе спор бы решался чужим порядком', async () => {
    const d = digestOf(containerOf(1));
    const head = BigInt(44_700_000);
    const n = node({
      digests: [d], head,
      logs: [
        digestLog(d, head - BigInt(3), { args: { agreement: OTHER_DEAL, submitter: ALICE, digest: d, index: BigInt(0) } }),
        { eventName: 'DisputeNoResponseRecorded', blockNumber: head - BigInt(9), args: { agreement: DEAL, arbiter: REX, at: BigInt(1_760_000_000) } },
        { eventName: 'DisputeNoResponseRecorded', blockNumber: head - BigInt(8), args: { agreement: OTHER_DEAL, arbiter: REX, at: BigInt(1_760_000_000) } },
      ],
    });
    const a = await readChainAnchors(n.client, DEAL);
    expect(a.records.length, 'чужое событие уехало в порядок этой сделки').toBe(0);
    expect(a.noResponse.length).toBe(1);
    expect(a.noResponse[0].block).toBe(head - BigInt(9));
    // Отпечаток геттер назвал, а лента до него не дотянулась — это НЕ «нет отметки».
    expect(a.digests).toEqual([d]);
    expect(a.logsComplete).toBe(false);
  });

  it('G5: лента отказала — вердикт УЦЕЛЕЛ, потерялся только номер блока', async () => {
    const d = digestOf(containerOf(1));
    const n = node({ digests: [d], logsFail: true });
    const a = await readChainAnchors(n.client, DEAL, { onLogFailure: () => {} });
    expect(a.digests, 'отказ ленты утащил за собой ответ геттера').toEqual([d]);
    expect(a.digestsComplete).toBe(true);
    expect(a.records).toEqual([]);
    expect(a.logsComplete).toBe(false);
  });

  it('G6: геттер отказал — БРОСАЕТ. «Не знаем» решает вызывающий, а не мы за него', async () => {
    const broken = {
      readContract: async () => { throw new Error('узел не ответил'); },
      getBlockNumber: async () => BigInt(1),
      getLogs: async () => [],
    } as unknown as PublicClient;
    await expect(readChainAnchors(broken, DEAL)).rejects.toThrow();
  });

  it('G7: окно можно сузить — и тогда это ОДИН запрос', async () => {
    const d = digestOf(containerOf(1));
    const head = BigInt(44_700_000);
    const n = node({ digests: [d], logs: [digestLog(d, head)], head });
    await readChainAnchors(n.client, DEAL, {
      windowBlocks: BigInt(100), chunkBlocks: BigInt(100),
    });
    expect(n.calls.logs).toBe(1);
    expect(n.ranges[0].toBlock).toBe(head);
  });

  it('G9: ЖИВАЯ ПРОБА — свежий отпечаток, СТАРАЯ запись арбитра (ревью, круг 2)', async () => {
    // ⚠️ ТА САМАЯ СЦЕНА, КОТОРОЙ РЕВЬЮЕР ПОЙМАЛ ЛОЖЬ, И ОНА НЕ УГОЛ: сторона
    // предъявила недавно, арбитр просил давно — самая обычная форма спора к
    // моменту разбора. Отпечаток внутри окна, запись арбитра трое суток назад,
    // снаружи. ВСЕ отпечатки при этом накрыты, и прежний признак
    // (`logsComplete`) объявлял «записи о молчании нет» — при правде
    // `record_first`.
    const c = containerOf(1);
    const d = digestOf(c);
    const head = BigInt(44_700_000);
    const n = node({
      digests: [d], head,
      logs: [
        digestLog(d, head - BigInt(20_000)),
        // Трое суток назад: в окно 43 200 не попадает и в ленте не найдётся.
        {
          eventName: 'DisputeNoResponseRecorded', blockNumber: head - BigInt(130_000),
          args: { agreement: DEAL, arbiter: REX, at: BigInt(1_759_000_000) },
        },
      ],
    });
    const a = await readChainAnchors(n.client, DEAL);

    expect(a.logsComplete, 'все отпечатки накрыты — и это ни о чём не говорит').toBe(true);
    expect(a.noResponse, 'запись арбитра в окно не попала').toEqual([]);
    expect(a.windowCoversDispute, 'покрытие начала спора доказано неоткуда').toBe(false);

    const { bagAnchor: bag } = await import('@/lib/presentationAnchor');
    const anchor = bag(d, a);
    expect(anchor.verdict).toBe('match');
    expect(anchorOrder(anchor, a),
      'экран сказал бы «записи нет», а правда — запись легла РАНЬШЕ').toBe('out_of_window');
  });

  it('G10: окно упёрлось в начало цепи — вот тогда «записи нет» это знание', async () => {
    const c = containerOf(1);
    const d = digestOf(c);
    // Голова ближе к нулю, чем ширина окна: раньше ничего быть не может.
    const head = BigInt(500);
    const n = node({ digests: [d], head, logs: [digestLog(d, BigInt(400))] });
    const a = await readChainAnchors(n.client, DEAL, {
      windowBlocks: BigInt(1_000), chunkBlocks: BigInt(1_000),
    });
    expect(a.windowCoversDispute).toBe(true);
    const { bagAnchor: bag } = await import('@/lib/presentationAnchor');
    expect(anchorOrder(bag(d, a), a)).toBe('no_record');
  });

  it('G11: ЗАМЕР — сторона открывает чат по СПОРНОЙ сделке: ленты НОЛЬ, геттер на месте', async () => {
    // ⚠️ ВОЛНА ПРАВОК ОБЩЕГО РЕВЬЮ, ПРАВКА 2. Сцена ровно та, что стоила
    // дороже всего: спор идёт, отпечаток по сделке ЕСТЬ (значит G1 «ленту не
    // спрашиваем, когда отпечатков нет» здесь не спасает), человек открывает
    // чат. Прежде это стоило двенадцать параллельных `eth_getLogs` — 43 200
    // блоков кусками по 3 600, — и покупало стороне только `txHash`, который
    // `PresentAnchorLine` не рисует нигде.
    const c = containerOf(1);
    const d = digestOf(c);
    const head = BigInt(44_700_000);
    const n = node({ digests: [d], logs: [digestLog(d, head - BigInt(5))], head });

    const a = await readChainAnchors(n.client, DEAL, { withLog: false });

    expect(n.calls.logs, 'лента спрошена там, где номера блока никто не рисует').toBe(0);
    expect(n.calls.head, 'голову цепи спросили — значит ленту всё-таки готовили').toBe(0);
    expect(n.calls.pages, 'геттер не спрошен — вердикт считать нечем').toBe(1);

    // И ВЕРДИКТ ПРИ ЭТОМ ЦЕЛ: ради него всё и читается.
    const { bagAnchor: bag } = await import('@/lib/presentationAnchor');
    expect(bag(d, a).verdict, 'отметка есть в цепи, а сторона её не видит').toBe('match');
    expect(anchorFromChain(d, a)).toEqual({ kind: 'anchored', txHash: null });
  });

  it('G12: без ленты «не отмечено» и «не знаем» ПО-ПРЕЖНЕМУ разные (Задача 7)', async () => {
    // ⚠️ ГЛАВНОЕ СОМНЕНИЕ ПРАВКИ 2, И ОНО ЗАКРЫВАЕТСЯ ЗАМЕРОМ, А НЕ РАССУЖДЕНИЕМ.
    // Честное различение считается по ГЕТТЕРУ (`anchorBy`), лента в вердикт не
    // входит ни одной веткой — значит обязано пережить `withLog: false`.
    const c = containerOf(1);
    const d = digestOf(c);

    // «не отмечено»: геттер ответил, и в ответе пусто → строка и кнопка есть.
    const пусто = node({ digests: [] });
    expect(anchorFromChain(d, await readChainAnchors(пусто.client, DEAL, { withLog: false })))
      .toEqual({ kind: 'missing', digest: d });

    // «не сходится»: отпечатки есть, но чужие — тоже знание, тоже кнопка.
    const чужой = node({ digests: [keccak256(new Uint8Array([9, 9]))] });
    expect(anchorFromChain(d, await readChainAnchors(чужой.client, DEAL, { withLog: false })).kind)
      .toBe('missing');

    // «не знаем»: список УПЁРСЯ В ПОТОЛОК страниц → молчим, кнопки нет.
    const много = Array.from({ length: ANCHOR_DIGEST_PAGE * ANCHOR_DIGEST_MAX_PAGES },
      (_, i) => keccak256(new Uint8Array([i & 0xff, (i >> 8) & 0xff, 7])));
    const неполный = node({ digests: много });
    const a = await readChainAnchors(неполный.client, DEAL, { withLog: false });
    expect(a.digestsComplete, 'список полон — сцена «не знаем» не поставлена').toBe(false);
    expect(anchorFromChain(d, a), '«не знаем» превратилось в «не отмечено» — это обвинение стороны')
      .toEqual({ kind: 'none' });

    // «цепь молчит»: геттер БРОСАЕТ и без ленты — решает вызывающий (G6).
    const мёртвый = {
      readContract: async () => { throw new Error('узел не ответил'); },
      getBlockNumber: async () => BigInt(1),
      getLogs: async () => [],
    } as unknown as PublicClient;
    await expect(readChainAnchors(мёртвый, DEAL, { withLog: false })).rejects.toThrow();
  });

  it('G13: у АРБИТРА лента по-прежнему спрашивается — умолчание не перевернули', async () => {
    // Обратная сторона G11, и без неё правка «не спрашивать ленту» могла бы
    // молча уехать в умолчание: вердикт арбитра остался бы зелёным (он из
    // геттера), а порядок — то, ради чего всё затевалось, — пропал бы совсем.
    const d = digestOf(containerOf(1));
    const head = BigInt(44_700_000);
    const n = node({ digests: [d], logs: [digestLog(d, head - BigInt(5))], head });

    await readChainAnchors(n.client, DEAL);        // как зовёт арбитр — без опций
    expect(n.calls.logs).toBe(Number(ANCHOR_LOG_WINDOW_BLOCKS / ANCHOR_LOG_CHUNK_BLOCKS));

    // И `withLog: true` явным словом — то же самое, а не третье поведение.
    const m = node({ digests: [d], logs: [digestLog(d, head - BigInt(5))], head });
    await readChainAnchors(m.client, DEAL, { withLog: true });
    expect(m.calls.logs).toBe(n.calls.logs);
  });

  it('G8: сверка отпечатков не смотрит на регистр, но смотрит на длину', () => {
    const d = digestOf(containerOf(1));
    expect(sameDigest(d, d.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(sameDigest(d, d.slice(0, 40))).toBe(false);
    expect(sameDigest(d, null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Сторона, вернувшаяся на ПЕРЕЗАГРУЖЕННУЮ вкладку
//
// Замер приёмки из поправки координатора: положить мешок, не отметить в цепи,
// перезагрузить — интерфейс обязан сказать «не отмечено», а не «предъявлено» и
// не «ничего нет».
// ═══════════════════════════════════════════════════════════════════════════

describe('«отмечено ли» переживает перезагрузку вкладки', () => {
  const runRestore = async (io: {
    drafts: PresentationDraft[]; anchors: Parameters<typeof anchorFromChain>[1] | 'throw';
    alive?: boolean;
  }): Promise<AnchorState> => {
    let state: AnchorState = { kind: 'none' };
    await restoreAnchorImpl({
      presenter: ALICE, agreement: DEAL,
      alive: () => io.alive !== false,
      applyAnchor: (fn) => { state = fn(state); },
      readDrafts: async () => io.drafts,
      readAnchors: async () => {
        if (io.anchors === 'throw' || io.anchors === null) throw new Error('узел не ответил');
        return io.anchors;
      },
    });
    return state;
  };

  const anchors = (digests: Hex[], records: { digest: Hex; block: bigint; txHash?: Hex }[] = []) => ({
    digests, digestsComplete: true, logsComplete: true, window: null,
    windowCoversDispute: false, noResponse: [],
    records: records.map(r => ({
      digest: r.digest, submitter: ALICE, index: BigInt(0), block: r.block,
      txHash: r.txHash ?? null,
    })),
  });

  it('H1: ЗАМЕР ПРИЁМКИ — мешок положен, в цепи НЕ отмечен, вкладку перезагрузили', async () => {
    const c = containerOf(1_760_000_000_000);
    const state = await runRestore({ drafts: [draftOf(c)], anchors: anchors([]) });
    expect(state.kind, 'человек вернулся и не узнал, что страховки нет').toBe('missing');
    expect(state.kind === 'missing' && state.digest).toBe(digestOf(c));
  });

  it('H2: отмечен — «отмечено», и номер транзакции взят из ленты', async () => {
    const c = containerOf(1_760_000_000_000);
    const tx = `0x${'cd'.repeat(32)}` as Hex;
    const state = await runRestore({
      drafts: [draftOf(c)],
      anchors: anchors([digestOf(c)], [{ digest: digestOf(c), block: BigInt(44_700_000), txHash: tx }]),
    });
    expect(state).toEqual({ kind: 'anchored', txHash: tx });
  });

  it('H2b: отмечен, но лента не дотянулась — всё равно «отмечено», просто без номера', () => {
    const c = containerOf(1);
    expect(anchorFromChain(digestOf(c), anchors([digestOf(c)])))
      .toEqual({ kind: 'anchored', txHash: null });
  });

  it('H3: собранный, но НЕ отправленный черновик — молчим', async () => {
    const c = containerOf(1_760_000_000_000);
    const state = await runRestore({
      drafts: [draftOf(c, { state: 'built', sentAt: undefined, bagKey: undefined })],
      anchors: anchors([]),
    });
    // Мешок у арбитра не лежит — «в цепи не отмечено» пугало бы человека тем,
    // чего он не отправлял.
    expect(state.kind).toBe('none');
  });

  it('H4: цепь молчит — «не отмечено» НЕ говорим', async () => {
    const c = containerOf(1_760_000_000_000);
    const state = await runRestore({ drafts: [draftOf(c)], anchors: 'throw' });
    expect(state.kind, 'молчание узла погнало человека платить за вторую отметку').toBe('none');
  });

  it('H5: черновик ДРУГОЙ сделки не отвечает за эту', async () => {
    const c = containerOf(1_760_000_000_000);
    const state = await runRestore({
      drafts: [draftOf(c, { dealId: OTHER_DEAL })], anchors: anchors([]),
    });
    expect(state.kind).toBe('none');
  });

  it('H6: вкладку закрыли, пока ходили в цепь — ничего не применяем', async () => {
    const c = containerOf(1_760_000_000_000);
    const state = await runRestore({ drafts: [draftOf(c)], anchors: anchors([]), alive: false });
    expect(state.kind).toBe('none');
  });

  it('H7: восстановленное НЕ затирает известное — свежая отправка старше по знанию', () => {
    const fresh: AnchorState = { kind: 'missing', digest: `0x${'11'.repeat(32)}` as Hex };
    expect(keepKnownAnchor(fresh, { kind: 'anchored', txHash: null })).toBe(fresh);
    expect(keepKnownAnchor({ kind: 'none' }, fresh)).toBe(fresh);
  });

  it('H8: контейнер, у которого канонический вид не считается, ни с чем не сходится', () => {
    const broken = { ...containerOf(1), issuedAt: 1.5 } as unknown as PresentationContainer;
    expect(verifyDigest(broken, `0x${'00'.repeat(32)}` as Hex)).toBe(false);
  });
});
