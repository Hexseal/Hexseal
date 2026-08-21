/**
 * THE SEAM: the route really does CALL the "does this URL carry a key" test —
 * and stays quiet where it used to shout.
 *
 * WHAT IT WAS. `route.ts` recognised "a public endpoint in the private slot" by
 * a LIST OF DOMAINS, and beside the list stood an argument: our provider's paid
 * endpoint lives on another domain, so banning the free one's domain is safe.
 * The argument was wrong — the provider serves paid access on more than one
 * domain, one of them was on the list, and on that form the warning printed at
 * every single startup of the frontend. A false alarm is worse than silence:
 * the real signal drowns in it. Worse still, the key does not always sit where
 * the list assumed: on the live paid address it is a segment of the PATH, which
 * a list of hostnames could not have seen under any membership.
 *
 * WHY A SEPARATE FILE, AND WHY `vi.resetModules()`. The private slot is read
 * ONCE at module level (same shape as `ALLOWED_ORIGINS` in
 * `route.origin.test.ts`) and the warning is printed right there, at import.
 * So every scene needs its own import with its own environment.
 *
 * ⚠️ AND THAT IS ALSO WHY three variables are deleted before each scene. The
 * working directory runs under direnv (`.envrc: dotenv`) and the root `.env`
 * really does set `DRPC_URL` and `BASE_SEPOLIA_RPC_URL`: "not setting the
 * variable in the test" does NOT mean "it is empty" here. Without these three
 * lines the "slot is empty" scene would quietly be exercising the owner's live
 * address.
 *
 * ⚠️ The keys below are INVENTED, and written so that being invented is
 * self-evident on sight. This repository is public.
 */
import { describe, it, expect, vi } from 'vitest';

const FAKE_QUERY_KEY = 'FAKE-QUERY-KEY-not-a-real-credential';
const FAKE_PATH_KEY  = 'FAKE-PATH-KEY-not-a-real-credential-000';
const FAKE_SHORT_KEY = 'Fake1234';

/** What the route prints about the private slot when started with this URL. */
async function slotLinesFor(privateUrl: string | undefined): Promise<string[]> {
  vi.resetModules();
  delete process.env.DRPC_URL;
  delete process.env.RPC_URL;
  delete process.env.BASE_SEPOLIA_RPC_URL;
  if (privateUrl !== undefined) process.env.DRPC_URL = privateUrl;

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await import('./route');
    return warn.mock.calls
      .map(c => String(c[0]))
      .filter(line => line.includes('private RPC slot'));
  } finally {
    warn.mockRestore();
  }
}

describe('/api/rpc — the private slot is judged by its KEY, not by its hostname', () => {
  it('CASE 1: the live paid address — key as a PATH SEGMENT — the route stays QUIET', async () => {
    // The form from the owner's environment. A list of domains would never
    // have seen it.
    expect(await slotLinesFor(`https://lb.drpc.live/base-sepolia/${FAKE_PATH_KEY}`)).toEqual([]);
  });

  it('CASE 1b: the same paid endpoint on the domain that was blacklisted — also QUIET', async () => {
    expect(await slotLinesFor(`https://lb.drpc.org/ogrpc?network=base-sepolia&dkey=${FAKE_QUERY_KEY}`)).toEqual([]);
  });

  it('CASE 2: the free drpc endpoint — SAME domain, no key — the route warns', async () => {
    const lines = await slotLinesFor('https://base-sepolia.drpc.org');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no access key');
    expect(lines[0]).toContain('base-sepolia.drpc.org');
  });

  it('CASE 3: the public Base endpoint — the route warns', async () => {
    const lines = await slotLinesFor('https://sepolia.base.org');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no access key');
  });

  it('CASE 4: a key in the path at another provider (`/v2/<key>`) — QUIET', async () => {
    expect(await slotLinesFor(`https://base-sepolia.g.alchemy.com/v2/${FAKE_QUERY_KEY}`)).toEqual([]);
  });

  it('THE COUNTER-CASE: the route cannot buy quiet on the paid address by never speaking', async () => {
    // If the test calls EVERYTHING private (or the route stopped calling it),
    // these two lines are the only thing that will say so.
    expect(await slotLinesFor('https://base-sepolia.drpc.org')).toHaveLength(1);
    expect(await slotLinesFor('https://base-sepolia-rpc.publicnode.com')).toHaveLength(1);
  });

  it('empty slot — nothing said about keys at all (another line shouts about that, on every request)', async () => {
    expect(await slotLinesFor(undefined)).toEqual([]);
  });

  it('the log line holds the host and nothing else: no key, no parameter values', async () => {
    // A scene where a warning EXISTS and a short key in the URL exists TOO.
    const lines = await slotLinesFor(`https://lb.drpc.org/base-sepolia/${FAKE_SHORT_KEY}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(FAKE_SHORT_KEY);
    expect(lines[0]).toContain('lb.drpc.org');
  });

  it('an unparseable address — the route SAYS SO (there used to be an empty catch here)', async () => {
    const lines = await slotLinesFor('lb.drpc.org/base-sepolia/some-key');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot tell');
  });
});
