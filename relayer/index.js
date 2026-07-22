import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Client } from '@xmtp/node-sdk';
import webpush from 'web-push';
import fs, { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: '.env.relayer' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────

let VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL     = process.env.VAPID_EMAIL || 'mailto:admin@hexseal.com';

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
  } catch {}
  return new Map();
}
function savePushSubs() {
  try {
    const obj = Object.fromEntries(_pushSubs);
    // loadPushSubs()/savePushSubs() run at module load, before the storage dirs are
    // created further down — make sure the directory exists or the write is lost.
    fs.mkdirSync(path.dirname(PUSH_SUBS_FILE), { recursive: true });
    writeFileSync(PUSH_SUBS_FILE, JSON.stringify(obj), 'utf8');
  } catch {}
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
];

const REGISTRY_MINI_ABI = [
  'function getDisputed() view returns (tuple(address agreement, address client, address executor, uint256 amount, uint8 status, uint256 createdAt, uint256 resolvedAt)[])',
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
const AGR_PUSH_MSG = {
  1: { title: 'Deal Complete ✓',      body: 'Payment has been released. The deal is closed.',      notify: 'both'         },
  2: { title: 'Deal Refunded ↩️',    body: 'The deal was cancelled and refunded.',                notify: 'client'       },
  3: { title: 'Dispute Raised ⚠️',   body: 'A dispute was opened. An arbiter will review.',      notify: 'both+arbiter' },
  4: { title: 'Dispute Resolved ⚖️', body: 'The arbiter has resolved the dispute.',              notify: 'both'         },
};

// activate(), markDone(), and fund() don't emit AgreementStatusUpdated,
// so we detect them by function selector and send push directly.
const FUNC_PUSH_MSG = {
  '0xb60d4288': { title: 'Deal Funded 💰',      body: 'Your deal has been funded. Activate to start working.',    notify: 'executor' },
  '0x0f15f4c0': { title: 'Deal Activated ⚡',  body: 'Work has started. Track progress in the deal page.',        notify: 'client'   },
  '0x1bdfc6e3': { title: 'Work Submitted ✔',   body: 'The executor marked the job as done. Please review it.',   notify: 'client'   },
};

async function pushAfterRelay(receipt, agreementAddress, calldata) {
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
      if (cfg.notify === 'both+arbiter' && arbiter && arbiter !== ZERO) sends.push(sendPush(arbiter, payload));
      return Promise.allSettled(sends);
    };

    // Check for AgreementStatusUpdated event first (terminal state changes).
    for (const log of receipt.logs) {
      try {
        const parsed = agrEventInterface.parseLog(log);
        if (parsed?.name === 'AgreementStatusUpdated') {
          const cfg = AGR_PUSH_MSG[Number(parsed.args.newStatus)];
          if (cfg) await sendCfg(cfg);
          return;
        }
      } catch {}
    }

    // No event found — check if the called function is activate() or markDone().
    const selector = typeof calldata === 'string' ? calldata.slice(0, 10).toLowerCase() : null;
    if (selector) {
      const cfg = FUNC_PUSH_MSG[selector];
      if (cfg) await sendCfg(cfg);
    }
  } catch {
    // push is best-effort
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
function deriveLogKey(pairId) {
  return ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(pairId.toLowerCase() + SERVER_SECRET))
  );
}

function encryptEntry(key, obj) {
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

function decryptEntry(key, { iv, ct, authTag }) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ct, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

const ETH_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const PAIR_ID_RE  = /^0x[a-fA-F0-9]{40}-0x[a-fA-F0-9]{40}$/;

function sortAddressPair(a, b) {
  const lc = [a.toLowerCase(), b.toLowerCase()];
  return lc[0] <= lc[1] ? lc : [lc[1], lc[0]];
}

function pairIdFromAddresses(a, b) {
  const [x, y] = sortAddressPair(a, b);
  return `${x}-${y}`;
}

function safeLogPath(pairId) {
  const id = pairId.toLowerCase();
  if (!PAIR_ID_RE.test(id)) throw new Error(`invalid pairId: ${id}`);
  const logPath = path.join(DIR_LOGS, `${id}.ndjson`);
  if (!path.resolve(logPath).startsWith(path.resolve(DIR_LOGS) + path.sep)) throw new Error('path escape');
  return logPath;
}

function appendLogEntry(pairId, entry) {
  const key = deriveLogKey(pairId);
  const encrypted = encryptEntry(key, entry);
  const line = JSON.stringify(encrypted) + '\n';
  fs.appendFileSync(safeLogPath(pairId), line);
}

function readLog(pairId) {
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
function safeKey(key) {
  return path.basename(String(key).replace(/[^a-zA-Z0-9.\-_]/g, '')).slice(0, 200);
}

// Cleanup: delete expired chat files and orphaned temp dirs — runs daily at 03:00
cron.schedule('0 3 * * *', async () => {
  const cutoff   = Date.now() - FILE_TTL_MS;
  const cutoff1d = Date.now() - 24 * 60 * 60 * 1000;
  const disputedPairIds = await getDisputedPairIds();

  // Expired chat files — skip any still tagged to a currently-disputed pair
  try {
    let removed = 0;
    let protectedCount = 0;
    for (const f of fs.readdirSync(DIR_FILES)) {
      const fp = path.join(DIR_FILES, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          const pairId = _filePairs[f];
          if (pairId && disputedPairIds.has(pairId)) {
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
});

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

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = _rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
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
];

const forwarder = new ethers.Contract(FORWARDER_ADDR, FORWARDER_ABI, provider);

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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Content-Type', 'application/octet-stream');
  next();
}, express.static(DIR_FILES, { maxAge: '1h' }));

// TRUST_PROXY=true only if running behind a reverse proxy (nginx/caddy) that sets
// X-Forwarded-For correctly. Without it, the header is spoofable by any client.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
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

// Dispute log — only accessible to the deal's on-chain arbiter.
// Arbiter signs "hexseal:dispute-log:{dealId}:{unixSeconds}" with their wallet.
app.get('/dispute-log/:dealId', async (req, res) => {
  const { dealId } = req.params;
  if (!ETH_ADDR_RE.test(dealId.toLowerCase())) return res.status(400).json({ error: 'Invalid dealId' });

  const ts  = req.headers['x-ts'];
  const sig = req.headers['x-sig'];

  if (!ts || !sig) return res.status(401).json({ error: 'Missing x-ts or x-sig header' });

  // Replay protection: timestamp must be within ±5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) {
    return res.status(401).json({ error: 'Timestamp out of window' });
  }

  try {
    // Recover signer address from signature
    const message = `hexseal:dispute-log:${dealId.toLowerCase()}:${ts}`;
    const signerAddr = ethers.verifyMessage(message, sig).toLowerCase();

    // Check on-chain: is this address the arbiter of this deal?
    const agr = new ethers.Contract(dealId, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const onChainArbiter = details.arbiter_?.toLowerCase();

    if (!onChainArbiter || onChainArbiter === ethers.ZeroAddress.toLowerCase()) {
      return res.status(403).json({ error: 'No arbiter assigned for this deal' });
    }
    if (onChainArbiter !== signerAddr) {
      return res.status(403).json({ error: 'Not the arbiter of this deal' });
    }

    // Log storage is keyed by pair (client+executor), not by this individual deal —
    // a pair's thread can span casual chat plus multiple deals over time, and the
    // arbiter is meant to see that full context, not just this deal's slice.
    const pairId = pairIdFromAddresses(details.client_, details.executor_);
    const entries = readLog(pairId);
    res.json({ entries });
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

    const MAX_GAS = 8_000_000n; // Agreement deployment (~4.6M) × 1.3 buffer + forwarder overhead
    if (BigInt(gas) > MAX_GAS) {
      return res.status(400).json({ error: `gas exceeds maximum (${MAX_GAS})` });
    }

    const onChainNonce = await forwarder.getNonce(from);
    const forwardReq = { from, to, value: BigInt(value), gas: BigInt(gas), nonce: onChainNonce, data };

    const valid = await forwarder.verify(forwardReq, signature);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });

    const tx = await forwarder.connect(relayer).execute(forwardReq, signature, { gasLimit: BigInt(gas) + 60_000n });
    const receipt = await tx.wait();
    if (receipt.status === 0) return res.status(400).json({ error: 'Transaction reverted on-chain' });

    res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber });
    pushAfterRelay(receipt, forwardReq.to, data);
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

function streamWithSizeLimit(req, res, filePath, maxBytes) {
  let received = 0;
  let aborted  = false;
  const ws = fs.createWriteStream(filePath);
  req.on('data', (chunk) => {
    received += chunk.length;
    if (!aborted && received > maxBytes) {
      aborted = true;
      ws.destroy();
      fs.unlink(filePath, () => {});
      if (!res.headersSent) res.status(413).json({ error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)` });
      req.destroy();
    }
  });
  req.pipe(ws);
  ws.on('finish', () => { if (!aborted && !res.headersSent) res.status(200).end(); });
  ws.on('error', (err) => { if (!res.headersSent) { console.error('[upload]', err.message); res.status(500).json({ error: 'Write error' }); } });
  req.on('error', () => ws.destroy());
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
// In-memory: resets on restart, but updatedAt = Date.now()/1000 always increases.
const _profileNonces = new Map();

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

app.post('/push/unsubscribe', async (req, res) => {
  try {
    const { address, endpoint } = req.body || {};
    if (!address) return res.status(400).json({ error: 'address required' });
    const key = address.toLowerCase();
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
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
    }
    const { to, title, body, url, from, tag } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });
    if (!ethers.isAddress(to)) return res.status(400).json({ error: 'Invalid address' });

    // `from` (for display-name resolution) is only trusted when the request comes
    // from our own Next.js server with the shared PUSH_SECRET header.
    // Without it, `from` is ignored and we fall back to `title` or a generic string.
    const isTrusted = PUSH_SECRET && req.headers['x-push-secret'] === PUSH_SECRET;
    // Fallback is 'New message', NOT 'Hexseal': the OS already shows the app name
    // ("from Hexseal") as the source, so a 'Hexseal' title read as "Hexseal from Hexseal".
    const resolvedTitle = isTrusted && from
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

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  app.listen(PORT, () => {
    console.log(`Relayer running on :${PORT}`);
    console.log(`Relayer wallet:  ${relayer.address}`);
    console.log(`Forwarder:       ${FORWARDER_ADDR}`);
    console.log(`Diamond:         ${DIAMOND_ADDR}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`Public URL:      ${BASE_URL}`);
    console.log(`Storage:         ${STORAGE_DIR}`);
    console.log(`  files/  → ${DIR_FILES} (encrypted, 7d TTL)`);
    console.log(`  public/ → ${DIR_PUBLIC} (permanent)`);
  });
}

start();

// ─── XMTP Bot startup ─────────────────────────────────────────────────────────
(async () => {
  try {
    const xmtpDbPath = path.join(STORAGE_DIR, 'xmtp-bot');
    const botClient = await Client.create(botSigner, {
      env: 'production',
      dbPath: xmtpDbPath,
    });
    console.log(`[bot] XMTP ready: ${botClient.inboxId}`);

    // Stream messages from one group (fire-and-forget). `currentDealId` is a
    // per-group cursor updated by silent deal_ctx marker messages (sent by the
    // frontend's ChatPanel) — it tags each logged entry with whichever deal was
    // "active" when the message was sent, but never gates whether an entry is
    // written: the log deliberately keeps the whole thread, unfiltered, so an
    // arbiter can see context from before a deal formally started.
    async function streamGroupMessages(group) {
      const groupName = group.name ?? '';
      if (!groupName.startsWith('HSEAL-PAIR-')) return;
      const pairId = groupName.slice('HSEAL-PAIR-'.length).toLowerCase();
      if (!PAIR_ID_RE.test(pairId)) return;

      let currentDealId = null;

      try {
        const stream = await group.stream();
        for await (const msg of stream) {
          if (typeof msg.content !== 'string' || !msg.content) continue;

          if (msg.content.startsWith('{')) {
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed._type === 'deal_ctx') {
                currentDealId = typeof parsed.dealId === 'string' ? parsed.dealId.toLowerCase() : null;
                continue; // marker itself is never a log entry
              }
            } catch { /* not JSON — fall through, log as a normal entry */ }
          }

          const members = await group.members();
          const sender = members.find(m => m.inboxId === msg.senderInboxId);
          const from = sender?.accountIdentifiers?.[0]?.identifier?.toLowerCase() ?? msg.senderInboxId;
          appendLogEntry(pairId, {
            ts:     msg.sentAt ? msg.sentAt.getTime() : Date.now(),
            from,
            text:   msg.content,
            dealId: currentDealId,
          });
        }
      } catch (err) {
        console.warn(`[bot] stream error for ${pairId}:`, err.message);
      }
    }

    // Sync and start streaming all existing HSEAL-* groups
    await botClient.conversations.sync();
    const groups = await botClient.conversations.listGroups();
    for (const g of groups) {
      streamGroupMessages(g); // intentionally not awaited
    }

    // Stream new group invitations
    (async () => {
      try {
        const stream = await botClient.conversations.stream();
        for await (const conv of stream) {
          streamGroupMessages(conv); // intentionally not awaited
        }
      } catch (err) {
        console.warn('[bot] conversation stream error:', err.message);
      }
    })();

  } catch (err) {
    console.error('[bot] XMTP init failed:', err.message);
    // Non-fatal — relay still works without the bot
  }
})();
