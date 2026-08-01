import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetSubgraphSyncState,
  invalidateSubgraphCache,
  readSubgraphHead,
  refreshAfterBlock,
  refreshAfterTx,
  waitForSubgraphBlock,
} from './subgraphSync';
import {
  CHAIN_REFRESH_EVENT,
  GRAPH_REFRESH_EVENT,
  subscribeRefresh,
  type RefreshTopic,
} from './dataRefresh';

type Call = { url: string };

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

/** Прокси-стаб: голову отдаёт по очереди из списка, сброс кэша всегда ok. */
function makeFetch(heads: (number | null)[], opts: { invalidateOk?: boolean } = {}) {
  const calls: Call[] = [];
  let i = 0;
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes('meta=1')) {
      const head = heads[Math.min(i++, heads.length - 1)];
      return jsonResponse({ block: head });
    }
    if (url.includes('invalidate=1')) {
      return jsonResponse({ ok: true }, opts.invalidateOk ?? true);
    }
    return jsonResponse({}, false);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const noSleep = () => Promise.resolve();

/** Часы, которые двигаются сами: каждое обращение — +1000 мс. */
function tickingClock(step = 1_000) {
  let t = 0;
  return () => (t += step) - step;
}

function withWindow(): EventTarget {
  const target = new EventTarget();
  (globalThis as unknown as { window: EventTarget }).window = target;
  return target;
}
function withoutWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

beforeEach(() => {
  __resetSubgraphSyncState();
  withoutWindow();
});
afterEach(() => {
  __resetSubgraphSyncState();
  withoutWindow();
});

describe('readSubgraphHead', () => {
  it('возвращает номер проиндексированного блока', async () => {
    const { impl, calls } = makeFetch([44_613_049]);
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBe(44_613_049);
    expect(calls[0].url).toContain('/api/subgraph?meta=1');
  });

  it('null на неуспешном ответе', async () => {
    const impl = (async () => jsonResponse({}, false)) as unknown as typeof fetch;
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBeNull();
  });

  it('null когда прокси не смог узнать голову', async () => {
    const { impl } = makeFetch([null]);
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBeNull();
  });

  it('null когда сеть упала — наружу не бросает', async () => {
    const impl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBeNull();
  });

  it('одновременные пробы делят один запрос', async () => {
    const { impl, calls } = makeFetch([100]);
    const [a, b, c] = await Promise.all([
      readSubgraphHead({ fetchImpl: impl }),
      readSubgraphHead({ fetchImpl: impl }),
      readSubgraphHead({ fetchImpl: impl }),
    ]);
    expect([a, b, c]).toEqual([100, 100, 100]);
    expect(calls.filter((c) => c.url.includes('meta=1'))).toHaveLength(1);
  });

  it('последовательные пробы запрашивают заново (флаг снимается до возврата)', async () => {
    const { impl, calls } = makeFetch([100, 101]);
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBe(100);
    await expect(readSubgraphHead({ fetchImpl: impl })).resolves.toBe(101);
    expect(calls.filter((c) => c.url.includes('meta=1'))).toHaveLength(2);
  });
});

describe('waitForSubgraphBlock', () => {
  it('true сразу, если сабграф уже впереди', async () => {
    const { impl, calls } = makeFetch([200]);
    await expect(
      waitForSubgraphBlock(198, { fetchImpl: impl, sleep: noSleep, now: () => 0 }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('true при точном совпадении номера блока', async () => {
    const { impl } = makeFetch([200]);
    await expect(
      waitForSubgraphBlock(200, { fetchImpl: impl, sleep: noSleep, now: () => 0 }),
    ).resolves.toBe(true);
  });

  it('опрашивает, пока сабграф не догонит', async () => {
    // Замеренное отставание — 1-3 блока; здесь ровно такое.
    const { impl, calls } = makeFetch([198, 199, 200]);
    const sleep = vi.fn(noSleep);
    await expect(
      waitForSubgraphBlock(200, { fetchImpl: impl, sleep, now: () => 0 }),
    ).resolves.toBe(true);
    expect(calls.filter((c) => c.url.includes('meta=1'))).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('false когда вышло время ожидания', async () => {
    const { impl } = makeFetch([100]);
    await expect(
      waitForSubgraphBlock(200, {
        fetchImpl: impl,
        sleep: noSleep,
        now: tickingClock(),
        timeoutMs: 3_000,
      }),
    ).resolves.toBe(false);
  });

  it('false когда голову узнать не удаётся вовсе', async () => {
    const { impl } = makeFetch([null]);
    await expect(
      waitForSubgraphBlock(200, {
        fetchImpl: impl,
        sleep: noSleep,
        now: tickingClock(),
        timeoutMs: 2_000,
      }),
    ).resolves.toBe(false);
  });

  it('false на бессмысленной цели, не потратив ни одного запроса', async () => {
    const { impl, calls } = makeFetch([200]);
    await expect(waitForSubgraphBlock(0, { fetchImpl: impl })).resolves.toBe(false);
    await expect(waitForSubgraphBlock(NaN, { fetchImpl: impl })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('принимает bigint (номер блока из квитанции — именно он)', async () => {
    const { impl } = makeFetch([200]);
    await expect(
      waitForSubgraphBlock(199n, { fetchImpl: impl, sleep: noSleep, now: () => 0 }),
    ).resolves.toBe(true);
  });
});

describe('invalidateSubgraphCache', () => {
  it('шлёт POST на ?invalidate=1', async () => {
    const { impl, calls } = makeFetch([]);
    await expect(invalidateSubgraphCache({ fetchImpl: impl })).resolves.toBe(true);
    expect(calls[0].url).toContain('/api/subgraph?invalidate=1');
  });

  it('не бросает, если прокси недоступен', async () => {
    const impl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(invalidateSubgraphCache({ fetchImpl: impl })).resolves.toBe(false);
  });
});

describe('refreshAfterBlock', () => {
  it('цепные темы уходят сразу, до всякого ожидания индексации', async () => {
    withWindow();
    const order: string[] = [];
    const offChain = subscribeRefresh(CHAIN_REFRESH_EVENT, () => order.push('chain'));
    const offGraph = subscribeRefresh(GRAPH_REFRESH_EVENT, () => order.push('graph'));
    const { impl } = makeFetch([198, 199, 200]);

    await refreshAfterBlock(200, { chain: ['deals'], graph: ['deals'] }, {
      fetchImpl: impl, sleep: () => { order.push('poll'); return Promise.resolve(); }, now: () => 0,
    });

    offChain();
    offGraph();
    expect(order[0]).toBe('chain');
    expect(order[order.length - 1]).toBe('graph');
    expect(order).toContain('poll');
  });

  it('сбрасывает кэш прокси ПОСЛЕ того, как сабграф догнал', async () => {
    withWindow();
    const { impl, calls } = makeFetch([198, 200]);
    await refreshAfterBlock(200, { graph: ['jobs'] }, {
      fetchImpl: impl, sleep: noSleep, now: () => 0,
    });
    const kinds = calls.map((c) => (c.url.includes('meta=1') ? 'meta' : 'invalidate'));
    expect(kinds).toEqual(['meta', 'meta', 'invalidate']);
  });

  it('без графовых тем в сабграф не ходит вовсе', async () => {
    withWindow();
    const { impl, calls } = makeFetch([200]);
    const seen: RefreshTopic[][] = [];
    const off = subscribeRefresh(CHAIN_REFRESH_EVENT, (t) => seen.push(t));
    await refreshAfterBlock(200, { chain: ['arbiter'] }, { fetchImpl: impl });
    off();
    expect(seen).toEqual([['arbiter']]);
    expect(calls).toHaveLength(0);
  });

  it('графовые темы уходят даже если индексации не дождались', async () => {
    // Иначе человек остаётся наедине с записью, которой гарантированно до
    // 120 секунд; подписчики читают с x-fresh и возьмут самое свежее, что есть.
    withWindow();
    const graph = vi.fn();
    const off = subscribeRefresh(GRAPH_REFRESH_EVENT, graph);
    const { impl } = makeFetch([100]);
    await refreshAfterBlock(200, { graph: ['deals'] }, {
      fetchImpl: impl, sleep: noSleep, now: tickingClock(), timeoutMs: 2_000,
    });
    off();
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('без номера блока обновляется вслепую, но обновляется', async () => {
    withWindow();
    const graph = vi.fn();
    const off = subscribeRefresh(GRAPH_REFRESH_EVENT, graph);
    const { impl, calls } = makeFetch([]);
    await refreshAfterBlock(undefined, { graph: ['services'] }, { fetchImpl: impl });
    off();
    expect(calls.map((c) => c.url.includes('invalidate=1'))).toEqual([true]);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('пустые темы — полный no-op', async () => {
    withWindow();
    const { impl, calls } = makeFetch([200]);
    await refreshAfterBlock(200, {}, { fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });
});

describe('refreshAfterTx', () => {
  const RECEIPT_TX = '0xdeadbeef' as const;

  it('ждёт квитанцию и берёт номер блока из неё', async () => {
    withWindow();
    const client = {
      waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 200n })),
    };
    const { impl, calls } = makeFetch([200]);
    await refreshAfterTx(client, RECEIPT_TX, { graph: ['deals'] }, {
      fetchImpl: impl, sleep: noSleep, now: () => 0,
    });
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: RECEIPT_TX }),
    );
    expect(calls.map((c) => c.url.includes('meta=1'))).toEqual([true, false]);
  });

  it('квитанция не пришла — всё равно обновляет, только без ожидания', async () => {
    withWindow();
    const client = {
      waitForTransactionReceipt: vi.fn(async () => { throw new Error('timeout'); }),
    };
    const graph = vi.fn();
    const off = subscribeRefresh(GRAPH_REFRESH_EVENT, graph);
    const { impl, calls } = makeFetch([]);
    await refreshAfterTx(client, RECEIPT_TX, { graph: ['deals'] }, { fetchImpl: impl });
    off();
    expect(calls.every((c) => c.url.includes('invalidate=1'))).toBe(true);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('без клиента или без хэша — не падает', async () => {
    withWindow();
    const { impl } = makeFetch([]);
    await expect(
      refreshAfterTx(null, RECEIPT_TX, { chain: ['jobs'] }, { fetchImpl: impl }),
    ).resolves.toBeUndefined();
    await expect(
      refreshAfterTx({ waitForTransactionReceipt: vi.fn() }, undefined, { chain: ['jobs'] }, { fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });
});
