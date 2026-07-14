import type { UserProfile } from '@/types/profile';
import { uploadToIPFS } from '@/lib/ipfs';

const CACHE_PREFIX = 'hexseal-public_';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Deduplicates concurrent fetchProfile calls for the same address.
const _inflight = new Map<string, Promise<UserProfile | null>>();

/**
 * Fetch profile for a specific address.
 * Uses /api/profiles which reads directly from the relayer server.
 */
export async function fetchProfile(address: string): Promise<UserProfile | null> {
  const normalizedAddress = address.toLowerCase();

  const cached = getCachedProfile(normalizedAddress);
  if (cached) return cached;

  const inflight = _inflight.get(normalizedAddress);
  if (inflight) return inflight;

  const promise = fetch(`/api/profiles?address=${normalizedAddress}`, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() as Promise<UserProfile | null> : null))
    .then(data => { if (data) cacheProfile(normalizedAddress, data); return data; })
    .catch(() => null)
    .finally(() => _inflight.delete(normalizedAddress));

  _inflight.set(normalizedAddress, promise);
  return promise;
}

/**
 * Publish a profile to the relayer server.
 * Stored at a deterministic URL: /public/profile-${address}.json
 *
 * `signature` — eth_sign of the profile JSON string, used by the relayer to
 * verify the uploader owns the wallet matching the profile address.
 * Obtain via wagmi signMessage({ message: JSON.stringify(profileData) }).
 */
export async function publishProfile(
  profileData: Omit<UserProfile, 'cid'>,
  signature: string,
): Promise<string> {
  const address = profileData.address.toLowerCase();
  const filename = `profile-${address}.json`;

  const profileJson = JSON.stringify(profileData);
  const profileBlob = new Blob([profileJson], { type: 'application/json' });

  const profileResult = await uploadToIPFS(profileBlob, filename, { signature });

  const profileUrl = profileResult.storjUrl || profileResult.url;
  if (!profileUrl) {
    throw new Error('Profile upload failed: no URL returned from server');
  }

  // POST to /api/profiles is now a no-op but kept for compatibility
  await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, profileCid: profileUrl }),
  }).catch(() => {});

  cacheProfile(address, { ...profileData, cid: profileUrl });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: { address } }));
  }

  return profileUrl;
}


// ─── Cache helpers ────────────────────────────────────────────────────────────

export function invalidateProfileCache(address: string): void {
  try {
    localStorage.removeItem(`${CACHE_PREFIX}${address.toLowerCase()}`);
  } catch { /* ignore */ }
}

function getCachedProfile(address: string): UserProfile | null {
  try {
    const key = `${CACHE_PREFIX}${address}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function cacheProfile(address: string, profile: UserProfile): void {
  try {
    const key = `${CACHE_PREFIX}${address}`;
    localStorage.setItem(key, JSON.stringify({ data: profile, timestamp: Date.now() }));
  } catch {
    // ignore
  }
}
