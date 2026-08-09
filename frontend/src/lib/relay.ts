/**
 * relay.ts — клиентская сторона gasless relay
 *
 * sendGasless() — универсальный gasless для любого вызова Diamond
 *
 * Комиссия для подписи (permit/value) везде читается с контракта
 * непосредственно перед подписанием — см. readQuotedFee()/readFeeFloor()
 * ниже. Никогда не берётся из аргумента функции и не считается локально.
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
import {
  acquireWalletLock,
  awaitFreshForwarderNonce,
  rememberSpentForwarderNonce,
} from '@/lib/walletLock';

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

/**
 * ABI заявки на спор. Вынесен из тела функции наружу НАМЕРЕННО: по нему
 * сверяется замок `claimAbiMatchesContract.test.ts`, а замок обязан проверять
 * тот ABI, которым реально идёт вызов, а не отдельную запись в config/contracts.ts
 * (та не используется для записи и уже один раз разошлась с контрактом молча).
 *
 * Меняется подпись в контракте — краснеет тест. Это единственное, что связывает
 * фронт с контрактом автоматически.
 */
export const CLAIM_DISPUTE_ABI = parseAbi([
  'function claimDispute(address agreement, bytes32 salt, bytes32 boxKey, bytes32 signKey)',
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

// ─── Fee quoting (permit-critical) ────────────────────────────────────────────

/**
 * Комиссия ДЛЯ ПОДПИСИ — всегда с контракта, никогда не из аргумента и не из
 * локальной формулы. Читается непосредственно перед signTypedData, чтобы
 * подписанное значение не могло разойтись с тем, что спишет контракт.
 */
async function readQuotedFee(publicClient: PublicClient, amount: bigint): Promise<bigint> {
  return await publicClient.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI as Abi,
    functionName: 'quoteFee',
    args: [amount],
  }) as bigint;
}

/** Комиссия за публикацию услуги — плоский пол, суммы сделки в этот момент нет. */
async function readFeeFloor(publicClient: PublicClient): Promise<bigint> {
  return await publicClient.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI as Abi,
    functionName: 'getFeeFloor',
  }) as bigint;
}

// ─── Gas defaults ─────────────────────────────────────────────────────────────
//
// These are FALLBACKS, used only when the live estimateGas() below fails; the
// estimate path applies its own 130% buffer and never reads this table. Since
// they get no such buffer themselves, each needs its own margin over the
// worst case it might actually see.
//
// The dominant cost driver here is NOT the Agreement deploy — clones cost
// 278_355 gas (test/AgreementClone.t.sol, testCloneDeployStaysCheap), a
// rounding error next to what follows. It's the `terms`/`title`/`description`
// strings these calls write on-chain: the contracts place NO length limit on
// them at all (docs/CONTRACT_GUIDE.md) — the only ceiling is the frontend
// form's maxLength (title 100, description 500, terms 2000, 2600 combined for
// a job posting), and at roughly 825 gas per stored character that swamps
// everything else. An earlier version of this table was sized off
// measurements taken with a ~19-character terms string and came in far too
// low once a form gets used anywhere near its actual limit.
//
// Measured at the form's actual maximum (mock USDC, foundry):
//
//   mintJob          (title 100 / description 500 / terms 2000)  2_791_334
//   acceptRequest    (19 siblings, terms 2000)                   2_593_454
//   acceptApplicant  (terms 2000)                                2_116_407
//   deployAndFund    (terms 2000)                                2_074_240
//
// Real USDC is a proxied FiatTokenV2_2, not the mock: each transfer costs
// roughly 10-15k more than measured here, which matters most for the
// sibling-refund loop with its ~21 transfers. The constants below keep real
// margin over the measured figures rather than tracking them tightly — a
// fallback that is too LOW breaks a live deal (the relayer's pre-flight
// staticCall fails and the action 400s), while one that is too high costs
// nothing: the chain charges gas used, not gas offered.
const GAS_DEFAULTS: Record<string, bigint> = {
  deployAndFund:      2_800_000n, // measured 2_074_240 at max terms length
  // Confirmed by direct measurement (not just "cheaper than deployAndFund"
  // reasoning): 1_927_995 at max terms length — strictly less than
  // deployAndFund's 2_074_240 as expected (no fundFromFactory + second
  // transfer here), so the shared 2_800_000n ceiling carries even more
  // margin (31%) than deployAndFund's own 26%.
  deployAgreement:    2_800_000n,
  // mintJob/mintJobWithPermit were underestimated before the clone work too —
  // this is not a regression from this branch, just fixed alongside it. Measured
  // 2_791_334 at max title/description/terms; permit adds only ~30k on top.
  mintJob:            3_600_000n,
  mintJobWithPermit:  3_600_000n,
  editJob:              150_000n,
  editService:          150_000n,
  // Fee economics (feat/fee-economics-frontend) added a FeeCollected LOG4
  // (~1_756 gas) on this path, on top of the clone deploy — still ONE fee
  // transfer, no new second transfer here. Freshly measured 2_332_247 at max
  // terms length (mock USDC), leaving only ~17% margin over the old
  // 2_800_000n. Raised with the real-USDC correction (+19%, real USDC being
  // a proxied FiatTokenV2_2 that costs more per transfer than the mock) then
  // +20% margin on top: 2_332_247 * 1.19 * 1.2 ≈ 3_330_449, rounded up.
  acceptApplicant:    3_400_000n,
  // Cancelling now makes TWO transfers instead of one — the refund to the
  // client AND the non-refundable feeFloor to the treasury — plus a
  // FeeCollected LOG4 (~1_756 gas). Freshly measured 116_211 on the
  // JobBoardFacet table (stable — identical across 3 repeated full-suite
  // `--gas-report` runs) and 118_414 on the DiamondProxy table (this second
  // table is NOT stable between runs on this same commit — it swung between
  // 115_533 and 118_414 across those same 3 runs, most likely Foundry's gas
  // attribution getting confused by the low-level `.call()` sites in
  // `_assertLedgerBalanced` (test/BoardsFixture.sol:361) and the reentrancy
  // callback (test/Reentrancy.t.sol:82) — the facet table has no such call
  // sites feeding it and stayed put. Take max(stable table, worst seen on
  // the unstable one) = 118_414, not whatever a single run happens to print
  // for DiamondProxy: only ~22% margin over the old 150_000n either way.
  // Raised with the real-USDC + 20%-margin formula: 118_414 * 1.19 * 1.2 ≈
  // 169_095, rounded up (same bucket as 116_211's own 165_949 — the ceiling
  // doesn't move, only this comment's numbers do).
  cancelJob:            170_000n,
  applyForJob:          150_000n,
  withdrawApplication:  150_000n,
  // Listing a service now also emits FeeCollected (~1_756 gas) alongside the
  // pre-existing anti-spam-floor transfer — one transfer as before, just a
  // new log. Freshly measured 712_340 (mintService) / 728_667
  // (mintServiceWithPermit) at max title/description length (mock USDC),
  // leaving only ~11%/~9% margin over the old 800_000n. Raised by the same
  // formula off the worse (permit) figure: 728_667 * 1.19 * 1.2 ≈ 1_040_536,
  // rounded up; mintService rounds to the same bucket.
  mintService:              1_100_000n,
  mintServiceWithPermit:    1_100_000n,
  // Also underestimated before the clone work (was 800_000n) — not a regression
  // from this branch. Measured 1_868_986 at max title/description/terms.
  requestService:       2_400_000n,
  // Clones an Agreement PLUS a loop refunding every OTHER still-pending
  // request from the same client to this executor (up to MAX_PENDING_PER_PAIR-1=19
  // siblings), unlike acceptApplicant/deployAndFund which have no such loop.
  // That loop used to make ONE transfer per superseded sibling; fee economics
  // split it into TWO (refund to client + forfeited floor to the treasury)
  // and added a FeeCollected LOG4 per sibling — up to 19x the per-sibling
  // overhead. Freshly measured with the FULL 19-sibling loop AND max terms
  // length on the accepted request (mock USDC): 3_219_461, only ~8% margin
  // over the old 3_500_000n. Raised with the same formula:
  // 3_219_461 * 1.19 * 1.2 ≈ 4_597_390, rounded up.
  acceptRequest:      4_600_000n,
  // Same second-transfer-plus-LOG4 change as cancelJob (refund + forfeited
  // floor to the treasury). Freshly measured 108_829 on the JobBoardFacet-
  // equivalent (ServiceBoardFacet) table — the facet table's own stable
  // max, re-confirmed identical across 3 repeated full-suite runs. The
  // DiamondProxy table has the same cross-run instability noted on cancelJob
  // above but stayed below this figure in every run sampled (95_662 /
  // 108_151 / 102_377), so 108_829 stands as the max. Only ~9% margin over
  // the old 120_000n. Raised: 108_829 * 1.19 * 1.2 ≈ 155_408, rounded up.
  rejectRequest:        160_000n,
  // Same change as rejectRequest, and the one that already broke: measured
  // 126_383 against the old 120_000n ceiling — already over budget on mock
  // USDC alone, before any real-USDC correction. This is why Task 10 exists.
  // (Also cross-checked against the DiamondProxy-table instability noted on
  // cancelJob above: 126_383 was the max seen on that table in 2 of 3
  // repeated runs — the facet table's own stable max is lower, 117_461 — so
  // this figure already accounts for it.) Raised: 126_383 * 1.19 * 1.2 ≈
  // 180_475, rounded up.
  cancelRequest:        190_000n,
  pauseService:          80_000n,
  unpauseService:        80_000n,
  removeService:         80_000n,
  // 9 августа заявка стала возить два открытых ключа чата арбитра: это два
  // холодных SSTORE (2×22 100) и один LOG2 — примерно +46 000 газа. Замер по
  // фасету: первая в жизни запись ключа до 72 868, тёплая перезапись ~38 656
  // (медиана из 108 вызовов).
  //
  // ⚠️ В ЭТОМ ЖЕ ФАЙЛЕ такое уже случалось: замеренные 126 383 против прежней
  // отсечки 120 000. Слишком низкая отсечка валит предварительный staticCall
  // релеера, и действие отдаёт отказ. Завышенная не стоит ничего: газ платится
  // по факту, а не по лимиту.
  claimDispute:         260_000n,
  releaseDisputeClaim:  100_000n,
  commitDisputeClaim:   100_000n,
  resolveDispute:       200_000n,
  // transferFrom USDC (permit-authorized, Diamond as spender) + two storage
  // writes (disputeBounty, disputeBountyPayer) + one event.
  fundDispute:          220_000n,
  // The way back out of the same storage. Cheaper than fundDispute: plain
  // transfer() instead of transferFrom() (no permit, no allowance write), one
  // storage slot zeroed instead of two written, one event. Budgeted at the
  // same relative margin rather than measured — this ceiling is only ever
  // reached when estimateGas itself failed, and the withdrawal is the last
  // step of a refund we already promised.
  withdrawDisputeBounty: 150_000n,
  // Agreement lifecycle
  //
  // The five ceilings below (fund, raiseDispute, triggerActivationTimeout,
  // triggerDeadlineTimeout, triggerAutoApprove) were found and raised while
  // measuring the commission/refund paths above — they are NOT part of the
  // fee-economics work: `src/Agreement.sol` was read in full and confirmed
  // to have no `FeeCollected` emission and no second transfer anywhere.
  // They were already broken (or, for triggerAutoApprove, dramatically
  // under-budgeted) on this branch before this task touched anything, and
  // leaving them known-broken while fixing their neighbours in the same
  // file would be worse than raising them alongside. All five (plus
  // `release`, added for the same reason — see its own comment below)
  // re-measured with `forge test --gas-report`, confirmed IDENTICAL across
  // 3 repeated full-suite runs (this table doesn't have the cross-run
  // instability the DiamondProxy table has, see cancelJob above), then
  // raised with the same real-USDC + 20%-margin formula.
  //
  // measured 172_786 (mock USDC) against the old 150_000n — already over
  // budget before any real-USDC correction, on plain fund() (one
  // transferFrom + two NFT mints, no extras/disputes involved).
  // 172_786 * 1.19 * 1.2 ≈ 246_714, rounded up.
  fund:               250_000n,
  activate:           200_000n,
  markDone:           200_000n,
  // measured 458_530 (mock USDC) against the old 500_000n — only ~8% margin,
  // below the 20% floor. Worst case is a completed deal between a
  // client/executor pair on their FIRST deal together, for an amount at or
  // above ReputationFacet's MIN_WIN_AMOUNT (10 USDC): autoAwardXP() then
  // writes fresh (cold) XP/streak storage for BOTH parties in the same call
  // (confirmed via test/Diamond.t.sol:testFullLifecycle, which reuses the
  // fixture's client/executor on their first-ever deal) — not an edge case,
  // this is what every brand-new pair's first completed deal costs.
  // 458_530 * 1.19 * 1.2 ≈ 654_781, rounded up.
  release:            660_000n,
  // measured 107_897 (mock USDC) against the old 100_000n — already over
  // budget before any real-USDC correction.
  // 107_897 * 1.19 * 1.2 ≈ 154_077, rounded up.
  raiseDispute:       160_000n,
  // Записывает один бит в свежий слот (холодный SSTORE 0→1) плюс событие.
  // По формуле файла: измеренное * 1.19 (real USDC) * 1.2 (margin), вверх.
  respondToDispute:   120_000n,
  // Same first-deal / first-XP-award mechanism as `release` above (this
  // function is release()'s twin — same _settlePending + _complete +
  // transfer shape, just callable by anyone after the auto-approve window
  // instead of by the client), confirmed via test/Diamond.t.sol:
  // testAgreementAutoApprove / testAgreementAutoApproveByAnyone, both of
  // which hit exactly this figure. Measured 456_158 (mock USDC) against the
  // old 120_000n — underbudgeted by 3.8x, not an edge case but the cost of
  // literally every new pair's first auto-approved deal.
  // 456_158 * 1.19 * 1.2 ≈ 651_394, rounded up.
  triggerAutoApprove: 660_000n,
  // measured 140_386 (mock USDC) against the old 100_000n — already over
  // budget before any real-USDC correction.
  // 140_386 * 1.19 * 1.2 ≈ 200_471, rounded up.
  triggerActivationTimeout: 210_000n,
  // measured 149_205 (mock USDC) against the old 100_000n — already over
  // budget before any real-USDC correction.
  // 149_205 * 1.19 * 1.2 ≈ 213_065, rounded up.
  triggerDeadlineTimeout:   220_000n,
  // Both branches of the dispute timeout blow straight through the old 100_000n —
  // measured with `forge test --gas-report` on test/DisputeSettlement.t.sol:
  // 145_825 worst case for the split (two USDC transfers, registry write, claim
  // reset) and 147_014 for the refund after a claim (one transfer, plus
  // notifyArbiterTimeout on the Diamond, which costs more than the second
  // transfer saved). The fallback was under both, so whenever estimateGas() failed
  // the meta-transaction reverted out of gas. Those figures come off the local
  // harness with a mock USDC; real Base Sepolia USDC is a proxy and its transfers
  // cost more, so the margin is taken from the closest neighbour instead of the
  // measurement. That neighbour used to be `release` at its old 500_000n — now
  // raised to 660_000n (see above) after its own first-deal/first-XP-award
  // worst case was measured at 458_530 — so this 500_000n ceiling no longer
  // matches that reasoning literally. It's still safe on its own numbers
  // (145_825/147_014 measured, i.e. ~70% margin), just no longer justified by
  // the "matches release's budget" argument; left as-is since it isn't a
  // fee-economics path and its own margin was never in question.
  triggerArbiterTimeout:    500_000n,
};

const DEFAULT_GAS = 500_000n;

// ─── Per-wallet serialization ─────────────────────────────────────────────────
//
// `acquireWalletLock` жил здесь и был приватным для этого файла — двенадцать
// вызовов, все внутри relay.ts. Теперь он в `@/lib/walletLock` и берётся
// каждым путём подписи в приложении, а не только гейслесс-путями: любой второй
// одновременный запрос подписи прилетает в кошелёк как -32002
// («already pending for origin»), а в мобильном MetaMask залипший запрос
// нечем отменить. Поведение при переносе не менялось; см. шапку того файла.

// ─── Forwarder nonce ─────────────────────────────────────────────────────────

/**
 * Единственная точка чтения nonce форвардера во всём файле — три места читали
 * его по отдельности, и ровно поэтому починка одного не чинила остальные.
 *
 * Обычный `readContract` здесь недостаточен: RPC за одним URL — это пул реплик,
 * и чтение СРАЗУ ПОСЛЕ своей же замайненной мета-транзакции спокойно попадает на
 * узел, который её ещё не видел. Тогда подпись уходит со старым nonce, а релеер
 * отвечает «MinimalForwarder: nonce mismatch» — то, что 1 августа 2026 полностью
 * сломало арбитру кнопку «Принять дело» (commit → claim, два вызова подряд).
 * Разбор приёма и потолков — в шапке соответствующего раздела `walletLock.ts`.
 */
async function readFreshNonce(
  publicClient: PublicClient,
  forwarder: Address,
  userAddress: Address,
): Promise<bigint> {
  return awaitFreshForwarderNonce(userAddress, forwarder, async () =>
    await publicClient.readContract({
      address: forwarder,
      abi: FORWARDER_READ_ABI,
      functionName: 'getNonce',
      args: [userAddress],
    }),
  );
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

  // Get nonce from the effective MinimalForwarder (опрос до свежего — см. readFreshNonce)
  const nonce = await readFreshNonce(publicClient, effectiveForwarder, userAddress);

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

  // Отмечаем nonce израсходованным ДО отправки, а не после ответа: с этого
  // момента подпись существует и может долететь до цепи даже если ответ до нас
  // не вернётся (оборванная сеть на мобильном — обычное дело). Следующий вызов
  // этого кошелька обязан дождаться сдвига счётчика, а не подписать тот же nonce
  // второй раз. Обратная сторона — если отправка в итоге не долетела, запись
  // протухает сама (TTL в walletLock.ts), а не штрафует кошелёк навсегда.
  rememberSpentForwarderNonce(userAddress, effectiveForwarder, nonce);

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
  },
): Promise<{ txHash: string; jobId?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { title, description, amount, deadlineDays, terms, region } = params;
  const fee = await readQuotedFee(publicClient, amount);
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
  },
): Promise<{ txHash: string; serviceId?: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

  const { title, description, price, deadlineDays, region } = params;
  const fee = await readFeeFloor(publicClient);

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
 *   1. USDC permit (EIP-2612) — Diamond как spender, amount + fee (комиссия теперь
 *      платится клиентом при запросе, а не executor'ом)
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
  const fee = await readQuotedFee(publicClient, amount);
  const total = amount + fee;

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
    message: { owner: userAddress, spender: DIAMOND, value: total, nonce: usdcNonce, deadline: permitDeadline },
  });

  const { r, s, v } = parseSignature(permitSig);
  const vNum = Number(v) < 27 ? Number(v) + 27 : Number(v);

  // encode requestService calldata (no permit params — relay calls USDC.permit() separately)
  // amount here is the deal amount in calldata, NOT the permit allowance — fee is
  // carried only in the permit (value: total above), never in this argument list.
  const calldata = encodeFunctionData({
    abi: DIAMOND_ABI as Abi,
    functionName: 'requestService',
    args: [serviceId, amount, deadlineDays, terms, region],
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

  try {
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'requestService', DIAMOND, undefined, permitParams);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    // Direct fallback: the relay would have called USDC.permit() itself before
    // requestService() — without an on-chain permit first, the client has no
    // standing USDC allowance to the Diamond, so a direct requestService() call
    // is guaranteed to revert. Submit the already-signed permit ourselves
    // first, the same two-tx fallback fundAgreementGasless already uses.
    console.warn('[relay] down → direct permit+requestService');
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const permitTx = await walletClient.writeContract({
      address: USDC,
      abi: WRITE_USDC_ABI,
      functionName: 'permit',
      args: [userAddress, DIAMOND, total, permitDeadline, vNum, r, s],
      account,
      chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, permitTx);
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
  const nonce = await readFreshNonce(publicClient, effectiveForwarder, userAddress);

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
  // (тот же учёт израсходованного nonce, что в _sendForwardRequest — этот путь
  // постит в /api/relay сам и через него не проходит)
  rememberSpentForwarderNonce(userAddress, effectiveForwarder, nonce);
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

  const nonce = await readFreshNonce(publicClient, effectiveForwarder, userAddress);

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

  // Тот же учёт израсходованного nonce, что в _sendForwardRequest.
  rememberSpentForwarderNonce(userAddress, effectiveForwarder, nonce);

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
 *
 * boxKey/signKey — открытые половины ключей чата арбитра, по 32 байта.
 * ОБЯЗАТЕЛЬНЫ: контракт не принимает заявку без них, и это сделано формой
 * аргумента, а не проверкой. Арбитр без ключа не смог бы прочитать
 * предъявленное, а дело ушло бы в таймаут с делением котла пополам.
 */
export async function claimDisputeGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  salt: Hex,
  boxKey: Hex,
  signKey: Hex,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const calldata = encodeFunctionData({
    abi: CLAIM_DISPUTE_ABI,
    functionName: 'claimDispute',
    args: [agreementAddress, salt, boxKey, signKey],
  });
  try {
    const result = await _sendForwardRequest(walletClient, publicClient, calldata as Hex, 'claimDispute', DIAMOND);
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi: CLAIM_DISPUTE_ABI, functionName: 'claimDispute',
      args: [agreementAddress, salt, boxKey, signKey], account, chain: walletClient.chain,
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

// ─── fundDisputeGasless ───────────────────────────────────────────────────────

/**
 * Доплатить до порога, чтобы арбитр взялся за мелкий спор — gasless.
 *
 * `amount` — ТОЧНАЯ котировка с `quoteDisputeTopUp(agreement)`, читается вызывающей
 * стороной (страница сделки) и передаётся сюда, а не пересчитывается здесь: вторая
 * копия арифметики порога разошлась бы с контрактом молча.
 *
 * fundDispute() на Diamond делает transferFrom(msg.sender, Diamond, amount) —
 * спонсор (Diamond), а не Agreement, поэтому permit подписывается с этим
 * spender'ом. Тот же приём, что requestServiceGasless уже использует для
 * своей собственной doplata на Diamond (permitSpender: DIAMOND).
 *
 * Пользователь подписывает:
 *   1. USDC permit (EIP-2612) — Diamond как spender, amount
 *   2. ForwardRequest (EIP-712) — fundDispute(agreement) calldata → Diamond
 */
const FUND_DISPUTE_ABI = parseAbi(['function fundDispute(address agreement)']);

export async function fundDisputeGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
  agreementAddress: Address,
  amount: bigint,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {

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
    abi: FUND_DISPUTE_ABI,
    functionName: 'fundDispute',
    args: [agreementAddress],
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
    return await _sendForwardRequest(walletClient, publicClient, calldata, 'fundDispute', DIAMOND, undefined, permitParams);
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    // Direct fallback: the relay would have called USDC.permit() itself before
    // fundDispute() — without an on-chain permit first, the caller has no
    // standing USDC allowance to the Diamond, so a direct fundDispute() call
    // is guaranteed to revert. Submit the already-signed permit ourselves
    // first, same two-tx fallback fundAgreementGasless/requestServiceGasless use.
    console.warn('[relay] down → direct permit+fundDispute for', agreementAddress);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const permitTx = await walletClient.writeContract({
      address: USDC,
      abi: WRITE_USDC_ABI,
      functionName: 'permit',
      args: [userAddress, DIAMOND, amount, permitDeadline, vNum, r, s],
      account,
      chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, permitTx);
    const txHash = await walletClient.writeContract({
      address: DIAMOND,
      abi: FUND_DISPUTE_ABI,
      functionName: 'fundDispute',
      args: [agreementAddress],
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

// ─── withdrawDisputeBountyGasless ─────────────────────────────────────────────

/**
 * Забрать доплату за арбитра, которая вернулась плательщику — gasless.
 *
 * Обратная сторона `fundDisputeGasless`, и намеренно проще неё: у контракта
 * `withdrawDisputeBounty()` нет ни аргументов, ни `transferFrom` — он делает
 * `transfer` со своего баланса тому, кто позвал. Значит permit не нужен, и
 * прямой фолбэк здесь однотранзакционный, а не двух-, как у оплаты.
 *
 * Сумма нигде не передаётся: контракт отдаёт весь остаток `refundableBounty`
 * вызывающего целиком и обнуляет его. Фронт эту сумму только показывает
 * (`getRefundableBounty`), но не влияет на неё — второй копии арифметики
 * возврата здесь нет по конструкции.
 *
 * Как и `fundDispute`, функция читает `_msgSender()`, а не `msg.sender`:
 * через форвардер сырой `msg.sender` — это адрес форвардера, и человек забирал
 * бы не свой остаток, а (всегда нулевой) остаток форвардера. Поэтому гейслесс
 * путь тут не украшение, а единственный, который вообще работает без
 * доработок контракта.
 */
const WITHDRAW_BOUNTY_ABI = parseAbi(['function withdrawDisputeBounty()']);

export async function withdrawDisputeBountyGasless(
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<{ txHash: string; fallbackUsed?: boolean }> {
  const userAddress = walletClient.account?.address;
  if (!userAddress) throw new Error('Wallet not connected');
  const releaseLock = await acquireWalletLock(userAddress);
  try {
  const calldata = encodeFunctionData({
    abi: WITHDRAW_BOUNTY_ABI,
    functionName: 'withdrawDisputeBounty',
  });
  try {
    const result = await _sendForwardRequest(walletClient, publicClient, calldata as Hex, 'withdrawDisputeBounty', DIAMOND);
    return { txHash: result.txHash };
  } catch (err) {
    if (!isRelayDown(err)) throw err;
    console.warn('[relay] down → direct withdrawDisputeBounty for', userAddress);
    const account = walletClient.account;
    if (!account) throw new Error('Wallet not connected');
    const txHash = await walletClient.writeContract({
      address: DIAMOND, abi: WITHDRAW_BOUNTY_ABI, functionName: 'withdrawDisputeBounty',
      args: [], account, chain: walletClient.chain,
    });
    await assertFallbackMined(publicClient, txHash);
    return { txHash, fallbackUsed: true };
  }
  } finally {
    releaseLock();
  }
}
