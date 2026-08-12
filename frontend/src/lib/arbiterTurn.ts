import type { Address, PublicClient } from 'viem';
import type { Abi, AbiEvent } from 'viem';
import { AGREEMENT_ABI, ARBITER_REGISTRY_ABI, CONTRACTS } from '@/config/contracts';
import { CATCHUP_CHUNK_BLOCKS } from '@/lib/chainWatchGate';

/**
 * Какой по счёту это арбитр — факт цепи, добытый счётом логов.
 *
 * ЗАЧЕМ. Каждая смена арбитра — ещё один человек, прочитавший переписку
 * целиком; ушедший ничего не возвращает, он уже всё знает. Сторона имеет право
 * показать второму МЕНЬШЕ, чем первому, и лишена этого права, если не знает,
 * что показывает не первому (§2.4 замысла).
 *
 * ПОЧЕМУ ЛОГАМИ, А НЕ ГЕТТЕРОМ. Счётчика на спор в цепи нет ни в каком виде —
 * проверено чтением всей ArbiterRegistryStorage.Data и всего фасета: ни поля,
 * ни геттера. `openClaimCount` — это «арбитр → сколько споров у НЕГО»;
 * `arbiterDeals` смотрит в обратную сторону, а ушедший арбитр из `arbiterList`
 * удаляется (removeArbiter / resignAsArbiter / демоушен), то есть обход по
 * `getArbiters()` систематически недосчитывает РОВНО ТЕХ, из-за кого спор и
 * сменил арбитра. Сабграф `DisputeClaimed` не индексирует. Остаются логи.
 * Дешёвая альтернатива — счётчик в цепи — это разрез фасета, то есть Выкатка 2.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО: недосчёта. Любая беда — молчащий узел, слишком
 * широкий диапазон, непроверяемый край окна — даёт `{ known: false }`, а не
 * меньшее число. Неправда числом здесь дороже незнания: на это число сторона
 * опирается, решая, показывать ли переписку.
 *
 * ЦЕНА, ЗАМЕРЕННАЯ ТЕСТАМИ (не оценка на глаз):
 *   — широкая дорога прошла: `getLogs = 1`, и это весь счёт целиком;
 *   — широкая дорога отказала, окно спора читается: 8 обращений к узлу
 *     (`getLogs = 3`, `getBlock = 2`, `readContract = 2`, `blockNumber = 1`);
 *   — худший случай, посчитанный руками: окно спора 4 дня = 172 800 блоков,
 *     при куске 3 600 это 48 кусков, плюс голова, два чтения агримента и до
 *     четырёх проб края. Дальше `TURN_MAX_CHUNKS` — честное `{ known: false }`.
 */

/**
 * Блок деплоя диамонда (25 июля 2026) — раньше него логов быть не может.
 *
 * ⚠️ ЭТО ВТОРАЯ КОПИЯ ЧИСЛА. Хозяин — `subgraph/subgraph.yaml` (`startBlock`),
 * без него сабграф пуст, поэтому при следующем переразвёртывании обновят
 * именно его. Копия здесь законна только потому, что сверяется с хозяином
 * замком `arbiterTurn.test.ts` («блок деплоя диамонда: копия во фронте
 * сверяется с хозяином») — тест читает yaml, а не повторяет число.
 */
export const DIAMOND_DEPLOY_BLOCK = BigInt(44_613_049);

/**
 * Секунд на блок у Base (OP-stack). Оценкой пользуемся только чтобы ПРЕДПОЛОЖИТЬ
 * край диапазона; сам край подтверждается чтением времени блока, поэтому ошибка
 * оценки удорожает счёт, но не искажает его.
 */
export const BASE_BLOCK_SECONDS = BigInt(2);

/** Ширина куска. Берётся у `chainWatchGate`, а не заводится второй копией:
 *  число выбрано там из тех же соображений («провайдеры режут диапазон»), и
 *  двум копиям одного числа положено разъехаться. */
export const TURN_CHUNK_BLOCKS = CATCHUP_CHUNK_BLOCKS;

/** Потолок числа кусков на один счёт. Больше — честное «не знаю». */
export const TURN_MAX_CHUNKS = 64;

/** Сколько раз пробуем подтвердить край диапазона чтением блока. */
export const TURN_PROBE_MAX = 4;

export type ArbiterTurn =
  | { known: true; turn: number }
  | { known: false };

/**
 * ⚠️ ЗАМОК КОМПИЛЯТОРА: `{ known: false }` не несёт числа ВООБЩЕ. Тот же приём,
 * что `PRESENTATION_REFUSAL_FITS_IS_REQUIRED` в `presentation.ts`. Живёт в
 * боевом файле, а не в тесте: `**\/*.test.ts` исключены из программы `tsc`
 * (`tsconfig.json`), и там проверка формы не поймала бы ничего.
 *
 * Что исчезнет из поведения, если снять: возможность приписать «не знаю»
 * число 0 — то есть сказать стороне «арбитр первый» там, где мы не считали.
 */
type TurnUnknown = Extract<ArbiterTurn, { known: false }>;
export type ArbiterTurnUnknownCarriesNoNumber =
  [Extract<keyof TurnUnknown, 'turn'>] extends [never] ? true : never;
export const ARBITER_TURN_UNKNOWN_CARRIES_NO_NUMBER: ArbiterTurnUnknownCarriesNoNumber = true;

export interface TurnScanChunk { fromBlock: bigint; toBlock: bigint }

/** Описание события берётся из БОЕВОГО ABI, а не переписывается руками:
 *  переписанное с другим типом поля даёт другой topic0, и фильтр молча
 *  перестаёт ловить. */
const DISPUTE_CLAIMED_EVENT: AbiEvent | undefined =
  (ARBITER_REGISTRY_ABI as unknown as { type?: string; name?: string }[])
    .find((e) => e && e.type === 'event' && e.name === 'DisputeClaimed') as AbiEvent | undefined;

/**
 * Куски обхода: от старых блоков к новым, без дыр и нахлёста.
 * `null` — обходить нечем: вывернутый диапазон, мусор, либо кусков нужно больше
 * потолка. ⚠️ Именно `null`, а не урезанный план: урезание дало бы недосчёт с
 * уверенным лицом.
 */
export function planTurnScan(
  from: bigint,
  to: bigint,
  chunk: bigint = TURN_CHUNK_BLOCKS,
  maxChunks: number = TURN_MAX_CHUNKS,
): TurnScanChunk[] | null {
  if (typeof from !== 'bigint' || typeof to !== 'bigint' || typeof chunk !== 'bigint') return null;
  if (!Number.isInteger(maxChunks) || maxChunks <= 0) return null;
  if (from < BigInt(0) || to < from || chunk <= BigInt(0)) return null;

  const need = (to - from) / chunk + BigInt(1);
  if (need > BigInt(maxChunks)) return null;

  const out: TurnScanChunk[] = [];
  let f = from;
  while (f <= to) {
    const t = f + chunk - BigInt(1);
    out.push({ fromBlock: f, toBlock: t > to ? to : t });
    f = t + BigInt(1);
  }
  return out;
}

/** Оценка номера блока по времени. ТОЛЬКО оценка — край подтверждается чтением. */
export function estimateBlockAt(
  head: bigint,
  headTs: bigint,
  targetTs: bigint,
  blockSeconds: bigint = BASE_BLOCK_SECONDS,
): bigint {
  if (typeof head !== 'bigint' || typeof headTs !== 'bigint' || typeof targetTs !== 'bigint') return head;
  if (blockSeconds <= BigInt(0) || targetTs >= headTs) return head;
  const back = (headTs - targetTs) / blockSeconds;
  return head > back ? head - back : BigInt(0);
}

/**
 * Сколько раз заявляли спор по этой сделке. Свой отсев по адресу обязателен:
 * фильтр по `args` ставит и узел, но верить чужому ответу на своём вопросе —
 * это не проверка.
 */
export function countClaimsForAgreement(logs: readonly unknown[], agreement: Address): number {
  if (!Array.isArray(logs)) return 0;
  const want = String(agreement).toLowerCase();
  const seen = new Set<string>();
  let n = 0;
  for (const raw of logs) {
    const log = raw as { eventName?: unknown; args?: unknown;
                         transactionHash?: unknown; logIndex?: unknown } | null;
    if (!log || typeof log !== 'object') continue;
    if (log.eventName !== 'DisputeClaimed') continue;
    const args = log.args as { agreement?: unknown } | undefined;
    const which = args?.agreement;
    if (typeof which !== 'string' || which.toLowerCase() !== want) continue;
    // Опознавательные знаки есть не всегда (стенд, урезанный ответ узла).
    // Считать по неполному ключу нельзя: все логи слились бы в один.
    const hasId = typeof log.transactionHash === 'string'
      && (typeof log.logIndex === 'number' || typeof log.logIndex === 'bigint');
    if (hasId) {
      const id = `${log.transactionHash as string}|${String(log.logIndex)}`;
      if (seen.has(id)) continue;
      seen.add(id);
    }
    n++;
  }
  return n;
}

/** Время блока, либо null — узел не ответил. */
async function blockTimestamp(client: PublicClient, blockNumber: bigint): Promise<bigint | null> {
  try {
    const block = await client.getBlock({ blockNumber });
    const ts = (block as { timestamp?: unknown } | null)?.timestamp;
    return typeof ts === 'bigint' ? ts : null;
  } catch { return null; }
}

/** Логи заявок диапазона, либо null — узел отказал (в т.ч. «диапазон широк»). */
async function claimLogs(
  client: PublicClient, agreement: Address, fromBlock: bigint, toBlock: bigint,
): Promise<unknown[] | null> {
  if (!DISPUTE_CLAIMED_EVENT) return null;
  try {
    const logs = await client.getLogs({
      address: CONTRACTS.diamond,
      event: DISPUTE_CLAIMED_EVENT,
      args: { agreement },
      fromBlock,
      toBlock,
    } as never);
    return Array.isArray(logs) ? (logs as unknown[]) : null;
  } catch { return null; }
}

/** `disputedAt` и `DISPUTE_WINDOW` С САМОГО АГРИМЕНТА: клоны EIP-1167 прибиты
 *  к своей реализации намертво, и у старого клона окно может быть прежним
 *  (оно уже менялось с 7 дней на 4). */
async function disputeSpan(
  client: PublicClient, agreement: Address,
): Promise<{ disputedAt: bigint; window: bigint } | null> {
  try {
    const [disputedAt, window] = await Promise.all([
      client.readContract({ address: agreement, abi: AGREEMENT_ABI as Abi,
                            functionName: 'disputedAt' }) as Promise<bigint>,
      client.readContract({ address: agreement, abi: AGREEMENT_ABI as Abi,
                            functionName: 'DISPUTE_WINDOW' }) as Promise<bigint>,
    ]);
    if (typeof disputedAt !== 'bigint' || typeof window !== 'bigint') return null;
    if (disputedAt <= BigInt(0) || window <= BigInt(0)) return null;
    return { disputedAt, window };
  } catch { return null; }
}

/** Нижний край, ПОДТВЕРЖДЁННЫЙ чтением: время блока ≤ цели. null — не подтвердили. */
async function verifiedFrom(
  client: PublicClient, head: bigint, headTs: bigint, targetTs: bigint,
): Promise<bigint | null> {
  let candidate = estimateBlockAt(head, headTs, targetTs);
  for (let probe = 0; probe < TURN_PROBE_MAX; probe++) {
    if (candidate <= DIAMOND_DEPLOY_BLOCK) return DIAMOND_DEPLOY_BLOCK;
    const ts = await blockTimestamp(client, candidate);
    if (ts === null) return null;
    if (ts <= targetTs) return candidate;
    const back = (ts - targetTs) / BASE_BLOCK_SECONDS + BigInt(1);
    candidate = candidate > back ? candidate - back : DIAMOND_DEPLOY_BLOCK;
  }
  return null;
}

/** Верхний край. Не подтвердили — берём ГОЛОВУ: она заведомо не мала. */
async function verifiedTo(
  client: PublicClient, from: bigint, head: bigint, targetTs: bigint, window: bigint,
): Promise<bigint> {
  let candidate = from + window / BASE_BLOCK_SECONDS + TURN_CHUNK_BLOCKS;
  for (let probe = 0; probe < TURN_PROBE_MAX; probe++) {
    if (candidate >= head) return head;
    const ts = await blockTimestamp(client, candidate);
    if (ts === null) return head;
    if (ts >= targetTs) return candidate;
    candidate = candidate + (targetTs - ts) / BASE_BLOCK_SECONDS + BigInt(1);
  }
  return head;
}

export async function arbiterTurnOf(
  publicClient: PublicClient, agreement: Address,
): Promise<ArbiterTurn> {
  if (!DISPUTE_CLAIMED_EVENT) return { known: false };

  let head: bigint;
  try {
    head = await publicClient.getBlockNumber();
  } catch { return { known: false }; }
  if (typeof head !== 'bigint' || head <= BigInt(0)) return { known: false };

  // Дорога 1: один запрос от блока деплоя до головы. Топик-фильтр по адресу
  // сделки делает ответ крошечным; если провайдер не режет диапазон — это весь
  // счёт целиком, один поход.
  const wide = await claimLogs(publicClient, agreement, DIAMOND_DEPLOY_BLOCK, head);
  if (wide !== null) return { known: true, turn: countClaimsForAgreement(wide, agreement) };

  // Дорога 2: сужаем окном спора и идём кусками. ВСЕ заявки этой сделки лежат
  // внутри [disputedAt, disputedAt + DISPUTE_WINDOW]: и claimDispute, и
  // releaseDisputeClaim ревертят DisputeWindowPassed за краем окна.
  let from = DIAMOND_DEPLOY_BLOCK;
  let to = head;
  const span = await disputeSpan(publicClient, agreement);
  if (span !== null) {
    const headTs = await blockTimestamp(publicClient, head);
    if (headTs !== null) {
      const lower = await verifiedFrom(publicClient, head, headTs, span.disputedAt);
      if (lower !== null) {
        from = lower > DIAMOND_DEPLOY_BLOCK ? lower : DIAMOND_DEPLOY_BLOCK;
        to = await verifiedTo(publicClient, from, head, span.disputedAt + span.window, span.window);
      }
    }
  }

  const plan = planTurnScan(from, to);
  if (plan === null) return { known: false };

  const all: unknown[] = [];
  for (const chunk of plan) {
    const logs = await claimLogs(publicClient, agreement, chunk.fromBlock, chunk.toBlock);
    // ⚠️ Половина кусков — это не половина счёта, а неизвестный счёт.
    if (logs === null) return { known: false };
    all.push(...logs);
  }
  return { known: true, turn: countClaimsForAgreement(all, agreement) };
}
