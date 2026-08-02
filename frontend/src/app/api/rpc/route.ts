import { NextRequest, NextResponse } from 'next/server';
import { appChain } from '@/config/chain';
import {
  classifyFetchFailure,
  describeRpcCall,
  formatAttempts,
  rpcHostLabel,
  shouldRetryPrivate,
  type RpcAttempt,
} from '@/lib/rpcProxy';

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

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 },
    );
  }

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
