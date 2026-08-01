import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CHAIN_REFRESH_EVENT,
  GRAPH_REFRESH_EVENT,
  TOPIC_READS,
  collectFunctionNames,
  emitChainRefresh,
  emitGraphRefresh,
  matcherForTopics,
  queryKeyTouches,
  subscribeRefresh,
  type RefreshTopic,
} from './dataRefresh';

// Тесты идут в node-окружении (см. vitest.config.mjs), окна тут нет. Модуль
// намеренно рассчитан и на это: на сервере emit/subscribe — тихий no-op.
// Где нужна доставка, окно подставляется вручную самым тонким возможным
// стабом: EventTarget умеет ровно те три метода, которыми модуль пользуется.
function withWindow(): EventTarget {
  const target = new EventTarget();
  (globalThis as unknown as { window: EventTarget }).window = target;
  return target;
}
function withoutWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe('TOPIC_READS', () => {
  it('покрывает каждую тему непустым списком чтений', () => {
    for (const [topic, names] of Object.entries(TOPIC_READS)) {
      expect(names.length, topic).toBeGreaterThan(0);
    }
  });

  it('не содержит дублей внутри темы', () => {
    for (const [topic, names] of Object.entries(TOPIC_READS)) {
      expect(new Set(names).size, topic).toBe(names.length);
    }
  });
});

describe('matcherForTopics', () => {
  it('объединяет чтения нескольких тем', () => {
    const { reads } = matcherForTopics(['jobs', 'services']);
    expect(reads.has('getJob')).toBe(true);
    expect(reads.has('getService')).toBe(true);
  });

  it('на пустом наборе тем даёт пустой матчер', () => {
    const m = matcherForTopics([]);
    expect(m.reads.size).toBe(0);
    expect(m.roots.size).toBe(0);
  });

  it('игнорирует тему, которой нет в карте, а не падает', () => {
    const { reads } = matcherForTopics(['jobs', 'nonsense' as RefreshTopic]);
    expect(reads.has('getJob')).toBe(true);
  });

  it('пересекающиеся темы не дублируют имя (arbiter и deals делят getDisputeClaimer)', () => {
    expect(TOPIC_READS.deals).toContain('getDisputeClaimer');
    expect(TOPIC_READS.arbiter).toContain('getDisputeClaimer');
    const { reads } = matcherForTopics(['deals', 'arbiter']);
    expect([...reads].filter((n) => n === 'getDisputeClaimer')).toHaveLength(1);
  });

  it('тема кошелька даёт ещё и корень ключа — useBalance имени функции не кладёт', () => {
    const { roots } = matcherForTopics(['wallet']);
    expect(roots.has('balance')).toBe(true);
  });

  it('темы без корней их и не приносят', () => {
    expect(matcherForTopics(['jobs', 'deals']).roots.size).toBe(0);
  });
});

describe('collectFunctionNames', () => {
  it('достаёт имя из ключа useReadContract', () => {
    const key = ['readContract', { address: '0xd1a', functionName: 'getJob', args: [1n] }];
    expect([...collectFunctionNames(key)]).toEqual(['getJob']);
  });

  it('достаёт все имена из ключа useReadContracts', () => {
    const key = [
      'readContracts',
      {
        contracts: [
          { address: '0xd1a', functionName: 'getJob', args: [1n] },
          { address: '0xd1a', functionName: 'getApplicants', args: [1n] },
        ],
      },
    ];
    expect([...collectFunctionNames(key)].sort()).toEqual(['getApplicants', 'getJob']);
  });

  it('не спотыкается о bigint в аргументах (JSON.stringify тут бросил бы)', () => {
    const key = ['readContract', { functionName: 'getDetails', args: [2n ** 70n] }];
    expect(() => JSON.stringify(key)).toThrow();
    expect(collectFunctionNames(key).has('getDetails')).toBe(true);
  });

  it('переживает циклическую ссылку', () => {
    const inner: Record<string, unknown> = { functionName: 'getService' };
    inner.self = inner;
    expect(collectFunctionNames(['readContract', inner]).has('getService')).toBe(true);
  });

  it('игнорирует functionName нестрокового типа', () => {
    expect(collectFunctionNames(['readContract', { functionName: 42 }]).size).toBe(0);
  });

  it('на примитиве и null возвращает пустое множество', () => {
    expect(collectFunctionNames(null).size).toBe(0);
    expect(collectFunctionNames('getJob').size).toBe(0);
    expect(collectFunctionNames(undefined).size).toBe(0);
  });

  it('не уходит глубже разумного — вложенность за пределом не читается', () => {
    let deep: Record<string, unknown> = { functionName: 'getJob' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(collectFunctionNames(deep).size).toBe(0);
  });
});

describe('queryKeyTouches', () => {
  const jobs = matcherForTopics(['jobs']);

  it('да — когда ключ упоминает чтение темы', () => {
    expect(queryKeyTouches(['readContract', { functionName: 'getJob' }], jobs)).toBe(true);
  });

  it('нет — когда ключ про другую тему', () => {
    expect(queryKeyTouches(['readContract', { functionName: 'getDetails' }], jobs)).toBe(false);
  });

  it('нет — на пустом матчере (иначе инвалидировали бы всё подряд)', () => {
    const empty = matcherForTopics([]);
    expect(queryKeyTouches(['readContract', { functionName: 'getJob' }], empty)).toBe(false);
    expect(queryKeyTouches(['balance', { address: '0xabc' }], empty)).toBe(false);
  });

  it('ключ useBalance ловится корнем, а не именем функции', () => {
    const wallet = matcherForTopics(['wallet']);
    expect(queryKeyTouches(['balance', { address: '0xabc', token: '0x5dc0' }], wallet)).toBe(true);
    // Чужая тема этот же ключ не трогает.
    expect(queryKeyTouches(['balance', { address: '0xabc' }], jobs)).toBe(false);
  });

  it('корень сравнивается только с первым элементом, не с любым вхождением', () => {
    const wallet = matcherForTopics(['wallet']);
    expect(queryKeyTouches(['readContract', { scopeKey: 'balance' }], wallet)).toBe(false);
  });

  it('нет — для чужих ключей react-query (например xmtp/profile)', () => {
    expect(queryKeyTouches(['profile', { address: '0xabc' }], jobs)).toBe(false);
  });

  it('достаточно одного совпадения в мультизапросе', () => {
    const key = [
      'readContracts',
      { contracts: [{ functionName: 'balanceOf' }, { functionName: 'getJob' }] },
    ];
    expect(queryKeyTouches(key, jobs)).toBe(true);
  });
});

describe('emit / subscribe', () => {
  beforeEach(() => withoutWindow());
  afterEach(() => withoutWindow());

  it('без окна не падает и ничего не делает', () => {
    expect(() => emitChainRefresh(['deals'])).not.toThrow();
    expect(subscribeRefresh(CHAIN_REFRESH_EVENT, () => {})()).toBeUndefined();
  });

  it('доставляет темы подписчику своего канала', () => {
    withWindow();
    const seen: RefreshTopic[][] = [];
    const off = subscribeRefresh(CHAIN_REFRESH_EVENT, (t) => seen.push(t));
    emitChainRefresh(['deals', 'jobs']);
    off();
    expect(seen).toEqual([['deals', 'jobs']]);
  });

  it('каналы не смешиваются: graph не будит подписчика chain', () => {
    withWindow();
    const chain = vi.fn();
    const graph = vi.fn();
    const offChain = subscribeRefresh(CHAIN_REFRESH_EVENT, chain);
    const offGraph = subscribeRefresh(GRAPH_REFRESH_EVENT, graph);
    emitGraphRefresh(['deals']);
    offChain();
    offGraph();
    expect(chain).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('схлопывает повторы тем', () => {
    withWindow();
    const seen: RefreshTopic[][] = [];
    const off = subscribeRefresh(CHAIN_REFRESH_EVENT, (t) => seen.push(t));
    emitChainRefresh(['deals', 'deals', 'jobs', 'deals']);
    off();
    expect(seen).toEqual([['deals', 'jobs']]);
  });

  it('пустой список тем события не порождает', () => {
    withWindow();
    const handler = vi.fn();
    const off = subscribeRefresh(CHAIN_REFRESH_EVENT, handler);
    emitChainRefresh([]);
    off();
    expect(handler).not.toHaveBeenCalled();
  });

  it('отписка действительно отписывает', () => {
    withWindow();
    const handler = vi.fn();
    subscribeRefresh(CHAIN_REFRESH_EVENT, handler)();
    emitChainRefresh(['deals']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('событие без осмысленного detail подписчика не будит', () => {
    const target = withWindow();
    const handler = vi.fn();
    const off = subscribeRefresh(CHAIN_REFRESH_EVENT, handler);
    target.dispatchEvent(new CustomEvent(CHAIN_REFRESH_EVENT));
    target.dispatchEvent(new CustomEvent(CHAIN_REFRESH_EVENT, { detail: { topics: [] } }));
    off();
    expect(handler).not.toHaveBeenCalled();
  });
});
