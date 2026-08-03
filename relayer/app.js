import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import webpush from 'web-push';
import fs, { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: '.env.relayer' });

// Задача 3 (chat-transport-storage): статические импорты, не
// `const { X } = await import(...)` — тот и другой модуль экспортируют
// `export let` (DIR_BAGS, MAX_BAG_SIZE, ...), и только именованный статический
// import (или обращение через пространство имён) даёт живую ссылку, которая
// видит значения ПОСЛЕ assertBagStoreReady()/assertBagPassReady() ниже, а не
// снимок на момент этой строки — см. заголовок test/bagStore.test.js.
//
// Текстуально ПОСЛЕ dotenv.config() по требованию ревью Задачи 3. Строго
// говоря это не меняет порядок ВЫПОЛНЕНИЯ — ESM вычисляет все импорты раньше
// тела импортирующего модуля независимо от того, где текстуально стоит
// `import`, так что bagStore.js/bagPass.js в любом случае получают
// управление до этой строки. Оба спроектированы это пережить (ленивое чтение
// секрета в bagPass.js; module-level `_refreshConfig()` в bagStore.js,
// повторно вызываемая из assertBagStoreReady()) — но текстовый порядок здесь
// дешевле и надёжнее как сигнал для читателя, поэтому он такой.
import {
  bagKeyFor, recordBag, markFetched, listBagsFor, bagMetaOf, bagPathFor,
  assertBagStoreReady, MAX_BAG_SIZE,
} from './bagStore.js';
import { bagPassChallenge, issueBagPass, verifyBagPass, assertBagPassReady } from './bagPass.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────

let VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL     = process.env.VAPID_EMAIL || 'mailto:admin@hexseal.net';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY  = keys.publicKey;
  VAPID_PRIVATE_KEY = keys.privateKey;
  console.warn('[push] VAPID keys not set — generated for this session only.');
  console.warn('[push] Add to .env to persist subscriptions across restarts:');
  console.warn(`VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}`);
  console.warn(`VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}`);
  console.warn(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}`);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Absolute, and honours STORAGE_DIR like every other storage path (see STORAGE_DIR
// below — this constant is declared earlier, so the same default is inlined). It used
// to be the relative './storage/push_subscriptions.json', which only resolved by
// accident from the container WORKDIR and silently pointed at a file that did not
// exist after the store was moved — so the relayer loaded an empty map and every push
// was sent to zero subscriptions with no error logged anywhere.
const PUSH_SUBS_FILE = path.join(
  process.env.STORAGE_DIR || path.join(__dirname, 'storage'),
  'push_subscriptions.json',
);
function loadPushSubs() {
  try {
    if (existsSync(PUSH_SUBS_FILE)) {
      const raw = JSON.parse(readFileSync(PUSH_SUBS_FILE, 'utf8'));
      return new Map(Object.entries(raw));
    }
  } catch (e) {
    // The paragraph above describes this exact outcome happening in production —
    // an empty map means every push for every user is dropped for the whole life
    // of the process. The path bug got fixed; the SILENCE around it did not, so a
    // truncated write or an EACCES still produced a perfectly healthy-looking
    // relayer that delivered nothing. A corrupt store is a loud failure now.
    console.error(`[push] FAILED TO LOAD ${PUSH_SUBS_FILE} — starting with ZERO subscriptions, no push will be delivered:`, e.message);
  }
  return new Map();
}
function savePushSubs() {
  try {
    const obj = Object.fromEntries(_pushSubs);
    // loadPushSubs()/savePushSubs() run at module load, before the storage dirs are
    // created further down — make sure the directory exists or the write is lost.
    fs.mkdirSync(path.dirname(PUSH_SUBS_FILE), { recursive: true });
    writeFileSync(PUSH_SUBS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    // /push/subscribe answers {ok:true} off the in-memory map regardless, so a
    // read-only volume or a full disk used to mean: the user is told he is
    // subscribed, the subscription dies at the next restart, and nobody ever finds
    // out. At minimum the operator gets to see it.
    console.error(`[push] FAILED TO PERSIST ${PUSH_SUBS_FILE} — subscriptions live in memory only and are lost on restart:`, e.message);
  }
}
const _pushSubs = loadPushSubs();

async function sendPush(address, payload) {
  const subs = _pushSubs.get(address?.toLowerCase()) ?? [];
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      // 404/410 = endpoint gone. 400/401/403 = the subscription was created with a
      // DIFFERENT VAPID key (VapidPkHashMismatch) and can never be delivered to
      // again — it was previously only logged and kept, so a stale subscription was
      // retried forever and the user's push stayed dead even after re-subscribing.
      if ([400, 401, 403, 404, 410].includes(e.statusCode)) {
        dead.push(sub.endpoint);
        console.warn('[push] dropping undeliverable subscription:', e.statusCode, e.body ?? e.message ?? '');
      } else {
        // Anything else (429, network errors, ...) is transient — log, keep, retry.
        console.error('[push] sendNotification failed:', e.statusCode ?? '', e.body ?? e.message ?? e);
      }
    }
  }
  if (dead.length) {
    _pushSubs.set(address.toLowerCase(), subs.filter(s => !dead.includes(s.endpoint)));
    savePushSubs();
  }
}

// ─── Agreement ABI ────────────────────────────────────────────────────────────

const AGREEMENT_MINI_ABI = [
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, string terms_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
  // Срок отклика на спор. Читается с контракта, а не берётся из константы здесь:
  // DISPUTE_WINDOW уже менялась однажды (7 дней → 4), и захардкоженное число
  // начнёт врать в пуше молча — а пуш живёт в шторке уведомлений, его не
  // отзовёшь. Тем же способом читает фронт (frontend/src/app/deal/[address]).
  'function DISPUTE_WINDOW() view returns (uint256)',
];

const REGISTRY_MINI_ABI = [
  'function getDisputed() view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt)[])',
];

// ─── Who is the arbiter of a dispute (and why NOT Agreement.arbiter) ──────────
//
// Agreement.arbiter is never a human. claimDispute() sets it to the DIAMOND
// itself (Diamond-as-arbiter, so the diamond controls verdict execution,
// freezing and overturns) — see ArbiterRegistryFacet.sol, the comment block
// above creditDisputeFee. So comparing a recovered signer against
// getDetails().arbiter_ is "diamond vs human" and is false for everybody,
// always: it locked every arbiter out of the dispute log on the live server.
//
// The real arbiter lives on the diamond, in two mappings that cover different
// stages of one dispute:
//
//   disputeClaims[agreement]        — written by claimDispute(), the ONLY field
//     populated between claiming a dispute and submitting a verdict. That is
//     exactly the window in which an arbiter needs to read the log: he reads to
//     decide. Deleted by releaseDisputeClaim() (he gave the case back) and by
//     clearDisputeClaim() (the agreement left the dispute).
//
//   pendingVerdicts[agreement].arbiter — written by submitVerdict(), which also
//     requires the caller to BE disputeClaims[agreement], so the two can never
//     name different people. It outlives the claim: finalizeVerdict() holds
//     v.executing = true across the call into the agreement, and that flag is
//     precisely what stops clearDisputeClaim() from deleting the verdict while
//     the claim itself is cleared.
//
// Hence the union below, in that order. Before a verdict only the first exists;
// after a finalized verdict only the second does; in between both agree. On the
// timeout path (nobody claimed, or the claimer never delivered) BOTH are wiped,
// and access ends — which is right: nobody adjudicated that dispute.
const ARBITER_REGISTRY_MINI_ABI = [
  'function getDisputeClaimer(address agreement) view returns (address)',
  'function getPendingVerdict(address agreement) view returns (tuple(address arbiter, bool clientWins, uint256 submittedAt, bool frozen, bool finalized, bool overturned, bool executing, bool appealed, bool appealResolved, address appellant, uint256 appealDeadline, uint256 votesUphold, uint256 votesOverturn))',
];

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * The address currently entitled to read this deal's dispute log, or null.
 * Reads the DIAMOND, never the agreement — see the block above.
 */
async function disputeArbiterOf(agreement) {
  const registry = new ethers.Contract(DIAMOND_ADDR, ARBITER_REGISTRY_MINI_ABI, provider);

  const claimer = (await registry.getDisputeClaimer(agreement))?.toLowerCase();
  if (claimer && claimer !== ZERO_ADDR) return claimer;

  // No live claim: either the dispute was never claimed, or it already ran to a
  // finalized verdict (which clears the claim but keeps the verdict record).
  const verdict = await registry.getPendingVerdict(agreement);
  if (!verdict) return null;
  // submittedAt == 0 is the facet's own "no verdict here" sentinel (finalizeVerdict
  // reverts NoVerdict on it); a zeroed struct decodes to arbiter == address(0) too,
  // so check both rather than trusting one of them.
  if (BigInt(verdict.submittedAt ?? 0) === 0n) return null;
  const arbiter = verdict.arbiter?.toLowerCase();
  if (!arbiter || arbiter === ZERO_ADDR) return null;
  return arbiter;
}

// Board / service / dispute-claim events. These are emitted by the Diamond (not an
// Agreement), so they can't be resolved from the relayed tx target the way
// AGR_PUSH_MSG/FUNC_PUSH_MSG are — pushBoardEvents() scans the receipt logs and
// resolves recipients from the event args (JobApplied/ServiceRequested need one
// follow-up read via getJob/getService for the poster's address).
const BOARD_EVENT_ABI = [
  'event JobApplied(uint256 indexed jobId, address indexed executor)',
  'event JobAccepted(uint256 indexed jobId, address indexed client, address indexed executor, address agreement)',
  'event ServiceRequested(uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount)',
  'event RequestAccepted(uint256 indexed requestId, address indexed executor, address indexed client, address agreement)',
  'event RequestRejected(uint256 indexed requestId, address indexed executor, address indexed client)',
  'event DisputeClaimed(address indexed agreement, address indexed arbiter)',
  'event AppealRaised(address indexed agreement, address indexed appellant)',
];
const boardEventInterface = new ethers.Interface(BOARD_EVENT_ABI);
const JOB_MINI_ABI = [
  'function getJob(uint256) view returns (tuple(address client, string title, string description, uint256 amount, uint256 deadlineDays, string terms, uint8 region, uint8 status, uint256 createdAt, address chosenExecutor, address agreement))',
];
const SERVICE_MINI_ABI = [
  'function getService(uint256) view returns (tuple(address executor, string title, string description, uint256 price, uint256 deadlineDays, uint8 region, uint8 status, uint256 createdAt, uint256 hiresCount))',
];

// Set of pairIds currently holding a DISPUTED agreement — one on-chain call per
// cleanup run, not per file.
async function getDisputedPairIds() {
  try {
    const registry = new ethers.Contract(DIAMOND_ADDR, REGISTRY_MINI_ABI, provider);
    const disputed = await registry.getDisputed();
    return new Set(disputed.map((r) => pairIdFromAddresses(r.client, r.executor)));
  } catch (e) {
    console.error('[files] getDisputed lookup failed, skipping TTL protection this run:', e.message);
    return new Set(); // fail open on the on-chain read — never block cleanup entirely
  }
}

const AGR_STATUS_EVENT_ABI = [
  'event AgreementStatusUpdated(address indexed agreement, uint8 newStatus)',
];
const agrEventInterface = new ethers.Interface(AGR_STATUS_EVENT_ABI);

// Push config for RegistryFacet.AgreementStatus event (ACTIVE=0, COMPLETED=1, REFUNDED=2, DISPUTED=3, RESOLVED=4).
// ACTIVE(0) is omitted — fund() doesn't call updateStatus in the current contract.
// notify: 'executor' | 'client' | 'both' | 'both+arbiter'
//
// DISPUTED(3) is a fallback here, not the normal path: the two parties are in
// opposite positions the moment a dispute is raised (only the non-raiser can
// still respond, and only she loses a quarter by not doing it), so one message
// for both roles is wrong by construction. When the receipt carries the
// agreement's own DisputeRaised — every real raiseDispute does —
// sendDisputeRaised() splits it into two messages and this row goes to the
// raiser alone. It is still reached by a later syncRegistry() that carries the
// status without the raiser.
const AGR_PUSH_MSG = {
  1: { title: 'Deal Complete',      body: 'Payment has been released. The deal is closed.',      notify: 'both'         },
  2: { title: 'Deal Refunded',       body: 'The deal was cancelled and refunded.',                notify: 'both'         },
  3: { title: 'Dispute Raised',   body: 'A dispute was opened. An arbiter will review.',      notify: 'both+arbiter' },
  4: { title: 'Dispute Resolved', body: 'The arbiter has resolved the dispute.',              notify: 'both'         },
};

// ─── REFUNDED(2) is two different outcomes ────────────────────────────────────
//
// Agreement.triggerArbiterTimeout() ends the deal one of two ways, and the
// Registry gets the same REFUNDED(2) for both — the enum mirrors the agreement's
// frozen `enum Status` and cannot grow, so what distinguishes the cases is an
// event, not a status:
//
//   • nobody ever claimed the dispute → the escrow is SPLIT (floor(pot/2) to the
//     executor, the remainder to the client) and DisputeSplitNoVerdict is emitted;
//   • an arbiter claimed it and never delivered → the whole pot goes back to the
//     client and ArbiterTimedOut is emitted.
//
// Without this distinction AGR_PUSH_MSG[2] told an executor who had just received
// half the escrow that "the deal was cancelled and refunded" — the lie lands in
// the OS notification tray and stays there, unlike an on-screen toast.
//
// The signal is free: DisputeSplitNoVerdict is in the SAME receipt as the
// AgreementStatusUpdated we already decode (Agreement emits it after
// _complete()), so no extra chain read is needed.
const AGR_SPLIT_EVENT_ABI = [
  'event DisputeSplitNoVerdict(uint256 toClient, uint256 toExecutor)',
];
const agrSplitInterface = new ethers.Interface(AGR_SPLIT_EVENT_ABI);

const AGR_RESPONDED_EVENT_ABI = [
  'event DisputeResponded(address indexed party)',
];
const agrRespondedInterface = new ethers.Interface(AGR_RESPONDED_EVENT_ABI);

// Who raised the dispute. The Diamond's AgreementStatusUpdated says only THAT a
// dispute exists, never by whom — and the two parties are in opposite positions
// from the moment it is raised (see sendDisputeRaised below), so the raiser's
// address is what decides who gets which message. Agreement-emitted, hence its
// own interface rather than boardEventInterface.
const AGR_RAISED_EVENT_ABI = [
  'event DisputeRaised(address indexed by)',
];
const agrRaisedInterface = new ethers.Interface(AGR_RAISED_EVENT_ABI);

/** REFUNDED(2), the status the split shares with a genuine refund. */
const AGR_STATUS_REFUNDED = 2;

/** DISPUTED(3) — the status whose two recipients need two different messages. */
const AGR_STATUS_DISPUTED = 3;

/**
 * Exact USDC amount, never shorter than two decimals: 200000000 → "200.00",
 * 33 → "0.000033". Rounding is not allowed here — these numbers have to match
 * what the contract actually paid, and the pot splits unevenly when it is odd.
 */
export function usdcExact(value) {
  const [whole, frac = ''] = ethers.formatUnits(value ?? 0n, 6).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

/**
 * DisputeSplitNoVerdict from THIS agreement in a mined receipt, or null.
 * Address-scoped on purpose: only the agreement the relayed call targeted may
 * decide how that deal's push reads.
 */
export function findDisputeSplit(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrSplitInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeSplitNoVerdict') {
      return { toClient: ev.args.toClient, toExecutor: ev.args.toExecutor };
    }
  }
  return null;
}

/**
 * Who responded to the dispute in this transaction. Scoped by agreement address
 * for the same reason as findDisputeSplit: the agreement itself emits this event,
 * not the Diamond, so it never lands in the shared boardEventInterface.
 */
export function findDisputeResponded(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrRespondedInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeResponded') return { party: ev.args.party };
  }
  return null;
}

/**
 * Both amounts, as numbers rather than the word "half": on an odd pot they
 * differ by a unit, and if USDC has blacklisted the executor the contract sends
 * his half to the client instead — in which case the event carries a zero and
 * this message says so, which is the truth.
 */
export function disputeSplitPushMsg({ toClient, toExecutor }) {
  return {
    title: 'Escrow Split',
    body:  `Nobody took the dispute, so there was nobody to judge it. The escrow was split: `
         + `${usdcExact(toExecutor)} USDC to the executor, ${usdcExact(toClient)} USDC to the client.`,
    notify: 'both',
  };
}

/**
 * Who raised the dispute, from this agreement's own log in a mined receipt, or
 * null. Address-scoped for the same reason as findDisputeSplit.
 */
export function findDisputeRaised(logs, agreementAddress) {
  const target = agreementAddress?.toLowerCase();
  for (const log of logs ?? []) {
    if (target && log.address?.toLowerCase() !== target) continue;
    let ev;
    try { ev = agrRaisedInterface.parseLog(log); } catch { continue; }
    if (ev?.name === 'DisputeRaised') return { by: ev.args.by };
  }
  return null;
}

/**
 * Unambiguous instant, in UTC to the minute: "2026-08-03 09:41 UTC". The relayer
 * has no user locale to render into (every push string here is hardcoded
 * English), and a bare date would hide up to a day of the window.
 */
export function utcMinuteLabel(date) {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * When the response window closes, as a Date — or null if it could not be read.
 *
 * NOT `now + 4 days`. `DISPUTE_WINDOW` already changed once (7 days → 4), a
 * hardcoded number would start lying silently, and unlike an on-screen hint a
 * push sits in the notification tray until it is dismissed. The frontend reads
 * it from the contract for exactly this reason; so does this.
 *
 * `disputedAt` costs nothing extra — it already came back in the `getDetails()`
 * the caller does anyway — so the only added read is the window itself. Using
 * the contract's own `disputedAt` rather than the block time of the receipt also
 * makes the printed instant the one `triggerArbiterTimeout` will actually
 * compare against, with no room for the two to drift.
 */
async function disputeResponseDeadline(agreementAddress, disputedAt) {
  if (!disputedAt) return null;
  try {
    const agr = new ethers.Contract(agreementAddress, AGREEMENT_MINI_ABI, provider);
    const window = await agr.DISPUTE_WINDOW();
    return new Date(Number(BigInt(disputedAt) + BigInt(window)) * 1000);
  } catch (e) {
    // Degrade, don't drop: the price of silence is still worth saying, and the
    // deal page shows the exact deadline. Staying quiet would be the bug this
    // whole message exists to fix.
    console.warn('[push] DISPUTE_WINDOW read failed — warning goes out without a date:', e.message ?? e);
    return null;
  }
}

/**
 * The message for the side that has NOT responded — the only one with anything
 * at stake. Names the deadline and the price of silence, because a rule nobody
 * is told about before it fires is a trap, not a rule.
 */
export function disputeRaisedWarningMsg(deadline) {
  const by = deadline ? ` by ${utcMinuteLabel(deadline)}` : '';
  return {
    title: 'Answer the Dispute',
    body:  `A dispute was opened on your deal. Answer it${by} — if you stay silent `
         + 'and nobody takes the case, you get a quarter of the escrow instead of half.',
  };
}

// activate(), markDone(), and fund() don't emit AgreementStatusUpdated,
// so we detect them by function selector and send push directly.
const FUNC_PUSH_MSG = {
  '0xb60d4288': { title: 'Deal Funded',      body: 'Your deal has been funded. Activate to start working.',    notify: 'executor' },
  '0x0f15f4c0': { title: 'Deal Activated',  body: 'Work has started. Track progress in the deal page.',        notify: 'client'   },
  '0x1bdfc6e3': { title: 'Work Submitted',   body: 'The executor marked the job as done. Please review it.',   notify: 'client'   },
};

// OS pushes for Diamond-emitted board / service / dispute-claim events. Recipients come
// straight from the event args, except JobApplied/ServiceRequested where the poster's
// address is read via getJob/getService. Independent of the relayed tx target.
async function pushBoardEvents(receipt) {
  for (const log of receipt.logs) {
    let ev;
    try { ev = boardEventInterface.parseLog(log); } catch { continue; }
    if (!ev) continue;
    try {
      switch (ev.name) {
        case 'JobAccepted':
          await sendPush(ev.args.executor.toLowerCase(), {
            title: "You're Hired",
            body:  'Your application was accepted. The deal is funded — activate to start.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        case 'RequestAccepted':
          await sendPush(ev.args.client.toLowerCase(), {
            title: 'Request Accepted',
            body:  'The executor accepted your request. The deal is live.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        case 'RequestRejected':
          await sendPush(ev.args.client.toLowerCase(), {
            title: 'Request Declined',
            body:  'The executor declined your request. Your funds were refunded.',
            url:   '/dashboard',
          });
          break;
        case 'JobApplied': {
          const board = new ethers.Contract(DIAMOND_ADDR, JOB_MINI_ABI, provider);
          const job = await board.getJob(ev.args.jobId);
          if (job?.client) await sendPush(job.client.toLowerCase(), {
            title: 'New Applicant',
            body:  'Someone applied to your job. Review and pick your executor.',
            url:   `/job/${ev.args.jobId}`,
          });
          break;
        }
        case 'ServiceRequested': {
          const board = new ethers.Contract(DIAMOND_ADDR, SERVICE_MINI_ABI, provider);
          const svc = await board.getService(ev.args.serviceId);
          if (svc?.executor) await sendPush(svc.executor.toLowerCase(), {
            title: 'New Service Request',
            body:  `A client requested your service (${(Number(ev.args.amount) / 1e6).toFixed(2)} USDC). Accept to start.`,
            url:   `/request/${ev.args.requestId}`,
          });
          break;
        }
        case 'DisputeClaimed': {
          const agr = new ethers.Contract(ev.args.agreement, AGREEMENT_MINI_ABI, provider);
          const d = await agr.getDetails();
          const payload = { title: 'Arbiter Assigned', body: 'An arbiter took your dispute. Expect a resolution soon.', url: `/deal/${ev.args.agreement}` };
          if (d.client_)   await sendPush(d.client_.toLowerCase(),   payload);
          if (d.executor_) await sendPush(d.executor_.toLowerCase(), payload);
          break;
        }
        case 'AppealRaised': {
          const agr = new ethers.Contract(ev.args.agreement, AGREEMENT_MINI_ABI, provider);
          const d = await agr.getDetails();
          const appellant = ev.args.appellant.toLowerCase();
          const other = d.client_?.toLowerCase() === appellant ? d.executor_ : d.client_;
          if (other) await sendPush(other.toLowerCase(), {
            title: 'Verdict Appealed',
            body:  'The dispute verdict was appealed and is under review.',
            url:   `/deal/${ev.args.agreement}`,
          });
          break;
        }
      }
    } catch (e) {
      console.error('[push] board event', ev.name, 'failed:', e.message);
    }
  }
}

async function pushAfterRelay(receipt, agreementAddress, calldata) {
  // Diamond-emitted board/service/dispute events — resolved from logs, independent of
  // the tx target, so this runs for every relayed tx.
  await pushBoardEvents(receipt);

  // Agreement-lifecycle events need getDetails() on the agreement, so this only fires
  // when the tx actually targeted (or deployed) one. Wrapped separately so a
  // non-agreement target (a board action) can't abort the board pushes above.
  try {
    const agr = new ethers.Contract(agreementAddress, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const client   = details.client_?.toLowerCase();
    const executor = details.executor_?.toLowerCase();
    const arbiter  = details.arbiter_?.toLowerCase();
    const ZERO     = '0x0000000000000000000000000000000000000000';

    const sendCfg = (cfg) => {
      const url = `/deal/${agreementAddress}`;
      const payload = { title: cfg.title, body: cfg.body, url };
      const sends = [];
      if (cfg.notify !== 'executor' && client)   sends.push(sendPush(client,   payload));
      if (cfg.notify !== 'client'   && executor) sends.push(sendPush(executor, payload));
      // 'both+arbiter' reaches nobody extra, and cannot be made to by fixing this
      // line. `arbiter` here is Agreement.arbiter, which is never a human: it is
      // address(0) until someone claims the dispute (which is exactly when
      // DISPUTED fires) and the DIAMOND afterwards (Diamond-as-arbiter, see
      // ARBITER_REGISTRY_MINI_ABI). Notifying the arbiter of a *fresh* dispute
      // would mean notifying every registered arbiter — a product decision, not
      // a lookup. The arbiter who does take the case learns it from his own
      // claimDispute; the parties are told by the DisputeClaimed branch below.
      if (cfg.notify === 'both+arbiter' && arbiter && arbiter !== ZERO) sends.push(sendPush(arbiter, payload));
      return Promise.allSettled(sends);
    };

    /**
     * A dispute was just raised, and the two parties are NOT in the same
     * position — so one message for both is wrong no matter how it is worded.
     *
     * `raiseDispute` marks the raiser as present on the spot
     * (`src/Agreement.sol`), which means `respondToDispute()` reverts
     * `AlreadyResponded` for him: he risks nothing and can do nothing. The clock
     * runs against the OTHER side, and until this existed she was warned by no
     * channel at all — her only push was AGR_PUSH_MSG[3], one message for both
     * roles, with neither the deadline nor the price of silence in it.
     *
     * `sendCfg` cannot express this: its `notify` field knows only the hardcoded
     * roles, and "the other side, whichever that is" is a comparison, not a
     * role — same as the AppealRaised case in pushBoardEvents().
     */
    const sendDisputeRaised = async (raiser) => {
      const url = `/deal/${agreementAddress}`;
      const by = raiser?.toLowerCase();
      const other = by === client ? executor : by === executor ? client : null;
      // The raiser isn't one of our two parties — the log and the target
      // disagree about whose deal this is, so trust neither and fall back to the
      // role-blind message rather than guess who is at risk.
      if (!by || !other) return sendCfg(AGR_PUSH_MSG[AGR_STATUS_DISPUTED]);

      const deadline = await disputeResponseDeadline(agreementAddress, details.disputedAt_);
      const warning = disputeRaisedWarningMsg(deadline);
      const raiserCfg = AGR_PUSH_MSG[AGR_STATUS_DISPUTED];
      return Promise.allSettled([
        // The raiser keeps the old copy: nothing is running against him.
        sendPush(by,    { title: raiserCfg.title, body: raiserCfg.body, url }),
        sendPush(other, { title: warning.title,   body: warning.body,   url }),
      ]);
    };

    // A split pot reaches the Registry as REFUNDED(2), exactly like a real refund —
    // only the agreement's own event in THIS receipt tells them apart. Resolved up
    // front because the Diamond's AgreementStatusUpdated is emitted first (from
    // inside _complete()) and the loop below returns on the first match.
    const split = findDisputeSplit(receipt.logs, agreementAddress);

    // Someone answered the dispute. The recipient here is ALWAYS the raiser, and
    // that is structural, not incidental: `raiseDispute` marks the raiser present,
    // so `respondToDispute()` is only callable by the second party, and the party
    // opposite whoever responded is therefore the one who already responded.
    //
    // Which makes this message purely informational, and it used to demand an
    // action that reverts — "answer it too" cost the reader a signature and the
    // relayer gas for a guaranteed AlreadyResponded. What he actually needs to
    // know is that the arithmetic moved: with both sides present a timeout splits
    // the escrow in half, where a minute ago three quarters of it were his.
    //
    // The side with something at stake is warned when the dispute is RAISED
    // (sendDisputeRaised above), not here — by then it is too late to be news.
    const responded = findDisputeResponded(receipt.logs, agreementAddress);
    if (responded) {
      const party = responded.party?.toLowerCase();
      const other = party === client ? executor : party === executor ? client : null;
      if (other) {
        await sendPush(other, {
          title: 'Dispute Answered',
          body:  'The other side answered the dispute. If nobody takes the case, the escrow is '
               + 'now split in half instead of three quarters to you.',
          url:   `/deal/${agreementAddress}`,
        });
        return;
      }
      // The responder is neither of the two parties this agreement reports — the
      // log and getDetails() disagree about whose deal this is. The `return` used
      // to be unconditional, so this case ate the Dispute Answered push AND
      // short-circuited the status loop and the selector fallback below it: two
      // notifications gone, nothing written down. Say so and fall through, the
      // same way sendDisputeRaised() falls back rather than dropping.
      console.error(
        `[push] DisputeResponded on ${agreementAddress} came from ${responded.party}, ` +
        `who is neither client (${client}) nor executor (${executor}) — "Dispute Answered" not sent`,
      );
    }

    // Check for AgreementStatusUpdated event first (terminal state changes).
    // Scoped to THIS agreement: the recipients, the deal URL and the copy below all
    // come from the target we already resolved, so a status event about a different
    // agreement would describe someone else's deal to our two parties. Today one
    // receipt can only carry one (MinimalForwarder.execute() makes a single inner
    // call), which is why this was never a live bug — but that is a property of the
    // caller, not of this loop, and findDisputeSplit() right above already scopes.
    // Who raised it, resolved up front for the same reason as the split above: the
    // Diamond's status event is decoded in the loop below, which returns on the
    // first match, and DISPUTED(3) alone doesn't say by whom.
    const raised = findDisputeRaised(receipt.logs, agreementAddress);

    const target = agreementAddress?.toLowerCase();
    for (const log of receipt.logs) {
      try {
        const parsed = agrEventInterface.parseLog(log);
        if (parsed?.name === 'AgreementStatusUpdated') {
          if (target && parsed.args.agreement?.toLowerCase() !== target) continue;
          const status = Number(parsed.args.newStatus);
          // DISPUTED(3) with the raiser known — two recipients, two messages.
          // Without the raiser (a later syncRegistry() carrying the status alone)
          // there is nobody to compare against, and the role-blind message below
          // is all we can honestly send.
          if (status === AGR_STATUS_DISPUTED && raised) {
            await sendDisputeRaised(raised.by);
            return;
          }
          const cfg = status === AGR_STATUS_REFUNDED && split
            ? disputeSplitPushMsg(split)
            : AGR_PUSH_MSG[status];
          if (cfg) await sendCfg(cfg);
          return;
        }
      } catch {}
    }

    // No status event — check if the called function is fund()/activate()/markDone().
    // Those three emit no AgreementStatusUpdated, so the selector IS their only
    // notification path. /relay/notify does not require `calldata` (only txHash and
    // agreement), so a caller that omits it silently loses Deal Funded / Deal
    // Activated / Work Submitted entirely — worth a line, it can only mean the
    // caller is malformed.
    if (typeof calldata !== 'string') {
      console.warn(`[push] no calldata for ${agreementAddress} — fund/activate/markDone pushes cannot be resolved`);
      return;
    }
    const cfg = FUNC_PUSH_MSG[calldata.slice(0, 10).toLowerCase()];
    if (cfg) await sendCfg(cfg);
  } catch (e) {
    // This catch wraps EVERYTHING above — getDetails(), the dispute reads, every
    // sendCfg(). Its comment claimed it only caught "not an agreement target", and
    // for a board action that is true: getDetails() does not exist on the Diamond,
    // so the call reverts and lands here by design. But a transient RPC failure on
    // a REAL agreement was indistinguishable from that, and took Deal Complete /
    // Refunded / Dispute Raised / Funded / Activated / Work Submitted down with it
    // in complete silence — the same disease the receipt polling above was added to
    // cure, one frame further in, and reachable right after that polling succeeds.
    //
    // We can tell the two apart: a board action targets the Diamond itself, an
    // agreement action does not. So the expected case stays quiet and everything
    // else is reported.
    if (agreementAddress?.toLowerCase() === DIAMOND_ADDR?.toLowerCase()) return;
    console.error(`[push] lifecycle pushes failed for agreement ${agreementAddress}:`, e.message);
  }
}

// ─── Local file storage ───────────────────────────────────────────────────────

const PORT         = process.env.PORT || 3001;
const BASE_URL     = (process.env.RELAYER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STORAGE_DIR  = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const DIR_FILES    = path.join(STORAGE_DIR, 'files');   // encrypted chat files — 7d TTL
const DIR_PUBLIC   = path.join(STORAGE_DIR, 'public');  // permanent public files (profiles, avatars)
const DIR_TEMP     = path.join(STORAGE_DIR, 'temp');    // in-progress multipart chunks
const FILE_TTL_MS  = 7 * 24 * 60 * 60 * 1000;          // 7 days

for (const dir of [DIR_FILES, DIR_PUBLIC, DIR_TEMP]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Dispute Bot ──────────────────────────────────────────────────────────────

const SERVER_SECRET = process.env.SERVER_SECRET;
if (!SERVER_SECRET) throw new Error('SERVER_SECRET is not set');

// Задача 3: перечитать/провалидировать конфигурацию пропуска и склада
// мешков ЗДЕСЬ, после dotenv.config() выше. Оба модуля посчитали свои
// значения ещё на импорте (до dotenv — см. комментарий у импортов выше);
// без этого вызова первым, кто заметит отсутствующий SERVER_SECRET или
// битый STORAGE_DIR/*_MS/*_SIZE, был бы не старт процесса, а первый живой
// запрос к /bags/*.
assertBagPassReady();
assertBagStoreReady();

// Single deterministic bot wallet — keccak256(SERVER_SECRET) as private key
const BOT_PRIVATE_KEY = ethers.keccak256(ethers.toUtf8Bytes(SERVER_SECRET));
const botWallet = new ethers.Wallet(BOT_PRIVATE_KEY);

// XMTP signer for node-sdk (same shape as browser-sdk signer)
const botSigner = {
  type: 'EOA',
  getIdentifier: () => ({
    identifier: botWallet.address.toLowerCase(),
    identifierKind: 0, // IdentifierKind.Ethereum
  }),
  signMessage: async (message) => {
    const sig = await botWallet.signMessage(message);
    return ethers.getBytes(sig);
  },
};

// ─── Log encryption ───────────────────────────────────────────────────────────

const DIR_LOGS = path.join(STORAGE_DIR, 'logs');
fs.mkdirSync(DIR_LOGS, { recursive: true });

/**
 * AES-256-GCM key for a given pair's log.
 * key = keccak256(pairId.toLowerCase() + SERVER_SECRET) → 32 bytes
 */
export function deriveLogKey(pairId) {
  return ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(pairId.toLowerCase() + SERVER_SECRET))
  );
}

export function encryptEntry(key, obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv:      iv.toString('hex'),
    ct:      ct.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function decryptEntry(key, { iv, ct, authTag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ct, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
export const PAIR_ID_RE  = /^0x[a-fA-F0-9]{40}-0x[a-fA-F0-9]{40}$/;

// Known push-service endpoint hosts. A subscription's `endpoint` is a URL the
// relayer later POSTs to (via web-push's sendNotification) — accepting an
// arbitrary client-supplied host here would let a malicious "subscription"
// turn the relayer into an SSRF proxy against any URL of the attacker's choosing.
const PUSH_SERVICE_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'web.push.apple.com',
];

export function isKnownPushServiceEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return PUSH_SERVICE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function sortAddressPair(a, b) {
  const lc = [a.toLowerCase(), b.toLowerCase()];
  return lc[0] <= lc[1] ? lc : [lc[1], lc[0]];
}

export function pairIdFromAddresses(a, b) {
  const [x, y] = sortAddressPair(a, b);
  return `${x}-${y}`;
}

export function safeLogPath(pairId) {
  const id = pairId.toLowerCase();
  if (!PAIR_ID_RE.test(id)) throw new Error(`invalid pairId: ${id}`);
  const logPath = path.join(DIR_LOGS, `${id}.ndjson`);
  if (!path.resolve(logPath).startsWith(path.resolve(DIR_LOGS) + path.sep)) throw new Error('path escape');
  return logPath;
}

export function appendLogEntry(pairId, entry) {
  const key = deriveLogKey(pairId);
  const encrypted = encryptEntry(key, entry);
  const line = JSON.stringify(encrypted) + '\n';
  fs.appendFileSync(safeLogPath(pairId), line);
}

// Экспортирован: `botLog.js` читает журнал ПЕРЕД дочитыванием истории, чтобы
// знать, какие сообщения уже записаны (дедупликация) и на какой глубине
// остановиться. До этого журнал только дописывался и никогда не перечитывался
// ботом — отсюда и брались дыры.
export function readLog(pairId) {
  const logPath = safeLogPath(pairId);
  if (!fs.existsSync(logPath)) return [];
  const key = deriveLogKey(pairId);
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return decryptEntry(key, JSON.parse(line)); }
      catch { return null; }
    })
    .filter(Boolean);
}

// Strips path traversal and unsafe chars — returns just the basename
export function safeKey(key) {
  return path.basename(String(key).replace(/[^a-zA-Z0-9.\-_]/g, '')).slice(0, 200);
}

// Cleanup: delete expired chat files and orphaned temp dirs. Exported as a plain
// function (not wrapped in cron.schedule here) so importing this module — e.g.
// from a test — never schedules a real recurring job; index.js is the only
// place that actually calls cron.schedule(runFileCleanup).
export async function runFileCleanup() {
  const cutoff   = Date.now() - FILE_TTL_MS;
  const cutoff1d = Date.now() - 24 * 60 * 60 * 1000;
  const disputedPairIds = await getDisputedPairIds();

  // Expired chat files — skip any still tagged to a currently-disputed pair,
  // but only up to MAX_PROTECTED_AGE_MS. peerA/peerB tagging on /files/presign
  // has no proof-of-participation check — any caller can tag their own upload
  // with a real, public agreement's addresses even if they're not a party to
  // it, which would otherwise let unrelated content be "protected" forever for
  // as long as that agreement's dispute stays open. This ceiling bounds that.
  try {
    let removed = 0;
    let protectedCount = 0;
    const MAX_PROTECTED_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
    for (const f of fs.readdirSync(DIR_FILES)) {
      const fp = path.join(DIR_FILES, f);
      try {
        const mtimeMs = fs.statSync(fp).mtimeMs;
        if (mtimeMs < cutoff) {
          const pairId = _filePairs[f];
          const withinProtectionCeiling = mtimeMs > Date.now() - MAX_PROTECTED_AGE_MS;
          if (pairId && disputedPairIds.has(pairId) && withinProtectionCeiling) {
            protectedCount++;
            continue;
          }
          fs.unlinkSync(fp);
          removed++;
          if (pairId) {
            delete _filePairs[f];
          }
        }
      } catch {}
    }
    if (removed || protectedCount) _saveFilePairs();
    if (removed) console.log(`[files] cleanup: removed ${removed} expired file(s)`);
    if (protectedCount) console.log(`[files] cleanup: protected ${protectedCount} file(s) — pair still disputed`);
  } catch (e) {
    console.error('[files] cleanup error:', e.message);
  }

  // Orphaned temp dirs (uploads that never completed)
  try {
    for (const d of fs.readdirSync(DIR_TEMP)) {
      const dp = path.join(DIR_TEMP, d);
      try {
        if (fs.statSync(dp).mtimeMs < cutoff1d) fs.rmSync(dp, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL        = process.env.RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const RELAYER_KEY    = process.env.RELAYER_PRIVATE_KEY;
const FORWARDER_ADDR = process.env.TRUSTED_FORWARDER;
const DIAMOND_ADDR   = process.env.DIAMOND_ADDRESS;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001')
  .split(',').map(o => o.trim()).filter(Boolean);

if (!RELAYER_KEY)    throw new Error('RELAYER_PRIVATE_KEY is not set');
if (!FORWARDER_ADDR) throw new Error('TRUSTED_FORWARDER is not set');
if (!DIAMOND_ADDR)   throw new Error('DIAMOND_ADDRESS is not set');

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 10;
const _rateMap       = new Map();

// И-4 (ревью): второй параметр — тот же общий `_rateMap`/`RATE_WINDOW_MS`
// (60с), но с СВОИМ потолком вместо глобального RATE_MAX (10/мин). Каждый
// существующий вызывающий (везде в файле, кроме нового блока мешков ниже)
// зовёт с одним аргументом и получает ровно прежнее поведение — потолок по
// умолчанию `RATE_MAX`. Разные бюджеты мешков (выпуск пропуска/чтение/
// запись, см. BAG_PASS_RATE_MAX и соседей) используют одну и ту же карту, но
// разные КЛЮЧИ (bagPassRateKey/bagReadRateKey/bagWriteRateKey) — так что
// потолок здесь не обязан быть одним числом для всех ключей одновременно;
// он просто параметр конкретного вызова, а не свойство самой карты.
export function checkRateLimit(ip, max = RATE_MAX) {
  const now = Date.now();
  const entry = _rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateMap) {
    if (now > entry.resetAt) _rateMap.delete(ip);
  }
}, 5 * 60_000);

// ─── Ethers ───────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayer  = new ethers.Wallet(RELAYER_KEY, provider);

const FORWARDER_ABI = [
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)',
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes retdata)',
  // Without this the relayer had no way to see execute()'s own success flag at all —
  // MinimalForwarder.execute() never reverts on an inner-call failure, it just emits
  // this and returns (false, revertData), so a receipt.status === 1 tells you nothing.
  'event Executed(address indexed from, address indexed to, bool success)',
];

// Standalone Interface (not the mocked `forwarder` Contract instance below) so log
// parsing works the same whether `forwarder` is real or, in tests, replaced by the
// ethers.Contract mock in test/mocks — that mock never fakes `.interface`.
const FORWARDER_INTERFACE = new ethers.Interface(FORWARDER_ABI);

const forwarder = new ethers.Contract(FORWARDER_ADDR, FORWARDER_ABI, provider);

// ─── Forwarder inner-call revert decoding ────────────────────────────────────
// Mirrors the CUSTOM_ERRORS table in frontend/src/app/api/relay/route.ts, the other
// path that forwards through this same MinimalForwarder and already had to solve
// this. Duplicated rather than shared: relayer/ is plain Node ESM with no build
// step and route.ts is compiled by Next.js, so importing one from the other would
// mean standing up a small internal package neither app currently has for the sake
// of one lookup table. Keep the two tables in sync if either changes.
const FORWARDER_CUSTOM_ERRORS = {
  '0xf12ce677': 'ActivationWindowPassed',
  '0x646cf558': 'AlreadyClaimed',
  '0xb6682ad2': 'CommitmentNotFound',
  '0x8e128786': 'CommitmentTooEarly',
  '0x53adc965': 'CommitmentExpired',
  '0xb737f1d8': 'NotTheClaimer',
  '0xb78c9549': 'DisputeWindowPassed',
  '0x422a8e97': 'VerdictAlreadySubmitted',
  '0x7fcc22c9': 'HasOpenDisputeClaims',
  '0xf1898254': 'AppealInProgress',
  '0xdf726563': 'NoVerdict',
  '0x7c9a1cf9': 'AlreadyVoted',
  '0x4dcfa42d': 'AlreadyAppealed',
  '0x7401943d': 'AppealWindowClosed',
  '0x2b6484d8': 'NoAppeal',
  '0xb4021411': 'CannotVoteOnOwnVerdict',
  '0xe3c5eb52': 'AppealAlreadyResolved',
  '0x1285c993': 'AppealWindowNotClosed',
  '0x0cdc2cad': 'VerdictFrozenError',
  '0x5216eba1': 'InsufficientArbitersForAppeal',
  '0x630ed4c8': 'NotLosingParty',
  // Платный вызов арбитра (ArbiterRegistryFacet). NoRefundableBounty — своя
  // ошибка withdrawDisputeBounty, NothingToPush — своя ошибка
  // withdrawTreasurySlice: две функции, два адресата, два разных сообщения.
  // Разными их сделали намеренно (ArbiterRegistryFacet.sol:233-237, тест
  // testBountyAndTreasuryErrorsAreNotTheSameSelector) — и обе обязаны лежать
  // ЗДЕСЬ, иначе разделение бессмысленно: неразобранный селектор долетает до
  // человека сырым хексом, и различать в нём нечего.
  // withdrawTreasurySlice открыта намеренно, её толкает кипер, а кипер ходит
  // тем же путём через релеер.
  '0x277093f8': 'TopUpNotNeeded',
  '0x88d471c4': 'BountyAlreadyFunded',
  '0xd3fc8f8a': 'DisputeAlreadyClaimed',
  '0x2d4e8c7b': 'NoRefundableBounty',
  '0x68d369c9': 'NothingToPush',
  '0x30b29a76': 'ActiveDealExists',
  '0xf9be60a2': 'AlreadyActive',
  '0x09dd1236': 'AlreadyDisputed',
  '0x5adf6387': 'AlreadyFunded',
  '0xc851267c': 'AlreadyMarkedDone',
  '0x6d5703c2': 'AlreadyResolved',
  '0xb7ae9877': 'ArbiterWindowNotPassed',
  '0x2eb35430': 'DeadlineNotPassed',
  '0x70f65caa': 'DeadlinePassed',
  '0x80cb55e2': 'NotActive',
  '0xccb665a6': 'NotArbiter',
  '0x20dbc874': 'NotClient',
  '0x433b0e14': 'NotDisputed',
  '0xc32d1d76': 'NotExecutor',
  '0xd5ef09ba': 'NotFunded',
  '0x38cbd109': 'NotMarkedDone',
  '0xc8ee2d1d': 'NotParty',
  '0xb5365156': 'NoArbiterSet',
  '0x49986e73': 'WrongAmount',
  '0x607311ec': 'WindowAlreadyPassed',
  '0x4dc5a7d2': 'WindowNotPassed',
  '0x1f2a2005': 'ZeroAmount',
  '0x2e020977': 'ExtraNotPending',
  '0x475a2535': 'AlreadyFinalized',
  // Kept: Agreement.sol still declares ZeroAddress(), and the deployed diamond runs pre-F-5 facets until the next diamondCut
  '0xd92e233d': 'ZeroAddress',
  '0x57876cd6': 'FactoryZeroAddress',
  '0x6ca1fdd7': 'RegistryZeroAddress',
  '0xdac33008': 'JobBoardZeroAddress',
  '0x317820eb': 'ArbiterZeroAddress',
  '0xd45bbaf9': 'ClientEqualsExecutor',
  '0xd04b63aa': 'NotDiamond',
  '0xad32732c': 'ArbiterIsParty',
  '0xa22d819e': 'ArbiterNotRegistered',
  '0xf4d678b8': 'InsufficientBalance',
  '0x32cc7236': 'NotFactory',
  '0x90b8ec18': 'TransferFailed',
};

// Decodes MinimalForwarder.execute()'s `retdata` (the inner call's own revert data)
// into a human-readable reason, same shape as route.ts's inline decode.
function decodeForwarderRevert(retdata) {
  const selector = retdata && retdata !== '0x' ? retdata.slice(0, 10).toLowerCase() : '';
  let reason = 'Inner call reverted';
  if (FORWARDER_CUSTOM_ERRORS[selector]) {
    reason = FORWARDER_CUSTOM_ERRORS[selector];
  } else if (selector === '0x08c379a0') {
    // Standard Error(string)
    try {
      reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + retdata.slice(10))[0];
    } catch { /* ignore decode errors, fall back to generic reason */ }
  }
  return { reason, selector };
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
  optionsSuccessStatus: 200,
}));

app.use(express.json({ limit: '64kb' }));

// Serve public files (profiles, avatars) — permanent, long-cached
// nosniff + CSP prevent XSS even if someone smuggled an unexpected file type
app.use('/public', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
// Note: no 'immutable' — allows hard-refresh (Ctrl+Shift+R) to bypass cache.
// 'immutable' would lock in a broken cache (e.g. missing CORS headers) for a year.
}, express.static(DIR_PUBLIC, { maxAge: '1d' }));
// Serve encrypted chat files — content is always AES-256-GCM ciphertext (never renderable),
// but defensive headers prevent any accidental MIME-sniffing or rendering attempt
app.use('/files', (req, res, next) => {
  // Only the actual file-download path (express.static below) needs these forced —
  // the JSON API routes nested under /files/* (presign, multipart, ...) must keep
  // their own real Content-Type so res.json() isn't silently mislabeled.
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  next();
}, express.static(DIR_FILES, { maxAge: '1h' }));

// TRUST_PROXY=true only when the relayer sits behind a proxy we control that
// rewrites the client-identifying headers — here a Cloudflare Tunnel. Leave it
// unset if the port is reachable directly: then these headers are whatever the
// caller typed, and honouring them hands anyone a rate-limit bypass.
//
// Note that leaving it unset is not "safe by default" either. Behind a tunnel
// every request arrives from the cloudflared container, so req.socket sees one
// address for the whole world and RATE_MAX becomes a global cap of 10 req/min
// shared by all users. Behind a proxy this must be true; without one, false.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

export function clientIp(req) {
  if (TRUST_PROXY) {
    // Cloudflare sets CF-Connecting-IP itself and strips whatever the caller
    // sent under that name, so it cannot be forged from outside the tunnel.
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();

    // Fallback for a non-Cloudflare proxy. Take the LAST hop, not the first:
    // each proxy APPENDS the address it observed, so the tail is what our own
    // nearest proxy actually saw. The head is whatever the caller chose to
    // claim — Cloudflare appends to a client-supplied X-Forwarded-For instead
    // of replacing it, so trusting the head would let anyone rotate fake
    // addresses and never hit the rate limit at all.
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = forwarded.split(',');
      return hops[hops.length - 1].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// ─── Core routes ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', relayer: relayer.address, diamond: DIAMOND_ADDR });
});

app.get('/nonce/:address', async (req, res) => {
  try {
    const nonce = await forwarder.getNonce(req.params.address);
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/balance', async (_req, res) => {
  try {
    const balance = await provider.getBalance(relayer.address);
    res.json({ address: relayer.address, balance: ethers.formatEther(balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns the relay bot's XMTP address so the frontend knows who to invite.
app.get('/bot-address', (_req, res) => {
  res.json({ address: botWallet.address.toLowerCase() });
});

// ─── Dispute-log session pass ────────────────────────────────────────────────
//
// The wallet signature proves WHO is asking. It used to be demanded on every
// single GET, with a ±5 minute window, so an arbiter who opened the history,
// closed it and opened it again paid a third wallet popup on top of the two the
// commit-reveal claim already costs. The complaint that started this was exactly
// that: "three signatures to take one dispute".
//
// The pass replaces the *identity proof* on repeat reads, and nothing else:
//
//   • it does NOT replace authorization. Every request — pass or signature —
//     still asks the chain whether that address is the arbiter of this dispute
//     right now (disputeArbiterOf). Release the claim, get overturned off the
//     case, and the pass stops working on the very next read. So the pass is
//     not a capability handed out for 12 hours; it is a cached "I am 0xabc…",
//     and the real gate is re-evaluated on-chain every time.
//   • it is bound to one deal AND one address, so it cannot be carried to
//     another dispute, and another wallet gains nothing by holding it: the
//     server authorizes the address inside the token, not the bearer.
//   • it is a keyed MAC over (deal, address, expiry) using SERVER_SECRET, which
//     the relayer already requires at boot. Nothing is stored server-side: no
//     table to grow, no state to lose on restart, and a token cannot be forged
//     without the secret that also protects the chat-log encryption keys.
//
// Twelve hours: an arbiter reads a thread, waits for the parties to answer in
// the deal chat, comes back and re-reads — that is a working day, and a shorter
// TTL just recreates the popup fatigue this removes. Longer would start to
// outlive the browser session it is scoped to. DISPUTE_WINDOW is four days, so
// a full case still costs a handful of signatures at most, not one per click.
//
// No revocation path, by design: expiry is the only exit, which is why the TTL
// is a day and not a week.
export const DISPUTE_PASS_TTL_SEC = 12 * 60 * 60;
const DISPUTE_PASS_PREFIX  = 'v1';

function disputePassMac(body) {
  return createHmac('sha256', SERVER_SECRET)
    .update(`hexseal:dispute-log-pass:${DISPUTE_PASS_PREFIX}:${body}`)
    .digest('base64url');
}

export function issueDisputeLogPass(dealId, arbiter, nowSec = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSec + DISPUTE_PASS_TTL_SEC;
  const body = `${dealId.toLowerCase()}.${arbiter.toLowerCase()}.${expiresAt}`;
  return {
    token: `${DISPUTE_PASS_PREFIX}.${Buffer.from(body, 'utf8').toString('base64url')}.${disputePassMac(body)}`,
    expiresAt,
  };
}

/**
 * → { address } on success, or { error, code } describing why not.
 * `code` exists so the frontend can tell "sign again, your pass ran out" apart
 * from "you are not the arbiter here" — an expired pass that answered a bare
 * 403 would look identical to being thrown off the case.
 */
export function verifyDisputeLogPass(token, dealId, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = { error: 'Invalid dispute log pass', code: 'pass_invalid' };
  if (typeof token !== 'string') return bad;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DISPUTE_PASS_PREFIX) return bad;

  const [, encodedBody, mac] = parts;
  let body;
  try {
    body = Buffer.from(encodedBody, 'base64url').toString('utf8');
  } catch { return bad; }

  // Constant-time compare, and only after a length check — timingSafeEqual
  // throws on mismatched lengths instead of returning false.
  const expected = Buffer.from(disputePassMac(body), 'utf8');
  const given    = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return bad;

  const [tokenDeal, tokenAddr, expRaw] = body.split('.');
  if (!tokenDeal || !tokenAddr || !expRaw) return bad;
  if (!ETH_ADDR_RE.test(tokenDeal) || !ETH_ADDR_RE.test(tokenAddr)) return bad;
  // A pass minted for one deal must not open another one's log, even though the
  // MAC is genuine.
  if (tokenDeal !== dealId.toLowerCase()) return bad;

  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt)) return bad;
  if (nowSec >= expiresAt) {
    return { error: 'Dispute log pass expired', code: 'pass_expired' };
  }

  return { address: tokenAddr };
}

// Dispute log — only accessible to the arbiter who holds this deal's dispute.
// First read: arbiter signs "hexseal:dispute-log:{dealId}:{unixSeconds}" and gets
// a `pass` back. Later reads: send that pass in `x-dispute-pass`, no signature.
app.get('/dispute-log/:dealId', async (req, res) => {
  const { dealId } = req.params;
  if (!ETH_ADDR_RE.test(dealId.toLowerCase())) return res.status(400).json({ error: 'Invalid dealId' });

  const ts   = req.headers['x-ts'];
  const sig  = req.headers['x-sig'];
  const pass = req.headers['x-dispute-pass'];

  let callerAddr;
  let issuePass = false;

  if (pass) {
    const verified = verifyDisputeLogPass(pass, dealId);
    if (verified.error) return res.status(401).json({ error: verified.error, code: verified.code });
    callerAddr = verified.address;
  } else {
    if (!ts || !sig) return res.status(401).json({ error: 'Missing x-ts or x-sig header' });

    // Replay protection for the signature path is unchanged: ±5 minutes. The
    // pass carries its own, much longer, expiry inside the MAC instead.
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > 300) {
      return res.status(401).json({ error: 'Timestamp out of window' });
    }

    try {
      const message = `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`;
      callerAddr = ethers.verifyMessage(message, sig).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    issuePass = true;
  }

  try {
    // Authorization, re-checked on chain for BOTH paths. Reads the diamond, not
    // the agreement — Agreement.arbiter is the diamond itself (see
    // ARBITER_REGISTRY_MINI_ABI above).
    const onChainArbiter = await disputeArbiterOf(dealId);

    if (!onChainArbiter) {
      return res.status(403).json({ error: 'No arbiter assigned for this deal', code: 'no_arbiter' });
    }
    if (onChainArbiter !== callerAddr) {
      return res.status(403).json({ error: 'Not the arbiter of this deal', code: 'not_arbiter' });
    }

    // Log storage is keyed by pair (client+executor), not by this individual deal —
    // a pair's thread can span casual chat plus multiple deals over time, and the
    // arbiter is meant to see that full context, not just this deal's slice.
    const agr = new ethers.Contract(dealId, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const pairId = pairIdFromAddresses(details.client_, details.executor_);
    const entries = readLog(pairId);
    res.json(issuePass ? { entries, pass: issueDisputeLogPass(dealId, callerAddr) } : { entries });
  } catch (err) {
    console.error('[dispute-log] error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ⚠️  RELAY IS SPLIT: frontend currently calls Vercel /api/relay/route.ts, NOT this endpoint.
// This endpoint is unused until VPS migration. On VPS: /api/relay/route.ts becomes a thin
// proxy to this endpoint (localhost:3001/relay) and duplication disappears.
// Any change to gas cap or relay logic must also be applied to frontend/src/app/api/relay/route.ts.
app.post('/relay', async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
    }

    const { from, to, value = '0', gas, nonce, data, signature } = req.body;
    if (!from || !to || !gas || !data || !signature) {
      return res.status(400).json({ error: 'Missing fields: from, to, gas, data, signature' });
    }
    if (!ethers.isAddress(from) || !ethers.isAddress(to)) {
      return res.status(400).json({ error: 'Invalid address in from/to' });
    }

    // Ceiling on how much gas one ForwardRequest may ask the relayer to pay for.
    //
    // The previous 5M cap (itself a fix, raised from an earlier 3M) was sized
    // off pre-fee-economics measurements. Task 10 of the fee-economics-frontend
    // branch re-measured every gasless path at the form's actual maxLength
    // (mock USDC, foundry) and found several functions grew once cancel/reject
    // started doing a second transfer plus a `FeeCollected` log — most sharply
    // `acceptRequest`, which also stacks the worst-case 19-sibling refund loop:
    //
    //   acceptRequest    (19 siblings, terms 2000)                   3_219_461
    //   mintJob          (title 100 / description 500 / terms 2000)  2_791_334
    //   acceptApplicant  (terms 2000)                                2_332_247
    //   deployAndFund    (terms 2000)                                2_074_240
    //
    // `acceptRequest` is the operation that squeezed the old 5M cap: the
    // frontend's live gas estimate buffers the measured value 1.3x before the
    // signed request ever reaches this route — 3_219_461 * 1.3 = 4_185_299
    // against mock USDC, only 16% margin under 5M. Real USDC (proxied
    // FiatTokenV2_2) costs ~19% more than the mock per the same adjustment
    // Task 10 applied elsewhere: 3_219_461 * 1.19 * 1.3 ≈ 4_980_505 — 0.4%
    // margin, i.e. functionally no headroom left.
    //
    // Raised to 7M: keeps ~40% margin over acceptRequest's real-USDC estimate
    // (4_980_505) while still cutting the per-request ETH-drain ceiling versus
    // the original 8M this cap descended from.
    //
    // The asymmetry here is worth spelling out: a cap that's too low kills a
    // legitimate user action outright — worse, the direct-tx fallback doesn't
    // save it, since isRelayDown() (frontend/src/lib/relay.ts) only catches
    // network failures and 5xx, not this 400 — while a cap that's too high
    // costs nothing, because the chain charges gas actually used, not gas
    // requested. Rate limiting (10 req/min) is the other half of the drain
    // defence.
    //
    // Keep in sync with MAX_FORWARD_GAS in frontend/src/app/api/relay/route.ts
    // — the other path through the same forwarder.
    const MAX_GAS = 7_000_000n;
    if (BigInt(gas) > MAX_GAS) {
      return res.status(400).json({ error: `gas exceeds maximum (${MAX_GAS})` });
    }

    const onChainNonce = await forwarder.getNonce(from);
    const forwardReq = { from, to, value: BigInt(value), gas: BigInt(gas), nonce: onChainNonce, data };

    const valid = await forwarder.verify(forwardReq, signature);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });

    const forwarderAsRelayer = forwarder.connect(relayer);
    const gasOverride = { gasLimit: BigInt(gas) + 60_000n };

    // ── Simulate execute() to catch silent inner-call failures ────────────────
    // MinimalForwarder.execute() deliberately does NOT revert when the forwarded
    // call fails — it consumes the nonce, emits Executed(from, to, false), and
    // returns (false, revertData); the outer tx still succeeds. staticCall runs
    // execute() without spending gas or broadcasting, so a doomed call is caught
    // — and paid for nothing — before we ever send it.
    let simSuccess, simRetdata;
    try {
      [simSuccess, simRetdata] = await forwarderAsRelayer.execute.staticCall(forwardReq, signature, gasOverride);
    } catch (err) {
      console.error('[relay] simulation failed:', err.message);
      return res.status(400).json({ error: `Simulation failed: ${err.message}` });
    }
    if (!simSuccess) {
      const { reason, selector } = decodeForwarderRevert(simRetdata);
      console.error('[relay] inner call failed (caught by simulation):', reason, 'retdata:', simRetdata);
      return res.status(400).json({ error: `Call failed: ${reason}`, errorCode: selector });
    }

    const tx = await forwarderAsRelayer.execute(forwardReq, signature, gasOverride);
    const receipt = await tx.wait();
    if (receipt.status === 0) return res.status(400).json({ error: 'Transaction reverted on-chain' });

    // ── Re-verify after mining ─────────────────────────────────────────────────
    // A passing simulation does not guarantee the real tx still succeeds — state
    // can change between the two (another tx lands in the interim), so the mined
    // receipt's own Executed(from, to, success) log is the actual source of truth.
    let minedSuccess = true; // no matching log found is unexpected, not a signal — fail open, not closed
    for (const log of receipt.logs ?? []) {
      if (log.address?.toLowerCase() !== FORWARDER_ADDR.toLowerCase()) continue;
      try {
        const parsed = FORWARDER_INTERFACE.parseLog(log);
        if (parsed?.name === 'Executed') { minedSuccess = parsed.args.success; break; }
      } catch { /* not a log this ABI recognizes */ }
    }
    if (!minedSuccess) {
      console.error('[relay] inner call failed on the mined tx despite a passing simulation (state changed in between)');
      return res.status(400).json({ error: 'Transaction mined but the inner call failed (state changed after simulation)' });
    }

    res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber });
    // Floating on purpose — the response is already out and a push must never
    // delay a tx. But it needs its own .catch(): pushAfterRelay() starts with
    // `await pushBoardEvents(receipt)`, which is OUTSIDE its internal try, so a
    // receipt without `logs` throws a TypeError that escapes as an unhandled
    // rejection — and on Node >= 15 that takes the whole relayer down. The same
    // call from /relay/notify has always been wrapped; this one was not.
    pushAfterRelay(receipt, forwardReq.to, data)
      .catch(e => console.error(`[push] post-relay pushes failed for ${receipt.hash}:`, e.message));
  } catch (err) {
    console.error('[relay] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── File endpoints — local disk ──────────────────────────────────────────────
//
// Small encrypted files (≤ 20 MB):
//   POST /files/presign           → { uploadUrl, downloadUrl, key }
//   PUT  /files/upload-put/:key   → streams body to DIR_FILES/<key>
//
// Large encrypted files (> 20 MB), chunk-by-chunk:
//   POST /files/multipart/create  → { uploadId, key, partUrls[] }
//   PUT  /files/part/:id/:num     → streams chunk to DIR_TEMP/<id>/<num>
//   POST /files/multipart/complete→ concatenates chunks → { downloadUrl }
//   POST /files/multipart/abort   → removes temp dir
//
// Public permanent files (profiles, avatars):
//   POST /files/public/presign    → { uploadUrl, publicUrl, key }
//   PUT  /files/public-put/:key   → streams body to DIR_PUBLIC/<key>
//
// URL refresh (local URLs never expire, just verify file still exists):
//   POST /files/refresh-url       → { downloadUrl }
//
// Serving:
//   GET  /files/:key              → express.static(DIR_FILES)
//   GET  /public/:key             → express.static(DIR_PUBLIC)

// ── Small encrypted file presign ──────────────────────────────────────────────

app.post('/files/presign', (req, res) => {
  try {
    // Chat files are always encrypted binary blobs — extension is cosmetic only.
    // We ignore whatever ext the client sends and always use .bin so that
    // express.static never serves them with a text/html or image MIME type.
    const key = `${Date.now()}-${randomUUID()}.bin`;

    // Optional: tag this file with the chat pair it belongs to, so the nightly
    // cleanup job can protect it while that pair has a disputed agreement.
    // Best-effort only — an invalid/missing pair just skips tagging, it never
    // blocks the upload itself.
    const { peerA, peerB } = req.body || {};
    if (peerA && peerB && ETH_ADDR_RE.test(peerA) && ETH_ADDR_RE.test(peerB)) {
      _filePairs[key] = pairIdFromAddresses(peerA, peerB);
      _saveFilePairs();
    }

    res.json({
      uploadUrl:   `${BASE_URL}/files/upload-put/${key}`,
      downloadUrl: `${BASE_URL}/files/${key}`,
      key,
      expiresIn: '7 days',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Small encrypted file upload (streaming, size-limited) ────────────────────

const MAX_FILE_SIZE   = 5 * 1024 * 1024 * 1024; // 5 GB — encrypted chat files
const MAX_PUBLIC_SIZE =           5 * 1024 * 1024; // 5 MB — avatars, profiles
const MAX_PART_SIZE   =          50 * 1024 * 1024; // 50 MB — per multipart chunk

// MAX_BAG_SIZE (Задача 3) is a quarter megabyte — `Math.round(bytes/1024/1024)`
// alone renders that as "(max 0 MB)", which is a genuine lie, not just an ugly
// number. KB below 1 MB, same rounding above it.
function formatMaxSize(maxBytes) {
  return maxBytes >= 1024 * 1024
    ? `${Math.round(maxBytes / 1024 / 1024)} MB`
    : `${Math.round(maxBytes / 1024)} KB`;
}

// onFinish, if given, replaces the default "200, empty body" success response —
// called with the written filePath once the stream has finished, aborted:false.
// Задача 3's bag upload route needs this: it has to stat the file (real bytes on
// disk, not the client-claimed size), persist metadata, and shape its own JSON
// body — none of which the three pre-existing callers below need, and none of
// them pass a 5th argument, so their behaviour is unchanged (undefined → old
// branch).
function streamWithSizeLimit(req, res, filePath, maxBytes, onFinish) {
  let received = 0;
  let aborted  = false;
  const ws = fs.createWriteStream(filePath);
  req.on('data', (chunk) => {
    received += chunk.length;
    if (!aborted && received > maxBytes) {
      aborted = true;
      ws.destroy();
      fs.unlink(filePath, () => {});
      if (!res.headersSent) res.status(413).json({ error: `File too large (max ${formatMaxSize(maxBytes)})` });
      req.destroy();
    }
  });
  req.pipe(ws);
  ws.on('finish', () => {
    if (aborted) return;
    if (onFinish) { onFinish(filePath); return; }
    if (!res.headersSent) res.status(200).end();
  });
  ws.on('error', (err) => { if (!res.headersSent) { console.error('[upload]', err.message); res.status(500).json({ error: 'Write error' }); } });
  // И-2 (ревью): a dropped connection mid-upload (client closes the socket,
  // network drop) used to only stop the write — whatever had already landed
  // on disk stayed there, orphaned, with no metaindex entry (recordBag()
  // never ran). The only thing that would ever pick it up is the mtime-based
  // orphan sweep, not before BAG_UNREAD_TTL_MS (30 days by default) — and
  // Задача 4 hasn't even wired that sweep into the nightly schedule yet.
  // Same cleanup as the size-limit abort branch above: mark aborted so
  // ws.on('finish') (which can still fire after this) doesn't call onFinish
  // on a truncated file, and delete what was written so far.
  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    ws.destroy();
    fs.unlink(filePath, () => {});
  });
}

app.put('/files/upload-put/:key', (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'Invalid key' });
  streamWithSizeLimit(req, res, path.join(DIR_FILES, key), MAX_FILE_SIZE);
});

// ── URL refresh (local files don't expire by URL, only by TTL cleanup) ────────

app.post('/files/refresh-url', (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Invalid key' });
    const safeK = safeKey(key);
    if (!fs.existsSync(path.join(DIR_FILES, safeK))) {
      return res.status(404).json({ error: 'File not found or expired' });
    }
    res.json({ downloadUrl: `${BASE_URL}/files/${safeK}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public file presign (profiles, avatars — permanent) ───────────────────────
// Only whitelisted extensions allowed — prevents HTML/SVG XSS via static serve

const PUBLIC_ALLOWED_EXT = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

app.post('/files/public/presign', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
  }
  try {
    const { ext = '' } = req.body || {};
    const safeExt = String(ext).replace(/[^a-zA-Z0-9.]/g, '').toLowerCase().slice(0, 10);
    const dotExt  = safeExt.startsWith('.') ? safeExt : (safeExt ? `.${safeExt}` : '');
    if (dotExt && !PUBLIC_ALLOWED_EXT.has(dotExt)) {
      return res.status(400).json({ error: `File type not allowed. Allowed: ${[...PUBLIC_ALLOWED_EXT].join(', ')}` });
    }
    const key = `${Date.now()}-${randomUUID()}${dotExt}`;
    res.json({
      uploadUrl: `${BASE_URL}/files/public-put/${key}`,
      publicUrl: `${BASE_URL}/public/${key}`,
      key,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public file upload (streaming) ────────────────────────────────────────────
// Profile JSONs (profile-0x<addr>.json) require an Ethereum signature from
// the profile owner to prevent unauthorized overwrites.

const PROFILE_KEY_RE = /^profile-(0x[a-f0-9]{40})\.json$/i;

// Tracks last-seen updatedAt nonce per address — prevents signature replay.
// Persisted to disk (mirrors _filePairs'/_pushSubs' own load/save pattern in
// this same file) so a server restart doesn't reset every address's floor
// back to 0 and allow a previously-valid, since-superseded signed profile
// update to be replayed.
const PROFILE_NONCES_FILE = path.join(STORAGE_DIR, 'profile_nonces.json');
function loadProfileNonces() {
  try {
    if (existsSync(PROFILE_NONCES_FILE)) {
      const raw = JSON.parse(readFileSync(PROFILE_NONCES_FILE, 'utf8'));
      return new Map(Object.entries(raw));
    }
  } catch {}
  return new Map();
}
function saveProfileNonces() {
  try { writeFileSync(PROFILE_NONCES_FILE, JSON.stringify(Object.fromEntries(_profileNonces)), 'utf8'); } catch {}
}
const _profileNonces = loadProfileNonces();

app.put('/files/public-put/:key', async (req, res) => {
  const key = safeKey(req.params.key);
  if (!key) return res.status(400).json({ error: 'Invalid key' });

  const profileMatch = key.match(PROFILE_KEY_RE);
  if (profileMatch) {
    // ── Signed profile upload ──────────────────────────────────────────────
    // Content-Type is application/octet-stream (set by uploader) so express.json()
    // never consumes the stream — we read raw bytes here safely.
    const address = profileMatch[1].toLowerCase();
    const sig     = req.headers['x-profile-signature'];
    if (!sig) return res.status(401).json({ error: 'Profile upload requires X-Profile-Signature' });

    // 1. Buffer raw body
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); }
    catch { return res.status(400).json({ error: 'Body read error' }); }
    const body    = Buffer.concat(chunks);
    const bodyStr = body.toString('utf8');

    // 2. Parse JSON and extract nonce
    let profileData;
    try { profileData = JSON.parse(bodyStr); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    // The edit-form UI already checks this client-side, but a caller who signs
    // and uploads a profile JSON directly bypasses that entirely — their own
    // wallet signature is always valid for their own address. Reject an unsafe
    // scheme here so a javascript: URI can never be persisted and served back.
    const website = profileData?.links?.website;
    if (website && typeof website === 'string') {
      let scheme = null;
      try { scheme = new URL(website).protocol; } catch { /* invalid URL */ }
      if (scheme !== 'http:' && scheme !== 'https:') {
        return res.status(400).json({ error: 'links.website must be an http(s) URL' });
      }
    }

    const nonce = profileData.updatedAt;
    if (typeof nonce !== 'number' || !Number.isFinite(nonce)) {
      return res.status(400).json({ error: 'Missing or invalid updatedAt nonce' });
    }
    const lastNonce = _profileNonces.get(address) || 0;
    if (nonce <= lastNonce) {
      return res.status(400).json({ error: 'Stale nonce — replay detected' });
    }

    // 3. Verify: signed message commits to address + nonce + body hash
    //    message = "hexseal:profile:update:<addr>:<nonce>:<keccak256(body)>"
    const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(bodyStr));
    const message  = `hexseal:profile:update:${address}:${nonce}:${bodyHash}`;
    let recovered;
    try { recovered = ethers.recoverAddress(ethers.hashMessage(message), sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature format' }); }

    if (recovered !== address) {
      console.warn(`[files/public-put] sig mismatch: recovered=${recovered} expected=${address}`);
      return res.status(403).json({ error: 'Signature mismatch' });
    }

    // 4. Persist nonce, write file
    _profileNonces.set(address, nonce);
    saveProfileNonces();
    fs.writeFile(path.join(DIR_PUBLIC, key), body, (err) => {
      if (err) { console.error('[files/public-put]', err.message); return res.status(500).json({ error: 'Write error' }); }
      res.status(200).end();
    });
    return;
  }

  // ── Non-profile files: stream with size limit ───────────────────────────
  streamWithSizeLimit(req, res, path.join(DIR_PUBLIC, key), MAX_PUBLIC_SIZE);
});

// ── Multipart create ──────────────────────────────────────────────────────────

app.post('/files/multipart/create', (req, res) => {
  try {
    const { ext = '', chunkCount } = req.body || {};
    if (!chunkCount || chunkCount < 1 || chunkCount > 10000) {
      return res.status(400).json({ error: 'chunkCount must be 1–10000' });
    }
    const safeExt  = String(ext).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
    const uploadId = randomUUID();
    const key      = `${Date.now()}-${randomUUID()}${safeExt}`;

    fs.mkdirSync(path.join(DIR_TEMP, uploadId), { recursive: true });

    const partUrls = Array.from({ length: chunkCount }, (_, i) =>
      `${BASE_URL}/files/part/${uploadId}/${i + 1}`
    );

    res.json({ uploadId, key, partUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multipart part upload (streaming, one chunk per request) ──────────────────

app.put('/files/part/:uploadId/:partNum', (req, res) => {
  const uploadId = safeKey(req.params.uploadId);
  const partNum  = parseInt(req.params.partNum, 10);
  if (!uploadId || isNaN(partNum) || partNum < 1 || partNum > 10000) {
    return res.status(400).json({ error: 'Invalid uploadId or partNum' });
  }
  const dir = path.join(DIR_TEMP, uploadId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Upload session not found' });

  const filename = String(partNum).padStart(6, '0');
  streamWithSizeLimit(req, res, path.join(dir, filename), MAX_PART_SIZE);
});

// ── Multipart complete — concatenate chunks ───────────────────────────────────

app.post('/files/multipart/complete', async (req, res) => {
  try {
    const { uploadId, key } = req.body || {};
    if (!uploadId || !key) return res.status(400).json({ error: 'uploadId and key required' });

    const safeUploadId = safeKey(uploadId);
    const safeK        = safeKey(key);
    const tempDir      = path.join(DIR_TEMP, safeUploadId);
    const destPath     = path.join(DIR_FILES, safeK);

    if (!fs.existsSync(tempDir)) return res.status(404).json({ error: 'Upload session not found' });

    const parts = fs.readdirSync(tempDir).sort();
    if (!parts.length) return res.status(400).json({ error: 'No parts found' });

    const ws = fs.createWriteStream(destPath);
    for (const part of parts) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(tempDir, part));
        rs.pipe(ws, { end: false });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
    }
    await new Promise((resolve, reject) => {
      ws.end();
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    fs.rmSync(tempDir, { recursive: true, force: true });

    res.json({ downloadUrl: `${BASE_URL}/files/${safeK}` });
  } catch (err) {
    console.error('[files/multipart/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Multipart abort ───────────────────────────────────────────────────────────

app.post('/files/multipart/abort', (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    fs.rmSync(path.join(DIR_TEMP, safeKey(uploadId)), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bag endpoints — chat transport, blind to content ─────────────────────────
//
// A "bag" is an opaque, client-encrypted chat payload — the server never reads,
// parses or logs its bytes, at upload, at download, or in cleanup (Задача 4).
// Everything this block operates on is addresses, sizes and timestamps.
//
// Separate storage, separate route family, on purpose: DIR_FILES/DIR_PUBLIC
// above are mounted under express.static and openly listable-by-guessing —
// tolerable for ciphertext attachments nobody can open without a key, but not
// for bags, where the metadata itself (who talked to whom, and when) is the
// thing the product promises not to hand to a stranger. Nothing below is
// mounted under express.static — see test/bagRoutes.test.js's direct-request
// test for the check that actually proves it.
//
//   POST /bags/pass         → { pass, expiresAt } — x-ts/x-sig headers over
//                              bagPassChallenge(address, ts), address in the
//                              JSON body (see the long comment on the route
//                              itself for why address can't come from the
//                              headers alone).
//   PUT  /bags/:recipient   → { key } — sender comes from the pass, never
//                              from the body; body is the raw sealed bytes.
//   GET  /bags?since=<ms>   → [{ key, sender, size, uploadedAt }] for the
//                              address inside the pass.
//   GET  /bags/:recipient/:filename (== GET /bags/:key, key = "recipient/filename"
//                              — the key format from bagKeyFor() always has one
//                              slash in it, so it needs two URL segments)
//                            → raw bytes, only if the pass's address is the
//                              recipient. Wrong owner and unknown key answer
//                              identically (404, same body) — see rule 3 below.
//
// Rules, each locked by test/bagRoutes.test.js:
//   1. Recipient/sender are read from the pass or the URL, never the body.
//   2. Wrong-owner and unknown-key GETs are indistinguishable (404, same
//      body) — a 403 there would let someone enumerate another address's
//      bag count by the status code alone. An invalid/expired PASS is still
//      401 with its own code — that one has to be distinguishable, or the
//      client can't tell "re-sign" from "no such bag".
//   3. The rate limiter runs on all four routes, keyed by IP (as elsewhere)
//      AND by the caller's address (bagPassRateKey/bagReadRateKey/
//      bagWriteRateKey below — see the long comment there for why three
//      separate budgets, not one shared one) — behind the
//      Cloudflare Tunnel every IP collapses to one (app.js:1081-1101), so an
//      IP-only limiter is worthless here.

const BAG_PASS_HEADER = 'x-bag-pass';
const BAG_NOT_FOUND   = { error: 'Bag not found', code: 'bag_not_found' };

// И-4 (ревью): один общий бюджет "bag-addr:<addr>" на все четыре маршрута
// оказался и небезопасным (С1 — непроверенный адрес мог тратить чужой), и
// непригодным для живого разговора сам по себе: 10 действий в минуту на ВСЕ
// четыре маршрута вместе означало, что один опрос списка раз в десять секунд
// съедал шесть, и собственная отправка следом уже голодала собственное же
// чтение — без единого нападающего, просто от нормального использования
// (измерено координатором: пропуск + девять отправок → своё же чтение
// получает 429). Три отдельных бюджета — выпуск пропуска, чтение (список +
// скачивание одного мешка — оба "прочитать что-то"), запись — не делят
// один счётчик, так что интенсивная отправка не блокирует чтение и наоборот.
//
// Числа подобраны под живой разговор, не под один запрос в шесть секунд:
//   - выпуск пропуска — редкое событие (раз в BAG_PASS_TTL_SEC = 12ч, плюс
//     случайные переподписи), запас на повторные попытки не помешает;
//   - чтение — список опрашивается чаще всего (раз в 1-2с в активном чате)
//     плюс скачивание каждого нового мешка тем же бюджетом;
//   - запись — всплеск быстрой печати/отправки короткими сообщениями.
// Через окружение, с явными умолчаниями — то же правило, что уже применено
// к MAX_BAG_SIZE и срокам жизни в bagStore.js.
function readPositiveInt(envVar, defaultValue) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  // Громкий отказ при старте, не тихий NaN — `entry.count >= NaN` всегда
  // false, то есть битое значение здесь означает не "потолок поменьше", а
  // "лимитера нет вообще". На старте, а не на первом запросе: ровно то же
  // рассуждение, что assertBagStoreReady()/assertBagPassReady() выше по
  // файлу уже применяют к своим собственным числам.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${envVar}=${JSON.stringify(raw)} is not a positive finite number`);
  }
  return n;
}

const BAG_PASS_RATE_MAX  = readPositiveInt('BAG_PASS_RATE_MAX',  30);
const BAG_READ_RATE_MAX  = readPositiveInt('BAG_READ_RATE_MAX', 120);
const BAG_WRITE_RATE_MAX = readPositiveInt('BAG_WRITE_RATE_MAX', 60);

function bagPassRateKey(address)  { return `bag-pass:${address}`;  }
function bagReadRateKey(address)  { return `bag-read:${address}`;  }
function bagWriteRateKey(address) { return `bag-write:${address}`; }

function bagRateLimited(res) {
  return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
}

// Shared by PUT/GET/GET-list: verify the pass, answer 401 with its code on
// failure, otherwise return the address it names. Every caller below treats
// that address as the ONLY source of truth for "who is asking" — see rule 1.
function requireBagPass(req, res) {
  const verified = verifyBagPass(req.headers[BAG_PASS_HEADER]);
  if (verified.error) {
    res.status(401).json({ error: verified.error, code: verified.code });
    return null;
  }
  return verified.address;
}

// POST /bags/pass — mints a bag pass from a wallet signature.
//
// Unlike GET /dispute-log/:dealId (app.js:1237-1258, the pattern this route
// is otherwise copied from), there is no resource id in this URL that the
// server already knows and can fold into the challenge — dispute-log signs
// over `dealId`, which comes from the path. bagPassChallenge(address, ts)
// signs over the CALLER's OWN address instead, and building that exact
// message server-side (required before ethers.verifyMessage can recover
// anyone) needs the address as an input, not just an output. So the caller
// states a claimed address in the JSON body, and the route checks
// self-consistency — recovered signer === claimed address — exactly the
// pattern /push/subscribe and /push/unsubscribe already use below for the
// same shape of problem (no URL-supplied resource, signer proves an address
// that's also plain input).
//
// Deliberately NOT copied from /push/subscribe/unsubscribe: those two have no
// replay protection at all (docs/OPEN-ITEMS.md #27) — a captured signature is
// valid forever. This route keeps bagPassChallenge's ±5 minute window, the
// same discipline GET /dispute-log/:dealId already applies to its own
// signature path, checked via Number.isFinite (not a bare Number(ts) > …
// comparison — that version silently accepts a non-numeric ts because
// `NaN > 300` is always false, the exact failure mode named in the same
// OPEN-ITEMS entry).
//
// Ordering is cost-ordered, cheapest first: address shape → header presence →
// timestamp window → rate limit by the CLAIMED address → only then the actual
// ecdsa recovery. The address-rate-limit step exists here specifically
// because — unlike the three consuming routes below, which only learn the
// caller's address by already having verified a pass — this route is handed
// an address up front, so a flood of garbage signatures against one address
// hits the limiter before paying for a single recovery.
app.post('/bags/pass', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) return bagRateLimited(res);

  const { address } = req.body || {};
  if (typeof address !== 'string' || !ETH_ADDR_RE.test(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }
  const addr = address.toLowerCase();

  const ts  = req.headers['x-ts'];
  const sig = req.headers['x-sig'];
  if (!ts || !sig) {
    return res.status(401).json({ error: 'Missing x-ts or x-sig header' });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum  = Number(ts);
  // Number.isFinite first, not just `Math.abs(nowSec - tsNum) > 300` — the
  // same class of bug docs/OPEN-ITEMS.md #27 (subpoint 3) found in
  // /push/subscribe's sibling code: Number('never') is NaN, and any
  // comparison against NaN is always false, so a non-numeric x-ts silently
  // sails through a bare magnitude check instead of being rejected by it.
  // (bagPassChallenge() below happens to also reject NaN via its own
  // Number.isSafeInteger guard — Задача 1's contract, not this route's — so
  // removing this line doesn't reopen an exploit today; it does start
  // reporting a garbage timestamp as "invalid signature" instead of what it
  // actually is, and removes the one guard here that doesn't depend on a
  // frozen module elsewhere still being strict tomorrow.)
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) {
    return res.status(401).json({ error: 'Timestamp out of window', code: 'ts_out_of_window' });
  }

  // С1 (ревью, критическая — координаторская, не моя изначальная идея):
  // раньше здесь стоял `checkRateLimit(bagAddrRateKey(addr))` — бюджет
  // адреса тратился ЗАЯВЛЕННЫМ (непроверенным) адресом из тела, ДО
  // восстановления подписи. Это тот же бюджет, что PUT/GET/GET-список
  // списывают под настоящий, проверенный адрес — так что нападающий, ни
  // разу не подписавшись как жертва, мог 9-10 мусорными попытками в минуту
  // разрядить бюджет чужого адреса и держать человека отрезанным от
  // собственного чата постоянно, повторяя раз в минуту. Кошелёк жертвы не
  // нужен вообще — адреса публичны в цепи.
  //
  // Защита от нагрузки ДО восстановления подписи — только IP-лимитер выше
  // (`checkRateLimit(ip)`), больше ничего с адресом не связанного здесь не
  // трогается. Координатор явно допускал два варианта («только по IP, либо
  // по отдельному пространству имён, никак не связанному с бюджетом
  // адреса») — выбран первый, более простой: заводить третье пространство
  // имён ради ограничения объёма чистого ecdsa-восстановления (микросекунды
  // на попытку) не стоит сложности, которую оно добавляет.
  let recovered;
  try {
    const message = bagPassChallenge(addr, tsNum);
    recovered = ethers.verifyMessage(message, sig).toLowerCase();
  } catch {
    return res.status(401).json({ error: 'Invalid signature', code: 'invalid_signature' });
  }
  if (recovered !== addr) {
    // Distinct from both pass_expired (this route doesn't consume an
    // existing pass) and invalid_signature (the signature itself parsed and
    // recovered fine — it just isn't for the address the caller claimed) —
    // Задача 6 tells "re-sign" and "you sent someone else's address" apart
    // by this code.
    return res.status(401).json({ error: 'Signature does not match claimed address', code: 'address_mismatch' });
  }

  // Бюджет адреса тратится только ЗДЕСЬ — после того, как подпись реально
  // восстановлена И совпала с заявленным адресом. `recovered` и `addr`
  // равны в этой точке (проверено строкой выше), но ключом идёт именно
  // `recovered` — не по привычке, а как утверждение: списывается бюджет
  // ТОЛЬКО доказанного адреса, никогда заявленного (С1).
  if (!checkRateLimit(bagPassRateKey(recovered), BAG_PASS_RATE_MAX)) return bagRateLimited(res);

  const { token, expiresAt } = issueBagPass(recovered, nowSec);
  res.json({ pass: token, expiresAt });
});

// PUT /bags/:recipient — body is the raw sealed bag. Sender comes from the
// pass; the body is never parsed (bytes only, no matter what they look like).
app.put('/bags/:recipient', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) return bagRateLimited(res);

  const sender = requireBagPass(req, res);
  if (!sender) return;

  if (!checkRateLimit(bagWriteRateKey(sender), BAG_WRITE_RATE_MAX)) return bagRateLimited(res);

  // И-1 (ревью): app.use(express.json({limit:'64kb'})) is mounted globally,
  // ahead of every route (app.js, near the top of the file) — for any
  // request whose Content-Type it recognises (exactly 'application/json',
  // by default; verified against the `type-is` matcher express.json() uses
  // internally — a `+json` suffix type like 'application/vnd.api+json' does
  // NOT match), it fully drains and parses the body BEFORE this handler
  // ever runs. By the time streamWithSizeLimit below tries to read the
  // request stream, there is nothing left on it — it writes zero bytes,
  // recordBag() happily records size:0, and the caller gets a normal
  // `200 {key}` for a bag that was never actually stored. The sender
  // believes it was delivered; the recipient downloads emptiness. Reject
  // explicitly instead of silently "succeeding" with nothing on disk.
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') {
    return res.status(400).json({ error: 'Bag upload must not use Content-Type: application/json (body already consumed upstream)' });
  }

  const recipient = String(req.params.recipient || '').toLowerCase();
  if (!ETH_ADDR_RE.test(recipient)) return res.status(400).json({ error: 'Invalid recipient' });

  // Neither assertBagStoreReady() nor bagPathFor() creates the recipient's
  // own subdirectory — only the storage root (DIR_BAGS) exists at boot. This
  // route is the one place a bag actually lands on disk, so it has to make
  // the directory itself, or the very first write to a new recipient fails.
  let key, filePath;
  try {
    key = bagKeyFor(recipient);
    filePath = bagPathFor(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (e) {
    console.error('[bags] PUT setup failed:', e.message);
    return res.status(500).json({ error: 'Failed to prepare bag storage' });
  }

  streamWithSizeLimit(req, res, filePath, MAX_BAG_SIZE, () => {
    // Measure what actually landed on disk — not the client-claimed size,
    // not a running byte count off the wire (see the comment on
    // MAX_BAG_SIZE in bagStore.js: recordBag()'s own ceiling check only ever
    // sees whatever number it's handed here). uploadedAt is `Date.now()`,
    // never anything the client sent — bagStore.js's assertNotFromFuture()
    // exists precisely so a spoofed uploadedAt can't be used to outlive the
    // TTL rules, and that protection is worthless if this route just
    // forwards a client-supplied value instead of stamping its own.
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      console.error('[bags] PUT stat-after-write failed:', e.message);
      fs.unlink(filePath, () => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read uploaded bag' });
      return;
    }
    try {
      const stored = recordBag({ sender, recipient, key, size, uploadedAt: Date.now() });
      res.status(200).json({ key: stored.key });
    } catch (e) {
      // recordBag() throws (bagStore.js's documented contract, not an
      // accident) — Express 4 doesn't turn a throw from inside this
      // callback into a response on its own, so this has to be caught here
      // or a disk failure kills the process instead of just failing the
      // request.
      console.error('[bags] recordBag failed:', e.message);
      fs.unlink(filePath, () => {});
      if (!res.headersSent) res.status(500).json({ error: 'Failed to record bag' });
    }
  });
});

// GET /bags?since=<ms> — bags addressed to the pass's own address, oldest
// first (listBagsFor's own order). Only the four fields Задача 3's spec
// names ship back — not pairId, not firstFetchedAt, not dealDeadline.
app.get('/bags', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) return bagRateLimited(res);

  const address = requireBagPass(req, res);
  if (!address) return;

  // Read budget — shared with GET /bags/:key (download) below: both are
  // "read something", and a client that lists then downloads several new
  // bags in one poll cycle is one coherent burst of reading, not two
  // independent activities that should each get their own ceiling.
  if (!checkRateLimit(bagReadRateKey(address), BAG_READ_RATE_MAX)) return bagRateLimited(res);

  let since = null;
  if (req.query.since !== undefined) {
    since = Number(req.query.since);
    if (!Number.isFinite(since)) return res.status(400).json({ error: 'Invalid since' });
  }

  let list;
  try {
    list = listBagsFor(address);
  } catch (e) {
    console.error('[bags] GET /bags failed:', e.message);
    return res.status(500).json({ error: 'Failed to list bags' });
  }

  // И-3 (ревью): nonstrict `>=`, not `>`. Two bags landing in the same
  // millisecond is a real race, not a theoretical one (measured live by the
  // coordinator) — a client that remembers the newest uploadedAt it has seen
  // and polls with ?since=<that value> would, with a strict `>`, exclude a
  // sibling bag stamped with the EXACT same millisecond forever: that bag's
  // uploadedAt never becomes greater than the since it will keep sending
  // from now on. `>=` re-sends the already-seen bag alongside it — a client
  // dedupes by key, so a repeat is a no-op, not a data-loss risk the way
  // silently dropping a message forever is.
  if (since !== null) list = list.filter((b) => b.uploadedAt >= since);

  res.json(list.map(({ key, sender, size, uploadedAt }) => ({ key, sender, size, uploadedAt })));
});

// GET /bags/:recipient/:filename — download. bagKeyFor() always produces a
// key shaped "<recipient>/<uploadedAt>-<uuid>.bin", so the external
// "GET /bags/:key" interface needs two URL segments here, not one — a single
// `:key` param would stop at the first `/`.
app.get('/bags/:recipient/:filename', (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) return bagRateLimited(res);

  const address = requireBagPass(req, res);
  if (!address) return;

  if (!checkRateLimit(bagReadRateKey(address), BAG_READ_RATE_MAX)) return bagRateLimited(res);

  const key = `${req.params.recipient}/${req.params.filename}`;

  // Every failure branch below — malformed key, wrong owner, meta present but
  // the file is gone, key simply never existed — answers with the exact same
  // 404 body. That collapse is the point (rule 2 above): a 403 on "wrong
  // owner" vs 404 on "no such key" would let someone learn which keys exist
  // in another address's bag list just by watching the status code.
  let meta;
  try {
    meta = bagMetaOf(key);
  } catch {
    return res.status(404).json(BAG_NOT_FOUND);
  }
  if (!meta || meta.recipient !== address) {
    return res.status(404).json(BAG_NOT_FOUND);
  }

  let filePath;
  try {
    filePath = bagPathFor(key);
  } catch {
    return res.status(404).json(BAG_NOT_FOUND);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json(BAG_NOT_FOUND);
  }

  try {
    markFetched(key, Date.now());
  } catch (e) {
    // markFetched() throws on an unknown key (bagStore.js's contract) — but
    // this route already confirmed the key exists via bagMetaOf() above, so
    // reaching this catch means a genuine disk failure or a race with
    // cleanup (Задача 4) between that check and here. Either way it's the
    // server's failure, not "no such bag" — 500, not folded into
    // BAG_NOT_FOUND.
    console.error('[bags] markFetched failed:', e.message);
    return res.status(500).json({ error: 'Failed to mark bag as fetched' });
  }

  // Same defensive headers as the /files static mount (app.js:1058-1068) —
  // ciphertext is never meant to be rendered or sniffed.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  // И-5 (ревью): the right to read this response lives ENTIRELY in the
  // x-bag-pass header — the body itself carries no proof of authorization.
  // A caching intermediary that keys on URL alone (and the key is part of
  // the URL, so it's a stable cache address) could otherwise serve a stored
  // response to a LATER request for the same URL with no pass at all.
  // no-store forbids storing this response anywhere; Vary additionally
  // tells any cache that does inspect headers that the response depends on
  // x-bag-pass, not just the URL.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'x-bag-pass');
  const rs = fs.createReadStream(filePath);
  rs.on('error', (e) => {
    console.error('[bags] read failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read bag' });
  });
  rs.pipe(res);
});

// ─── Push notification endpoints ──────────────────────────────────────────────

app.get('/push/vapid-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /push/subscribe — requires ownership proof.
// Client signs: "hexseal:push-subscribe:<address>:<endpoint>"
app.post('/push/subscribe', async (req, res) => {
  try {
    const { address, subscription, sig } = req.body || {};
    if (!address || !subscription?.endpoint) {
      return res.status(400).json({ error: 'address and subscription required' });
    }
    if (!sig) return res.status(401).json({ error: 'Missing sig — sign hexseal:push-subscribe:<address>:<endpoint>' });

    const addr = address.toLowerCase();
    const message  = `hexseal:push-subscribe:${addr}:${subscription.endpoint}`;
    let recovered;
    try { recovered = ethers.verifyMessage(message, sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }

    if (recovered !== addr) return res.status(403).json({ error: 'Signature mismatch' });

    if (!isKnownPushServiceEndpoint(subscription.endpoint)) {
      return res.status(400).json({ error: 'Unrecognized push service endpoint' });
    }

    const existing = _pushSubs.get(addr) ?? [];
    if (!existing.some(s => s.endpoint === subscription.endpoint)) {
      _pushSubs.set(addr, [...existing, subscription]);
      savePushSubs();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/unsubscribe — requires ownership proof, mirroring /push/subscribe.
// Client signs: "hexseal:push-unsubscribe:<address>:<endpoint>"
app.post('/push/unsubscribe', async (req, res) => {
  try {
    const { address, endpoint, sig } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    if (!sig) return res.status(401).json({ error: 'Missing sig — sign hexseal:push-unsubscribe:<address>:<endpoint>' });

    const key = address.toLowerCase();
    const message = `hexseal:push-unsubscribe:${key}:${endpoint || 'all'}`;
    let recovered;
    try { recovered = ethers.verifyMessage(message, sig).toLowerCase(); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }
    if (recovered !== key) return res.status(403).json({ error: 'Signature mismatch' });

    if (endpoint) {
      _pushSubs.set(key, (_pushSubs.get(key) ?? []).filter(s => s.endpoint !== endpoint));
    } else {
      _pushSubs.delete(key);
    }
    savePushSubs();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PUSH_SECRET = process.env.PUSH_SECRET ?? '';

// Resolve a display name for a wallet address: profile displayName → short address.
// Only called when the request has been authenticated via X-Push-Secret.
function resolveDisplayName(addr) {
  if (!addr || !ethers.isAddress(addr)) return null;
  try {
    const profilePath = path.join(DIR_PUBLIC, `profile-${addr.toLowerCase()}.json`);
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (profile?.displayName?.trim()) return profile.displayName.trim();
    }
  } catch {}
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

app.post('/push/send', async (req, res) => {
  try {
    // Only this server's own Next.js /api/push route is a legitimate caller —
    // it already sends this header on every request. Without a hard gate here,
    // anyone could send an arbitrary push notification (any title/body/url) to
    // any wallet address just by knowing it, since `to` is only ever validated
    // as a well-formed address, never tied to who's actually asking.
    if (!PUSH_SECRET || req.headers['x-push-secret'] !== PUSH_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
    }
    const { to, title, body, url, from, tag } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });
    if (!ethers.isAddress(to)) return res.status(400).json({ error: 'Invalid address' });

    // The gate above already proves this request is from our own server, so
    // `from` is always safe to trust for display-name resolution now.
    // Fallback is 'New message', NOT 'Hexseal': the OS already shows the app name
    // ("from Hexseal") as the source, so a 'Hexseal' title read as "Hexseal from Hexseal".
    const resolvedTitle = from
      ? (resolveDisplayName(from) ?? title ?? 'New message')
      : (title ?? 'New message');

    await sendPush(to.toLowerCase(), {
      title: resolvedTitle,
      body:  String(body).slice(0, 200),
      url:   url || '/chat',
      tag:   tag || url || '/chat',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called server-to-server by the Next.js /api/relay after a meta-transaction confirms.
// pushAfterRelay + the push-subscription store live here, so the Next route just hands us
// the tx hash + the target it acted on, and we send the deal-lifecycle OS notifications
// (Funded / Activated / Work Submitted / Complete / Refunded / Dispute). Trusted by
// PUSH_SECRET only. Historically /api/relay never called this, so on-chain OS pushes
// never fired — only in-app (event-watching) notifications did, and only while the app
// was open. This closes that gap.
// ─── Receipt polling for /relay/notify ────────────────────────────────────────
//
// The caller (frontend/src/app/api/relay/route.ts) has ALREADY waited for this
// receipt on ITS connection before calling us. We then look the same tx up on
// OURS — a different URL (RPC_URL || BASE_SEPOLIA_RPC_URL || the free public
// node), and even when it is the same URL a load-balanced endpoint like
// drpc.live fans out over several node providers with independent lag. So the
// block the frontend has already seen may not have reached the replica that
// answers us, and getTransactionReceipt() returns `null` — not an error, just
// nothing. A single attempt therefore drops the push silently, which is how the
// deal-lifecycle OS notifications went missing with no trace anywhere.
//
// Same disease and same cure as the read-after-write guard on the USDC
// allowance in route.ts: poll until the fact is visible instead of assuming one
// read is authoritative.
//
// Ceiling: a Base Sepolia block is 2 s and the replica lag we have actually
// measured on this stack is 2–6 s, so 24 × 500 ms ≈ 11.5 s gives roughly 2× the
// worst observed lag. The step is a quarter of a block — fine enough that we
// notice the replica catching up almost immediately, coarse enough that a full
// exhaustion is 24 RPC calls, not hundreds.
//
// Mutable on purpose: the tests shrink `stepMs` so exhausting the poll takes
// milliseconds instead of eleven seconds, while still exercising the real
// attempt count.
export const RECEIPT_POLL = { attempts: 24, stepMs: 500 };

/**
 * Reads the receipt for `txHash`, retrying while the RPC replica has not caught
 * up. Resolves to the receipt, or to `null` once the attempts are spent — the
 * caller MUST say something about `null`, never swallow it.
 */
export async function waitForReceipt(txHash) {
  const { attempts, stepMs } = RECEIPT_POLL;
  for (let i = 0; i < attempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, stepMs));
  }
  return null;
}

app.post('/relay/notify', (req, res) => {
  if (!PUSH_SECRET || req.headers['x-push-secret'] !== PUSH_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { txHash, agreement, calldata } = req.body || {};
  if (!txHash || !agreement) return res.status(400).json({ error: 'txHash and agreement required' });
  // Ack immediately so the caller's relay response isn't delayed; fetch the receipt and
  // fan out the pushes in the background. Best-effort — a push must never block a tx.
  res.json({ ok: true });
  (async () => {
    try {
      const receipt = await waitForReceipt(txHash);
      if (receipt) {
        await pushAfterRelay(receipt, agreement, calldata);
        return;
      }
      // Giving up is a REPORTABLE outcome, not a no-op. Without this line the
      // only symptom of a dropped notification was a user who never heard about
      // his own deal, and nothing on the server said so. The txHash is in the
      // message so the tx can be looked up on the explorer and the pushes
      // reconstructed by hand.
      console.error(
        `[push] relay/notify: no receipt for ${txHash} after ${RECEIPT_POLL.attempts} attempts ` +
        `(~${Math.round((RECEIPT_POLL.attempts - 1) * RECEIPT_POLL.stepMs / 1000)}s) — ` +
        `pushes dropped for agreement ${agreement}`,
      );
    } catch (e) {
      console.error(`[push] relay/notify failed for ${txHash}:`, e.message);
    }
  })();
});

// ─── Dispute Reasons ──────────────────────────────────────────────────────────

const DISPUTE_REASONS_FILE = path.join(STORAGE_DIR, 'dispute-reasons.json');
let _disputeReasons = (() => {
  try { return existsSync(DISPUTE_REASONS_FILE) ? JSON.parse(readFileSync(DISPUTE_REASONS_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function _saveDisputeReasons() {
  try { writeFileSync(DISPUTE_REASONS_FILE, JSON.stringify(_disputeReasons), 'utf8'); } catch {}
}

// ─── File → pair manifest (protects evidence from TTL cleanup mid-dispute) ────
// Chat files carry no association to a deal on their own — chats are one MLS
// group per client/executor pair, not per deal (findOrCreatePairGroup). Tagging
// a file with its pairId lets the nightly cleanup job (see below) check whether
// that pair currently has a disputed agreement before deleting an expired file.

const FILE_PAIRS_FILE = path.join(STORAGE_DIR, 'file-pairs.json');
let _filePairs = (() => {
  try { return existsSync(FILE_PAIRS_FILE) ? JSON.parse(readFileSync(FILE_PAIRS_FILE, 'utf8')) : {}; } catch { return {}; }
})();
function _saveFilePairs() {
  try { writeFileSync(FILE_PAIRS_FILE, JSON.stringify(_filePairs), 'utf8'); } catch {}
}

app.get('/dispute-reason', (req, res) => {
  const agreement = String(req.query.agreement || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/i.test(agreement)) return res.status(400).json({ error: 'Invalid agreement address' });
  res.json(_disputeReasons[agreement] ?? { reason: null });
});

// POST /dispute-reason — requires Ethereum signature from the raiser (client or executor).
// Message: "hexseal:dispute-reason:<agreement>:<ts>:<keccak256(reason)>"
// Timestamp must be within ±5 minutes. Signer must be client or executor of the agreement.
app.post('/dispute-reason', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
  }

  const { agreement, reason, ts, sig } = req.body ?? {};
  if (!agreement || !/^0x[0-9a-f]{40}$/i.test(agreement)) return res.status(400).json({ error: 'Invalid agreement address' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
  if (reason.length > 2000) return res.status(400).json({ error: 'Reason too long (max 2000 chars)' });
  if (!ts || !sig) return res.status(401).json({ error: 'Missing ts or sig' });

  // Replay protection: timestamp must be within ±5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) {
    return res.status(401).json({ error: 'Timestamp out of window' });
  }

  try {
    // Recover signer from EIP-191 signed message
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(reason.trim()));
    const message    = `hexseal:dispute-reason:${agreement.toLowerCase()}:${ts}:${reasonHash}`;
    const raiser     = ethers.verifyMessage(message, sig).toLowerCase();

    // Verify on-chain: signer must be client or executor of this agreement
    const agr        = new ethers.Contract(agreement, AGREEMENT_MINI_ABI, provider);
    const details    = await agr.getDetails();
    const onChainClient   = details.client_?.toLowerCase();
    const onChainExecutor = details.executor_?.toLowerCase();

    if (raiser !== onChainClient && raiser !== onChainExecutor) {
      return res.status(403).json({ error: 'Not a party to this agreement' });
    }

    _disputeReasons[agreement.toLowerCase()] = {
      agreement: agreement.toLowerCase(),
      raiser,
      reason: reason.trim(),
      timestamp: Date.now(),
    };
    _saveDisputeReasons();
    res.json({ ok: true });
  } catch (err) {
    console.error('[dispute-reason] error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Exports for the bootstrap entrypoint (index.js) and for tests ───────────

export const relayerInfo = {
  relayerAddress: relayer.address,
  forwarderAddr:  FORWARDER_ADDR,
  diamondAddr:    DIAMOND_ADDR,
  allowedOrigins: ALLOWED_ORIGINS,
  baseUrl:        BASE_URL,
  storageDir:     STORAGE_DIR,
  dirFiles:       DIR_FILES,
  dirPublic:      DIR_PUBLIC,
  port:           PORT,
};

export { app, botSigner, botWallet };

// ─── Treasury keeper ──────────────────────────────────────────────────────────
//
// The treasury is pull-based by necessity: ERC-20 has no callback, so it cannot
// learn that a fee arrived. Nothing distributes itself — without something
// calling distribute(), fees just pile up on the contract and the arbiter vault
// is never funded. This is that something.
//
// Exported as a plain function, like runFileCleanup above: importing this module
// from a test must never schedule a real recurring job. index.js is the only
// place that wraps it in cron.schedule().
//
// Gas is paid by the relayer wallet. A full pass is three transactions at worst,
// a few hundred thousand gas each — on Base that is a rounding error against the
// fees it moves.

const TREASURY_ABI = [
  'function pendingDistribution() view returns (uint256)',
  'function vaultShortfall() view returns (uint256)',
  'function reserveBalance() view returns (uint256)',
  'function foundationOwed() view returns (uint256)',
  'function distribute()',
  'function topUpVault()',
  'function withdrawFoundation()',
  'event Distributed(uint256 toVault, uint256 toFoundation, uint256 toReserve)',
];

const DIAMOND_VAULT_ABI = ['function getVaultBalance() view returns (uint256)'];

// Built from the ABI rather than taken off the contract instance: parsing a
// receipt is a pure decode and has no business depending on which object the
// call happened to come back through.
const treasuryIface = new ethers.Interface(TREASURY_ABI);

// USDC has 6 decimals. These floors exist so the keeper never spends a
// transaction to move dust — fees trickle in continuously, and distributing
// three cents every hour costs more than it accomplishes.
const KEEPER_MIN_DISTRIBUTE = 1_000_000n;   // 1 USDC of undistributed income
const KEEPER_MIN_TOP_UP     = 1_000_000n;   // 1 USDC of vault shortfall
const KEEPER_MIN_WITHDRAW   = 10_000_000n;  // 10 USDC owed to the foundation

const usdc6 = (v) => `${(Number(v) / 1e6).toFixed(6)} USDC`;

export async function runTreasuryKeeper() {
  // Not deployed, or deployed but not yet wired in via setFeeRecipient. Staying
  // silent is correct: this is the normal state until someone decides to route
  // protocol income here, and a warning every hour would train people to ignore
  // the log.
  // Read at call time, not at import: the treasury does not exist yet, and an
  // operator who sets TREASURY_ADDRESS should not have to reason about whether
  // this module had already been imported when they did it.
  const treasuryAddr = process.env.TREASURY_ADDRESS;
  if (!treasuryAddr) return;

  const treasury = new ethers.Contract(treasuryAddr, TREASURY_ABI, relayer);
  const diamond  = new ethers.Contract(DIAMOND_ADDR, DIAMOND_VAULT_ABI, provider);

  // ── 1. Distribute income ────────────────────────────────────────────────────
  try {
    const pending = await treasury.pendingDistribution();
    if (pending >= KEEPER_MIN_DISTRIBUTE) {
      const vaultBefore = await diamond.getVaultBalance();

      const tx = await treasury.distribute();
      const receipt = await tx.wait();

      // The treasury deliberately has NO postcondition that the vault actually
      // credited what it received — one there would revert the whole waterfall
      // and let a broken facet freeze all income, which is the failure mode the
      // contract spends most of its design avoiding. The check lives here
      // instead: money left the treasury, so the vault must have grown by at
      // least as much. If it did not, a facet upgrade took the transfer without
      // recording it, and every subsequent pass will quietly feed the same hole.
      let toVault = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = treasuryIface.parseLog(log);
          if (parsed?.name === 'Distributed') toVault = parsed.args.toVault;
        } catch { /* not ours */ }
      }

      if (toVault > 0n) {
        const vaultAfter = await diamond.getVaultBalance();
        if (vaultAfter - vaultBefore < toVault) {
          console.error(
            `[keeper] ALARM: treasury sent ${usdc6(toVault)} to the vault but the vault ` +
            `only grew by ${usdc6(vaultAfter - vaultBefore)}. Money is leaving the treasury ` +
            `without being credited — stop the keeper and check fundVault on the diamond.`
          );
        }
      }

      console.log(`[keeper] distributed ${usdc6(pending)} (tx ${receipt.hash})`);
    }
  } catch (err) {
    console.warn('[keeper] distribute failed:', err.shortMessage || err.message);
  }

  // ── 2. Top the arbiter vault up from the reserve ────────────────────────────
  // Strictly after step 1, and not merely for tidiness: topUpVault() reverts
  // with DistributeFirst() while anything is undistributed. That gate exists
  // because otherwise the call ORDER decided who paid for the vault — calling
  // top-up first made the reserve pay, and up to 70% of that ended up as
  // foundation share instead. Distribute first, then let the reserve cover
  // whatever income could not.
  // Reading the state and acting on it are reported separately on purpose. Both
  // used to share one catch, so an RPC hiccup on the reads logged "topUpVault
  // failed" — which reads as "the chain refused the call" when in fact nothing
  // was ever attempted. Seen in the wild on the first live run.
  let topUpAmount = null;
  try {
    const [shortfall, reserve, pending] = await Promise.all([
      treasury.vaultShortfall(),
      treasury.reserveBalance(),
      treasury.pendingDistribution(),
    ]);
    if (shortfall >= KEEPER_MIN_TOP_UP && reserve > 0n && pending === 0n) {
      topUpAmount = shortfall < reserve ? shortfall : reserve;
    }
  } catch (err) {
    console.warn(
      '[keeper] could not read the treasury to decide on a vault top-up (nothing was attempted):',
      err.shortMessage || err.message
    );
  }

  if (topUpAmount !== null) {
    try {
      const tx = await treasury.topUpVault();
      const receipt = await tx.wait();
      console.log(
        `[keeper] topped the vault up by ${usdc6(topUpAmount)} from the reserve (tx ${receipt.hash})`
      );
    } catch (err) {
      console.warn('[keeper] topUpVault failed:', err.shortMessage || err.message);
    }
  }

  // ── 3. Push the foundation's accrued share out ──────────────────────────────
  // distribute() only accrues foundationOwed; the transfer is a separate call
  // so that a blacklisted or reverting foundation address cannot brick the
  // whole waterfall. Anyone may trigger it and the money can only ever go to
  // the immutable foundation address, so the keeper doing it is safe.
  try {
    const owed = await treasury.foundationOwed();
    if (owed >= KEEPER_MIN_WITHDRAW) {
      const tx = await treasury.withdrawFoundation();
      const receipt = await tx.wait();
      console.log(`[keeper] paid the foundation ${usdc6(owed)} (tx ${receipt.hash})`);
    }
  } catch (err) {
    console.warn('[keeper] withdrawFoundation failed:', err.shortMessage || err.message);
  }
}
