import { describe, expect, it, vi } from 'vitest';
import {
  PRIVATE_RETRY_MAX_ELAPSED_MS,
  classifyFetchFailure,
  describeRpcCall,
  formatAttempts,
  rpcHostLabel,
  classifyRpcCredential,
  privateSlotWarning,
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
  GATE_SIGNAL_CODES,
  GATE_SIGNAL_COOLDOWN_MS,
  GATE_SIGNAL_MESSAGE,
  isGateRejectionBody,
  shouldRaiseGateSignal,
  createRpcGateSignal,
  MAX_COUNTER_KEY_LEN,
  MAX_COUNTER_KEYS,
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

  it('MEASUREMENT: a key in the PATH never reaches the log — neither it nor the path', () => {
    // ⚠️ THIS CASE COSTS MORE THAN IT LOOKS. A mask written for `?dkey=` (cut
    // everything after `?`) lets a path-borne key through WHOLE — and in the
    // owner's environment the key sits exactly in the path. Same class as the
    // host list: knowing one form is taken for knowing the test.
    const KEY = 'FAKE-PATH-KEY-not-a-real-credential-000';
    const label = rpcHostLabel(`https://lb.drpc.live/base-sepolia/${KEY}`);
    expect(label).toBe('lb.drpc.live');
    expect(label).not.toContain(KEY);
    expect(label).not.toContain('/');
  });

  it('на неразобравшуюся строку не отдаёт её саму', () => {
    const label = rpcHostLabel('этоневообщеurl?dkey=SECRET');
    expect(label).toBe('<не-URL>');
    expect(label).not.toContain('SECRET');
  });
});

/**
 * ⚠️ THE KEYS BELOW ARE INVENTED, and written so that being invented is
 * self-evident on sight. This repository is public; a real paid key never
 * appears here in any shape. Only the FORM matters — length, character set,
 * where in the URL it sits — never a value.
 */
const FAKE_PATH_KEY  = 'FAKE-PATH-KEY-not-a-real-credential-000'; // path-borne key, 39 chars
const FAKE_QUERY_KEY = 'FAKE-QUERY-KEY-not-a-real-credential';    // parameter-borne key, 36 chars
/** 8 chars: longer than a word, shorter than a key — the "cannot tell" band. */
const FAKE_SHORT_KEY = 'Fake1234';

describe('classifyRpcCredential — private is whoever holds a KEY, not whoever is off a host list', () => {
  it('CASE 1: the live paid address — key as a PATH SEGMENT — is private', () => {
    // The form that sits in the owner's environment. A list of domains would
    // NEVER have seen it: it does not reason about keys at all.
    expect(classifyRpcCredential(`https://lb.drpc.live/base-sepolia/${FAKE_PATH_KEY}`).kind).toBe('keyed');
  });

  it('CASE 1b: the same paid endpoint on the provider\'s OTHER domain — key as a parameter — is private', () => {
    // That domain was on the old blacklist: on this form the detector fired at
    // every startup. The test below knows nothing about domains.
    const v = classifyRpcCredential(`https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=${FAKE_QUERY_KEY}`);
    expect(v.kind).toBe('keyed');
  });

  it('CASE 1c: the same URL with a ONE-CHARACTER key value — still private', () => {
    // The parameter is NAMED like a key and is not empty; the length of the
    // value is none of our business.
    expect(classifyRpcCredential('https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=X').kind).toBe('keyed');
  });

  it('CASE 2: the free drpc endpoint — same domain, no key — is public', () => {
    expect(classifyRpcCredential('https://base-sepolia.drpc.org').kind).toBe('bare');
  });

  it('CASE 3: the public Base endpoint is public', () => {
    expect(classifyRpcCredential('https://sepolia.base.org').kind).toBe('bare');
  });

  it('CASE 4: a key in the path at another provider (`/v2/<key>`) is private', () => {
    expect(classifyRpcCredential(`https://base-sepolia.g.alchemy.com/v2/${FAKE_QUERY_KEY}`).kind).toBe('keyed');
  });

  it('the route\'s whole public pool reads as public, including the one that has a path', () => {
    // `blockpi` carries `/v1/rpc/public`: there is a path, there is no key. On
    // exactly such a URL a "has a path, therefore has a key" test would go
    // quiet where it has to shout.
    for (const url of [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com',
      'https://base-sepolia.blockpi.network/v1/rpc/public',
    ]) {
      expect(classifyRpcCredential(url), url).toEqual({ kind: 'bare' });
    }
  });

  it('basic-auth is a credential in its purest form', () => {
    expect(classifyRpcCredential('https://user:pw0rd@node.example.com/rpc').kind).toBe('keyed');
  });

  it('KNOWS NO SPELLINGS: an unfamiliar parameter name with a credential root is private too', () => {
    // The sixth way to fool yourself (`docs/PROCESS.md`): the test has to
    // recognise the concept. Neither of these providers appears anywhere in
    // this codebase, and that is precisely the point of the case.
    expect(classifyRpcCredential(`https://rpc.example.net/ogrpc?access_token=${FAKE_QUERY_KEY}`).kind).toBe('keyed');
    expect(classifyRpcCredential(`https://rpc.example.net/ogrpc?pkey=${FAKE_QUERY_KEY}`).kind).toBe('keyed');
  });

  it('CANNOT TELL — SAYS SO instead of staying quiet: the string is not a URL at all', () => {
    const v = classifyRpcCredential('this is not a url ?dkey=SECRET');
    expect(v.kind).toBe('unclear');
    if (v.kind === 'unclear') expect(v.why).not.toContain('SECRET');
  });

  it('CANNOT TELL: a parameter named like a key but empty — broken config, and it is audible', () => {
    const v = classifyRpcCredential('https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=');
    expect(v.kind).toBe('unclear');
  });

  it('CANNOT TELL: a short opaque run in the path is "I will not judge", NOT "there is no key"', () => {
    // An error in this direction is safe: a human reads the line and looks for
    // themselves. An error in the other one ("no key") is the false alarm.
    expect(classifyRpcCredential(`https://rpc.example.net/base-sepolia/${FAKE_SHORT_KEY}`).kind).toBe('unclear');
  });

  it('WHERE the key sits is named; WHAT is in it, never', () => {
    const v = classifyRpcCredential(`https://lb.drpc.live/base-sepolia/${FAKE_PATH_KEY}`);
    expect(JSON.stringify(v)).not.toContain(FAKE_PATH_KEY);
    const q = classifyRpcCredential(`https://lb.drpc.org/ogrpc?dkey=${FAKE_QUERY_KEY}`);
    expect(JSON.stringify(q)).not.toContain(FAKE_QUERY_KEY);
  });
});

describe('privateSlotWarning — what the route will say at startup', () => {
  it('CASE 1: QUIET on the live paid address — in both live forms of the key', () => {
    expect(privateSlotWarning(`https://lb.drpc.live/base-sepolia/${FAKE_PATH_KEY}`)).toBeNull();
    expect(privateSlotWarning(`https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=${FAKE_QUERY_KEY}`)).toBeNull();
    expect(privateSlotWarning('https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=X')).toBeNull();
  });

  it('CASE 4: QUIET on a key in the path at another provider', () => {
    expect(privateSlotWarning(`https://base-sepolia.g.alchemy.com/v2/${FAKE_QUERY_KEY}`)).toBeNull();
  });

  it('CASES 2 and 3 + THE COUNTER-CASE: SPEAKS on a keyless endpoint — a test that calls everything private must go red right here', () => {
    for (const url of ['https://base-sepolia.drpc.org', 'https://sepolia.base.org', 'https://base-sepolia.blockpi.network/v1/rpc/public']) {
      const w = privateSlotWarning(url);
      expect(w, url).not.toBeNull();
      expect(w, url).toContain('no access key');
    }
  });

  it('the warning holds the host and nothing else: no key, no parameter values', () => {
    // The string travels to the container log — the whole `rpcHostLabel` rule.
    // The scene is chosen so that a warning EXISTS and a short key in the URL
    // exists TOO: "I will not judge" must not become a way to leak a value.
    const w = privateSlotWarning(`https://lb.drpc.org/base-sepolia/${FAKE_SHORT_KEY}`);
    expect(w).not.toBeNull();
    expect(w!).toContain('lb.drpc.org');
    expect(w!).not.toContain(FAKE_SHORT_KEY);

    const q = privateSlotWarning('https://lb.drpc.org/ogrpc?network=base-sepolia&secret=');
    expect(q).not.toBeNull();
    expect(q!).not.toContain('base-sepolia');
  });

  it('an unparseable address is NOT silence: there used to be an empty catch here', () => {
    const w = privateSlotWarning('lb.drpc.org/base-sepolia/some-key');
    expect(w).not.toBeNull();
    expect(w!).toContain('cannot tell');
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

  /* ═══════ НАХОДКА РЕВЬЮ (Critical): ключ агрегата — из тела ЧУЖОГО запроса ═══════
   *
   * `route.ts` строит ключ `method_not_allowed:${m}`, где `m` — сырое имя
   * метода из ПРИСЛАННОГО (не нашего) JSON-RPC-вызова, никак не обрезанное.
   * Пачка до `MAX_BATCH_SIZE`=10, тело до `MAX_BODY_BYTES`=64 КиБ — значит
   * ОДИН HTTP-запрос мог завести до десяти новых уникальных ключей суммарно
   * почти на 64 КБ, и (до починки гейт 2 стоял раньше лимитера) ничем не
   * лимитировался по частоте. Карта росла без предела — правдоподобный OOM
   * на процессе, который обслуживает ВСЕ чтения цепи сайта: ровно та беда,
   * которую весь разрез должен был снять.
   */
  it('длинный ключ обрезается потолком длины — один гигантский ключ не раздувает карту', () => {
    const counts = new Map<string, number>();
    const huge = 'method_not_allowed:' + 'x'.repeat(10_000);
    bumpMethodCounts(counts, [huge]);
    expect(counts.size).toBe(1);
    const [storedKey] = [...counts.keys()];
    expect(storedKey.length).toBeLessThanOrEqual(MAX_COUNTER_KEY_LEN + 1); // +1 — многоточие
    expect(storedKey.length).toBeLessThan(huge.length);
  });

  it('короткий ключ не трогается — усечение не портит настоящие имена методов', () => {
    const counts = new Map<string, number>();
    bumpMethodCounts(counts, ['eth_call']);
    expect(counts.has('eth_call')).toBe(true);
  });

  it('МНОГО РАЗНЫХ уникальных ключей — карта перестаёт расти после потолка, лишнее в общее ведро', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < MAX_COUNTER_KEYS + 500; i++) {
      bumpMethodCounts(counts, [`method_not_allowed:garbage_${i}`]);
    }
    // Ключей — не больше потолка ПЛЮС ведро переполнения.
    expect(counts.size).toBeLessThanOrEqual(MAX_COUNTER_KEYS + 1);
    expect(counts.size).toBe(MAX_COUNTER_KEYS + 1); // потолок исчерпан целиком + ведро
    const overflowTotal = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(overflowTotal).toBe(MAX_COUNTER_KEYS + 500); // ни один вызов не потерян, просто не у всех свой ключ
  });

  it('переполнение уходит в СВОЙ (настраиваемый) ключ ведра — узнаваемый в журнале, не общая безымянная куча', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3; i++) {
      bumpMethodCounts(counts, [`k${i}`], { maxKeys: 2, overflowKey: 'method_not_allowed:other' });
    }
    expect(counts.get('method_not_allowed:other')).toBe(1);
  });

  it('уже существующий ключ продолжает копиться САМ, а не уезжает в ведро — переполнение только для НОВЫХ ключей', () => {
    const counts = new Map<string, number>();
    bumpMethodCounts(counts, ['k0', 'k1'], { maxKeys: 2, overflowKey: 'other' });
    bumpMethodCounts(counts, ['k0', 'k0']); // тот же ключ снова, потолок уже исчерпан
    expect(counts.get('k0')).toBe(3);
    expect(counts.has('other')).toBe(false);
  });

  it('свои maxKeyLen/maxKeys/overflowKey работают независимо от умолчаний модуля', () => {
    const counts = new Map<string, number>();
    bumpMethodCounts(counts, ['abcdefgh'], { maxKeyLen: 3 });
    expect([...counts.keys()][0].length).toBeLessThanOrEqual(4); // 3 + многоточие
  });

  it('умолчания — разумные константы, а не выдумка теста', () => {
    expect(MAX_COUNTER_KEY_LEN).toBeGreaterThan(20); // с запасом вмещает "method_not_allowed:" (19 симв.) + короткое имя
    expect(MAX_COUNTER_KEYS).toBeGreaterThan(ALLOWED_RPC_METHODS.size); // счётчик успехов никогда не должен переполниться
    expect(MAX_COUNTER_KEYS).toBeLessThan(1000); // потолок памяти карты, не «почти без разницы»
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

/* ═══════════════════════ видимый сигнал на отказ гейта (находка ревью) ═══════════════════════
 *
 * `useReadContracts` без `isError` (DealCard.tsx), `useNotifications`/
 * `useDealLiveRefresh` (только console.warn) — отказ ЧЕТЫРЁХ новых гейтов
 * тонет: экран просто не обновляется, и застывший дашборд неотличим от
 * факта. Чинится на транспорте (providers.tsx: `onFetchResponse` у
 * viem-http), не на экранах — экраны не тронуты вовсе. Логика классификации
 * и троттлинга — здесь, тестируема без DOM; сама подмена — в providers.tsx
 * (см. providers.rpcGateSignal.test.ts, тестирует именно ПРОВОД).
 */

describe('isGateRejectionBody', () => {
  it('коды наших гейтов — да', () => {
    for (const code of GATE_SIGNAL_CODES) {
      expect(isGateRejectionBody({ jsonrpc: '2.0', error: { code }, id: null })).toBe(true);
    }
  });

  it('чужой код (например, -32700 — ошибка разбора, не наш гейт) — нет', () => {
    expect(isGateRejectionBody({ jsonrpc: '2.0', error: { code: -32700 }, id: null })).toBe(false);
  });

  it('502 апстрима (-32603) — нет: это отказ УЗЛА, не нашего гейта, и у него своя история', () => {
    expect(isGateRejectionBody({ jsonrpc: '2.0', error: { code: -32603 }, id: null })).toBe(false);
  });

  it('успешный ответ (нет error) — нет', () => {
    expect(isGateRejectionBody({ jsonrpc: '2.0', result: '0x1', id: 1 })).toBe(false);
  });

  it('мусор вместо тела — нет, не падение', () => {
    expect(isGateRejectionBody(null)).toBe(false);
    expect(isGateRejectionBody('строка')).toBe(false);
    expect(isGateRejectionBody({})).toBe(false);
    expect(isGateRejectionBody({ error: 'не объект' })).toBe(false);
    expect(isGateRejectionBody({ error: { code: 'не число' } })).toBe(false);
  });
});

describe('shouldRaiseGateSignal', () => {
  it('сигнала ещё не было (lastAt === null) — можно', () => {
    expect(shouldRaiseGateSignal(null, 0, 60_000)).toBe(true);
  });

  it('внутри окна остывания — нельзя', () => {
    expect(shouldRaiseGateSignal(0, 59_999, 60_000)).toBe(false);
  });

  it('окно истекло — можно снова', () => {
    expect(shouldRaiseGateSignal(0, 60_000, 60_000)).toBe(true);
  });

  it('умолчание — минута, как сказано в задаче («не чаще раза в минуту»)', () => {
    expect(GATE_SIGNAL_COOLDOWN_MS).toBe(60_000);
  });
});

describe('createRpcGateSignal', () => {
  function fakeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('ok-ответ (успех) — сигнал не поднимается', async () => {
    const raise = vi.fn();
    const handler = createRpcGateSignal({ raise, now: () => 0 });
    await handler(fakeResponse(200, { jsonrpc: '2.0', result: '0x1', id: 1 }));
    expect(raise).not.toHaveBeenCalled();
  });

  it('отказ НАШЕГО гейта — сигнал поднимается ровно с сообщением задачи', async () => {
    const raise = vi.fn();
    const handler = createRpcGateSignal({ raise, now: () => 0 });
    await handler(fakeResponse(429, { jsonrpc: '2.0', error: { code: -32005, message: 'Rate limit exceeded' }, id: null }));
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith(GATE_SIGNAL_MESSAGE);
  });

  it('отказ ЧУЖОЙ природы (парсинг/апстрим) — сигнал НЕ поднимается', async () => {
    const raise = vi.fn();
    const handler = createRpcGateSignal({ raise, now: () => 0 });
    await handler(fakeResponse(502, { jsonrpc: '2.0', error: { code: -32603, message: 'RPC proxy error' }, id: null }));
    expect(raise).not.toHaveBeenCalled();
  });

  it('троттлинг: два отказа гейта подряд в одну минуту — ОДИН сигнал, не два', async () => {
    const raise = vi.fn();
    let now = 0;
    const handler = createRpcGateSignal({ raise, now: () => now });
    const rejected = fakeResponse(400, { jsonrpc: '2.0', error: { code: -32600 }, id: null });
    await handler(rejected.clone());
    now = 30_000; // ещё внутри минуты
    await handler(rejected.clone());
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('троттлинг снимается через минуту — второй отказ подаёт второй сигнал', async () => {
    const raise = vi.fn();
    let now = 0;
    const handler = createRpcGateSignal({ raise, now: () => now });
    const rejected = fakeResponse(400, { jsonrpc: '2.0', error: { code: -32600 }, id: null });
    await handler(rejected.clone());
    now = 60_000;
    await handler(rejected.clone());
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('тело не JSON — не падает, сигнал не поднимается (не наш случай)', async () => {
    const raise = vi.fn();
    const handler = createRpcGateSignal({ raise, now: () => 0 });
    const notJson = new Response('не json{', { status: 400 });
    await expect(handler(notJson)).resolves.toBeUndefined();
    expect(raise).not.toHaveBeenCalled();
  });

  it('читает тело клоном — не мешает вызывающему (viem) прочитать response.json() следом', async () => {
    const raise = vi.fn();
    const handler = createRpcGateSignal({ raise, now: () => 0 });
    const res = fakeResponse(429, { jsonrpc: '2.0', error: { code: -32005 }, id: null });
    await handler(res);
    // Если бы `handler` прочитал тело БЕЗ клонирования, второе чтение здесь упало бы
    // («body stream already read») — именно так viem читает ответ ПОСЛЕ onFetchResponse.
    await expect(res.json()).resolves.toMatchObject({ error: { code: -32005 } });
  });
});
