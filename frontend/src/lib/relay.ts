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
    console.log('[permit] domain:', JSON.stringify(domain, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v));
    return domain;
  } catch {
    const domain = { name: 'USDC', version: '2', chainId: BigInt(CHAIN_ID), verifyingContract: USDC };
    console.log('[permit] fallback domain:', JSON.stringify(domain, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v));
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
  deployAndFund:      1_800_000n,
  deployAgreement:    1_500_000n,
  mintJob:            1_500_000n, // mintJobWithPermit deploys Agreement → heavy
  mintJobWithPermit:  1_500_000n,
  editJob:              150_000n,
  editService:          150_000n,
  acceptApplicant:    1_800_000n, // deploys Agreement via FactoryFacet
  cancelJob:            150_000n,
  applyForJob:          150_000n,
  mintService:          300_000n,
  requestService:       300_000n,
  acceptRequest:      1_800_000n,
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
  activate:           100_000n,
  markDone:            80_000n,
  release:            120_000n,
  raiseDispute:       100_000n,
  triggerAutoApprove: 120_000n,
  triggerActivationTimeout: 100_000n,
  triggerDeadlineTimeout:   100_000n,
  triggerArbiterTimeout:    100_000n,
};

const DEFAULT_GAS = 500_000n;

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

const WRITE_USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

// ─── Internal: build & send ForwardRequest ────────────────────────────────────

async function _sendForwardRequest(
  walletClient: WalletClient,
  publicClient: PublicClient,
  calldata: Hex,
  functionName: string,
  targetAddress: Address = DIAMOND,
  forwarderOverride?: Address,
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
    termsHash:    Hex;     // bytes32
    region:       number;  // 0-3
    fee:          bigint;  // PPP fee, 6 decimals
  },
): Promise<{ txHash: string; agreementAddr?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

  const { executor, amount, deadlineDays, termsHash, region, fee } = params;
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
  console.log('[permit] deployAndFund sig v:', v?.toString(), '→ vNum:', vNum, 'r:', r, 's:', s);

  // Step 5 — encode deployAndFund calldata
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'deployAndFund',
    args: [
      userAddress,   // client
      executor,      // executor
      amount,        // amount (6 dec)
      deadlineDays,  // deadline in days
      termsHash,     // bytes32
      region,        // uint8
      permitDeadline,// uint256
      vNum,          // uint8 v
      r,             // bytes32 r
      s,             // bytes32 s
    ],
  });

  // Step 6 — sign ForwardRequest and send; fallback: submit calldata directly to Diamond
  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'deployAndFund');
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    // Permit params are baked into calldata — Diamond processes them directly
    console.warn('[relay] down → direct deployAndFund');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    return { txHash, fallbackUsed: true };
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
    termsHash:    Hex;     // bytes32
    region:       number;  // 0-3
    fee:          bigint;  // PPP fee, 6 decimals
  },
): Promise<{ txHash: string; jobId?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

  const { title, description, amount, deadlineDays, termsHash, region, fee } = params;
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
  console.log('[permit] mintJob sig v:', v?.toString(), '→ vNum:', vNum, 'r:', r, 's:', s);

  // Step 5 — encode mintJobWithPermit calldata
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'mintJobWithPermit',
    args: [
      userAddress,   // client
      title,
      description,
      amount,
      deadlineDays,
      termsHash,
      region,
      permitDeadline,
      vNum,
      r,
      s,
    ],
  });

  // Step 6 — sign ForwardRequest and send; fallback: submit calldata directly to Diamond
  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'mintJob');
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct mintJobWithPermit');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    return { txHash, fallbackUsed: true };
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
  console.log('[permit] mintService sig v:', v?.toString(), '→ vNum:', vNum, 'r:', r, 's:', s);

  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'mintServiceWithPermit',
    args: [userAddress, title, description, price, deadlineDays, region, permitDeadline, vNum, r, s],
  });

  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'mintService');
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct mintServiceWithPermit');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    return { txHash, fallbackUsed: true };
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
    termsHash:    Hex;     // bytes32
    region:       number;  // 0-3
  },
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

  const { serviceId, amount, deadlineDays, termsHash, region } = params;

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

  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'requestServiceWithPermit',
    args: [userAddress, serviceId, amount, deadlineDays, termsHash, region, permitDeadline, vNum, r, s],
  });

  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'requestService');
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct requestServiceWithPermit');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.sendTransaction({ account, to: DIAMOND, data: calldata, chain: walletClient.chain });
    return { txHash, fallbackUsed: true };
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
      return sendAgreementGasless(walletClient, publicClient, agreementAddress, 'fund', FUND_ABI_CALL as Abi);
    }
  } catch { /* proceed with full permit flow */ }

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
    await publicClient.waitForTransactionReceipt({ hash: permitTx });
    const txHash = await walletClient.writeContract({
      address: agreementAddress,
      abi: FUND_ABI,
      functionName: 'fund',
      account,
      chain: walletClient.chain,
    });
    return { txHash, fallbackUsed: true };
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
    return { txHash, fallbackUsed: true };
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
  'function proposeExtra(uint256 extraAmount, bytes32 extraTermsHash)',
]);

export async function proposeExtraGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  extraAmount: bigint,
  extraTermsHash: `0x${string}`,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');

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
    args: [extraAmount, extraTermsHash],
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
    await publicClient.waitForTransactionReceipt({ hash: permitTx });
    const txHash = await walletClient.writeContract({
      address: agreementAddress,
      abi: PROPOSE_EXTRA_ABI,
      functionName: 'proposeExtra',
      args: [extraAmount, extraTermsHash],
      account,
      chain: walletClient.chain,
    });
    return { txHash, fallbackUsed: true };
  }
}

// ─── sendAgreementGasless ─────────────────────────────────────────────────────

/**
 * Gasless вызов любой функции Agreement (activate, markDone, release, raiseDispute, etc.).
 * Пользователь подписывает одну ForwardRequest (EIP-712). Газ платит relay.
 */
const TRUSTED_FORWARDER_ABI = parseAbi(['function trustedForwarder() view returns (address)']);

export async function sendAgreementGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  functionName: string,
  abi: Abi,
  args: unknown[] = [],
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
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
    return { txHash, fallbackUsed: true };
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
    return { txHash, fallbackUsed: true };
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
    return { txHash, fallbackUsed: true };
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
    return { txHash, fallbackUsed: true };
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
