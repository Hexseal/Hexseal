import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  keccak256,
  toBytes,
  decodeEventLog,
  type Hex,
  type Address,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { appChain, appRpcUrl } from '@/config/chain';
import { CONTRACTS } from '@/config/contracts';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIAMOND   = CONTRACTS.diamond   as Address;
const FORWARDER = CONTRACTS.forwarder as Address;
const USDC      = CONTRACTS.usdc      as Address;

// Legacy MinimalForwarder (pre-UpdateForwarder deploy). Used by older Agreements
// whose trustedForwarder was set before the upgrade.
const FORWARDER_LEGACY = '0xf963B2794c4fE788f98d7770dd3d9B3aBE8d9D58' as Address;

const KNOWN_FORWARDERS = new Set([
  FORWARDER.toLowerCase(),
  FORWARDER_LEGACY.toLowerCase(),
]);

const USDC_PERMIT_ABI = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const FORWARDER_ABI = parseAbi([
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)',
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes retdata)',
  // Without this there was no way to read execute()'s own success flag back off a
  // mined receipt — MinimalForwarder.execute() never reverts on an inner-call
  // failure, it just emits this and returns (false, revertData), so `receipt.status
  // === 'success'` alone tells you nothing. Mirrors the same addition in
  // relayer/app.js's FORWARDER_ABI (the other path forwarding through this contract).
  'event Executed(address indexed from, address indexed to, bool success)',
]);

// AgreementDeployed(address indexed agreement, address indexed client, address indexed executor, uint256 amount, uint8 region, uint256 fee)
const AGREEMENT_DEPLOYED_TOPIC = keccak256(toBytes('AgreementDeployed(address,address,address,uint256,uint8,uint256)'));

// JobPosted(uint256 indexed jobId, address indexed client, uint256 amount, uint8 region, string title, string description, uint256 deadlineDays, string terms)
const JOB_POSTED_TOPIC = keccak256(toBytes('JobPosted(uint256,address,uint256,uint8,string,string,uint256,string)'));

/**
 * Maximum gas units allowed in a single ForwardRequest.
 *
 * The previous 5M cap (itself a fix, raised from an earlier 3M) was sized off
 * pre-fee-economics measurements. Task 10 of the fee-economics-frontend branch
 * re-measured every gasless path at the form's actual maxLength (mock USDC,
 * foundry) and found several functions grew once cancel/reject started doing
 * a second transfer plus a `FeeCollected` log — most sharply `acceptRequest`,
 * which also stacks the worst-case 19-sibling refund loop:
 *
 *   acceptRequest    (19 siblings, terms 2000)                   3_219_461
 *   mintJob          (title 100 / description 500 / terms 2000)  2_791_334
 *   acceptApplicant  (terms 2000)                                2_332_247
 *   deployAndFund    (terms 2000)                                2_074_240
 *
 * `acceptRequest` is the operation that squeezed the old 5M cap: the
 * frontend's live gas estimate (frontend/src/lib/relay.ts) buffers the
 * measured value 1.3× before the signed request ever reaches this route —
 * 3_219_461 × 1.3 = 4_185_299 against mock USDC, only 16% margin under 5M.
 * Real USDC (proxied FiatTokenV2_2) costs ~19% more than the mock per the
 * same adjustment Task 10 applied elsewhere: 3_219_461 × 1.19 × 1.3 ≈
 * 4_980_505 — 0.4% margin, i.e. functionally no headroom left. mintJob is the
 * next heaviest at 2_791_334, with mintJobWithPermit adding ~30k for the
 * permit call on top; neither comes close to acceptRequest's real-USDC number.
 *
 * Raised to 7M: keeps ~40% margin over acceptRequest's real-USDC estimate
 * (4_980_505) while still cutting the per-request ETH-drain ceiling versus
 * the original 8M this cap descended from.
 *
 * The asymmetry is worth spelling out: a cap that's too low kills a
 * legitimate user action outright — worse, the direct-tx fallback doesn't
 * save it, since isRelayDown() (frontend/src/lib/relay.ts) only catches
 * network failures and 5xx, not this 400 — while a cap that's too high costs
 * nothing, because the chain charges gas actually used, not gas requested.
 * Rate limiting (10 req/min) is the other half of the drain defence.
 *
 * Keep in sync with MAX_GAS in relayer/app.js — the other path through the
 * same forwarder.
 */
const MAX_FORWARD_GAS = 7_000_000n;

// ─── Relayer hot-wallet nonce serialization ──────────────────────────────────
//
// Every request here signs and broadcasts transaction(s) from the SAME relayer
// hot-wallet account (RELAYER_PRIVATE_KEY) — viem determines each tx's nonce
// via eth_getTransactionCount(address,'pending') at send time (no nonceManager
// is configured on the account), and nothing serialized that across concurrent
// invocations of this route handler. Two ordinary gasless actions from
// different users (or the same user's own second browser tab) arriving close
// together — completely normal during any period of overlapping marketplace
// activity — could both read the same "next" nonce and race; one (often both)
// gets rejected/dropped by the node with a raw, unhelpful 500. This process is
// a persistent Node server (VPS Docker deploy, not a serverless function that
// resets per invocation), so a plain module-level queue genuinely serializes
// real concurrent requests. Capped so one slow request can't wedge every
// other user's action behind it indefinitely.
let _relayerLock: Promise<void> = Promise.resolve();
const RELAYER_LOCK_TIMEOUT_MS = 4 * 60_000; // a bit over viem's 180s receipt-wait default

async function withRelayerLock<T>(fn: () => Promise<T>): Promise<T> {
  const ahead = _relayerLock;
  let release!: () => void;
  const ours = new Promise<void>(resolve => { release = resolve; });
  _relayerLock = ours; // install as the new tail before awaiting anything
  await Promise.race([
    ahead.then(() => {}, () => {}),
    new Promise<void>(resolve => setTimeout(resolve, RELAYER_LOCK_TIMEOUT_MS)),
  ]);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── Relayer balance visibility ──────────────────────────────────────────────
//
// Nothing anywhere checked the relayer hot wallet's own ETH balance before
// attempting to send — a dry wallet just fails every request identically via
// the generic catch-all with a raw, untranslated viem error ("insufficient
// funds for gas..."), giving no actionable signal that the relay itself is
// dry versus any other failure class, and nothing prompted a refill. This
// doesn't prevent that outage (needs a real top-up), but logs it loudly and
// distinctly the moment it becomes likely, instead of leaving it silent until
// someone notices failures or happens to check relayer/index.js's /balance
// endpoint manually. Cached briefly so it doesn't add an RPC round-trip (or
// meaningful load) to every single relay request.
const LOW_BALANCE_THRESHOLD_WEI = 5_000_000_000_000_000n; // 0.005 ETH
const LOW_BALANCE_CHECK_INTERVAL_MS = 60_000;
let _lastBalanceCheckAt = 0;

function checkRelayerBalance(publicClient: ReturnType<typeof createPublicClient>, address: Address): void {
  const now = Date.now();
  if (now - _lastBalanceCheckAt < LOW_BALANCE_CHECK_INTERVAL_MS) return;
  _lastBalanceCheckAt = now;
  publicClient.getBalance({ address })
    .then(balance => {
      if (balance < LOW_BALANCE_THRESHOLD_WEI) {
        console.error(
          `[relay] LOW BALANCE WARNING: relayer hot wallet ${address} has ${balance} wei ` +
          `(below ${LOW_BALANCE_THRESHOLD_WEI} wei threshold) — top up soon or gasless relay will start failing.`
        );
      }
    })
    .catch(() => { /* best-effort visibility only — never block/fail a request over this */ });
}

// ─── Rate limit: 10 req/min per wallet address (in-memory) ──────────────────
const _localMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(address: string): boolean {
  const key = address.toLowerCase();
  const now = Date.now();
  const entry = _localMap.get(key);
  if (!entry || now > entry.resetAt) {
    _localMap.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ─── Request type ────────────────────────────────────────────────────────────

type ForwardRequest = {
  from:      string;
  to:        string;
  value:     string;
  gas:       string;
  nonce:     string;
  data:      string;
  signature: string;
  // Optional: override forwarder for legacy agreements with a different trustedForwarder
  forwarderOverride?: string;
  // Optional: USDC permit params for gasless fund()
  permitOwner?:    string;
  permitSpender?:  string;
  permitValue?:    string;
  permitDeadline?: string;
  permitV?:        number;
  permitR?:        string;
  permitS?:        string;
};

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Parse body ──────────────────────────────────────────────────────────
    let body: Partial<ForwardRequest>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      from, to, value = '0', gas, nonce, data, signature,
      forwarderOverride,
      permitOwner, permitSpender, permitValue, permitDeadline, permitV, permitR, permitS,
    } = body;

    // Resolve effective forwarder — only allow known forwarder addresses
    const effectiveForwarder: Address =
      forwarderOverride && KNOWN_FORWARDERS.has(forwarderOverride.toLowerCase())
        ? (forwarderOverride as Address)
        : FORWARDER;

    // ── Field validation ────────────────────────────────────────────────────
    if (!from || !to || !gas || !nonce || !data || !signature) {
      return NextResponse.json(
        { error: 'Missing required fields: from, to, gas, nonce, data, signature' },
        { status: 400 }
      );
    }

    // ── gas cap — prevent relay ETH drain via oversized ForwardRequests ────────
    if (BigInt(gas) > MAX_FORWARD_GAS) {
      return NextResponse.json(
        { error: `gas exceeds maximum allowed (${MAX_FORWARD_GAS})` },
        { status: 400 }
      );
    }

    // ── to must be a valid Ethereum address ─────────────────────────────────────
    // Diamond calls, Agreement.fund() with permit, and Agreement actions (activate,
    // markDone, release, raiseDispute, etc.) are all allowed.
    // Security: on-chain signature verification + gas cap + rate limit.
    const isPermitFund = !!(permitOwner && permitSpender && permitValue && permitDeadline
      && permitV !== undefined && permitR && permitS);
    if (!isAddress(to)) {
      return NextResponse.json(
        { error: 'Invalid target: to must be a valid Ethereum address' },
        { status: 400 }
      );
    }

    // ── permitOwner must match from — prevents burning a victim's USDC nonce ──
    if (isPermitFund && permitOwner!.toLowerCase() !== from.toLowerCase()) {
      return NextResponse.json(
        { error: 'permitOwner must match from address' },
        { status: 400 }
      );
    }

    // ── permitV must be 27 or 28 (valid secp256k1 recovery id) ─────────────
    if (isPermitFund && permitV !== 27 && permitV !== 28) {
      return NextResponse.json(
        { error: 'Invalid permitV: must be 27 or 28' },
        { status: 400 }
      );
    }

    // ── Rate limit by wallet address ────────────────────────────────────────
    if (!checkRateLimit(from)) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Max 10 requests per minute.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }

    // ── Hot wallet ──────────────────────────────────────────────────────────
    const relayerKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.RELAY_PRIVATE_KEY;
    if (!relayerKey) {
      console.error('[relay] RELAYER_PRIVATE_KEY is not set');
      return NextResponse.json(
        { error: 'Gasless relay unavailable', gasless: false },
        { status: 503 }
      );
    }

    const account = privateKeyToAccount(relayerKey as Hex);
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? appRpcUrl;
    const fallbackRpc = appChain.id === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
    const transport = fallback([http(rpcUrl, { timeout: 30_000 }), http(fallbackRpc, { timeout: 30_000 })]);

    const publicClient = createPublicClient({
      chain: appChain,
      transport,
    });

    // Fire-and-forget, rate-limited to once per LOW_BALANCE_CHECK_INTERVAL_MS —
    // never awaited, so it adds no latency to this (or any) request.
    checkRelayerBalance(publicClient, account.address);

    const walletClient = createWalletClient({
      account,
      chain: appChain,
      transport,
    });

    // ── Build tuple ─────────────────────────────────────────────────────────
    const forwardReq = {
      from:  from  as Address,
      to:    to    as Address,
      value: BigInt(value),
      gas:   BigInt(gas),
      nonce: BigInt(nonce),
      data:  data  as Hex,
    } as const;

    // ── Verify signature on-chain ────────────────────────────────────────────
    const valid = await publicClient.readContract({
      address: effectiveForwarder,
      abi: FORWARDER_ABI,
      functionName: 'verify',
      args: [forwardReq, signature as Hex],
    });

    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      );
    }

    // Everything from here through the receipt wait below consumes the relayer
    // hot-wallet's own tx nonce (permit, then execute) — see withRelayerLock's
    // own comment for why this must be serialized across concurrent requests.
    // The callback returns a NextResponse directly for every early-exit path
    // (permit failure, simulation failure, etc.) so none of those need to
    // change — only the final success path returns the {receipt, txHash} pair.
    const relayResult = await withRelayerLock(async (): Promise<NextResponse | { receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>; txHash: Hex }> => {
    // ── USDC permit (for gasless fund / mintJob / mintService / requestService) ─
    // If permit params are provided, call USDC.permit() first so the target
    // contract can do transferFrom on behalf of the user.
    if (isPermitFund) {
      try {
        const permitTxHash = await walletClient.writeContract({
          address: USDC,
          abi: USDC_PERMIT_ABI,
          functionName: 'permit',
          args: [
            permitOwner! as Address,
            permitSpender! as Address,
            BigInt(permitValue!),
            BigInt(permitDeadline!),
            permitV! as number,
            permitR! as Hex,
            permitS! as Hex,
          ],
          chain: appChain,
        });
        await publicClient.waitForTransactionReceipt({ hash: permitTxHash });
        console.log('[relay] USDC permit set, txHash:', permitTxHash);

        // ── Read-after-write guard ──────────────────────────────────────────
        // waitForTransactionReceipt only proves the permit tx was mined — with
        // a load-balanced RPC endpoint (e.g. drpc.live proxying multiple node
        // providers behind one URL), the *next* read on this same client can
        // still land on a node that hasn't caught up to that block yet, so
        // allowance() can read back as stale/zero right after a confirmed
        // permit. Poll briefly until the allowance we just set is actually
        // visible before simulating the transferFrom that depends on it.
        const expectedAllowance = BigInt(permitValue!);
        let observedAllowance = 0n;
        for (let attempt = 0; attempt < 5; attempt++) {
          observedAllowance = await publicClient.readContract({
            address: USDC,
            abi: USDC_PERMIT_ABI,
            functionName: 'allowance',
            args: [permitOwner! as Address, permitSpender! as Address],
          });
          if (observedAllowance >= expectedAllowance) break;
          await new Promise(r => setTimeout(r, 400));
        }
        if (observedAllowance < expectedAllowance) {
          console.error(
            '[relay] allowance not visible after permit confirmation:',
            `expected >= ${expectedAllowance}, observed ${observedAllowance}`,
          );
          return NextResponse.json(
            { error: 'USDC permit confirmed but allowance not yet visible — please retry' },
            { status: 400 },
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[relay] USDC permit failed:', msg);
        return NextResponse.json({ error: `USDC permit failed: ${msg}` }, { status: 400 });
      }
    }

    // ── Simulate execute() to catch silent inner-call failures ───────────────
    // MinimalForwarder.execute() returns (bool success, bytes retdata).
    // If the inner call reverts, execute() itself does NOT revert — it returns
    // (false, revertData) and the tx receipt shows 'success'. We must detect
    // this before sending by simulating the call first.
    try {
      const sim = await publicClient.simulateContract({
        address: effectiveForwarder,
        abi: FORWARDER_ABI,
        functionName: 'execute',
        args: [forwardReq, signature as Hex],
        account: account.address,
        value: 0n,
      });
      // sim.result is [success: boolean, retdata: Hex]
      const [innerSuccess, retdata] = sim.result as [boolean, Hex];
      if (!innerSuccess) {
        // Known custom error selectors (Agreement.sol + FactoryFacet.sol +
        // ArbiterRegistryFacet.sol). This route forwards arbitrary calldata to
        // any target through MinimalForwarder.execute() — it's the same generic
        // path used for arbiter actions (commit/claim/verdict/appeal), not just
        // Agreement/FactoryFacet calls, despite what the comment used to imply.
        // Without the ArbiterRegistryFacet entries, e.g. two arbiters racing to
        // claim the same dispute left the losing one with a raw "Call failed:
        // Inner call reverted" instead of a message identifying what happened.
        const CUSTOM_ERRORS: Record<string, string> = {
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

        let reason = 'Inner call reverted';
        const selector = retdata ? retdata.slice(0, 10).toLowerCase() : '';

        if (CUSTOM_ERRORS[selector]) {
          reason = CUSTOM_ERRORS[selector];
        } else if (retdata && retdata.length > 10 && selector === '0x08c379a0') {
          // Standard Error(string)
          try {
            const decoded = retdata.slice(10);
            const len = parseInt(decoded.slice(64, 128), 16);
            reason = Buffer.from(decoded.slice(128, 128 + len * 2), 'hex').toString('utf8');
          } catch { /* ignore decode errors */ }
        }

        console.error('[relay] inner call failed:', reason, 'retdata:', retdata);
        return NextResponse.json({ error: `Call failed: ${reason}`, errorCode: selector }, { status: 400 });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[relay] simulation failed:', msg);
      return NextResponse.json({ error: `Simulation failed: ${msg}` }, { status: 400 });
    }

    // ── Estimate gas for execute() ───────────────────────────────────────────
    let gasLimit: bigint;
    try {
      const estimated = await publicClient.estimateContractGas({
        address: effectiveForwarder,
        abi: FORWARDER_ABI,
        functionName: 'execute',
        args: [forwardReq, signature as Hex],
        account: account.address,
        value: 0n,
      });
      gasLimit = (estimated * 120n) / 100n;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[relay] gas estimation failed:', msg);
      return NextResponse.json(
        { error: `Gas estimation failed: ${msg}` },
        { status: 400 }
      );
    }

    // ── Send tx through MinimalForwarder ─────────────────────────────────────
    const txHash = await walletClient.writeContract({
      address: effectiveForwarder,
      abi: FORWARDER_ABI,
      functionName: 'execute',
      args: [forwardReq, signature as Hex],
      gas: gasLimit,
      value: 0n,
      chain: appChain,
    });

    // ── Wait for receipt ─────────────────────────────────────────────────────
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === 'reverted') {
      return NextResponse.json(
        { error: 'Transaction reverted on-chain' },
        { status: 400 }
      );
    }

    return { receipt, txHash };
    });

    if (relayResult instanceof NextResponse) return relayResult;
    const { receipt, txHash } = relayResult;

    // ── Re-verify after mining ─────────────────────────────────────────────────
    // The simulateContract() call above is a gas-saving pre-filter, not proof —
    // state can change between simulating and broadcasting (another tx consumes
    // the same nonce, spends an allowance, accepts the same job first, ...), so
    // the inner call can still fail even though execute() itself doesn't revert
    // and receipt.status reads 'success'. The forwarder's own Executed(from, to,
    // success) log on the mined receipt is the actual source of truth. Mirrors
    // the same re-check added to relayer/app.js's /relay route — both paths must
    // reach the same verdict for the same on-chain outcome.
    let minedSuccess = true; // no matching log found is unexpected, not a signal — fail open, not closed
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== effectiveForwarder.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: FORWARDER_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === 'Executed') {
          minedSuccess = decoded.args.success;
          break;
        }
      } catch { /* not a log this ABI recognizes */ }
    }

    if (!minedSuccess) {
      // Unlike the pre-send simulateContract() failure above, Executed's event only
      // carries the bool — no revertdata — so the CUSTOM_ERRORS table can't decode
      // a specific reason here. Re-simulating now wouldn't recover it either: the
      // nonce this request signed is already consumed on-chain by the tx that just
      // mined, so a second execute() call with the same forwardReq would fail on the
      // nonce/signature check itself, not reproduce the original inner revert.
      console.error('[relay] inner call failed on the mined tx despite a passing simulation (state changed in between)');
      return NextResponse.json(
        { error: 'Transaction mined but the inner call failed (state changed after simulation) — no revert reason available' },
        { status: 400 }
      );
    }

    // ── Parse event logs ─────────────────────────────────────────────────────
    let agreementAddr: string | undefined;
    let jobId: string | undefined;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
      const topic0 = log.topics[0];

      // AgreementDeployed → extract agreementAddr from topic[1]
      if (topic0 === AGREEMENT_DEPLOYED_TOPIC) {
        const topic1 = log.topics[1];
        if (topic1) agreementAddr = '0x' + topic1.slice(26);
      }

      // JobPosted → extract jobId from topic[1] (uint256 indexed)
      if (topic0 === JOB_POSTED_TOPIC) {
        const topic1 = log.topics[1];
        if (topic1) jobId = BigInt(topic1).toString();
      }
    }

    // ── On-chain push notifications ──────────────────────────────────────────
    // Hand the confirmed tx to the standalone relayer so it sends the OS push
    // (Deal Funded / Activated / Work Submitted / Complete / Refunded / Dispute) via
    // pushAfterRelay, which owns the push-subscription store. The relayer acks
    // immediately and pushes in the background, so this adds negligible latency and
    // never fails the user's tx over a notification. For a deploy the target is the
    // freshly created agreement; otherwise it's whatever the action hit.
    const relayerInternal = (process.env.RELAYER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL ?? '').replace(/\/$/, '');
    const pushSecret = process.env.PUSH_SECRET;
    if (relayerInternal && pushSecret) {
      try {
        await fetch(`${relayerInternal}/relay/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Push-Secret': pushSecret },
          body: JSON.stringify({ txHash, agreement: agreementAddr ?? forwardReq.to, calldata: data }),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* best-effort — never fail the user's tx over a push */ }
    }

    return NextResponse.json({
      success: true,
      txHash,
      ...(agreementAddr ? { agreementAddr } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[relay] unexpected error:', msg);
    return NextResponse.json(
      { error: msg || 'Relay failed' },
      { status: 500 }
    );
  }
}
