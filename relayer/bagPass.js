import { createHmac, timingSafeEqual } from 'node:crypto';

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

// Read lazily, at call time, never at module load: app.js only calls
// dotenv.config() in its own body (after its imports have already been
// evaluated), so a top-level read here would run before .env is loaded —
// and app.js has no other local imports today, so this module would be the
// first to hit that ordering hole. The loud failure on a missing secret is
// still correct and still needs to exist; it just has to happen at a moment
// the caller controls, not at import time. That moment is assertBagPassReady().
function serverSecret() {
  const secret = process.env.SERVER_SECRET;
  if (!secret) throw new Error('SERVER_SECRET is not set');
  return secret;
}

// Call once at boot, after dotenv has run (app.js's job — Task 3). Turns a
// missing secret into a startup crash instead of a silent wrong-HMAC on the
// first request.
export function assertBagPassReady() {
  serverSecret();
}

// Twelve hours — a working session, exactly like the dispute-log pass
// (app.js:1155-1164). Not shorter, and not out of laziness: the pass does not
// protect against phishing (a site that already tricked someone into signing
// the chat key would, in the same visit, trick them into signing this
// challenge too), so shrinking the TTL here buys no security — only more
// wallet popups in someone's face. What the pass actually buys: nobody can
// list or download another address's bags without holding that wallet.
export const BAG_PASS_TTL_SEC = 12 * 60 * 60;
const BAG_PASS_PREFIX = 'v1';

export function bagPassChallenge(address, ts) {
  return `hexseal:chat-bags:${String(address).toLowerCase()}:${ts}`;
}

function bagPassMac(body) {
  return createHmac('sha256', serverSecret())
    .update(`hexseal:chat-bags-pass:${BAG_PASS_PREFIX}:${body}`)
    .digest('base64url');
}

export function issueBagPass(address, nowSec = Math.floor(Date.now() / 1000)) {
  // The body separator ('.') is unescaped, so an address that itself
  // contains a dot smuggles an extra field into the body — and the
  // expiresAt this function returns would then lie about what's actually
  // baked into the token. Reject before that can happen, not just on verify.
  const addr = String(address).toLowerCase();
  if (!ETH_ADDR_RE.test(addr)) throw new Error('issueBagPass: invalid address');

  const expiresAt = nowSec + BAG_PASS_TTL_SEC;
  const body = `${addr}.${expiresAt}`;
  return {
    token: `${BAG_PASS_PREFIX}.${Buffer.from(body, 'utf8').toString('base64url')}.${bagPassMac(body)}`,
    expiresAt,
  };
}

export function verifyBagPass(token, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = { error: 'Invalid bag pass', code: 'pass_invalid' };
  if (typeof token !== 'string') return bad;
  // The default parameter only fires for a literally-omitted/undefined
  // nowSec. Anything else non-numeric (null, NaN, a string, an object) skips
  // the default and reaches `nowSec >= expiresAt` below, where a comparison
  // against a non-number is always false — the only time boundary silently
  // disappears and the pass turns permanent.
  if (typeof nowSec !== 'number' || !Number.isFinite(nowSec)) return bad;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== BAG_PASS_PREFIX) return bad;

  const [, encodedBody, mac] = parts;
  let body;
  try {
    body = Buffer.from(encodedBody, 'base64url').toString('utf8');
  } catch { return bad; }

  // Constant-time compare, and only after a length check — timingSafeEqual
  // throws on mismatched lengths instead of returning false.
  // No test can lock "constant-time" here: a mutation to plain `===` still
  // returns the correct verdict, just leaks timing on it — a unit test can't
  // tell the two apart, only a code-review reader can. Keep it constant-time
  // on read, not because a green suite says so.
  const expected = Buffer.from(bagPassMac(body), 'utf8');
  const given    = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return bad;

  const [addr, expRaw] = body.split('.');
  if (!addr || !expRaw || !ETH_ADDR_RE.test(addr)) return bad;

  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt)) return bad;
  if (nowSec >= expiresAt) return { error: 'Bag pass expired', code: 'pass_expired' };

  return { address: addr };
}
