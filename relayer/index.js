import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import multer from 'multer';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

dotenv.config();

// ─── File storage config ──────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const FILE_TTL_MS = 18 * 24 * 60 * 60 * 1000; // 18 days
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '50') * 1024 * 1024;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Filename encodes upload timestamp: {timestamp}-{uuid}{ext}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file,  cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Cleanup: delete files older than FILE_TTL_MS — runs daily at 03:00
cron.schedule('0 3 * * *', () => {
  const cutoff = Date.now() - FILE_TTL_MS;
  let removed = 0;
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    const ts = parseInt(f.split('-')[0], 10);
    if (!isNaN(ts) && ts < cutoff) {
      fs.unlinkSync(path.join(UPLOADS_DIR, f));
      removed++;
    }
  }
  if (removed) console.log(`[files] cleanup: removed ${removed} expired file(s)`);
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

// ─── File endpoints ───────────────────────────────────────────────────────────

app.post('/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const expiresAt = parseInt(req.file.filename.split('-')[0], 10) + FILE_TTL_MS;
  res.json({
    id:        req.file.filename,
    expiresAt,
    expiresIn: '18 days',
  });
});

app.get('/files/:id', (req, res) => {
  const id = path.basename(req.params.id); // prevent path traversal
  const filePath = path.join(UPLOADS_DIR, id);

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found or expired' });

  const ts = parseInt(id.split('-')[0], 10);
  if (!isNaN(ts) && Date.now() - ts > FILE_TTL_MS) {
    fs.unlinkSync(filePath);
    return res.status(410).json({ error: 'File expired' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${id}"`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Relayer running on :${PORT}`);
  console.log(`Relayer wallet:  ${relayer.address}`);
  console.log(`Forwarder:       ${FORWARDER_ADDR}`);
  console.log(`Diamond:         ${DIAMOND_ADDR}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
