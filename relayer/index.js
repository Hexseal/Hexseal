import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

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
