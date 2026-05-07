/**
 * notifier.js — XMTP event notifier
 *
 * Watches on-chain Agreement events and sends XMTP DMs to deal parties.
 * Runs as a standalone process: `node relayer/notifier.js`
 *
 * Required env vars (same .env as relayer):
 *   BASE_SEPOLIA_RPC_URL    — RPC endpoint
 *   NOTIFIER_PRIVATE_KEY    — wallet key for the XMTP notifier identity
 *   DIAMOND_ADDRESS         — Diamond proxy address
 *
 * Install dependency: npm install @xmtp/xmtp-js
 */

import { Client } from '@xmtp/xmtp-js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL        = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const NOTIFIER_KEY   = process.env.NOTIFIER_PRIVATE_KEY;
const DIAMOND        = process.env.DIAMOND_ADDRESS;
const POLL_INTERVAL  = 60_000; // ms — how often to check for new agreements

if (!NOTIFIER_KEY) {
  console.error('[notifier] NOTIFIER_PRIVATE_KEY is required');
  process.exit(1);
}

// ─── Contract ABIs ───────────────────────────────────────────────────────────

const REGISTRY_ABI = [
  'function getAll() view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt)[])',
];

const AGREEMENT_ABI = [
  'function client() view returns (address)',
  'function executor() view returns (address)',
  'function arbiter() view returns (address)',
  'event Funded(address indexed client, uint256 amount)',
  'event Activated(address indexed executor)',
  'event MarkedDone(address indexed executor)',
  'event Released(address indexed client, address indexed executor, uint256 amount)',
  'event DisputeRaised(address indexed by)',
  'event DisputeResolved(address indexed arbiter, bool clientWins, uint256 amount)',
  'event TimedOut(address indexed client, uint256 amount)',
  'event ArbiterTimedOut(address indexed client, uint256 amount)',
];

// ─── Setup ───────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const notifierWallet = new ethers.Wallet(NOTIFIER_KEY, provider);

console.log('[notifier] wallet:', notifierWallet.address);

/** @type {Client} */
let xmtp;

/** addresses we're already watching */
const watched = new Set();

// ─── XMTP helpers ────────────────────────────────────────────────────────────

async function initXmtp() {
  xmtp = await Client.create(notifierWallet, { env: 'production' });
  console.log('[notifier] XMTP ready:', xmtp.address);
}

/**
 * Send a DM to a wallet address. Fire-and-forget.
 * @param {string} to
 * @param {string} text
 */
async function notify(to, text) {
  if (!to || to === ethers.ZeroAddress) return;
  try {
    const canMessage = await Client.canMessage(to, { env: 'production' });
    if (!canMessage) return; // recipient not on XMTP yet
    const convo = await xmtp.conversations.newConversation(to);
    await convo.send(text);
    console.log('[notifier] →', to.slice(0, 8), text.slice(0, 60));
  } catch (e) {
    console.warn('[notifier] DM failed to', to.slice(0, 8), e.message);
  }
}

// ─── Agreement event watchers ─────────────────────────────────────────────────

function shortAddr(a) {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

/**
 * Attach event listeners to a single Agreement contract.
 * @param {string} agreementAddr
 */
async function watchAgreement(agreementAddr) {
  if (watched.has(agreementAddr.toLowerCase())) return;
  watched.add(agreementAddr.toLowerCase());

  const contract = new ethers.Contract(agreementAddr, AGREEMENT_ABI, provider);

  // Read parties once (they're immutable)
  let client, executor;
  try {
    [client, executor] = await Promise.all([contract.client(), contract.executor()]);
  } catch {
    return; // not a valid agreement
  }

  const dealLink = `https://signature404.com/deal/${agreementAddr}`;
  const short = shortAddr(agreementAddr);

  contract.on('Funded', async () => {
    await notify(executor, `[S404] Deal ${short} funded — you can now activate it.\n${dealLink}`);
  });

  contract.on('Activated', async () => {
    await notify(client, `[S404] Deal ${short} activated by executor. Work has started.\n${dealLink}`);
  });

  contract.on('MarkedDone', async () => {
    await notify(client, `[S404] Deal ${short}: executor marked work done. Please review and release funds or raise a dispute.\n${dealLink}`);
  });

  contract.on('Released', async (_, __, amount) => {
    const usdcAmt = (Number(amount) / 1e6).toFixed(2);
    await notify(executor, `[S404] Deal ${short}: $${usdcAmt} USDC released to you.\n${dealLink}`);
  });

  contract.on('DisputeRaised', async () => {
    await notify(client,   `[S404] Deal ${short}: dispute raised. An arbiter will review the case.\n${dealLink}`);
    await notify(executor, `[S404] Deal ${short}: dispute raised. An arbiter will review the case.\n${dealLink}`);
  });

  contract.on('DisputeResolved', async (arbiterAddr, clientWins, amount) => {
    const usdcAmt = (Number(amount) / 1e6).toFixed(2);
    const outcome = clientWins ? `client refunded $${usdcAmt} USDC` : `executor paid $${usdcAmt} USDC`;
    await notify(client,     `[S404] Deal ${short} resolved: ${outcome}.\n${dealLink}`);
    await notify(executor,   `[S404] Deal ${short} resolved: ${outcome}.\n${dealLink}`);
    await notify(arbiterAddr,`[S404] Deal ${short} resolved by you: ${outcome}.\n${dealLink}`);
  });

  contract.on('TimedOut', async (clientAddr, amount) => {
    const usdcAmt = (Number(amount) / 1e6).toFixed(2);
    await notify(clientAddr, `[S404] Deal ${short} timed out — $${usdcAmt} USDC refunded.\n${dealLink}`);
    await notify(executor,   `[S404] Deal ${short} timed out — funds returned to client.\n${dealLink}`);
  });

  contract.on('ArbiterTimedOut', async (clientAddr, amount) => {
    const usdcAmt = (Number(amount) / 1e6).toFixed(2);
    await notify(clientAddr, `[S404] Deal ${short}: arbiter missed 7-day window — $${usdcAmt} USDC refunded to you.\n${dealLink}`);
    await notify(executor,   `[S404] Deal ${short}: arbiter timeout — funds returned to client.\n${dealLink}`);
  });

  console.log('[notifier] watching', agreementAddr.slice(0, 10), `(client=${shortAddr(client)} executor=${shortAddr(executor)})`);
}

// ─── Bootstrap: load all existing agreements ─────────────────────────────────

async function loadAgreements() {
  try {
    const registry = new ethers.Contract(DIAMOND, REGISTRY_ABI, provider);
    const all = await registry.getAll();
    console.log('[notifier] found', all.length, 'agreements in registry');
    for (const rec of all) {
      await watchAgreement(rec.agreement);
    }
  } catch (e) {
    console.warn('[notifier] getAll() failed:', e.message, '— will pick up new agreements via polling');
  }
}

// ─── Polling: pick up new agreements periodically ────────────────────────────

async function pollNewAgreements() {
  try {
    const registry = new ethers.Contract(DIAMOND, REGISTRY_ABI, provider);
    const all = await registry.getAll();
    let added = 0;
    for (const rec of all) {
      if (!watched.has(rec.agreement.toLowerCase())) {
        await watchAgreement(rec.agreement);
        added++;
      }
    }
    if (added > 0) console.log('[notifier] +', added, 'new agreements');
  } catch {
    // silent — getAll may not exist on this Diamond version
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[notifier] starting on', RPC_URL);
  console.log('[notifier] Diamond:', DIAMOND);

  await initXmtp();
  await loadAgreements();

  // Poll for new agreements
  setInterval(pollNewAgreements, POLL_INTERVAL);

  console.log('[notifier] running — polling every', POLL_INTERVAL / 1000, 's');
}

main().catch(e => {
  console.error('[notifier] fatal:', e);
  process.exit(1);
});
