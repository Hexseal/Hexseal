import { describe, expect, it } from 'vitest';
import {
  PRIVATE_RETRY_MAX_ELAPSED_MS,
  classifyFetchFailure,
  describeRpcCall,
  formatAttempts,
  rpcHostLabel,
  shouldRetryPrivate,
  type RpcAttempt,
  MAX_BATCH_SIZE,
  MAX_BODY_BYTES,
  batchLength,
  ALLOWED_RPC_METHODS,
  rpcMethods,
  disallowedMethods,
  RPC_RATE_WINDOW_MS,
  RPC_RATE_MAX,
  checkRpcRateLimit,
  requestSourceIp,
  parseAllowedOrigins,
  isOriginAllowed,
  bumpMethodCounts,
  formatMethodCounts,
  type RateLimitStore,
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

/* ═══════════════════════ потолок на пачку и на тело ═══════════════════════ */

describe('batchLength', () => {
  it('одиночный вызов — длина 1', () => {
    expect(batchLength({ method: 'eth_call' })).toBe(1);
  });

  it('массив — его длина, включая пустой', () => {
    expect(batchLength([{ method: 'eth_call' }, { method: 'eth_blockNumber' }])).toBe(2);
    expect(batchLength([])).toBe(0);
  });

  it('мусор вместо тела — тоже 1 (это один негодный вызов, не ноль)', () => {
    expect(batchLength(null)).toBe(1);
    expect(batchLength('не тело')).toBe(1);
  });
});

describe('MAX_BATCH_SIZE / MAX_BODY_BYTES — потолки существуют и разумны', () => {
  it('потолок пачки — положительное целое, достаточно маленькое, чтобы амплификация была ограничена', () => {
    expect(Number.isInteger(MAX_BATCH_SIZE)).toBe(true);
    expect(MAX_BATCH_SIZE).toBeGreaterThan(0);
    // Замер: собственный фронт JSON-RPC пачками не пользуется вовсе (viem
    // http-транспорт настроен без `batch`, см. rpcProxy.ts — комментарий у
    // константы). Потолок — не измеренный максимум, а намеренно узкий запас
    // над нулём: соточные и тысячные пачки, которыми амплифицируют квоту,
    // отсекаются с большим запасом.
    expect(MAX_BATCH_SIZE).toBeLessThan(100);
  });

  it('потолок тела — положительное целое в разумных байтах', () => {
    expect(Number.isInteger(MAX_BODY_BYTES)).toBe(true);
    expect(MAX_BODY_BYTES).toBeGreaterThan(1_024);
    expect(MAX_BODY_BYTES).toBeLessThan(10 * 1024 * 1024); // меньше 10 МиБ — не «без разницы»
  });
});

/* ─────────────────────── список разрешённых методов ─────────────────────── */

describe('ALLOWED_RPC_METHODS', () => {
  it('закрытый список, собранный по факту использования во фронте', () => {
    // Полный набор, подтверждённый чтением frontend/src (viem-действия →
    // JSON-RPC методы). Каждый — со своим потребителем, см. rpcProxy.ts.
    expect([...ALLOWED_RPC_METHODS].sort()).toEqual([
      'eth_blockNumber',
      'eth_call',
      'eth_estimateGas',
      'eth_getBlockByNumber',
      'eth_getCode',
      'eth_getFilterChanges',
      'eth_getLogs',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_newFilter',
      'eth_uninstallFilter',
    ].sort());
  });

  it('НЕ содержит eth_sendRawTransaction — подпись и рассылка идут через кошелёк, не через /api/rpc', () => {
    // Замер: `useWalletClient()` (wagmi) всегда получает транспорт от
    // самого коннектора (расширение кошелька), а не из `transports` конфига
    // — значит ни `eth_sendTransaction`, ни `eth_sendRawTransaction` через
    // этот прокси никогда не идут. Класть их в список значило бы открывать
    // дверь, которой не пользуется никто настоящий.
    expect(ALLOWED_RPC_METHODS.has('eth_sendRawTransaction')).toBe(false);
    expect(ALLOWED_RPC_METHODS.has('eth_sendTransaction')).toBe(false);
  });

  it('НЕ содержит eth_getBalance — вся балансовая логика фронта читает ERC-20 (readContract), не нативный эфир', () => {
    // Замер: все три `useBalance()` в src/ передают `token:` — это readContract
    // (eth_call), а не eth_getBalance. Единственный `getBalance` в кодовой базе —
    // серверный `api/relay/route.ts`, у него свой RPC_URL и через /api/rpc он
    // не ходит вовсе.
    expect(ALLOWED_RPC_METHODS.has('eth_getBalance')).toBe(false);
  });

  it('НЕ содержит debug_*/trace_* — самый дорогой класс злоупотребления', () => {
    expect(ALLOWED_RPC_METHODS.has('debug_traceTransaction')).toBe(false);
    expect(ALLOWED_RPC_METHODS.has('trace_block')).toBe(false);
  });
});

describe('rpcMethods', () => {
  it('одиночный вызов — массив из одного метода', () => {
    expect(rpcMethods({ method: 'eth_call' })).toEqual(['eth_call']);
  });

  it('пачка — все методы по порядку, дубликаты НЕ схлопываются (нужно для счётчика квоты)', () => {
    expect(rpcMethods([
      { method: 'eth_call' },
      { method: 'eth_call' },
      { method: 'eth_blockNumber' },
    ])).toEqual(['eth_call', 'eth_call', 'eth_blockNumber']);
  });

  it('мусор вместо метода — метка-заглушка, не падение', () => {
    expect(rpcMethods({})).toEqual(['<без метода>']);
    expect(rpcMethods(null)).toEqual(['<без метода>']);
  });
});

describe('disallowedMethods', () => {
  it('всё разрешено — пустой список', () => {
    expect(disallowedMethods({ method: 'eth_call' })).toEqual([]);
    expect(disallowedMethods([{ method: 'eth_call' }, { method: 'eth_blockNumber' }])).toEqual([]);
  });

  it('один неразрешённый метод — назван', () => {
    expect(disallowedMethods({ method: 'debug_traceTransaction' })).toEqual(['debug_traceTransaction']);
  });

  it('пачка со смесью — только чужие, без дублей', () => {
    const out = disallowedMethods([
      { method: 'eth_call' },
      { method: 'debug_traceCall' },
      { method: 'debug_traceCall' },
      { method: 'trace_block' },
    ]);
    expect(out).toEqual(['debug_traceCall', 'trace_block']);
  });

  it('принимает свой список вместо умолчания — проверяемо без правки ALLOWED_RPC_METHODS', () => {
    const custom = new Set(['only_this_method']);
    expect(disallowedMethods({ method: 'eth_call' }, custom)).toEqual(['eth_call']);
    expect(disallowedMethods({ method: 'only_this_method' }, custom)).toEqual([]);
  });
});

/* ───────────────────────── ограничитель частоты ──────────────────────────── */

describe('checkRpcRateLimit', () => {
  it('первый запрос в окне — проходит', () => {
    const store: RateLimitStore = new Map();
    expect(checkRpcRateLimit(store, 'ip:1.2.3.4', 3, 0)).toBe(true);
  });

  it('внутри потолка — проходит, сверх потолка — нет', () => {
    const store: RateLimitStore = new Map();
    expect(checkRpcRateLimit(store, 'k', 2, 0)).toBe(true);
    expect(checkRpcRateLimit(store, 'k', 2, 10)).toBe(true);
    expect(checkRpcRateLimit(store, 'k', 2, 20)).toBe(false);
    expect(checkRpcRateLimit(store, 'k', 2, 30)).toBe(false);
  });

  it('окно истекает — счётчик открывается заново', () => {
    const store: RateLimitStore = new Map();
    expect(checkRpcRateLimit(store, 'k', 1, 0, 60_000)).toBe(true);
    expect(checkRpcRateLimit(store, 'k', 1, 59_999, 60_000)).toBe(false);
    expect(checkRpcRateLimit(store, 'k', 1, 60_001, 60_000)).toBe(true);
  });

  it('разные ключи не мешают друг другу — один источник не глушит соседа', () => {
    const store: RateLimitStore = new Map();
    expect(checkRpcRateLimit(store, 'ip:A', 1, 0)).toBe(true);
    expect(checkRpcRateLimit(store, 'ip:A', 1, 1)).toBe(false);
    expect(checkRpcRateLimit(store, 'ip:B', 1, 1)).toBe(true);
  });

  it('умолчания — окно и потолок модуля, не выдумка теста', () => {
    expect(RPC_RATE_WINDOW_MS).toBe(60_000);
    expect(RPC_RATE_MAX).toBeGreaterThan(0);
    const store: RateLimitStore = new Map();
    for (let i = 0; i < RPC_RATE_MAX; i++) {
      expect(checkRpcRateLimit(store, 'k', undefined, i)).toBe(true);
    }
    expect(checkRpcRateLimit(store, 'k', undefined, RPC_RATE_MAX)).toBe(false);
  });
});

/* ───────────────────────── источник запроса (IP) ──────────────────────────── */

function headersOf(record: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => record[name.toLowerCase()] ?? null };
}

describe('requestSourceIp', () => {
  it('cf-connecting-ip — используется как есть (ставит и вычищает сам Cloudflare)', () => {
    expect(requestSourceIp(headersOf({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('x-forwarded-for — берётся ПОСЛЕДНИЙ прыжок, не первый', () => {
    // Первый — то, что заявил САМ клиент; его подделывают, чтобы обойти
    // лимитер. Последний — то, что увидел наш ближайший прокси.
    expect(requestSourceIp(headersOf({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('cf-connecting-ip приоритетнее x-forwarded-for, если пришли оба', () => {
    expect(requestSourceIp(headersOf({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '1.1.1.1',
    }))).toBe('203.0.113.9');
  });

  it('ни одного заголовка — «unknown», а не пустая строка или падение', () => {
    expect(requestSourceIp(headersOf({}))).toBe('unknown');
  });
});

/* ───────────────────────── проверка происхождения ─────────────────────────── */

describe('parseAllowedOrigins', () => {
  it('пусто/не задано — пустой список (слой выключен, см. isOriginAllowed)', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  it('список через запятую — обрезка пробелов, пустые звенья выброшены', () => {
    expect(parseAllowedOrigins(' https://hexseal.net , https://www.hexseal.net ,,'))
      .toEqual(['https://hexseal.net', 'https://www.hexseal.net']);
  });
});

describe('isOriginAllowed', () => {
  it('список пуст — слой выключен целиком, пропускает всё', () => {
    expect(isOriginAllowed({ origin: 'https://evil.example' }, [])).toBe(true);
    expect(isOriginAllowed({ origin: null }, [])).toBe(true);
  });

  it('список задан: свой origin проходит, чужой — нет', () => {
    const allowed = ['https://hexseal.net'];
    expect(isOriginAllowed({ origin: 'https://hexseal.net' }, allowed)).toBe(true);
    expect(isOriginAllowed({ origin: 'https://evil.example' }, allowed)).toBe(false);
  });

  it('нет заголовка Origin вовсе — пропускает (это не браузерный кросс-запрос — не работа этого слоя, см. docs)', () => {
    expect(isOriginAllowed({ origin: null }, ['https://hexseal.net'])).toBe(true);
  });

  it('Sec-Fetch-Site: cross-site — отказ БЕЗУСЛОВНО, даже если Origin случайно совпал со списком', () => {
    expect(isOriginAllowed(
      { origin: 'https://hexseal.net', secFetchSite: 'cross-site' },
      ['https://hexseal.net'],
    )).toBe(false);
  });

  it('Sec-Fetch-Site: same-origin/none — не мешает обычной проверке по списку', () => {
    expect(isOriginAllowed(
      { origin: 'https://hexseal.net', secFetchSite: 'same-origin' },
      ['https://hexseal.net'],
    )).toBe(true);
  });
});

/* ─────────────────────── счётчик методов для журнала ──────────────────────── */

describe('bumpMethodCounts / formatMethodCounts', () => {
  it('копится по методу, дубликаты внутри пачки считаются каждый', () => {
    const counts = new Map<string, number>();
    bumpMethodCounts(counts, ['eth_call', 'eth_call', 'eth_blockNumber']);
    bumpMethodCounts(counts, ['eth_call']);
    expect(counts.get('eth_call')).toBe(3);
    expect(counts.get('eth_blockNumber')).toBe(1);
  });

  it('formatMethodCounts — по убыванию счёта, метод=число', () => {
    const counts = new Map<string, number>([['eth_blockNumber', 2], ['eth_call', 9]]);
    const out = formatMethodCounts(counts);
    expect(out).toContain('eth_call=9');
    expect(out).toContain('eth_blockNumber=2');
    expect(out.indexOf('eth_call=9')).toBeLessThan(out.indexOf('eth_blockNumber=2'));
  });

  it('пустая карта — не пустая строка (иначе строка журнала пропадает молча)', () => {
    expect(formatMethodCounts(new Map())).toBeTruthy();
  });
});
