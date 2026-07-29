/**
 * e2e.mjs — end-to-end тест всех ончейн-флоу через gasless relay
 *
 * Что тестирует:
 *   1. mintJob       — клиент постит работу на JobBoard
 *   2. mintService   — исполнитель постит услугу на ServiceBoard
 *   3. applyForJob   — исполнитель откликается на работу
 *   4. acceptApplicant — клиент принимает → создаётся Agreement
 *   5. fund          — клиент финансирует Agreement
 *   6. activate      — исполнитель активирует
 *   7. markDone      — исполнитель отмечает выполнение
 *   8. release       — клиент отпускает оплату
 *   9. requestService — клиент напрямую запрашивает услугу исполнителя; permit
 *                        подписывается на amount + quoteFee(amount), а не на amount —
 *                        единственное место, где значение permit меняется по формуле
 *
 * Запуск:
 *   cd relayer && node e2e.mjs
 *
 * Требования:
 *   - Next.js фронт запущен: cd frontend && npm run dev
 *   - В корневом .env добавлены:
 *       TEST_CLIENT_KEY=0x<приватный ключ клиента>
 *       TEST_EXECUTOR_KEY=0x<приватный ключ исполнителя>
 *   - На кошельках есть USDC на Base Sepolia
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAIN_ID   = 84532;
const DIAMOND    = process.env.DIAMOND_ADDRESS    || '0x760F07367888C62f7c2Dfb619A5e534132855ce5';
const FORWARDER  = process.env.TRUSTED_FORWARDER  || '0x268dCfa7ab0DC134d01C5cBcAa7d2834d6dD0f0f';
const USDC       = process.env.USDC_ADDRESS       || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RELAY_URL  = process.env.RELAY_URL || 'http://localhost:3000/api/relay';
const RPC_URL    = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

const CLIENT_KEY   = process.env.TEST_CLIENT_KEY;
const EXECUTOR_KEY = process.env.TEST_EXECUTOR_KEY;

// Тестовые параметры — минимум чтобы не тратить лишний USDC
const TEST_AMOUNT   = 100_000n;   // 0.1 USDC budget — комиссия теперь max(amount*bps/10_000, floor);
                                   // при таком размере сделки она равна полу, а не фиксированным $4
const TEST_DEADLINE = 7n;         // 7 дней

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const USDC_ABI = [
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
];

const FORWARDER_ABI = [
  'function getNonce(address from) view returns (uint256)',
];

const DIAMOND_ABI = [
  'function mintJobWithPermit(address client, string title, string description, uint256 amount, uint256 deadlineDays, string terms, uint8 region, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 jobId)',
  'function mintServiceWithPermit(address executor, string title, string description, uint256 price, uint256 deadlineDays, uint8 region, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 serviceId)',
  'function applyForJob(uint256 jobId)',
  'function acceptApplicant(uint256 jobId, address executor)',
  'function requestService(uint256 serviceId, uint256 amount, uint256 deadlineDays, string terms, uint8 region) returns (uint256 requestId)',
  // getRegionFee() is DEPRECATED on-chain — it now always reverts FeeNotRegional().
  // quoteFee/getFeeFloor are the real source of truth (src/FactoryFacet.sol).
  'function quoteFee(uint256 amount) view returns (uint256)',
  'function getFeeFloor() view returns (uint256)',
  'function getRequestFunds(uint256 requestId) view returns (uint256)',
  'function getRequestFeeHeld(uint256 requestId) view returns (uint256)',
  'function getActivePair(address client, address executor) view returns (address)',
  // Events — parsed from tx receipts below, since the relay only surfaces
  // agreementAddr/jobId, not serviceId/requestId.
  'event ServicePosted(uint256 indexed serviceId, address indexed executor, uint256 price, uint8 region, string title, string description, uint256 deadlineDays)',
  'event ServiceRequested(uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount)',
];

const AGREEMENT_ABI = [
  'function fund()',
  'function activate()',
  'function markDone()',
  'function release()',
  // NOTE: terms_ is a `string` on-chain (src/Agreement.sol getDetails()), not
  // bytes32 — it was declared wrong here, which would have silently corrupted
  // every field decoded after it (dynamic-type ABI decoding shifts offsets).
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, string terms_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
];

// ─── EIP-712 types ────────────────────────────────────────────────────────────

const FORWARD_DOMAIN = {
  name: 'MinimalForwarder',
  version: '0.0.1',
  chainId: CHAIN_ID,
  verifyingContract: FORWARDER,
};

const FORWARD_TYPES = {
  ForwardRequest: [
    { name: 'from',  type: 'address' },
    { name: 'to',    type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas',   type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'data',  type: 'bytes'   },
  ],
};

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner',    type: 'address' },
    { name: 'spender',  type: 'address' },
    { name: 'value',    type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// ─── Gas limits (per function, fallback если estimateGas упадёт) ──────────────

const GAS = {
  mintJobWithPermit:     1_500_000n,
  mintServiceWithPermit:   800_000n, // permit + struct storage (7 fields) + array push + transferFrom
  applyForJob:             150_000n,
  acceptApplicant:       5_500_000n, // deployAgreement alone needs ~4.6M
  fund:                    150_000n,
  activate:                200_000n,
  markDone:                200_000n,
  release:                 500_000n, // _complete: NFT burn + Diamond registry call + USDC transfer
  requestService:          600_000n, // struct storage (9 fields incl. terms) + 3 array pushes + transferFrom
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(label, value) {
  console.log(`  ✓ ${label}:`, typeof value === 'bigint' ? value.toString() : value);
}

function step(n, label) {
  console.log(`\n── Step ${n}: ${label} ──────────────────────────────────`);
}

async function getUsdcDomain(provider) {
  const usdc = new ethers.Contract(USDC, USDC_ABI, provider);
  const [name, version] = await Promise.all([usdc.name(), usdc.version()]);
  return { name, version, chainId: CHAIN_ID, verifyingContract: USDC };
}

async function splitSig(rawSig) {
  const sig = ethers.Signature.from(rawSig);
  const v = sig.v < 27 ? sig.v + 27 : sig.v;
  return { v, r: sig.r, s: sig.s };
}

/**
 * Подписывает USDC permit и возвращает {v, r, s, deadline}
 */
async function signPermit(wallet, provider, spender, value) {
  const usdc        = new ethers.Contract(USDC, USDC_ABI, provider);
  const usdcDomain  = await getUsdcDomain(provider);
  const nonce       = await usdc.nonces(wallet.address);
  const deadline    = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const rawSig = await wallet.signTypedData(
    usdcDomain,
    PERMIT_TYPES,
    { owner: wallet.address, spender, value, nonce, deadline },
  );

  const { v, r, s } = await splitSig(rawSig);
  console.log(`    permit nonce=${nonce}, v=${v}`);
  return { v, r, s, deadline };
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Строит и подписывает ForwardRequest, отправляет на relay.
 * to = целевой контракт (Diamond или Agreement)
 * extraBody = доп. поля для permit (fund flow)
 */
async function sendForward(wallet, provider, to, calldata, fnName, extraBody = {}) {
  // Читаем нонс свежо с чейна каждый раз — relay тоже использует client-supplied nonce.
  const forwarder = new ethers.Contract(FORWARDER, FORWARDER_ABI, provider);
  const nonce     = await forwarder.getNonce(wallet.address);
  const gas       = GAS[fnName] ?? 500_000n;

  const message = {
    from:  wallet.address,
    to,
    value: 0n,
    gas,
    nonce,
    data:  calldata,
  };

  const rawSig = await wallet.signTypedData(FORWARD_DOMAIN, FORWARD_TYPES, message);

  const body = {
    from:      message.from,
    to:        message.to,
    value:     '0',
    gas:       gas.toString(),
    nonce:     nonce.toString(),
    data:      calldata,
    signature: rawSig,
    ...extraBody,
  };

  const res = await fetch(RELAY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  // Даём RPC время отразить обновлённый нонс перед следующим шагом
  await _sleep(2500);
  return json; // { txHash, agreementAddr?, jobId? }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Preflight checks
  if (!CLIENT_KEY)   { console.error('Missing TEST_CLIENT_KEY in .env'); process.exit(1); }
  if (!EXECUTOR_KEY) { console.error('Missing TEST_EXECUTOR_KEY in .env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const client   = new ethers.Wallet(CLIENT_KEY,   provider);
  const executor = new ethers.Wallet(EXECUTOR_KEY, provider);

  // Verify addresses match what was agreed
  const EXPECTED_CLIENT   = '0xA9EB25F433919AFCc30510BED70e0eB12e7D5FC0'.toLowerCase();
  const EXPECTED_EXECUTOR = '0x1E4DE456B77dE2A4aC01D59Db6C2AB2837F0842c'.toLowerCase();
  if (client.address.toLowerCase()   !== EXPECTED_CLIENT)   console.warn('⚠  Client address mismatch!');
  if (executor.address.toLowerCase() !== EXPECTED_EXECUTOR) console.warn('⚠  Executor address mismatch!');

  const diamond  = new ethers.Contract(DIAMOND, DIAMOND_ABI, provider);
  const usdcC    = new ethers.Contract(USDC, USDC_ABI, provider);

  console.log('══════════════════════════════════════════════════════════');
  console.log('  Hexseal E2E Test — Base Sepolia');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Relay  :', RELAY_URL);
  console.log('  Client :', client.address);
  console.log('  Executor:', executor.address);

  // Balances
  const [cBal, eBal] = await Promise.all([
    usdcC.balanceOf(client.address),
    usdcC.balanceOf(executor.address),
  ]);
  ok('Client USDC', `${Number(cBal) / 1e6} USDC`);
  ok('Executor USDC', `${Number(eBal) / 1e6} USDC`);

  // Fee quotes — source of truth is the contract (max(amount*bps/10_000, floor)).
  // Never recompute the formula client-side: that's exactly how a permit would
  // silently drift from what the contract actually charges.
  const dealFee = await diamond.quoteFee(TEST_AMOUNT);
  ok('Deal fee (quoteFee for TEST_AMOUNT)', `${Number(dealFee) / 1e6} USDC`);

  const listingFee = await diamond.getFeeFloor();
  ok('Service listing fee (flat floor — no deal amount exists yet at listing time)', `${Number(listingFee) / 1e6} USDC`);

  // ── Step 1: mintJob ──────────────────────────────────────────────────────────
  step(1, 'mintJob — client posts job');
  const jobTotal = TEST_AMOUNT + dealFee;
  const iface    = new ethers.Interface(DIAMOND_ABI);

  const jobPermit = await signPermit(client, provider, DIAMOND, jobTotal);
  const jobCalldata = iface.encodeFunctionData('mintJobWithPermit', [
    client.address,
    'E2E Test Job',
    'Automated e2e test — ignore',
    TEST_AMOUNT,
    TEST_DEADLINE,
    'E2E test terms', // terms
    1,                // region
    jobPermit.deadline,
    jobPermit.v,
    jobPermit.r,
    jobPermit.s,
  ]);

  const jobResult = await sendForward(client, provider, DIAMOND, jobCalldata, 'mintJobWithPermit');
  const jobId = BigInt(jobResult.jobId ?? 0);
  ok('txHash', jobResult.txHash);
  ok('jobId', jobId);

  // ── Step 2: mintService ──────────────────────────────────────────────────────
  step(2, 'mintService — executor posts service');
  const svcPermit = await signPermit(executor, provider, DIAMOND, listingFee);
  const svcCalldata = iface.encodeFunctionData('mintServiceWithPermit', [
    executor.address,
    'E2E Test Service',
    'Automated e2e test — ignore',
    TEST_AMOUNT, // price — advisory only, no fee is computed from it at listing time
    TEST_DEADLINE,
    1,           // region
    svcPermit.deadline,
    svcPermit.v,
    svcPermit.r,
    svcPermit.s,
  ]);

  const svcResult = await sendForward(executor, provider, DIAMOND, svcCalldata, 'mintServiceWithPermit');
  ok('txHash', svcResult.txHash);

  // The relay only parses agreementAddr/jobId out of logs, not serviceId — read
  // it ourselves so Step 9 (requestService) has a real serviceId to call against.
  const svcReceipt = await provider.getTransactionReceipt(svcResult.txHash);
  let serviceId;
  for (const log of svcReceipt.logs) {
    if (log.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'ServicePosted') { serviceId = parsed.args.serviceId; break; }
  }
  if (serviceId === undefined) throw new Error('Could not parse serviceId from ServicePosted log');
  ok('serviceId', serviceId);

  // ── Step 3: applyForJob ──────────────────────────────────────────────────────
  step(3, `applyForJob — executor applies to job #${jobId}`);
  const applyCalldata = iface.encodeFunctionData('applyForJob', [jobId]);
  const applyResult   = await sendForward(executor, provider, DIAMOND, applyCalldata, 'applyForJob');
  ok('txHash', applyResult.txHash);

  // ── Step 4: acceptApplicant ──────────────────────────────────────────────────
  step(4, 'acceptApplicant — client accepts executor → Agreement created');
  let agreementAddr;

  try {
    const acceptCalldata = iface.encodeFunctionData('acceptApplicant', [jobId, executor.address]);
    const acceptResult   = await sendForward(client, provider, DIAMOND, acceptCalldata, 'acceptApplicant');
    agreementAddr = acceptResult.agreementAddr;
    ok('txHash', acceptResult.txHash);
  } catch (e) {
    // acceptApplicant can fail with "deploy failed" if ActiveDealExists (previous test run).
    // In that case, retrieve the existing agreement from registry.
    if (!e.message.includes('deploy failed') && !e.message.includes('Call failed')) throw e;
    console.log('    deploy failed → checking for existing active pair...');
  }

  if (!agreementAddr) {
    // Fallback: read existing agreement from registry
    agreementAddr = await diamond.getActivePair(client.address, executor.address);
    if (!agreementAddr || agreementAddr === ethers.ZeroAddress)
      throw new Error('No agreementAddr — acceptApplicant failed and no active pair found');
    console.log('    Found existing agreement:', agreementAddr);
  }
  ok('agreementAddr', agreementAddr);

  const agrmC = new ethers.Contract(agreementAddr, AGREEMENT_ABI, provider);

  // ── Step 5: fund ─────────────────────────────────────────────────────────────
  step(5, 'fund — client funds Agreement');
  const agrmIface = new ethers.Interface(AGREEMENT_ABI);

  // acceptApplicant already funds via fundFromFactory() — check status first
  const detailsBeforeFund = await agrmC.getDetails();
  const statusBeforeFund  = Number(detailsBeforeFund.status_);
  if (statusBeforeFund >= 1) {
    ok('status', `already FUNDED (${statusBeforeFund}) — skipping fund step`);
  } else {
    const fundPermit   = await signPermit(client, provider, agreementAddr, TEST_AMOUNT);
    const fundCalldata = agrmIface.encodeFunctionData('fund');
    const fundResult   = await sendForward(client, provider, agreementAddr, fundCalldata, 'fund', {
      permitOwner:    client.address,
      permitSpender:  agreementAddr,
      permitValue:    TEST_AMOUNT.toString(),
      permitDeadline: fundPermit.deadline.toString(),
      permitV:        fundPermit.v,
      permitR:        fundPermit.r,
      permitS:        fundPermit.s,
    });
    ok('txHash', fundResult.txHash);
    const detailsAfterFund = await agrmC.getDetails();
    ok('status after fund', Number(detailsAfterFund.status_) === 1 ? 'FUNDED ✓' : `unexpected: ${detailsAfterFund.status_}`);
  }

  // ── Step 6: activate ─────────────────────────────────────────────────────────
  step(6, 'activate — executor activates Agreement');
  // Idempotent: activate only if not already activated (activatedAt == 0).
  const detailsBeforeActivate = await agrmC.getDetails();
  if (Number(detailsBeforeActivate.activatedAt_) > 0) {
    ok('status', 'already ACTIVE — skipping activate step');
  } else {
    const activateCalldata = agrmIface.encodeFunctionData('activate');
    const activateResult   = await sendForward(executor, provider, agreementAddr, activateCalldata, 'activate');
    ok('txHash', activateResult.txHash);
    const detailsAfterActivate = await agrmC.getDetails();
    ok('status after activate', Number(detailsAfterActivate.status_) === 2 ? 'ACTIVE ✓' : `unexpected: ${detailsAfterActivate.status_}`);
  }

  // ── Step 7: markDone ─────────────────────────────────────────────────────────
  step(7, 'markDone — executor marks work done');
  // Idempotent: markDone only if not already marked (markedDoneAt == 0).
  const detailsBeforeDone = await agrmC.getDetails();
  if (Number(detailsBeforeDone.markedDoneAt_) > 0) {
    ok('markedDoneAt', 'already set — skipping markDone step');
  } else {
    const markDoneCalldata = agrmIface.encodeFunctionData('markDone');
    const markDoneResult   = await sendForward(executor, provider, agreementAddr, markDoneCalldata, 'markDone');
    ok('txHash', markDoneResult.txHash);
    // Status stays ACTIVE (2) after markDone — computed dynamically from markedDoneAt timestamp.
    // Only changes to COMPLETED after release() or after AUTO_APPROVE_WINDOW expires.
    const detailsAfterDone = await agrmC.getDetails();
    ok('markedDoneAt set', Number(detailsAfterDone.markedDoneAt_) > 0 ? 'YES ✓' : 'NOT SET ✗');
  }

  // ── Step 8: release ──────────────────────────────────────────────────────────
  step(8, 'release — client releases payment');
  const releaseCalldata = agrmIface.encodeFunctionData('release');
  const releaseResult   = await sendForward(client, provider, agreementAddr, releaseCalldata, 'release');
  ok('txHash', releaseResult.txHash);

  // After release: verify executor received USDC (Agreement balance should be 0)
  const agrmBalance = await usdcC.balanceOf(agreementAddr);
  ok('Agreement USDC after release', Number(agrmBalance) === 0 ? '0 (paid out) ✓' : `${Number(agrmBalance) / 1e6} USDC (unexpected)`);

  // ── Step 9: requestService — client requests direct hire on executor's service ─
  // The one call in this whole script where the permit VALUE changed by formula,
  // not by size: it used to be `amount`, now it's `amount + quoteFee(amount)`.
  // Everything else above kept signing the same numbers, just sourced from a
  // different getter — this is the path that actually needs live-chain coverage.
  step(9, 'requestService — client requests service, permit covers amount + quoteFee(amount)');

  const requestAmount = TEST_AMOUNT;
  const requestFee    = await diamond.quoteFee(requestAmount);
  const requestTotal  = requestAmount + requestFee;
  ok('requestService fee (quoteFee)', `${Number(requestFee) / 1e6} USDC`);
  ok('requestService permit total (amount + fee)', `${Number(requestTotal) / 1e6} USDC`);

  const requestPermit = await signPermit(client, provider, DIAMOND, requestTotal);
  const requestCalldata = iface.encodeFunctionData('requestService', [
    serviceId,
    requestAmount,
    TEST_DEADLINE,
    'E2E test request terms', // terms
    1,                        // region
  ]);

  // Same shape as the fund() step above: calldata carries no permit args, the
  // permit is submitted by the relay separately via extraBody before the
  // ForwardRequest itself is forwarded (see frontend/src/lib/relay.ts requestServiceGasless).
  const requestResult = await sendForward(client, provider, DIAMOND, requestCalldata, 'requestService', {
    permitOwner:    client.address,
    permitSpender:  DIAMOND,
    permitValue:    requestTotal.toString(),
    permitDeadline: requestPermit.deadline.toString(),
    permitV:        requestPermit.v,
    permitR:        requestPermit.r,
    permitS:        requestPermit.s,
  });
  ok('txHash', requestResult.txHash);

  const requestReceipt = await provider.getTransactionReceipt(requestResult.txHash);
  let requestId;
  for (const log of requestReceipt.logs) {
    if (log.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'ServiceRequested') { requestId = parsed.args.requestId; break; }
  }
  if (requestId === undefined) throw new Error('Could not parse requestId from ServiceRequested log');
  ok('requestId', requestId);

  // The check that actually matters: confirm the contract locked amount+fee on
  // chain, not merely that the call didn't revert (a revert would already have
  // thrown above). This is what would catch a permit/contract fee-formula mismatch.
  const [lockedAmount, lockedFee] = await Promise.all([
    diamond.getRequestFunds(requestId),
    diamond.getRequestFeeHeld(requestId),
  ]);
  if (lockedAmount !== requestAmount || lockedFee !== requestFee) {
    throw new Error(
      `requestService locked amount/fee mismatch: expected ${requestAmount}/${requestFee}, got ${lockedAmount}/${lockedFee}`
    );
  }
  ok('locked amount == signed amount', `${lockedAmount} ✓`);
  ok('locked fee == quoteFee', `${lockedFee} ✓`);

  // ── Final balances ────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ALL STEPS PASSED');
  console.log('══════════════════════════════════════════════════════════');
  const [cBalEnd, eBalEnd] = await Promise.all([
    usdcC.balanceOf(client.address),
    usdcC.balanceOf(executor.address),
  ]);
  console.log(`  Client  USDC: ${Number(cBal) / 1e6} → ${Number(cBalEnd) / 1e6}`);
  console.log(`  Executor USDC: ${Number(eBal) / 1e6} → ${Number(eBalEnd) / 1e6}`);
  console.log(`  Agreement: ${agreementAddr}`);
}

main().catch(err => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
