import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTreasuryKeeper } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';
import { ethers } from 'ethers';

const TREASURY = '0x000000000000000000000000000000000015EA50';
const DIAMOND  = process.env.DIAMOND_ADDRESS;

const USDC = (n) => BigInt(Math.round(n * 1e6));

// A REAL Distributed log, encoded by the same ABI the keeper decodes with — so
// the test exercises the actual parse rather than a stub that would keep
// passing if the event signature drifted.
const IFACE = new ethers.Interface([
  'event Distributed(uint256 toVault, uint256 toFoundation, uint256 toReserve)',
]);

function receiptWithToVault(toVault) {
  const { data, topics } = IFACE.encodeEventLog('Distributed', [toVault, 0n, 0n]);
  return { hash: '0xkeeper', logs: [{ data, topics }] };
}

function treasuryMock({ pending, shortfall = 0n, reserve = 0n, owed = 0n, calls }) {
  return {
    pendingDistribution: vi.fn(async () => pending),
    vaultShortfall:      vi.fn(async () => shortfall),
    reserveBalance:      vi.fn(async () => reserve),
    foundationOwed:      vi.fn(async () => owed),
    distribute:          calls.distribute,
    topUpVault:          calls.topUpVault,
    withdrawFoundation:  calls.withdrawFoundation,
  };
}

function txReturning(receipt) {
  return vi.fn(async () => ({ wait: async () => receipt }));
}

describe('runTreasuryKeeper', () => {
  let calls;

  beforeEach(() => {
    calls = {
      distribute:         txReturning(receiptWithToVault(0n)),
      topUpVault:         txReturning({ hash: '0xtop' }),
      withdrawFoundation: txReturning({ hash: '0xwd' }),
    };
    delete process.env.TREASURY_ADDRESS;
  });

  afterEach(() => {
    delete process.env.TREASURY_ADDRESS;
    vi.restoreAllMocks();
  });

  it('does nothing at all while TREASURY_ADDRESS is unset', async () => {
    // The normal state until someone decides to route protocol income here.
    // Staying silent matters: an hourly warning trains people to ignore the log.
    mockContract(TREASURY, treasuryMock({ pending: USDC(1000), calls }));
    await runTreasuryKeeper();
    expect(calls.distribute).not.toHaveBeenCalled();
    expect(calls.topUpVault).not.toHaveBeenCalled();
    expect(calls.withdrawFoundation).not.toHaveBeenCalled();
  });

  it('distributes once income clears the dust floor', async () => {
    process.env.TREASURY_ADDRESS = TREASURY;
    mockContract(TREASURY, treasuryMock({ pending: USDC(250), calls }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    await runTreasuryKeeper();
    expect(calls.distribute).toHaveBeenCalledTimes(1);
  });

  it('does not spend a transaction moving dust', async () => {
    process.env.TREASURY_ADDRESS = TREASURY;
    mockContract(TREASURY, treasuryMock({ pending: USDC(0.03), calls }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    await runTreasuryKeeper();
    expect(calls.distribute).not.toHaveBeenCalled();
  });

  it('tops the vault up from the reserve only once income is distributed', async () => {
    // topUpVault() reverts with DistributeFirst() while anything is pending.
    // That gate is what stops the call ORDER from deciding who pays for the
    // vault, so the keeper must respect it rather than discover it by reverting.
    process.env.TREASURY_ADDRESS = TREASURY;
    mockContract(TREASURY, treasuryMock({
      pending: 0n, shortfall: USDC(200), reserve: USDC(300), calls,
    }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    await runTreasuryKeeper();
    expect(calls.topUpVault).toHaveBeenCalledTimes(1);
  });

  it('never calls topUpVault while income is still undistributed', async () => {
    process.env.TREASURY_ADDRESS = TREASURY;
    // pendingDistribution stays non-zero even after distribute() — e.g. the
    // vault stage refused the transfer, which is exactly the case the contract
    // documents for a treasury that is no longer the fee recipient.
    mockContract(TREASURY, treasuryMock({
      pending: USDC(500), shortfall: USDC(200), reserve: USDC(300), calls,
    }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    await runTreasuryKeeper();
    expect(calls.topUpVault).not.toHaveBeenCalled();
  });

  it('pays the foundation once the accrued debt clears the floor', async () => {
    process.env.TREASURY_ADDRESS = TREASURY;
    mockContract(TREASURY, treasuryMock({ pending: 0n, owed: USDC(700), calls }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    await runTreasuryKeeper();
    expect(calls.withdrawFoundation).toHaveBeenCalledTimes(1);
  });

  it('raises an alarm when the vault does not credit what the treasury sent', async () => {
    // The treasury deliberately has no on-chain postcondition here: one would
    // revert the whole waterfall and let a broken facet freeze all income. The
    // check lives in the keeper instead, so a facet that accepts the transfer
    // without recording it cannot quietly eat every fee for months.
    process.env.TREASURY_ADDRESS = TREASURY;
    const receipt = receiptWithToVault(USDC(500));
    calls.distribute = txReturning(receipt);

    mockContract(TREASURY, treasuryMock({ pending: USDC(1000), calls }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) }); // never grows

    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((m) => errors.push(String(m)));

    await runTreasuryKeeper();

    expect(errors.some(e => e.includes('ALARM'))).toBe(true);
  });

  it('stays quiet when the vault credits the full amount', async () => {
    process.env.TREASURY_ADDRESS = TREASURY;
    const receipt = receiptWithToVault(USDC(500));
    calls.distribute = txReturning(receipt);

    let vault = 0n;
    mockContract(TREASURY, treasuryMock({ pending: USDC(1000), calls }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => { const v = vault; vault = USDC(500); return v; }) });

    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((m) => errors.push(String(m)));

    await runTreasuryKeeper();

    expect(errors.some(e => e.includes('ALARM'))).toBe(false);
  });

  it('survives a failing step and still attempts the others', async () => {
    // One bad step must not stop the rest: a blacklisted foundation address, for
    // instance, should never keep the arbiter vault from being funded.
    process.env.TREASURY_ADDRESS = TREASURY;
    calls.distribute = vi.fn(async () => { throw new Error('boom'); });

    mockContract(TREASURY, treasuryMock({
      pending: USDC(1000), shortfall: USDC(200), reserve: USDC(300), owed: USDC(700), calls,
    }));
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runTreasuryKeeper()).resolves.toBeUndefined();
    expect(calls.withdrawFoundation).toHaveBeenCalledTimes(1);
  });

  it('does not claim topUpVault failed when it never got to attempt it', async () => {
    // An RPC hiccup on the state reads used to log "topUpVault failed", which
    // reads as "the chain refused the call" when nothing was ever sent. Seen on
    // the first live run and mistaken for a contract problem.
    process.env.TREASURY_ADDRESS = TREASURY;
    mockContract(TREASURY, {
      ...treasuryMock({ pending: 0n, calls }),
      vaultShortfall: vi.fn(async () => { throw new Error('server response 500 Internal Server Error'); }),
    });
    mockContract(DIAMOND, { getVaultBalance: vi.fn(async () => 0n) });

    const warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((m) => warnings.push(String(m)));

    await runTreasuryKeeper();

    expect(calls.topUpVault).not.toHaveBeenCalled();
    expect(warnings.some(w => w.includes('nothing was attempted'))).toBe(true);
    expect(warnings.some(w => w.includes('topUpVault failed'))).toBe(false);
  });
});
