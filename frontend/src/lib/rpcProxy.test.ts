import { describe, expect, it } from 'vitest';
import {
  PRIVATE_RETRY_MAX_ELAPSED_MS,
  classifyFetchFailure,
  describeRpcCall,
  formatAttempts,
  rpcHostLabel,
  shouldRetryPrivate,
  type RpcAttempt,
} from './rpcProxy';

describe('rpcHostLabel', () => {
  it('оставляет только хост', () => {
    expect(rpcHostLabel('https://lb.drpc.live/ogrpc?network=base-sepolia&dkey=SECRET')).toBe('lb.drpc.live');
  });

  it('НЕ пропускает ключ из query — главное правило файла', () => {
    const label = rpcHostLabel('https://lb.drpc.live/ogrpc?dkey=Ab3-SECRET-Xy');
    expect(label).not.toContain('SECRET');
    expect(label).not.toContain('dkey');
  });

  it('НЕ пропускает ключ из пути', () => {
    const label = rpcHostLabel('https://base-sepolia.g.alchemy.com/v2/SECRET-KEY-123');
    expect(label).toBe('base-sepolia.g.alchemy.com');
    expect(label).not.toContain('SECRET');
  });

  it('НЕ пропускает basic-auth', () => {
    const label = rpcHostLabel('https://user:SECRETPASS@node.example.com/rpc');
    expect(label).toBe('node.example.com');
    expect(label).not.toContain('SECRETPASS');
  });

  it('на неразобравшуюся строку не отдаёт её саму', () => {
    const label = rpcHostLabel('этоневообщеurl?dkey=SECRET');
    expect(label).toBe('<не-URL>');
    expect(label).not.toContain('SECRET');
  });
});

describe('classifyFetchFailure', () => {
  it('AbortSignal.timeout → таймаут', () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const out = classifyFetchFailure(err);
    expect(out.timeout).toBe(true);
    expect(out.message).toContain('TimeoutError');
  });

  it('старое имя AbortError тоже считается таймаутом', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyFetchFailure(err).timeout).toBe(true);
  });

  it('таймаут undici, спрятанный в cause, находится', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    const out = classifyFetchFailure(err);
    expect(out.timeout).toBe(true);
  });

  it('раскрывает `TypeError: fetch failed` до настоящей причины', () => {
    // Ровно эта пара и делала журнал бесполезным: верхушка одинакова у любого
    // сетевого сбоя, а различает их только cause.
    const cause = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
      code: 'ECONNREFUSED',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    const out = classifyFetchFailure(err);
    expect(out.timeout).toBe(false);
    expect(out.message).toContain('fetch failed');
    expect(out.message).toContain('ECONNREFUSED');
  });

  it('идёт по цепочке cause глубже одного звена', () => {
    const deep = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
    const mid = Object.assign(new Error('middle'), { cause: deep });
    const top = Object.assign(new TypeError('fetch failed'), { cause: mid });
    expect(classifyFetchFailure(top).message).toContain('EAI_AGAIN');
  });

  it('не зацикливается на самоссылающемся cause', () => {
    const err: { name: string; message: string; cause?: unknown } = {
      name: 'Error', message: 'loop',
    };
    err.cause = err;
    expect(classifyFetchFailure(err).message).toBeTruthy();
  });

  it('переживает брошенную не-ошибку', () => {
    expect(classifyFetchFailure('просто строка').message).toContain('просто строка');
    expect(classifyFetchFailure(null).message).toBe('неизвестный сбой fetch');
    expect(classifyFetchFailure(undefined).timeout).toBe(false);
  });
});

describe('shouldRetryPrivate', () => {
  it('быстрый сетевой сбой повторяем — ради него всё и написано', () => {
    expect(shouldRetryPrivate({ timeout: false }, 40)).toBe(true);
  });

  it('таймаут НЕ повторяем: бюджет нужен публичным запасным', () => {
    expect(shouldRetryPrivate({ timeout: true }, 6_000)).toBe(false);
    expect(shouldRetryPrivate({ timeout: true }, 10)).toBe(false);
  });

  it('5xx повторяем — «у узла временно плохо»', () => {
    expect(shouldRetryPrivate({ status: 500 }, 100)).toBe(true);
    expect(shouldRetryPrivate({ status: 502 }, 100)).toBe(true);
    expect(shouldRetryPrivate({ status: 503 }, 100)).toBe(true);
  });

  it('429 НЕ повторяем: повтор по превышенному лимиту — это шторм', () => {
    expect(shouldRetryPrivate({ status: 429 }, 100)).toBe(false);
  });

  it('ключ/квота/оплата НЕ повторяются: завтра будет то же самое', () => {
    for (const status of [400, 401, 402, 403, 404]) {
      expect(shouldRetryPrivate({ status }, 100)).toBe(false);
    }
  });

  it('медленный отказ не повторяется — иначе бюджет маршрута уедет за 20 с', () => {
    expect(shouldRetryPrivate({ status: 503 }, PRIVATE_RETRY_MAX_ELAPSED_MS)).toBe(false);
    expect(shouldRetryPrivate({ status: 503 }, PRIVATE_RETRY_MAX_ELAPSED_MS - 1)).toBe(true);
  });

  it('худший случай с повтором остаётся в прежнем бюджете 18 с', () => {
    const worst = PRIVATE_RETRY_MAX_ELAPSED_MS + 150 /* пауза */ + 3_000 /* повтор */ + 3 * 4_000;
    expect(worst).toBeLessThan(18_000);
  });
});

describe('describeRpcCall', () => {
  it('одиночный вызов — метод и id', () => {
    expect(describeRpcCall({ jsonrpc: '2.0', method: 'eth_call', id: 42 })).toBe('eth_call#42');
  });

  it('без id — только метод', () => {
    expect(describeRpcCall({ method: 'eth_blockNumber' })).toBe('eth_blockNumber');
  });

  it('пакет сворачивается в счётчики', () => {
    const out = describeRpcCall([
      { method: 'eth_call', id: 1 },
      { method: 'eth_call', id: 2 },
      { method: 'eth_getBalance', id: 3 },
    ]);
    expect(out).toContain('batch(3)');
    expect(out).toContain('eth_call ×2');
    expect(out).toContain('eth_getBalance');
  });

  it('НИКОГДА не тащит params в журнал', () => {
    const calldata = '0x' + 'ab'.repeat(200);
    const out = describeRpcCall({ method: 'eth_call', id: 1, params: [{ data: calldata }] });
    expect(out).not.toContain('ab');
    expect(out.length).toBeLessThan(40);
  });

  it('переживает мусор вместо тела', () => {
    expect(describeRpcCall(null)).toBe('<без метода>');
    expect(describeRpcCall({})).toBe('<без метода>');
    expect(describeRpcCall([])).toContain('batch(0)');
  });
});

describe('formatAttempts', () => {
  const attempts: RpcAttempt[] = [
    { target: 'private', outcome: 'timeout', error: 'TimeoutError', ms: 6001 },
    { target: 'https://sepolia.base.org', outcome: 'status', status: 429, ms: 120 },
    { target: 'https://x.publicnode.com', outcome: 'network', error: 'fetch failed ← ECONNRESET', ms: 30 },
  ];

  it('перечисляет ВСЕ попытки, а не последнюю', () => {
    const out = formatAttempts(attempts);
    expect(out).toContain('private');
    expect(out).toContain('sepolia.base.org');
    expect(out).toContain('publicnode.com');
    expect(out).toContain('HTTP 429');
    expect(out).toContain('таймаут');
    expect(out).toContain('ECONNRESET');
  });

  it('приватный узел подписан меткой, а не адресом', () => {
    expect(formatAttempts(attempts)).not.toContain('drpc');
    expect(formatAttempts(attempts)).not.toContain('dkey');
  });

  it('пустой список не превращается в пустую строку', () => {
    expect(formatAttempts([])).toBe('ни одного кандидата не настроено');
  });
});
