/**
 * Shared by /api/profiles and /api/profiles/batch — both resolve profiles from
 * the same deterministic relayer URL:
 *   GET ${RELAYER_PUBLIC_URL}/public/profile-${address}.json
 * Kept in one place so the two routes can't drift (headers, timeout, response shaping).
 */

export const RELAYER_URL = (
  process.env.NEXT_PUBLIC_RELAYER_URL || process.env.RELAYER_PUBLIC_URL || ''
).replace(/\/$/, '');

// Caller must have already validated `address` (isAddress) before calling this —
// it's interpolated straight into the relayer path.
export async function fetchRelayerProfile(address: string): Promise<Record<string, unknown> | null> {
  if (!RELAYER_URL) return null;
  try {
    const res = await fetch(`${RELAYER_URL}/public/profile-${address}.json`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const profile = await res.json();
    return { ...profile, cid: `profile-${address}.json` };
  } catch {
    return null;
  }
}
