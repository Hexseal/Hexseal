import type { UserProfile } from '@/types/profile';
import { uploadToIPFS } from '@/lib/ipfs';

/**
 * Fetch profile for a specific address from the relayer.
 * Pure async function — caching is handled by React Query (useProfile hook).
 */
export async function fetchProfile(address: string): Promise<UserProfile | null> {
  const res = await fetch(`/api/profiles?address=${address.toLowerCase()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json() as Promise<UserProfile | null>;
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
