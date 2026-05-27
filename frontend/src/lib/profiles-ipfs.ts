/**
 * User Profiles IPFS Manager
 * Handles fetching, caching, and publishing profiles to IPFS via Filebase
 */

import type { UserProfile } from '@/types/profile';
import { uploadToIPFS } from '@/lib/ipfs';

const CACHE_PREFIX = 'sig404_profile_';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch profile for a specific address.
 * Uses server-side API route (/api/profiles) to read the Filebase S3 index
 * directly — avoids CORS issues and broken IPFS gateway key-lookups.
 */
export async function fetchProfile(address: string): Promise<UserProfile | null> {
  const normalizedAddress = address.toLowerCase();

  // Check localStorage cache first (fast path after first load or own profile)
  const cached = getCachedProfile(normalizedAddress);
  if (cached) return cached;

  try {
    const res = await fetch(`/api/profiles?address=${normalizedAddress}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json() as UserProfile | null;
    if (!data) return null;
    cacheProfile(normalizedAddress, data);
    return data;
  } catch (error) {
    console.error(`Failed to fetch profile for ${address}:`, error);
    return null;
  }
}

/**
 * Publish a profile and update the index.
 * Profile JSON is uploaded to IPFS; the index is updated server-side via
 * /api/profiles (reads/writes S3 directly — no broken gateway key-lookups).
 */
export async function publishProfile(profileData: Omit<UserProfile, 'cid'>): Promise<string> {
  // 1. Upload profile JSON to IPFS
  const profileJson = JSON.stringify(profileData);
  const profileBlob = new Blob([profileJson], { type: 'application/json' });
  const profileResult = await uploadToIPFS(profileBlob, `profile-${profileData.address}-${Date.now()}.json`);
  const profileCid = profileResult.cid;

  // 2. Update index via server-side API (reads + writes Filebase S3 atomically)
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: profileData.address.toLowerCase(), profileCid }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'index update failed' })) as { error?: string };
    throw new Error(err.error || 'Failed to update profile index');
  }

  // 3. Cache locally
  cacheProfile(profileData.address.toLowerCase(), { ...profileData, cid: profileCid });

  return profileCid;
}

/**
 * Verify profile signature matches address
 */
export async function verifyProfileSignature(profile: UserProfile): Promise<boolean> {
  try {
    const { ethers } = await import('ethers');
    const message = `Signature404 Profile\n${JSON.stringify({
      address: profile.address,
      displayName: profile.displayName,
      bio: profile.bio,
      role: profile.role,
      specializations: profile.specializations,
      links: profile.links,
      avatarCid: profile.avatarCid,
      avatarUrl: profile.avatarUrl,    // undefined on old profiles → omitted in JSON → backward compat
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })}\n${profile.updatedAt}`;

    const messageHash = ethers.hashMessage(message);
    const signer = ethers.recoverAddress(messageHash, profile.signature);

    return signer.toLowerCase() === profile.address.toLowerCase();
  } catch (error) {
    console.error('Profile signature verification failed:', error);
    return false;
  }
}

// --- Cache helpers ---

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
    // Ignore cache errors
  }
}
