import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { randomUUID } from 'crypto';
import webpush from 'web-push';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

// ─── Web Push (VAPID) ─────────────────────────────────────────────────────────

let VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL     = process.env.VAPID_EMAIL || 'mailto:admin@signature404.com';

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

// address (lowercase) → PushSubscription[]
const _pushSubs = new Map();

async function sendPush(address, payload) {
  const subs = _pushSubs.get(address?.toLowerCase()) ?? [];
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    _pushSubs.set(address.toLowerCase(), subs.filter(s => !dead.includes(s.endpoint)));
  }
}

// ─── Agreement ABI (minimal — for reading deal participants after relay) ───────

const AGREEMENT_MINI_ABI = [
  'function getDetails() view returns (address client_, address executor_, address arbiter_, uint256 amount_, bytes32 termsHash_, uint256 deadlineDays_, uint256 fundedAt_, uint256 activatedAt_, uint256 markedDoneAt_, uint256 disputedAt_, uint256 resolvedAt_, uint8 status_)',
];

const AGR_STATUS_EVENT_ABI = [
  'event AgreementStatusUpdated(address indexed agreement, uint8 newStatus)',
];
const agrEventInterface = new ethers.Interface(AGR_STATUS_EVENT_ABI);

// Agreement.sol internal status enum
const AGR_PUSH_MSG = {
  2: { title: 'Deal Activated ⚡', body: 'The deal has been activated. Work has started.' },
  3: { title: 'Deal Complete ✓',  body: 'Payment has been released. Deal is closed.' },
  4: { title: 'Dispute Raised ⚠️', body: 'A dispute was opened on your deal. Arbiter will review.' },
  5: { title: 'Dispute Resolved ⚖️', body: 'The arbiter has resolved the dispute.' },
  6: { title: 'Deal Refunded ↩️', body: 'The deal was refunded.' },
};

async function pushAfterRelay(receipt, agreementAddress) {
  try {
    // Parse AgreementStatusUpdated from logs
    let newStatus = null;
    for (const log of receipt.logs) {
      try {
        const parsed = agrEventInterface.parseLog(log);
        if (parsed?.name === 'AgreementStatusUpdated') {
          newStatus = Number(parsed.args.newStatus);
          break;
        }
      } catch {}
    }
    if (newStatus === null || !AGR_PUSH_MSG[newStatus]) return;

    // Read agreement participants
    const agr = new ethers.Contract(agreementAddress, AGREEMENT_MINI_ABI, provider);
    const details = await agr.getDetails();
    const client   = details.client_?.toLowerCase();
    const executor = details.executor_?.toLowerCase();
    const arbiter  = details.arbiter_?.toLowerCase();

    const msg = AGR_PUSH_MSG[newStatus];
    const url = `/deal/${agreementAddress}`;
    const payload = { title: msg.title, body: msg.body, url };

    await Promise.allSettled([
      client   && sendPush(client,   payload),
      executor && sendPush(executor, payload),
      arbiter  && arbiter !== '0x0000000000000000000000000000000000000000' && newStatus === 4 && sendPush(arbiter, payload),
    ]);
  } catch {
    // Non-critical — push is best-effort
  }
}

// ─── Storj S3 config ──────────────────────────────────────────────────────────

const STORJ_ENDPOINT  = process.env.STORJ_ENDPOINT  || 'https://gateway.storjshare.io';
const STORJ_ACCESS    = process.env.STORJ_ACCESS_KEY;
const STORJ_SECRET    = process.env.STORJ_SECRET_KEY;
const BUCKET_FILES    = process.env.STORJ_BUCKET_FILES || 's404-files';
const FILE_TTL_S      = 18 * 24 * 60 * 60; // 18 days in seconds
const FILE_TTL_MS     = FILE_TTL_S * 1000;

if (!STORJ_ACCESS || !STORJ_SECRET) {
  console.warn('[s3] STORJ_ACCESS_KEY / STORJ_SECRET_KEY not set — file endpoints disabled');
}

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: STORJ_ENDPOINT,
  credentials: { accessKeyId: STORJ_ACCESS || '', secretAccessKey: STORJ_SECRET || '' },
  forcePathStyle: true,
});

// Cleanup: delete Storj objects older than 18 days — runs daily at 03:00
cron.schedule('0 3 * * *', async () => {
  if (!STORJ_ACCESS) return;
  const cutoff = new Date(Date.now() - FILE_TTL_MS);
  try {
    const toDelete = [];
    let token;
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_FILES, ContinuationToken: token }));
      for (const obj of list.Contents || []) {
        if (obj.LastModified < cutoff) toDelete.push({ Key: obj.Key });
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    if (toDelete.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET_FILES, Delete: { Objects: toDelete } }));
      console.log(`[files] cleanup: removed ${toDelete.length} expired object(s) from Storj`);
    }
  } catch (e) {
    console.error('[files] cleanup error:', e.message);
  }
});

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL          = process.env.RPC_URL
                      || process.env.BASE_SEPOLIA_RPC_URL
                      || 'https://sepolia.base.org';
const RELAYER_KEY      = process.env.RELAYER_PRIVATE_KEY;
const FORWARDER_ADDR   = process.env.TRUSTED_FORWARDER;
const DIAMOND_ADDR     = process.env.DIAMOND_ADDRESS;
const PORT             = process.env.PORT || 3001;

// Comma-separated list of allowed origins, e.g. "http://localhost:3000,https://signature404.com"
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
                          .split(',').map(o => o.trim()).filter(Boolean);

if (!RELAYER_KEY)    throw new Error('RELAYER_PRIVATE_KEY is not set');
if (!FORWARDER_ADDR) throw new Error('TRUSTED_FORWARDER is not set');
if (!DIAMOND_ADDR)   throw new Error('DIAMOND_ADDRESS is not set');

// ─── Rate limiter (in-memory, per IP, sliding window) ────────────────────────

const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX       = 10;     // max requests per window

const _rateMap = new Map(); // ip → { count, resetAt }

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

// Cleanup stale entries every 5 minutes to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateMap) {
    if (now > entry.resetAt) _rateMap.delete(ip);
  }
}, 5 * 60_000);

// ─── Ethers setup ─────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayer  = new ethers.Wallet(RELAYER_KEY, provider);

const FORWARDER_ABI = [
  'function getNonce(address from) view returns (uint256)',
  'function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)',
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes retdata)',
];

const forwarder = new ethers.Contract(FORWARDER_ADDR, FORWARDER_ABI, provider);

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin(origin, cb) {
    // Allow server-to-server (no Origin header) and explicitly whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
  optionsSuccessStatus: 200,
}));

app.use(express.json({ limit: '64kb' }));

// Resolve client IP (works behind common proxies)
function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

// ─── Routes ──────────────────────────────────────────────────────────────────

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

app.post('/relay', async (req, res) => {
  try {
    const ip = clientIp(req);

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (!checkRateLimit(ip)) {
      return res.status(429)
        .set('Retry-After', '60')
        .json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
    }

    const { from, to, value = '0', gas, nonce, data, signature } = req.body;

    // ── Field validation ──────────────────────────────────────────────────────
    if (!from || !to || !gas || !data || !signature) {
      return res.status(400).json({ error: 'Missing fields: from, to, gas, data, signature' });
    }

    if (!ethers.isAddress(from) || !ethers.isAddress(to)) {
      return res.status(400).json({ error: 'Invalid address in from/to' });
    }

    // ── Gas cap — prevent ETH drain via oversized requests ───────────────────
    const MAX_GAS = 4_000_000n;
    if (BigInt(gas) > MAX_GAS) {
      return res.status(400).json({ error: `gas exceeds maximum (${MAX_GAS})` });
    }

    // ── Fetch on-chain nonce (ignore client-supplied nonce to prevent replay) ─
    const onChainNonce = await forwarder.getNonce(from);

    const forwardReq = {
      from,
      to,
      value: BigInt(value),
      gas:   BigInt(gas),
      nonce: onChainNonce,
      data,
    };

    // ── Verify signature on-chain ─────────────────────────────────────────────
    const valid = await forwarder.verify(forwardReq, signature);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    const tx = await forwarder
      .connect(relayer)
      .execute(forwardReq, signature, { gasLimit: BigInt(gas) + 60_000n });

    const receipt = await tx.wait();

    if (receipt.status === 0) {
      return res.status(400).json({ error: 'Transaction reverted on-chain' });
    }

    res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber });

    // Fire-and-forget push notification (best-effort, non-blocking)
    pushAfterRelay(receipt, forwardReq.to);

  } catch (err) {
    console.error('[relay] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── File endpoints (Storj presigned) ────────────────────────────────────────

app.post('/files/presign', async (req, res) => {
  if (!STORJ_ACCESS) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const { ext = '' } = req.body || {};
    const safeExt = String(ext).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
    const key = `${Date.now()}-${randomUUID()}${safeExt}`;

    const [uploadUrl, downloadUrl] = await Promise.all([
      getSignedUrl(s3, new PutObjectCommand({
        Bucket: BUCKET_FILES,
        Key: key,
        ContentType: 'application/octet-stream',
      }), { expiresIn: 3600 }),
      getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET_FILES,
        Key: key,
      }), { expiresIn: FILE_TTL_S }),
    ]);

    res.json({ uploadUrl, downloadUrl, key, expiresIn: '18 days' });
  } catch (err) {
    console.error('[files/presign]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Multipart upload endpoints (large files > 20 MB) ────────────────────────

app.post('/files/multipart/create', async (req, res) => {
  if (!STORJ_ACCESS) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const { ext = '', chunkCount } = req.body || {};
    if (!chunkCount || chunkCount < 1 || chunkCount > 10000) {
      return res.status(400).json({ error: 'chunkCount must be between 1 and 10000' });
    }
    const safeExt = String(ext).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
    const key = `${Date.now()}-${randomUUID()}${safeExt}`;

    const create = await s3.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET_FILES,
      Key: key,
      ContentType: 'application/octet-stream',
    }));
    const uploadId = create.UploadId;

    // Presign all part URLs at once (parts are 1-indexed)
    const partUrls = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        getSignedUrl(s3, new UploadPartCommand({
          Bucket: BUCKET_FILES,
          Key: key,
          UploadId: uploadId,
          PartNumber: i + 1,
        }), { expiresIn: 7200 }) // 2 hours for large uploads
      )
    );

    res.json({ uploadId, key, partUrls });
  } catch (err) {
    console.error('[files/multipart/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/files/multipart/complete', async (req, res) => {
  if (!STORJ_ACCESS) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const { uploadId, key } = req.body || {};
    if (!uploadId || !key) return res.status(400).json({ error: 'uploadId and key required' });

    // Read ETags server-side via ListParts to avoid CORS ETag exposure issues
    const parts = [];
    let partNumberMarker;
    do {
      const listed = await s3.send(new ListPartsCommand({
        Bucket: BUCKET_FILES,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
      }));
      for (const p of listed.Parts || []) {
        parts.push({ PartNumber: p.PartNumber, ETag: p.ETag });
      }
      partNumberMarker = listed.IsTruncated ? listed.NextPartNumberMarker : undefined;
    } while (partNumberMarker);

    if (!parts.length) return res.status(400).json({ error: 'No parts found for this upload' });

    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET_FILES,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));

    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET_FILES,
      Key: key,
    }), { expiresIn: FILE_TTL_S });

    res.json({ downloadUrl });
  } catch (err) {
    console.error('[files/multipart/complete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/files/multipart/abort', async (req, res) => {
  if (!STORJ_ACCESS) return res.status(503).json({ error: 'File storage not configured' });
  try {
    const { uploadId, key } = req.body || {};
    if (!uploadId || !key) return res.status(400).json({ error: 'uploadId and key required' });
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: BUCKET_FILES,
      Key: key,
      UploadId: uploadId,
    }));
    res.json({ success: true });
  } catch (err) {
    console.error('[files/multipart/abort]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Push notification endpoints ─────────────────────────────────────────────

app.get('/push/vapid-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/push/subscribe', async (req, res) => {
  try {
    const { address, subscription } = req.body || {};
    if (!address || !subscription?.endpoint) {
      return res.status(400).json({ error: 'address and subscription required' });
    }
    const key = address.toLowerCase();
    const existing = _pushSubs.get(key) ?? [];
    // Avoid duplicate endpoints
    if (!existing.some(s => s.endpoint === subscription.endpoint)) {
      _pushSubs.set(key, [...existing, subscription]);
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
      const existing = _pushSubs.get(key) ?? [];
      _pushSubs.set(key, existing.filter(s => s.endpoint !== endpoint));
    } else {
      _pushSubs.delete(key);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    console.log(`Storage bucket:  ${STORJ_ACCESS ? BUCKET_FILES + ' (Storj)' : 'disabled'}`);
  });
}

start();
