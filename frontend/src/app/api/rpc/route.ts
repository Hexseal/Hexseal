import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';
import {
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
  RPC_RATE_MAX,
  checkRpcRateLimit,
  requestSourceIp,
  parseAllowedOrigins,
  isOriginAllowed,
  bumpMethodCounts,
  formatMethodCounts,
  type RateLimitStore,
} from '@/lib/rpcProxy';

// ═══════════════════════════ открытый прокси — гейты ═══════════════════════════
//
// `/api/rpc` пересылал тело запроса на платный узел drpc КАК ЕСТЬ: без проверки
// происхождения, без ограничителя частоты, без разбора того, что вообще
// прислали. По панели drpc — ~150 000 запросов в сутки (≈104/мин непрерывно),
// источник неизвестен.
//
// ⚠️ ПОРЯДОК ГЕЙТОВ НИЖЕ — НЕ «по убыванию пользы», а по порядку ИСПОЛНЕНИЯ,
// и это НАМЕРЕННО РАЗНЫЕ ВЕЩИ (находка ревью, Critical). Раньше порядок
// исполнения совпадал с порядком пользы (1→2→3→4), и это была ошибка: список
// методов (тогда — гейт 2) стоял РАНЬШЕ лимитера частоты (тогда — гейт 3), а
// значит запрос с запрещённым методом мог отправляться сколько угодно раз в
// секунду с одного IP — гейт, который его отклонял, сам никак не был
// лимитирован. Хуже: ключ агрегата отказов для этого гейта строился из СЫРОГО
// имени метода — поля из ТЕЛА ЧУЖОГО ЗАПРОСА, без потолка длины — так что
// один и тот же незалимитированный поток мог ещё и растить карту в памяти
// процесса без предела (см. докстринг `bumpMethodCounts` в `rpcProxy.ts`).
//
//  1а/1б. потолок на пачку и на тело (см. `rpcProxy.ts` — это ГЛАВНОЕ: JSON-RPC
//     пачка умеет быть массивом из сотен вызовов, и без потолка именно на НЕЁ
//     лимитер частоты (гейт 2) почти бесполезен — один HTTP-запрос обходит
//     любой потолок «N запросов в минуту»). Дешёвые проверки, идут первыми.
//  2. лимитер частоты по IP — ПЕРЕД списком методов: дешевле разбора (одно
//     сравнение с числом в карте) и закрывает саму ВОЗМОЖНОСТЬ долбить
//     ЛЮБЫМ последующим отказом с одного источника без ограничения.
//  3. список разрешённых методов (закрытый, собран по факту использования)
//     — уже посчитан лимитером выше, что бы он дальше ни отклонил.
//  4. проверка происхождения — ПОСЛЕДНЯЯ: она не останавливает `curl`
//     (Origin/Sec-Fetch-Site подделываются вне браузера как угодно), поэтому
//     не имеет смысла тратить её первой (но она тоже уже посчитана лимитером).
// Счётчик методов и отказов — не гейт, копится по каждому запросу (успеху или
// отказу) и пишется в журнал раз в несколько минут, не на каждый запрос —
// сам защищён потолком длины/числа ключей (`bumpMethodCounts`), иначе он был
// бы ровно тем каналом утечки памяти, который и нашли.

/** Общая карта лимитера — на процесс, как и у соседнего `api/push/route.ts`
 *  (`_proxyRate`) и у релеера (`_rateMap`). При нескольких инстансах фронта
 *  потолок умножится на их число — это честная граница, а не недосмотр. */
const _rpcRateStore: RateLimitStore = new Map();

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
if (ALLOWED_ORIGINS.length === 0) {
  // Тот же приём, что у предупреждения про публичный узел в приватном
  // слоте ниже: тихая дыра хуже названной. Само решение «не задан — не
  // судим» и почему оно НЕ «дыра по недосмотру» — докстринг `isOriginAllowed`.
  console.warn(
    '[/api/rpc] ALLOWED_ORIGINS не задан — проверка происхождения ВЫКЛЮЧЕНА ' +
    '(остальные три гейта работают независимо от неё)',
  );
}

/** Счётчик методов между печатями в журнал. Один на процесс, не на запрос —
 *  иначе он и есть вторая беда, которую всё это чинит. */
let _methodCounts = new Map<string, number>();

/**
 * НАХОДКА РЕВЬЮ: счётчик успехов выше сделан «раз в 5 минут, чтобы журнал не
 * стал второй бедой» — а путь ОТКАЗОВ был не защищён вовсе: `console.warn`
 * на КАЖДЫЙ отклонённый гейтом запрос. Если абузивный трафик продолжится (а
 * продолжится — просто теперь дешевле для платной квоты), в журнал польётся
 * тот же порядок строк, где раньше было около нуля. `docker-compose.yml` не
 * задаёт ротацию логов ни одному сервису, и у этого проекта уже была беда
 * «кончился диск» (`BAG_JOURNAL_MAX_BYTES`, см. `.env.vps.example`).
 *
 * Сведено к ТОМУ ЖЕ агрегату: считается по причине отказа на КАЖДЫЙ
 * отклонённый запрос (не печатается), печатается ОДНОЙ строкой в тот же
 * такт, что и счётчик методов.
 */
let _rejectCounts = new Map<string, number>();

const METHOD_LOG_INTERVAL_MS = 5 * 60_000; // тот же порядок, что у уборки карты лимитера в relayer/app.js (5 минут)
const _methodLogTimer = setInterval(() => {
  if (_methodCounts.size > 0) {
    console.log(`[/api/rpc] методы за ${METHOD_LOG_INTERVAL_MS / 60_000} мин: ${formatMethodCounts(_methodCounts)}`);
    _methodCounts = new Map();
  }
  if (_rejectCounts.size > 0) {
    console.log(`[/api/rpc] отказы за ${METHOD_LOG_INTERVAL_MS / 60_000} мин: ${formatMethodCounts(_rejectCounts)}`);
    _rejectCounts = new Map();
  }
}, METHOD_LOG_INTERVAL_MS);
// Не держит процесс живым ради самого себя — как и таймер GC карты лимитера
// в relayer/app.js, только там он этого не требует (Express-процесс и так
// не завершается). Next.js dev/test-процессы иногда ждут именно ОТСУТСТВИЯ
// активных таймеров, чтобы выйти.
_methodLogTimer.unref?.();

// Private RPC with API key — server-only, never exposed to client.
// Set DRPC_URL (no NEXT_PUBLIC_ prefix) in .env.vps so the key stays
// out of the JS bundle. docker-compose injects it at container runtime.
// Pick the first NON-EMPTY candidate. `??` alone was wrong here: an env var set to
// an empty string (e.g. a docker-compose `environment:` entry interpolating an unset
// ${DRPC_URL}) is not nullish, so it won the chain and silently disabled the private
// RPC — pushing every call onto rate-limited public endpoints.
//
// ORDER MATTERS, and it is paid-first on purpose. BASE_SEPOLIA_RPC_URL used to sit
// second, ahead of RPC_URL — but that variable is the generic chain RPC the whole
// repo shares (forge scripts, cast, the relayer), and in the owner's environment it
// points at the FREE public `base-sepolia.drpc.org`. A free public endpoint has no
// business being a candidate for the *private* slot: if DRPC_URL is ever empty, the
// "private" attempt below would just be a fourth public endpoint, sharing one rate
// limit with the three fallbacks — every one of them gets throttled together and the
// route 502s (the failure docker-compose's own comment warns about). Whatever
// distinguishes the private slot (its own quota, an API key, a paid plan) is exactly
// what public URLs don't have, so paid candidates go first and the shared/generic one
// is a last resort. The fallback pool below is unchanged: it is *supposed* to be public.
const PRIVATE_RPC =
  [process.env.DRPC_URL, process.env.RPC_URL, process.env.BASE_SEPOLIA_RPC_URL]
    .map(v => v?.trim())
    .find((v): v is string => !!v) ?? null;

// A public host winning the private slot is survivable but never intentional — and it
// was invisible in the logs, which is how it stayed hidden. Say so once at startup.
// Matched on hostname, not substring: drpc's FREE endpoint is `base-sepolia.drpc.org`
// while the paid one is `…drpc.live/…?dkey=`, and a substring test for "drpc" would
// flag the paid one too.
const PUBLIC_RPC_HOSTS = ['base.org', 'drpc.org', 'publicnode.com', 'blockpi.network'];
if (PRIVATE_RPC) {
  let host = '';
  try { host = new URL(PRIVATE_RPC).hostname; } catch { /* не URL — сказать нечего */ }
  if (PUBLIC_RPC_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    console.warn(
      `[/api/rpc] private RPC slot resolved to a public endpoint (${host}) — ` +
      'set DRPC_URL (or RPC_URL) to a keyed endpoint, or every call shares one public rate limit',
    );
  }
}

// Public fallback RPC endpoints tried in order if private RPC fails.
const PUBLIC_RPCS: string[] = appChain.id === 8453
  ? ['https://mainnet.base.org', 'https://base-rpc.publicnode.com']
  : ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.blockpi.network/v1/rpc/public'];

/** Имя приватного узла для журнала. Считается один раз на процесс — и это
 *  ЕДИНСТВЕННОЕ, что от `PRIVATE_RPC` попадает в вывод: в адресе лежит ключ
 *  доступа (`?dkey=`), и полный URL в журнале равносилен его утечке.
 *  Наружу, в тело ответа клиенту, не уходит и хост — там метка `private`. */
const PRIVATE_HOST = PRIVATE_RPC ? rpcHostLabel(PRIVATE_RPC) : '—';

const PRIVATE_TIMEOUT_MS       = 6_000;
const PRIVATE_RETRY_TIMEOUT_MS = 3_000;
const PUBLIC_TIMEOUT_MS        = 4_000;
/** Пауза перед повтором приватного. Не «бэкофф» в полном смысле — один шаг;
 *  нужна, чтобы повтор не улетел в ту же миллисекунду, что и сброшенное
 *  соединение. 150 мс не влияют на бюджет и снимают самый глупый вид шторма. */
const PRIVATE_RETRY_PAUSE_MS = 150;

async function callRpc(url: string, body: unknown, timeoutMs = PRIVATE_TIMEOUT_MS): Promise<Response> {
  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  });
}

/** JSON-RPC-формой ответа на отказ гейта — тем же, что и у остальных ошибок
 *  этого маршрута (502 ниже, parse error выше). Вызывающие — viem — ждут
 *  JSON-RPC объект в любом случае, а не голый `{error}`. */
function gateRejection(status: number, code: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code, message, ...(extra ? { data: extra } : {}) }, id: null },
    { status },
  );
}

export async function POST(req: NextRequest) {
  // ── Гейт 1а: тело — по СЫРЫМ байтам, ДО разбора JSON. Гигантское мусорное
  // тело иначе тратит время на `JSON.parse`, прежде чем его отвергнут.
  const rawText = await req.text();
  const bodyBytes = Buffer.byteLength(rawText, 'utf-8');
  if (bodyBytes > MAX_BODY_BYTES) {
    bumpMethodCounts(_rejectCounts, ['body_too_large']);
    return gateRejection(413, -32600, `Request body too large: ${bodyBytes} bytes (max ${MAX_BODY_BYTES})`);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 },
    );
  }

  // ── Гейт 1б: длина пачки. САМОЕ ВАЖНОЕ звено — без него JSON-RPC-массив
  // из сотен вызовов обходит лимитер частоты (гейт 3) одним HTTP-запросом:
  // один запрос = сколько угодно обращений к платной квоте.
  const size = batchLength(body);
  if (size > MAX_BATCH_SIZE) {
    bumpMethodCounts(_rejectCounts, ['batch_too_large']);
    return gateRejection(400, -32600, `Batch too large: ${size} calls (max ${MAX_BATCH_SIZE})`);
  }

  // ── Гейт 2: лимитер частоты по IP. ⚠️ НАХОДКА РЕВЬЮ (Critical): раньше
  // стоял ПОСЛЕ списка методов (гейт 3 ниже) — а значит запрос с
  // запрещённым методом вообще не доходил до лимитера и мог отправляться
  // сколько угодно раз в секунду с одного IP БЕЗ ограничения частоты.
  // Лимитер переставлен раньше самого разбора методов: он дешевле
  // (сравнение с числом в карте) и закрывает саму ВОЗМОЖНОСТЬ долбить
  // отказами — после 1а/1б (которые снимают амплификацию пачкой и стоят
  // копейки) первым делом считается КАЖДЫЙ отклонённый запрос, каким бы
  // гейтом он ни был отклонён дальше.
  const source = requestSourceIp(req.headers);
  if (!checkRpcRateLimit(_rpcRateStore, `rpc:${source}`, RPC_RATE_MAX)) {
    bumpMethodCounts(_rejectCounts, ['rate_limited']);
    return gateRejection(429, -32005, 'Rate limit exceeded', { source });
  }

  // ── Гейт 3: список разрешённых методов — закрытый, собран по факту
  // использования (см. `ALLOWED_RPC_METHODS` в `lib/rpcProxy.ts`). Заодно
  // снимает самый дорогой сценарий — `debug_*`/`trace_*` и обходы логов за
  // гигантские диапазоны чужой платной квотой.
  //
  // ⚠️ `m` — сырое имя метода из ТЕЛА ЧУЖОГО ЗАПРОСА, не наше. Ключ агрегата
  // ниже ОБЯЗАН идти через `bumpMethodCounts` с потолком длины/числа
  // ключей (см. докстринг там) — без него сама эта строка была источником
  // Critical-находки: карта росла без предела на чужом вводе. `overflowKey`
  // называет ПРИЧИНУ переполнения в журнале, а не сваливает её в общую кучу.
  const badMethods = disallowedMethods(body, ALLOWED_RPC_METHODS);
  if (badMethods.length > 0) {
    bumpMethodCounts(
      _rejectCounts,
      badMethods.map(m => `method_not_allowed:${m}`),
      { overflowKey: 'method_not_allowed:other' },
    );
    return gateRejection(400, -32601, `Method not allowed: ${badMethods.join(', ')}`);
  }

  // ── Гейт 4: происхождение — ПОСЛЕДНИЙ, см. докстринг `isOriginAllowed`:
  // не останавливает `curl`, поэтому не имеет смысла первым.
  const origin = req.headers.get('origin');
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (!isOriginAllowed({ origin, secFetchSite }, ALLOWED_ORIGINS)) {
    bumpMethodCounts(_rejectCounts, ['origin_rejected']);
    return gateRejection(403, -32600, 'Origin not allowed');
  }

  // Прошёл все гейты — считаем метод(ы) в агрегат журнала. По каждому вызову
  // ПАЧКИ отдельно (тарификация платной квоты идёт по вызову, не по HTTP-
  // запросу) — строка в журнал печатается отдельно и редко, не здесь.
  bumpMethodCounts(_methodCounts, rpcMethods(body));

  // Чем был этот запрос — для журнала. Без него строка «узел отказал» не
  // отвечает на главный вопрос расследования: КАКОЕ чтение упало. Ровно этот
  // вопрос и стоял 2 августа, когда у арбитра пропала роль: баланс приехал,
  // роль нет, а в журнале по `api/rpc` не было вообще ничего.
  const call = describeRpcCall(body);

  /** След всех попыток. Раньше выживало только последнее сообщение
   *  (`lastErr`), и по нему нельзя было понять ни сколько кандидатов пробовали,
   *  ни что ответил приватный. */
  const attempts: RpcAttempt[] = [];

  // Try private RPC first (6 s, плюс один короткий повтор на быстрый сбой);
  // auto-fallback to public pool if it fails.
  // Бюджет времени, худший случай — два разветвления, оба меньше прежних 18 с:
  //   • приватный отвалился по таймауту:  6 + 3 × 4 = 18 с (повтора нет, правило 1);
  //   • приватный отвалился быстро:     ≤2 + 0.15 + 3 + 3 × 4 ≈ 17.2 с.
  // Оба меньше 30 с — потолка serverless-функции. Обоснование самого повтора —
  // в `shouldRetryPrivate` (lib/rpcProxy.ts).
  if (PRIVATE_RPC) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeoutMs = attempt === 1 ? PRIVATE_TIMEOUT_MS : PRIVATE_RETRY_TIMEOUT_MS;
      const startedAt = Date.now();
      const tag = attempt === 1 ? 'приватный' : 'приватный (повтор)';
      let retryable = false;

      try {
        const res = await callRpc(PRIVATE_RPC, body, timeoutMs);
        const ms = Date.now() - startedAt;
        if (res.ok) {
          if (attempt === 2) {
            // Повтор спас чтение. Эту строку стоит видеть: она — единственное
            // доказательство, что повтор здесь не мёртвый код, и одновременно
            // счётчик того, как часто моргает платный узел.
            console.warn(`[/api/rpc] ${call}: повтор приватного (${PRIVATE_HOST}) удался за ${ms} мс`);
          }
          return NextResponse.json(await res.json());
        }
        attempts.push({ target: 'private', outcome: 'status', status: res.status, ms });
        console.warn(
          `[/api/rpc] ${call}: ${tag} (${PRIVATE_HOST}) ответил HTTP ${res.status} за ${ms} мс`,
        );
        retryable = shouldRetryPrivate({ status: res.status }, ms);
      } catch (err) {
        const ms = Date.now() - startedAt;
        // ⚠️ ЗДЕСЬ БЫЛ ПУСТОЙ `catch {}`. Приватный узел мог отваливаться по
        // таймауту или по сети сколько угодно раз, и в журнале не оставалось
        // ни строчки — поэтому в августе было неизвестно, почему приходит 502.
        const failure = classifyFetchFailure(err);
        attempts.push({
          target:  'private',
          outcome: failure.timeout ? 'timeout' : 'network',
          error:   failure.message,
          ms,
        });
        console.warn(
          `[/api/rpc] ${call}: ${tag} (${PRIVATE_HOST}) не ответил за ${ms} мс — ` +
          `${failure.timeout ? 'ТАЙМАУТ' : 'сетевой сбой'}: ${failure.message}`,
        );
        retryable = shouldRetryPrivate({ timeout: failure.timeout }, ms);
      }

      if (attempt === 2 || !retryable) break;
      await new Promise(r => setTimeout(r, PRIVATE_RETRY_PAUSE_MS));
    }
    console.warn(`[/api/rpc] ${call}: уходим на публичный пул (${PUBLIC_RPCS.length} кандидата)`);
  } else {
    // Тоже ветка отказа, и самая обидная: приватного узла просто нет в
    // окружении, каждый запрос идёт по публичным лимитам — а выглядит это
    // снаружи точно так же, как «приватный отвалился».
    console.warn(`[/api/rpc] ${call}: приватный узел не настроен, сразу публичный пул`);
  }

  // Try each public fallback in order (4 s each — short enough to stay in budget)
  for (const url of PUBLIC_RPCS) {
    const startedAt = Date.now();
    try {
      const res = await callRpc(url, body, PUBLIC_TIMEOUT_MS);
      const ms = Date.now() - startedAt;
      if (res.ok) {
        return NextResponse.json(await res.json());
      }
      attempts.push({ target: url, outcome: 'status', status: res.status, ms });
      console.warn(`[/api/rpc] ${call}: публичный ${url} ответил HTTP ${res.status} за ${ms} мс`);
    } catch (err) {
      const ms = Date.now() - startedAt;
      const failure = classifyFetchFailure(err);
      attempts.push({
        target:  url,
        outcome: failure.timeout ? 'timeout' : 'network',
        error:   failure.message,
        ms,
      });
      console.warn(
        `[/api/rpc] ${call}: публичный ${url} не ответил за ${ms} мс — ` +
        `${failure.timeout ? 'ТАЙМАУТ' : 'сетевой сбой'}: ${failure.message}`,
      );
    }
  }

  // Отдаём 502 — и вместе с ним весь след. Прежний ответ нёс только сообщение
  // ПОСЛЕДНЕГО публичного запасного; человек в консоли браузера видел
  // «RPC proxy error: fetch failed» и не мог узнать ни числа кандидатов, ни
  // того, что случилось с приватным.
  const trail = formatAttempts(attempts);
  console.error(`[/api/rpc] ${call}: 502, все ${attempts.length} кандидата отказали — ${trail}`);

  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: `RPC proxy error: перепробованы все ${attempts.length} кандидата — ${trail}`,
        // Структурированный тот же след: по нему можно отличить «все по
        // таймауту» (узлы живы, но медленные) от «все по кодам» (нас режут по
        // частоте) не разбирая строку глазами.
        data: { call, tried: attempts.length, attempts },
      },
      id: null,
    },
    { status: 502 },
  );
}
