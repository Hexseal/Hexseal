import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  keccak256,
  toBytes,
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
]);

const FORWARDER_ABI = parseAbi([
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)',
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes retdata)',
]);

// AgreementDeployed(address indexed agreement, address indexed client, address indexed executor, uint256 amount, uint8 region, uint256 fee)
const AGREEMENT_DEPLOYED_TOPIC = keccak256(toBytes('AgreementDeployed(address,address,address,uint256,uint8,uint256)'));

// JobPosted(uint256 indexed jobId, address indexed client, uint256 amount, uint8 region)
const JOB_POSTED_TOPIC = keccak256(toBytes('JobPosted(uint256,address,uint256,uint8)'));

/**
 * Maximum gas units allowed in a single ForwardRequest.
 * Agreement deployment (acceptApplicant / acceptRequest / deployAndFund) costs ≈4.6–5 M gas.
 * With 1.3× estimation buffer that's ≈6–6.5 M, so cap at 8 M to give headroom.
 * Rate limiting (10 req/min) prevents relay ETH drain.
 */
const MAX_FORWARD_GAS = 8_000_000n;

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

    // ── USDC permit (for gasless Agreement.fund()) ───────────────────────────
    // If permit params are provided, call USDC.permit() first so the agreement
    // contract can do transferFrom on behalf of the user inside fund().
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
        // Known custom error selectors (Agreement.sol + FactoryFacet.sol)
        const CUSTOM_ERRORS: Record<string, string> = {
          '0xf12ce677': 'ActivationWindowPassed',
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
