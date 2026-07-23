/**
 * relay.ts — клиентская сторона gasless relay
 *
 * deployAndFundGasless() — атомарный деплой+фанд+NFT mint за 2 подписи (0 газа от юзера)
 * sendGasless()          — универсальный gasless для любого вызова Diamond
 * approveUSDC()          — обычный ERC-20 approve (юзер платит газ)
 */

import {
  type WalletClient,
  type PublicClient,
  type Abi,
  encodeFunctionData,
  parseAbi,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { DIAMOND_ABI, CONTRACTS } from '@/config/contracts';
import { CHAIN_ID } from '@/config/constants';

// ─── Addresses ────────────────────────────────────────────────────────────────

const DIAMOND   = CONTRACTS.diamond   as Address;
const FORWARDER = CONTRACTS.forwarder as Address;
const USDC      = CONTRACTS.usdc      as Address;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const FORWARDER_READ_ABI = parseAbi([
  'function getNonce(address from) view returns (uint256)',
]);

const USDC_READ_ABI = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

// ─── EIP-712: ForwardRequest ──────────────────────────────────────────────────

const FORWARDER_DOMAIN = {
  name: 'MinimalForwarder',
  version: '0.0.1',
  chainId: CHAIN_ID,
  verifyingContract: FORWARDER,
} as const;

const FORWARD_TYPES = {
  ForwardRequest: [
    { name: 'from',  type: 'address' },
    { name: 'to',    type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas',   type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'data',  type: 'bytes'   },
  ],
} as const;

// ─── EIP-2612: USDC Permit ────────────────────────────────────────────────────

// Domain читается с контракта, а не захардкожен — USDC на разных сетях
// может иметь разные name/version/salt поля (EIP-5267).
async function getUsdcDomain(publicClient: PublicClient): Promise<Record<string, unknown>> {
  try {
    const [usdcName, usdcVersion] = await Promise.all([
      publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'name' }),
      publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'version' }),
    ]);
    const domain = { name: usdcName, version: usdcVersion, chainId: BigInt(CHAIN_ID), verifyingContract: USDC };
    return domain;
  } catch {
    const domain = { name: 'USDC', version: '2', chainId: BigInt(CHAIN_ID), verifyingContract: USDC };
    return domain;
  }
}

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner',    type: 'address' },
    { name: 'spender',  type: 'address' },
    { name: 'value',    type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// ─── Gas defaults ─────────────────────────────────────────────────────────────

const GAS_DEFAULTS: Record<string, bigint> = {
  deployAndFund:      5_500_000n, // deployAgreement alone ~4.6M
  deployAgreement:    5_500_000n,
  mintJob:            1_500_000n,
  mintJobWithPermit:  1_500_000n,
  editJob:              150_000n,
  editService:          150_000n,
  acceptApplicant:    5_500_000n, // deploys Agreement via FactoryFacet (~4.6M) + overhead
  cancelJob:            150_000n,
  applyForJob:          150_000n,
  withdrawApplication:  150_000n,
  mintService:              800_000n,
  mintServiceWithPermit:    800_000n,
  requestService:       800_000n,
  // also deploys Agreement (~4.6M) PLUS a loop refunding every OTHER still-pending
  // request from the same client to this executor (up to MAX_PENDING_PER_PAIR-1=19
  // siblings) — measured ~5.17M gas at the 19-sibling worst case, unlike
  // acceptApplicant/deployAndFund which share this same flat constant but have no
  // such loop. This fallback value gets no automatic buffer (unlike the live-estimate
  // path's 130%), so size it with real margin over the measured worst case.
  acceptRequest:      6_500_000n,
  rejectRequest:        120_000n,
  cancelRequest:        120_000n,
  pauseService:          80_000n,
  unpauseService:        80_000n,
  removeService:         80_000n,
  claimDispute:         200_000n,
  releaseDisputeClaim:  100_000n,
  commitDisputeClaim:   100_000n,
  resolveDispute:       200_000n,
  // Agreement lifecycle
  fund:               150_000n,
  activate:           200_000n,
  markDone:           200_000n,
  release:            500_000n, // _complete: NFT burn + Diamond registry call + USDC transfer
  raiseDispute:       100_000n,
  triggerAutoApprove: 120_000n,
  triggerActivationTimeout: 100_000n,
  triggerDeadlineTimeout:   100_000n,
  triggerArbiterTimeout:    100_000n,
};

const DEFAULT_GAS = 500_000n;

// ─── Per-wallet serialization ─────────────────────────────────────────────────
//
// Every gasless call for a given wallet reads a nonce (the MinimalForwarder's
// getNonce(from), and/or the USDC contract's EIP-2612 permit nonce for that
// owner) and signs against it — but nothing coordinated two gasless calls for
// the SAME wallet started close together (e.g. applying to two jobs, or acting
// on two different deals shown on the same dashboard). Both would read the
// same nonce, both get signed, and the second one to actually land on-chain
// reverts with a nonce mismatch — the user pays the friction of a real wallet
// signature for the losing one too, then sees a cryptic contract-error dump
// with no indication that simply retrying (once the first has landed) would
// work. Queue calls per wallet address so a second one waits for the first to
// finish (success or failure) before it even reads a nonce.
const _walletLocks = new Map<string, Promise<void>>();

// A held lock is only ever released from the holder's own `finally` — and the
// operations it guards (a wallet-signature popup with no code-level timeout,
// a WalletConnect mobile round-trip) can hang indefinitely on ordinary,
// non-adversarial wallet behavior (user backgrounds the tab mid-signature,
// abandons an open popup, a dropped mobile session that never rejects).
// Without a ceiling, one abandoned call would silently wedge every OTHER
// gasless action for that wallet — anywhere in the app — for the rest of the
// session, with no error and no way out short of a full page reload. Give up
// waiting after this long and let the next queued call proceed anyway,
// treating the holder as abandoned. This reopens a narrow window for the
// original nonce race this lock exists to prevent (only if the abandoned call
// is somehow later resurrected past this point), but a rare, low-cost repeat
// of that already-handled failure mode is far better than an indefinite,
// unrecoverable stall.
const WALLET_LOCK_TIMEOUT_MS = 3 * 60_000; // 3 min — generous for a real signature wait

/** Waits for any earlier-queued gasless call for this wallet to finish (success
 *  or failure — either way its nonce has already been consumed or never sent),
 *  then reserves the lock for the caller. Returns a release callback that MUST
 *  be called in a `finally` block so the next queued call can proceed. */
async function acquireWalletLock(address: string): Promise<() => void> {
  const key = address.toLowerCase();
  const ahead = _walletLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ours = new Promise<void>(resolve => { release = resolve; });
  // Install ourselves as the new tail of the queue before awaiting anything, so a
  // third concurrent call queues behind us, not behind whoever was ahead of us.
  _walletLocks.set(key, ours);
  await Promise.race([
    ahead.then(() => {}, () => {}),
    new Promise<void>(resolve => setTimeout(resolve, WALLET_LOCK_TIMEOUT_MS)),
  ]);
  return () => {
    release();
    // Only clear the map entry if nobody has queued behind us since — otherwise
    // this would drop the reference the next-in-line's "ahead" still points to.
    if (_walletLocks.get(key) === ours) _walletLocks.delete(key);
  };
}

// ─── Relay availability detection ────────────────────────────────────────────

/** True if error is relay SERVER failure (5xx / network down) — not a contract revert. */
function isRelayDown(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.toLowerCase().includes('failed to fetch') ||
    /relay error 5\d\d/i.test(msg)
  );
}

// Every "relay down" fallback below sends a direct on-chain tx and used to
// return fallbackUsed:true the moment walletClient.sendTransaction/writeContract
// resolved — which for a browser/injected wallet is mempool-ACCEPTANCE, not
// mining. Unlike the primary relay path (which waits for + checks the real
// receipt server-side before ever reporting success), nothing here verified the
// fallback tx actually succeeded. Most dangerously: isRelayDown() fires on a
// "failed to fetch" network error, which can happen AFTER the server already
// fully processed the original relay call — so the fallback can reuse an
// already-consumed permit signature, which then deterministically reverts on
// this exact retry, while the caller's success toast fires regardless.
async function assertFallbackMined(publicClient: PublicClient, txHash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain (fallback send)');
}

const WRITE_USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

const TRUSTED_FORWARDER_ABI = parseAbi(['function trustedForwarder() view returns (address)']);

// ─── Internal: build & send ForwardRequest ────────────────────────────────────

type PermitParams = {
  permitOwner: string; permitSpender: string; permitValue: string;
  permitDeadline: string; permitV: number; permitR: string; permitS: string;
};

async function _sendForwardRequest(
  walletClient: WalletClient,
  publicClient: PublicClient,
  calldata: Hex,
  functionName: string,
  targetAddress: Address = DIAMOND,
  forwarderOverride?: Address,
  permitParams?: PermitParams,
): Promise<{ txHash: string; agreementAddr?: string; jobId?: string }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

  const effectiveForwarder = forwarderOverride ?? FORWARDER;

  const forwarderDomain =
    effectiveForwarder.toLowerCase() === FORWARDER.toLowerCase()
      ? FORWARDER_DOMAIN
      : { ...FORWARDER_DOMAIN, verifyingContract: effectiveForwarder } as const;

  // Get nonce from the effective MinimalForwarder
  const nonce = await publicClient.readContract({
    address: effectiveForwarder,
    abi: FORWARDER_READ_ABI,
    functionName: 'getNonce',
    args: [userAddress],
  });

  // Estimate gas; fallback to default
  let gasLimit: bigint;
  try {
    const estimated = await publicClient.estimateGas({
      account: userAddress,
      to: targetAddress,
      data: calldata,
    });
    gasLimit = (estimated * 130n) / 100n;
  } catch {
    gasLimit = GAS_DEFAULTS[functionName] ?? DEFAULT_GAS;
  }

  const message = {
    from:  userAddress,
    to:    targetAddress,
    value: 0n,
    gas:   gasLimit,
    nonce,
    data:  calldata,
  };

  // Sign ForwardRequest (EIP-712)
  const signature = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: forwarderDomain,
    types:  FORWARD_TYPES,
    primaryType: 'ForwardRequest',
    message,
  });

  // POST to relay
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:      message.from,
      to:        message.to,
      value:     message.value.toString(),
      gas:       message.gas.toString(),
      nonce:     message.nonce.toString(),
      data:      message.data,
      signature,
      ...(forwarderOverride ? { forwarderOverride: effectiveForwarder } : {}),
      ...(permitParams ?? {}),
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Relay error ${res.status}`);

  return {
    txHash:        json.txHash as string,
    agreementAddr: json.agreementAddr as string | undefined,
    jobId:         json.jobId as string | undefined,
  };
}

// ─── deployAndFundGasless ─────────────────────────────────────────────────────

/**
 * Атомарный деплой + финансирование + mint NFT — всё в одной on-chain транзакции.
 *
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — Diamond как spender, amount + fee
 *   2. ForwardRequest (EIP-712) — deployAndFund calldata
 *
 * Газ платит relay hot wallet.
 */
export async function deployAndFundGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    executor:     Address;
    amount:       bigint;  // deal amount, 6 decimals
    deadlineDays: bigint;
    terms:        string;  // условия сделки (on-chain)
    region:       number;  // 0-3
    fee:          bigint;  // PPP fee, 6 decimals
  },
): Promise<{ txHash: string; agreementAddr?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { executor, amount, deadlineDays, terms, region, fee } = params;
  const total = amount + fee;

  // Step 1 — get USDC permit nonce + реальный EIP-712 домен
  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({
      address: USDC,
      abi: USDC_READ_ABI,
      functionName: 'nonces',
      args: [userAddress],
    }),
    getUsdcDomain(publicClient),
  ]);

  // Step 2 — permit deadline: now + 1 hour
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // Step 3 — sign USDC permit (wallet popup 1 of 2)
  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain:  usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types:   PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner:    userAddress,
      spender:  DIAMOND,
      value:    total,
      nonce:    usdcNonce,
      deadline: permitDeadline,
    },
  });

  // Step 4 — split permit signature into v, r, s
  const { r, s, v } = parseSignature(permitSig);
  // v может быть 0/1 (yParity) у некоторых кошельков — нормализуем до 27/28
  const vNum = Number(v) < 27 ? Number(v) + 27 : Number(v);

  // Step 5 — encode deployAndFund calldata WITHOUT permit params
  // Permit is sent separately in body; relay calls USDC.permit() before ForwardRequest
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'deployAndFund',
    args: [
      userAddress,  // client (_msgSender() check enforces this)
      executor,
      amount,
      deadlineDays,
      terms,
      region,
    ],
  });

  const permitParams: PermitParams = {
    permitOwner:    userAddress,
    permitSpender:  DIAMOND,
    permitValue:    total.toString(),
    permitDeadline: permitDeadline.toString(),
    permitV:        vNum,
    permitR:        r,
    permitS:        s,
  };

  // Step 6 — sign ForwardRequest and send; fallback: require user to approve USDC first
  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'deployAndFund', DIAMOND, undefined, permitParams);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    // Relay down — fallback: user must have approved USDC separately (or do it now)
    console.warn('[relay] down → direct deployAndFund');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── mintJobGasless ───────────────────────────────────────────────────────────

/**
 * Постит Job на борд — gasless.
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — Diamond как spender, amount + fee
 *   2. ForwardRequest (EIP-712) — mintJobWithPermit calldata
 */
export async function mintJobGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    title:        string;
    description:  string;
    amount:       bigint;  // deal amount, 6 decimals
    deadlineDays: bigint;
    terms:        string;  // условия работы (on-chain)
    region:       number;  // 0-3
    fee:          bigint;  // PPP fee, 6 decimals
  },
): Promise<{ txHash: string; jobId?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { title, description, amount, deadlineDays, terms, region, fee } = params;
  const total = amount + fee;

  // Step 1 — get USDC permit nonce + реальный EIP-712 домен
  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({
      address: USDC,
      abi: USDC_READ_ABI,
      functionName: 'nonces',
      args: [userAddress],
    }),
    getUsdcDomain(publicClient),
  ]);

  // Step 2 — permit deadline: now + 1 hour
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // Step 3 — sign USDC permit (wallet popup 1 of 2)
  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain:  usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types:   PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner:    userAddress,
      spender:  DIAMOND,
      value:    total,
      nonce:    usdcNonce,
      deadline: permitDeadline,
    },
  });

  // Step 4 — split permit signature
  const { r, s, v } = parseSignature(permitSig);
  // v может быть 0/1 (yParity) у некоторых кошельков — нормализуем до 27/28
  const vNum = Number(v) < 27 ? Number(v) + 27 : Number(v);

  // Step 5 — encode mintJobWithPermit calldata (permit params embedded, atomic in one tx)
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'mintJobWithPermit',
    args: [userAddress, title, description, amount, deadlineDays, terms, region, permitDeadline, vNum, r, s],
  });

  // Step 6 — sign ForwardRequest and send; no separate permitParams — relay doesn't call USDC.permit()
  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'mintJobWithPermit', DIAMOND);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct mintJobWithPermit');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── mintServiceGasless ───────────────────────────────────────────────────────

/**
 * Публикует Service на борд — gasless.
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — Diamond как spender, fee only
 *   2. ForwardRequest (EIP-712) — mintServiceWithPermit calldata
 */
export async function mintServiceGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    title:        string;
    description:  string;
    price:        bigint;  // listing price (рекомендованная), 6 decimals
    deadlineDays: bigint;
    region:       number;  // 0-3
    fee:          bigint;  // PPP fee, 6 decimals
  },
): Promise<{ txHash: string; serviceId?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { title, description, price, deadlineDays, region, fee } = params;

  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'nonces', args: [userAddress] }),
    getUsdcDomain(publicClient),
  ]);

  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain:  usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types:   PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: userAddress, spender: DIAMOND, value: fee, nonce: usdcNonce, deadline: permitDeadline },
  });

  const { r, s, v } = parseSignature(permitSig);
  const vNum = Number(v) < 27 ? Number(v) + 27 : Number(v);

  // encode mintServiceWithPermit calldata (permit params embedded, atomic in one tx)
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'mintServiceWithPermit',
    args: [userAddress, title, description, price, deadlineDays, region, permitDeadline, vNum, r, s],
  });

  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'mintServiceWithPermit', DIAMOND);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct mintServiceWithPermit');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── requestServiceGasless ────────────────────────────────────────────────────

/**
 * Клиент запрашивает услугу — gasless.
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — Diamond как spender, amount only (fee платил executor)
 *   2. ForwardRequest (EIP-712) — requestServiceWithPermit calldata
 */
export async function requestServiceGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  params: {
    serviceId:    bigint;
    amount:       bigint;  // deal amount, 6 decimals
    deadlineDays: bigint;
    terms:        string;  // условия (on-chain)
    region:       number;  // 0-3
  },
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { serviceId, amount, deadlineDays, terms, region } = params;

  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'nonces', args: [userAddress] }),
    getUsdcDomain(publicClient),
  ]);

  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain:  usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types:   PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: userAddress, spender: DIAMOND, value: amount, nonce: usdcNonce, deadline: permitDeadline },
  });

  const { r, s, v } = parseSignature(permitSig);
  const vNum = Number(v) < 27 ? Number(v) + 27 : Number(v);

  // encode requestService calldata (no permit params — relay calls USDC.permit() separately)
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'requestService',
    args: [serviceId, amount, deadlineDays, terms, region],
  });

  const permitParams: PermitParams = {
    permitOwner:    userAddress,
    permitSpender:  DIAMOND,
    permitValue:    amount.toString(),
    permitDeadline: permitDeadline.toString(),
    permitV:        vNum,
    permitR:        r,
    permitS:        s,
  };

  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'requestService', DIAMOND, undefined, permitParams);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct requestService');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── fundAgreementGasless ─────────────────────────────────────────────────────

/**
 * Gasless fund() для существующего Agreement.
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — agreement как spender
 *   2. ForwardRequest (EIP-712) — fund() calldata → Agreement
 *
 * Relay: вызывает USDC.permit() (устанавливает allowance), затем
 * MinimalForwarder.execute() → Agreement.fund() (ERC-2771 передаёт реального юзера).
 */
export async function fundAgreementGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  amount: bigint,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

  // Allowance shortcut: if agreement is already approved for >= amount, skip permit (1 sig instead of 2)
  const FUND_ABI_CALL = parseAbi(['function fund()']);
  try {
    const currentAllowance = await publicClient.readContract({
      address: USDC,
      abi: USDC_READ_ABI,
      functionName: 'allowance',
      args: [userAddress, agreementAddress],
    }) as bigint;
    if (currentAllowance >= amount) {
      // Delegates entirely to sendAgreementGasless, which acquires its own lock —
      // do not also acquire one here, or this would deadlock against itself.
      return sendAgreementGasless(walletClient, publicClient, agreementAddress, 'fund', FUND_ABI_CALL as Abi);
    }
  } catch { /* proceed with full permit flow */ }

  const releaseLock = await acquireWalletLock(userAddress);
  try {

  // Step 1 — detect agreement's forwarder (handles legacy agreements)
  let agreementForwarder: Address = FORWARDER;
  try {
    agreementForwarder = await publicClient.readContract({
      address: agreementAddress,
      abi: TRUSTED_FORWARDER_ABI,
      functionName: 'trustedForwarder',
    }) as Address;
  } catch { /* fallback */ }
  const forwarderOverride =
    agreementForwarder.toLowerCase() !== FORWARDER.toLowerCase()
      ? agreementForwarder
      : undefined;
  const effectiveForwarder = forwarderOverride ?? FORWARDER;
  const forwarderDomain =
    forwarderOverride
      ? { ...FORWARDER_DOMAIN, verifyingContract: effectiveForwarder } as const
      : FORWARDER_DOMAIN;

  // Step 2 — USDC permit nonce + domain
  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'nonces', args: [userAddress] }),
    getUsdcDomain(publicClient),
  ]);

  // Step 3 — permit deadline: now + 1 hour
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // Step 4 — sign USDC permit (spender = agreement, popup 1 of 2)
  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: userAddress, spender: agreementAddress, value: amount, nonce: usdcNonce, deadline: permitDeadline },
  });
  const { r: permitR, s: permitS, v: permitVRaw } = parseSignature(permitSig);
  const permitV = Number(permitVRaw) < 27 ? Number(permitVRaw) + 27 : Number(permitVRaw);

  // Step 5 — get ForwardRequest nonce from effective forwarder
  const nonce = await publicClient.readContract({
    address: effectiveForwarder,
    abi: FORWARDER_READ_ABI,
    functionName: 'getNonce',
    args: [userAddress],
  });

  // Step 6 — encode fund() calldata
  const FUND_ABI = parseAbi(['function fund()']);
  const calldata = encodeFunctionData({ abi: FUND_ABI, functionName: 'fund' });

  // Step 7 — estimate gas; fallback 150k
  let gasLimit: bigint;
  try {
    const estimated = await publicClient.estimateGas({ account: userAddress, to: agreementAddress, data: calldata as Hex });
    gasLimit = (estimated * 130n) / 100n;
  } catch {
    gasLimit = 150_000n;
  }

  const message = { from: userAddress, to: agreementAddress, value: 0n, gas: gasLimit, nonce, data: calldata as Hex };

  // Step 8 — sign ForwardRequest (popup 2 of 2)
  const signature = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: forwarderDomain,
    types: FORWARD_TYPES,
    primaryType: 'ForwardRequest',
    message,
  });

  // Step 9 — POST to relay with permit params; fallback: permit + fund directly
  try {
    const res = await fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:          message.from,
        to:            message.to,
        value:         '0',
        gas:           message.gas.toString(),
        nonce:         message.nonce.toString(),
        data:          message.data,
        signature,
        ...(forwarderOverride ? { forwarderOverride: effectiveForwarder } : {}),
        permitOwner:   userAddress,
        permitSpender: agreementAddress,
        permitValue:   amount.toString(),
        permitDeadline: permitDeadline.toString(),
        permitV,
        permitR,
        permitS,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Relay error ${res.status}`);
    return { txHash: json.txHash as string };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    // Direct fallback: reuse signed permit + call fund() directly (2 txs, user pays ~$0.001 gas each)
    console.warn('[relay] down → direct permit+fund for', agreementAddress);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const FUND_ABI = parseAbi(['function fund()']);
    const permitTx = await walletClient.writeContract({
      address: USDC,
      abi: WRITE_USDC_ABI,
      functionName: 'permit',
      args: [userAddress, agreementAddress, amount, permitDeadline, permitV, permitR, permitS],
      account,
      chain: walletClient.chain,
    });
    // A reused/already-consumed permit signature (isRelayDown can fire on a
    // network drop AFTER the server already processed the original call)
    // reverts right here — waitForTransactionReceipt alone wouldn't catch it,
    // since it resolves on a reverted receipt too.
    await assertFallbackMined(publicClient, permitTx);
    const txHash = await walletClient.writeContract({
      address: agreementAddress,
      abi: FUND_ABI,
      functionName: 'fund',
      account,
      chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── sendGasless ──────────────────────────────────────────────────────────────

/**
 * Универсальный gasless вызов любой функции Diamond.
 * Одна подпись (ForwardRequest), газ платит relay.
 */
export async function sendGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  functionName: string,
  args: unknown[],
  abi: Abi,
): Promise<{ txHash: string; agreementAddr?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const calldata = encodeFunctionData({ abi, functionName, args });
  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata as Hex, functionName);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct tx for', functionName);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi, functionName, args, account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── proposeExtraGasless ──────────────────────────────────────────────────────

/**
 * Gasless proposeExtra() для Agreement.
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — agreement как spender, сумма = extraAmount
 *   2. ForwardRequest (EIP-712) — proposeExtra() calldata → Agreement
 */
const PROPOSE_EXTRA_ABI = parseAbi([
  'function proposeExtra(uint256 extraAmount, string extraTerms)',
]);

export async function proposeExtraGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  extraAmount: bigint,
  extraTerms: string,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  let agreementForwarder: Address = FORWARDER;
  try {
    agreementForwarder = await publicClient.readContract({
      address: agreementAddress,
      abi: TRUSTED_FORWARDER_ABI,
      functionName: 'trustedForwarder',
    }) as Address;
  } catch { /* fallback */ }
  const forwarderOverride =
    agreementForwarder.toLowerCase() !== FORWARDER.toLowerCase()
      ? agreementForwarder
      : undefined;
  const effectiveForwarder = forwarderOverride ?? FORWARDER;
  const forwarderDomain =
    forwarderOverride
      ? { ...FORWARDER_DOMAIN, verifyingContract: effectiveForwarder } as const
      : FORWARDER_DOMAIN;

  const [usdcNonce, usdcDomain] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_READ_ABI, functionName: 'nonces', args: [userAddress] }),
    getUsdcDomain(publicClient),
  ]);

  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permitSig = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: usdcDomain as Parameters<typeof walletClient.signTypedData>[0]['domain'],
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: userAddress, spender: agreementAddress, value: extraAmount, nonce: usdcNonce, deadline: permitDeadline },
  });
  const { r: permitR, s: permitS, v: permitVRaw } = parseSignature(permitSig);
  const permitV = Number(permitVRaw) < 27 ? Number(permitVRaw) + 27 : Number(permitVRaw);

  const nonce = await publicClient.readContract({
    address: effectiveForwarder,
    abi: FORWARDER_READ_ABI,
    functionName: 'getNonce',
    args: [userAddress],
  });

  const calldata = encodeFunctionData({
    abi: PROPOSE_EXTRA_ABI,
    functionName: 'proposeExtra',
    args: [extraAmount, extraTerms],
  });

  let gasLimit: bigint;
  try {
    const estimated = await publicClient.estimateGas({ account: userAddress, to: agreementAddress, data: calldata as Hex });
    gasLimit = (estimated * 130n) / 100n;
  } catch {
    gasLimit = 150_000n;
  }

  const message = { from: userAddress, to: agreementAddress, value: 0n, gas: gasLimit, nonce, data: calldata as Hex };

  const signature = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: forwarderDomain,
    types: FORWARD_TYPES,
    primaryType: 'ForwardRequest',
    message,
  });

  try {
    const res = await fetch('/api/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:          message.from,
        to:            message.to,
        value:         '0',
        gas:           message.gas.toString(),
        nonce:         message.nonce.toString(),
        data:          message.data,
        signature,
        ...(forwarderOverride ? { forwarderOverride: effectiveForwarder } : {}),
        permitOwner:   userAddress,
        permitSpender: agreementAddress,
        permitValue:   extraAmount.toString(),
        permitDeadline: permitDeadline.toString(),
        permitV,
        permitR,
        permitS,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Relay error ${res.status}`);
    return { txHash: json.txHash as string };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct permit+proposeExtra for', agreementAddress);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const permitTx = await walletClient.writeContract({
      address: USDC,
      abi: WRITE_USDC_ABI,
      functionName: 'permit',
      args: [userAddress, agreementAddress, extraAmount, permitDeadline, permitV, permitR, permitS],
      account,
      chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, permitTx);
    const txHash = await walletClient.writeContract({
      address: agreementAddress,
      abi: PROPOSE_EXTRA_ABI,
      functionName: 'proposeExtra',
      args: [extraAmount, extraTerms],
      account,
      chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── sendAgreementGasless ─────────────────────────────────────────────────────

/**
 * Gasless вызов любой функции Agreement (activate, markDone, release, raiseDispute, etc.).
 * Пользователь подписывает одну ForwardRequest (EIP-712). Газ платит relay.
 */
export async function sendAgreementGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  functionName: string,
  abi: Abi,
  args: unknown[] = [],
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  // Detect which forwarder the Agreement trusts — handles legacy agreements
  let agreementForwarder: Address = FORWARDER;
  try {
    agreementForwarder = await publicClient.readContract({
      address: agreementAddress,
      abi: TRUSTED_FORWARDER_ABI,
      functionName: 'trustedForwarder',
    }) as Address;
  } catch { /* fallback to default */ }

  const forwarderOverride =
    agreementForwarder.toLowerCase() !== FORWARDER.toLowerCase()
      ? agreementForwarder
      : undefined;

  const calldata = encodeFunctionData({ abi, functionName, args });
  try {
    const result = await _sendForwardRequest(
      walletClient,
      publicClient,
      calldata as Hex,
      functionName,
      agreementAddress,
      forwarderOverride,
    );
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct tx for', functionName, '@', agreementAddress);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: agreementAddress, abi, functionName, args, account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── claimDisputeGasless ──────────────────────────────────────────────────────

/**
 * Арбитр берёт спорное дело — шаг 2/2 commit-reveal.
 * salt — случайные 32 байта, использованные в commitDisputeClaimGasless().
 * Можно вызывать только после того как коммит-транзакция замайнена (≥1 блок).
 */
export async function claimDisputeGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  salt: Hex,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const CLAIM_ABI = parseAbi(['function claimDispute(address agreement, bytes32 salt)']);
  const calldata = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: 'claimDispute',
    args: [agreementAddress, salt],
  });
  try {
    const result = await _sendForwardRequest(walletClient, publicClient, calldata as Hex, 'claimDispute', DIAMOND);
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi: CLAIM_ABI, functionName: 'claimDispute',
      args: [agreementAddress, salt], account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── releaseDisputeGasless ────────────────────────────────────────────────────

/**
 * Арбитр или owner снимает клейм с дела — gasless.
 */
export async function releaseDisputeGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const RELEASE_ABI = parseAbi(['function releaseDisputeClaim(address agreement)']);
  const calldata = encodeFunctionData({
    abi: RELEASE_ABI,
    functionName: 'releaseDisputeClaim',
    args: [agreementAddress],
  });
  try {
    const result = await _sendForwardRequest(walletClient, publicClient, calldata as Hex, 'releaseDisputeClaim', DIAMOND);
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi: RELEASE_ABI, functionName: 'releaseDisputeClaim',
      args: [agreementAddress], account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── commitDisputeClaimGasless ────────────────────────────────────────────────

/**
 * Арбитр коммитит намерение взять спор — шаг 1/2 commit-reveal.
 * commitment = keccak256(abi.encodePacked(agreement, arbiter, salt))
 * После майнинга этой транзакции можно вызвать claimDisputeGasless(agreement, salt).
 */
export async function commitDisputeClaimGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  commitment: Hex,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const COMMIT_ABI = parseAbi(['function commitDisputeClaim(bytes32 commitment)']);
  const calldata = encodeFunctionData({
    abi: COMMIT_ABI,
    functionName: 'commitDisputeClaim',
    args: [commitment],
  });
  try {
    const result = await _sendForwardRequest(walletClient, publicClient, calldata as Hex, 'commitDisputeClaim', DIAMOND);
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi: COMMIT_ABI, functionName: 'commitDisputeClaim',
      args: [commitment], account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}

// ─── approveUSDC ──────────────────────────────────────────────────────────────

/**
 * Обычный ERC-20 approve. Юзер платит газ.
 * Нужен как fallback или для первичного approve вне relay.
 */
export async function approveUSDC(
  walletClient: WalletClient,
  publicClient: PublicClient,
  amount: bigint,
): Promise<string> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet not connected');

  const calldata = encodeFunctionData({
    abi: USDC_READ_ABI,
    functionName: 'approve',
    args: [DIAMOND, amount],
  });

  let gasLimit: bigint;
  try {
    const estimated = await publicClient.estimateGas({
      account: account.address,
      to: USDC,
      data: calldata,
    });
    gasLimit = (estimated * 110n) / 100n;
  } catch {
    gasLimit = 80_000n;
  }

  const txHash = await walletClient.sendTransaction({
    account,
    to: USDC,
    data: calldata,
    gas: gasLimit,
    chain: walletClient.chain,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}
