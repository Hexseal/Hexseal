/**
 * Разводка логов цепи по уведомлениям — то, что раньше делали тринадцать
 * фильтров на стороне узла.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ПОЯВИЛСЯ. В `hooks/useNotifications.ts` стояло
 * тринадцать `useWatchContractEvent`. Каждый — отдельный цикл опроса, то есть
 * отдельный `eth_getFilterChanges` раз в шесть секунд: замер с телефона показал
 * 135 запросов в минуту на простаивающей странице, 8 100 в час с одной вкладки
 * (`docs/OPEN-ITEMS.md`, пункт 38). Тринадцать превращаются в один общий фильтр
 * по девяти родам событий, а отбор «моё / не моё», который делали `args`
 * фильтров, переезжает сюда.
 *
 * ЧЕМ ЭТО ОПАСНО И ЧТО С ЭТИМ СДЕЛАНО. Отбор в коде легко сделать «почти таким
 * же» и молча потерять род уведомления. Поэтому:
 *
 *  - ветки разводки НЕЗАВИСИМЫ там, где независимы были фильтры. Один лог
 *    `AgreementRegistered` в сделке с самим собой раньше попадал и в фильтр
 *    клиента, и в фильтр исполнителя; здесь обе ветки — отдельные `if`, а не
 *    `else if`. Единственная намеренно взаимоисключающая пара — `DisputeClaimed`:
 *    прежний наблюдатель сторон явно пропускал самого арбитра;
 *  - карта моих сделок пополняется ПО ХОДУ пачки. Так делал прежний код (клал в
 *    `myDeals.current` внутри обработчика), и это обязательное свойство при
 *    догоне: в одной выборке `eth_getLogs` могут лежать и рождение сделки, и
 *    смена её статуса, и вторая обязана узнать сделку, о которой узнала первая;
 *  - каждое назначение проверено отдельным замером в `notifRouter.test.ts`.
 *
 * ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Повторы. Догон после возврата во вкладку намеренно
 * перекрывает уже виденные блоки, и одно и то же событие приходит второй раз.
 * Отсекается уровнем ниже: `pushNotif` (`lib/notifications.ts`) отбрасывает
 * запись с тем же `txHash` и тем же родом. Поэтому КАЖДОЕ уведомление здесь
 * обязано нести `txHash` — без него повтор доедет до колокольчика.
 */

import type { AppNotification, NotifType } from '@/lib/notifications';
import { fmtUSDC } from '@/lib/notifications';
import type { RefreshTopics } from '@/lib/subgraphSync';
import { refundNotifCopy, type SettledRefund } from '@/lib/settledRefund';

export type NotifDraft = Omit<AppNotification, 'id' | 'timestamp' | 'read'>;

export type DealRole = { role: 'client' | 'executor'; amount: bigint };

export interface Viewer {
  /** Адрес подключённого кошелька; `undefined` — кошелёк не подключён. */
  address: string | undefined;
  /** Зарегистрирован ли этот адрес арбитром (нужно для очереди споров). */
  isArbiter: boolean;
  /** Мои сделки: адрес клона в нижнем регистре → роль и сумма. ПОПОЛНЯЕТСЯ по ходу. */
  deals: Map<string, DealRole>;
  /** Мои заказы (id строкой). */
  jobIds: Set<string>;
  /** Мои услуги (id строкой). */
  serviceIds: Set<string>;
}

export function makeViewer(address: string | undefined): Viewer {
  return { address, isArbiter: false, deals: new Map(), jobIds: new Set(), serviceIds: new Set() };
}

export interface RouteResult {
  /** Уведомления в колокольчик, в порядке появления в пачке. */
  notifs: NotifDraft[];
  /**
   * Что перечитать. Разбито по наборам тем, как это делали отдельные
   * наблюдатели: пустой список логов означает «перечитывать нечего», и звать
   * `refreshFromLogs` на него не надо (он сам вернётся ни с чем).
   */
  refreshes: { logs: unknown[]; topics: RefreshTopics }[];
  /** Наибольший номер блока в пачке — курсор догона. */
  maxBlock: bigint | undefined;
  /** Сколько логов оказалось непонятного рода (мусор либо новое событие). */
  unknown: number;
}

export interface RouteDeps {
  /**
   * Разбор статуса REFUNDED(2): настоящий возврат или дележ эскроу по
   * незанятому спору. См. `lib/settledRefund`.
   */
  classifyRefund: (agreement: `0x${string}`, txHash?: `0x${string}`) => Promise<SettledRefund>;
}

/**
 * Девять родов событий, которые становятся УВЕДОМЛЕНИЯМИ (колокольчик, пуш).
 *
 * ⚠️ ЭТО НЕ ТО ЖЕ, ЧТО «рода на проводе». Общий фильтр везёт ещё и
 * `WIRE_ONLY_EVENT_NAMES` — рода, нужные другому читателю; уведомлениями они не
 * становятся и веток в разводке ниже не имеют. Два списка нарочно раздельны и
 * названы по-разному: один отвечает на вопрос «что человек увидит», другой — на
 * «что приехало по проводу», и склеивать их нельзя.
 */
export const NOTIF_EVENT_NAMES = [
  'AgreementRegistered',
  'AgreementStatusUpdated',
  'JobAccepted',
  'JobCancelled',
  'JobApplied',
  'RequestAccepted',
  'RequestRejected',
  'ServiceRequested',
  'DisputeClaimed',
] as const;

export type NotifEventName = (typeof NOTIF_EVENT_NAMES)[number];

/**
 * Рода, которые едут ПО ОБЩЕМУ ПРОВОДУ, но уведомлениями НЕ становятся.
 *
 * ЗАЧЕМ ОНИ ЗДЕСЬ. Их читает слежение за сменой арбитра
 * (`lib/disputeArbiter.ts`): «арбитр сменился или повернул ключ — предъявите
 * заново». Своего цикла опроса слежение не заводит намеренно — третий фильтр на
 * странице спора сломал бы бюджет опроса цепи (`hooks/chainPollBudget.test.ts`:
 * не больше двух циклов и восьми запросов в минуту), а замер 9 августа, ради
 * которого этот бюджет заведён, — 8 100 обращений в час с одной вкладки.
 * Поэтому рода добавлены в общий фильтр: тот же фильтр, тот же такт, НОЛЬ лишних
 * обращений — растёт только массив `topics[0]`.
 *
 * ⚠️ НАЗВАНЫ ОНИ ИМЕННО ЗДЕСЬ, ЧТОБЫ НЕ СЧИТАТЬСЯ МУСОРОМ. Разводка ниже кладёт
 * всё, чего нет в `KNOWN`, в счётчик `unknown` («мусор либо новое событие»). Эти
 * два рода не мусор — они везутся нарочно, и счётчик о них знать обязан.
 * Замок — `notifRouter.test.ts`, «рода с провода не считаются мусором».
 *
 * ⚠️ И ГЛАВНОЕ: уведомлением такой род не становится НИКОГДА. Человеку от смены
 * ключа арбитра не прилетает ни колокольчик, ни пуш. Замок на это отдельный —
 * `notifRouter.test.ts`, «род с провода не превращается в уведомление».
 */
export const WIRE_ONLY_EVENT_NAMES = ['DisputeReleased', 'ArbiterChatKeySet'] as const;

export type WireOnlyEventName = (typeof WIRE_ONLY_EVENT_NAMES)[number];

const KNOWN = new Set<string>(NOTIF_EVENT_NAMES);
const WIRE_ONLY = new Set<string>(WIRE_ONLY_EVENT_NAMES);

// ── мелкие безопасные читатели ───────────────────────────────────────────────
//
// Всё, что приходит из цепи, читается через них: `strict: false` у фильтра viem
// означает, что лог с неподошедшей раскладкой доедет сюда с `args: undefined`, а
// узел под нагрузкой может отдать и вовсе не то. Падение здесь стоило бы всей
// пачки — а в пачке лежат чужие уведомления тоже.

function addr(v: unknown): string | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
}

function same(a: unknown, b: string | undefined): boolean {
  const x = addr(a);
  return x !== null && b !== undefined && x === b.toLowerCase();
}

function idStr(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v;
  return null;
}

function money(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(0);
}

function statusOf(v: unknown): number | null {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function argsOf(log: unknown): any {
  const a = (log as { args?: unknown } | null | undefined)?.args;
  return a && typeof a === 'object' ? a : null;
}

function txOf(log: unknown): `0x${string}` | undefined {
  const h = (log as { transactionHash?: unknown } | null | undefined)?.transactionHash;
  return typeof h === 'string' ? (h as `0x${string}`) : undefined;
}

function blockOf(log: unknown): bigint | undefined {
  const b = (log as { blockNumber?: unknown } | null | undefined)?.blockNumber;
  return typeof b === 'bigint' ? b : undefined;
}

function nameOf(log: unknown): string | null {
  const n = (log as { eventName?: unknown } | null | undefined)?.eventName;
  return typeof n === 'string' ? n : null;
}

/**
 * Наборы тем перечитывания — по одному на каждый прежний наблюдатель.
 * Ключи произвольны, важна только группировка: логи одного набора уезжают в
 * `refreshFromLogs` одним вызовом, как это было у отдельных наблюдателей.
 */
const BUCKETS = {
  dealAsClient:     { chain: ['deals', 'requests', 'wallet'], graph: ['deals'] },
  dealAsExecutor:   { chain: ['deals', 'jobs', 'services'],   graph: ['deals'] },
  statusMine:       { chain: ['deals', 'wallet'],             graph: ['deals'] },
  statusForArbiter: { chain: ['arbiter'] },
  jobAccepted:      { chain: ['deals', 'jobs'],               graph: ['deals', 'jobs'] },
  jobCancelled:     { chain: ['jobs', 'wallet'],              graph: ['jobs'] },
  requestAsClient:  { chain: ['deals', 'requests'],           graph: ['deals'] },
  requestAsExec:    { chain: ['deals', 'requests', 'services'], graph: ['deals', 'services'] },
  requestRejected:  { chain: ['requests', 'wallet'] },
  disputeAsArbiter: { chain: ['arbiter', 'deals'] },
  disputeParties:   { chain: ['deals'] },
  jobApplied:       { chain: ['jobs'],                        graph: ['jobs'] },
  serviceRequested: { chain: ['requests', 'wallet'] },
} as const satisfies Record<string, RefreshTopics>;

type BucketName = keyof typeof BUCKETS;

/**
 * Развести пачку логов. Не бросает: любой непонятный лог считается мусором и
 * учитывается в `unknown`.
 *
 * ⚠️ Мутирует `viewer.deals` — намеренно, см. шапку файла.
 */
export async function routeNotifLogs(
  logs: readonly unknown[],
  viewer: Viewer,
  deps: RouteDeps,
): Promise<RouteResult> {
  const notifs: NotifDraft[] = [];
  const buckets = new Map<BucketName, unknown[]>();
  let maxBlock: bigint | undefined;
  let unknown = 0;

  const me = viewer.address;
  const put = (b: BucketName, log: unknown) => {
    const cur = buckets.get(b);
    if (cur) cur.push(log);
    else buckets.set(b, [log]);
  };

  for (const log of logs) {
    const block = blockOf(log);
    if (block !== undefined && (maxBlock === undefined || block > maxBlock)) maxBlock = block;

    const event = nameOf(log);
    if (event === null) { unknown++; continue; }
    // Род везётся по общему проводу ради ДРУГОГО читателя (слежение за сменой
    // арбитра). Не мусор и не уведомление: молча пропускаем, счётчик не трогаем.
    if (WIRE_ONLY.has(event)) continue;
    if (!KNOWN.has(event)) { unknown++; continue; }
    const args = argsOf(log);
    if (args === null) { unknown++; continue; }
    // Кошелёк не подключён — уведомлять некого. Курсор блока при этом уже учтён.
    if (!me) continue;

    const tx = txOf(log);

    switch (event as NotifEventName) {
      // ── AgreementRegistered ────────────────────────────────────────────────
      // Две независимые ветки: прежде это были два фильтра, и в сделке с самим
      // собой срабатывали оба.
      case 'AgreementRegistered': {
        const agreement = addr(args.agreement);
        if (agreement === null) { unknown++; break; }
        const amount = money(args.amount);
        if (same(args.client, me)) {
          viewer.deals.set(agreement, { role: 'client', amount });
          notifs.push({
            type: 'deal_new',
            title: 'Deal Created',
            body: `Deal funded for $${fmtUSDC(amount)} USDC — the executor can now activate to start.`,
            link: `/deal/${args.agreement}`,
            txHash: tx,
          });
          put('dealAsClient', log);
        }
        if (same(args.executor, me)) {
          viewer.deals.set(agreement, { role: 'executor', amount });
          notifs.push({
            type: 'deal_new',
            title: "You've Been Hired!",
            body: `New deal for $${fmtUSDC(amount)} USDC. Activate to start working.`,
            link: `/deal/${args.agreement}`,
            txHash: tx,
          });
          put('dealAsExecutor', log);
        }
        break;
      }

      // ── AgreementStatusUpdated ─────────────────────────────────────────────
      // Прежний наблюдатель шёл без `args` и получал переходы всей биржи; отбор
      // и тогда был здесь, в коде. Enum реестра: ACTIVE=0, COMPLETED=1,
      // REFUNDED=2, DISPUTED=3, RESOLVED=4.
      case 'AgreementStatusUpdated': {
        const agreement = addr(args.agreement);
        if (agreement === null) { unknown++; break; }
        const status = statusOf(args.newStatus);
        if (status === null) { unknown++; break; }
        const info = viewer.deals.get(agreement);

        if (!info) {
          // Сделка не моя. Арбитру интересен ровно один переход — в спор.
          if (viewer.isArbiter && status === 3) {
            notifs.push({
              type: 'dispute_new',
              title: 'New Dispute Available',
              body: 'A dispute is open — be the first to claim and resolve it.',
              link: '/arbiter',
              txHash: tx,
            });
            put('statusForArbiter', log);
          }
          break;
        }

        // Отмечаем ДО разбора статуса: у ACTIVE(0) уведомления нет, но данные он
        // делает несвежими ровно так же.
        put('statusMine', log);

        const role = info.role;
        const msgMap: Partial<Record<number, [NotifType, string, string]>> = {
          1: ['deal_completed', 'Deal Complete', role === 'client' ? 'Payment successfully released to executor.' : 'Payment has been released to your wallet!'],
          2: ['deal_refunded', 'Deal Refunded', role === 'client' ? 'Funds returned to your wallet.' : 'The deal was refunded to the client.'],
          3: ['deal_disputed', 'Dispute Raised', role === 'client' ? 'A dispute was opened on your deal.' : 'Client raised a dispute — arbiter will review.'],
          4: ['deal_resolved', 'Dispute Resolved', 'The arbiter has resolved the dispute.'],
        };
        const entry = msgMap[status];
        if (!entry) break;

        let [, title, body] = entry;
        // REFUNDED(2) — два разных исхода под одним статусом: настоящий возврат
        // и дележ эскроу по спору, который никто не занял. Реестр их не
        // различает, различает сама сделка (`lib/settledRefund`).
        if (status === 2) {
          try {
            const outcome = await deps.classifyRefund(args.agreement as `0x${string}`, tx);
            ({ title, body } = refundNotifCopy(outcome, role));
          } catch {
            // Разбор не удался — оставляем нейтральный текст реестра, но
            // уведомление НЕ теряем: человек обязан узнать, что сделка закрыта.
          }
        }

        notifs.push({ type: entry[0], title, body, link: `/deal/${args.agreement}`, txHash: tx });
        break;
      }

      // ── JobAccepted ────────────────────────────────────────────────────────
      case 'JobAccepted': {
        const jobId = idStr(args.jobId);
        const agreement = addr(args.agreement);
        const link = agreement ? `/deal/${args.agreement}` : '/dashboard';
        if (same(args.executor, me)) {
          notifs.push({
            type: 'deal_new',
            title: 'Application Accepted',
            body: `Your application for Job #${jobId ?? '?'} was accepted.`,
            link,
            txHash: tx,
          });
          put('jobAccepted', log);
        }
        if (same(args.client, me)) {
          notifs.push({
            type: 'deal_new',
            title: 'Executor Accepted',
            body: `Executor confirmed for Job #${jobId ?? '?'}. Deal is ready.`,
            link,
            txHash: tx,
          });
          put('jobAccepted', log);
        }
        break;
      }

      // ── JobCancelled ───────────────────────────────────────────────────────
      case 'JobCancelled': {
        if (!same(args.client, me)) break;
        const jobId = idStr(args.jobId);
        notifs.push({
          type: 'job_cancelled',
          title: 'Job Cancelled',
          body: `Job #${jobId ?? '?'} cancelled. $${fmtUSDC(money(args.refundAmount))} USDC refunded.`,
          link: jobId !== null ? `/job/${jobId}` : '/dashboard',
          txHash: tx,
        });
        put('jobCancelled', log);
        break;
      }

      // ── JobApplied ─────────────────────────────────────────────────────────
      // Прежний наблюдатель без `args`: отклики на ВСЕ заказы биржи. Две ветки
      // взаимоисключающие — так было и раньше (`continue` после своей).
      case 'JobApplied': {
        const jobId = idStr(args.jobId);
        if (same(args.executor, me)) {
          notifs.push({
            type: 'job_applied',
            title: 'Application Submitted',
            body: `Applied to Job #${jobId ?? '?'}. Waiting for client to review.`,
            link: jobId !== null ? `/job/${jobId}` : '/dashboard',
            txHash: tx,
          });
          put('jobApplied', log);
          break;
        }
        if (jobId !== null && viewer.jobIds.has(jobId)) {
          notifs.push({
            type: 'job_applied',
            title: 'New Applicant',
            body: `Someone applied to your Job #${jobId}. Review on the job page.`,
            link: `/job/${jobId}`,
            txHash: tx,
          });
          put('jobApplied', log);
        }
        break;
      }

      // ── RequestAccepted ────────────────────────────────────────────────────
      case 'RequestAccepted': {
        const agreement = addr(args.agreement);
        const link = agreement ? `/deal/${args.agreement}` : '/dashboard';
        if (same(args.client, me)) {
          notifs.push({
            type: 'deal_new',
            title: 'Request Accepted',
            body: 'Your service request was accepted. Deal has been created.',
            link,
            txHash: tx,
          });
          put('requestAsClient', log);
        }
        if (same(args.executor, me)) {
          notifs.push({
            type: 'deal_new',
            title: 'Request Accepted',
            body: 'You accepted a service request. Deal has been created.',
            link,
            txHash: tx,
          });
          put('requestAsExec', log);
        }
        break;
      }

      // ── RequestRejected ────────────────────────────────────────────────────
      case 'RequestRejected': {
        if (!same(args.client, me)) break;
        const requestId = idStr(args.requestId);
        notifs.push({
          type: 'service_rejected',
          title: 'Request Declined',
          body: 'The executor declined your service request.',
          link: requestId !== null ? `/request/${requestId}` : '/dashboard',
          txHash: tx,
        });
        put('requestRejected', log);
        break;
      }

      // ── ServiceRequested ───────────────────────────────────────────────────
      case 'ServiceRequested': {
        const requestId = idStr(args.requestId);
        const serviceId = idStr(args.serviceId);
        const link = requestId !== null ? `/request/${requestId}` : '/dashboard';
        if (same(args.client, me)) {
          notifs.push({
            type: 'service_requested',
            title: 'Request Sent',
            body: `Your request for $${fmtUSDC(money(args.amount))} USDC has been sent. Waiting for executor.`,
            link,
            txHash: tx,
          });
          put('serviceRequested', log);
          break;
        }
        if (serviceId !== null && viewer.serviceIds.has(serviceId)) {
          notifs.push({
            type: 'service_requested',
            title: 'New Service Request',
            body: `A client requested your service for $${fmtUSDC(money(args.amount))} USDC.`,
            link,
            txHash: tx,
          });
          put('serviceRequested', log);
        }
        break;
      }

      // ── DisputeClaimed ─────────────────────────────────────────────────────
      // Единственная намеренно взаимоисключающая пара: прежний наблюдатель
      // сторон явно пропускал самого арбитра, чтобы тот не получил два
      // уведомления об одном событии.
      case 'DisputeClaimed': {
        const agreement = addr(args.agreement);
        if (same(args.arbiter, me)) {
          // Прежний код клал сделку в карту с ролью `client` и нулевой суммой —
          // не потому что арбитр клиент, а чтобы последующие смены статуса по
          // этой сделке узнавались как «мои». Свойство сохранено намеренно.
          if (agreement !== null) viewer.deals.set(agreement, { role: 'client', amount: BigInt(0) });
          notifs.push({
            type: 'dispute_claimed',
            title: 'Dispute Claimed',
            body: 'You have 7 days to review and resolve this case.',
            link: '/arbiter',
            txHash: tx,
          });
          put('disputeAsArbiter', log);
          break;
        }
        if (agreement === null) { unknown++; break; }
        if (!viewer.deals.has(agreement)) break;
        notifs.push({
          type: 'dispute_arbiter_claimed',
          title: 'Arbiter Assigned',
          body: 'An arbiter has taken your dispute. Resolution expected within 7 days.',
          link: `/deal/${args.agreement}`,
          txHash: tx,
        });
        put('disputeParties', log);
        break;
      }
    }
  }

  const refreshes = (Object.keys(BUCKETS) as BucketName[]).map((name) => ({
    logs: buckets.get(name) ?? [],
    topics: BUCKETS[name] as RefreshTopics,
  }));

  return { notifs, refreshes, maxBlock, unknown };
}
