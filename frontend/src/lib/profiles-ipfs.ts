import type { UserProfile } from '@/types/profile';
import { uploadToIPFS } from '@/lib/ipfs';

// ─── Micro-batching ───────────────────────────────────────────────────────────
// useProfile() runs once per card in list views (board, executor board), so
// rendering N cards fired N parallel GETs to /api/profiles. Every fetchProfile()
// call made within the same microtask tick (i.e. the same render/commit pass) is
// coalesced into one POST to /api/profiles/batch, then resolved individually from
// the combined response — transparent to callers, no call-site changes needed.

type Waiter = { resolve: (p: UserProfile | null) => void; reject: (err: unknown) => void };

let pendingBatch: Map<string, Waiter[]> | null = null;

function flushBatch(batch: Map<string, Waiter[]>) {
  fetch('/api/profiles/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: Array.from(batch.keys()) }),
    cache: 'no-store',
  })
    .then(res => (res.ok ? res.json() : {}) as Promise<Record<string, UserProfile | null>>)
    .then(profiles => {
      for (const [address, waiters] of batch) {
        const profile = profiles[address] ?? null;
        waiters.forEach(w => w.resolve(profile));
      }
    })
    .catch(err => {
      for (const waiters of batch.values()) waiters.forEach(w => w.reject(err));
    });
}

/**
 * Fetch profile for a specific address from the relayer.
 * Pure async function — caching is handled by React Query (useProfile hook).
 * Calls made in the same tick are batched into a single network request.
 */
export function fetchProfile(address: string): Promise<UserProfile | null> {
  const addr = address.toLowerCase();
  if (!pendingBatch) {
    pendingBatch = new Map();
    const batch = pendingBatch;
    queueMicrotask(() => {
      pendingBatch = null;
      flushBatch(batch);
    });
  }
  return new Promise((resolve, reject) => {
    const waiters = pendingBatch!.get(addr) ?? [];
    waiters.push({ resolve, reject });
    pendingBatch!.set(addr, waiters);
  });
}

/**
 * Publish a profile to the relayer server.
 * After calling this, invalidate the React Query cache:
 *   queryClient.invalidateQueries({ queryKey: ['profile', address.toLowerCase()] })
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

  // POST to /api/profiles is a no-op but kept for compatibility
  await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, profileCid: profileUrl }),
  }).catch(() => {});

  return profileUrl;
}
