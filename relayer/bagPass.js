import { createHmac, timingSafeEqual } from 'node:crypto';

const SERVER_SECRET = process.env.SERVER_SECRET;
if (!SERVER_SECRET) throw new Error('SERVER_SECRET is not set');

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

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
  return createHmac('sha256', SERVER_SECRET)
    .update(`hexseal:chat-bags-pass:${BAG_PASS_PREFIX}:${body}`)
    .digest('base64url');
}

export function issueBagPass(address, nowSec = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSec + BAG_PASS_TTL_SEC;
  const body = `${String(address).toLowerCase()}.${expiresAt}`;
  return {
    token: `${BAG_PASS_PREFIX}.${Buffer.from(body, 'utf8').toString('base64url')}.${bagPassMac(body)}`,
    expiresAt,
  };
}

export function verifyBagPass(token, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = { error: 'Invalid bag pass', code: 'pass_invalid' };
  if (typeof token !== 'string') return bad;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== BAG_PASS_PREFIX) return bad;

  const [, encodedBody, mac] = parts;
  let body;
  try {
    body = Buffer.from(encodedBody, 'base64url').toString('utf8');
  } catch { return bad; }

  // Constant-time compare, and only after a length check — timingSafeEqual
  // throws on mismatched lengths instead of returning false.
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
