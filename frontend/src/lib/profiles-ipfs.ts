/**
 * User Profiles IPFS Manager
 * Handles fetching, caching, and publishing profiles to IPFS via Filebase
 */

import type { UserProfile } from '@/types/profile';
import { uploadToIPFS } from '@/lib/ipfs';

const CACHE_PREFIX = 'hexseal-public_';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Deduplicates concurrent fetchProfile calls for the same address.
// Without this, 10 ConvoItems mounting simultaneously would fire 10 API calls
// before any localStorage cache entry exists.
const _inflight = new Map<string, Promise<UserProfile | null>>();

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

  // Return in-flight promise if this address is already being fetched
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
 * Publish a profile and update the index.
 *
 * Storage strategy:
 *   PRIMARY   — Storj via relayer presign  → permanent URL stored in Redis
 *   SECONDARY — Lighthouse IPFS pin        → optional, for decentralised redundancy
 *
 * Redis stores the best available ref:
 *   1. Storj URL  (preferred — fast, permanent, no IPFS dependency)
 *   2. IPFS CID   (fallback when Storj is unavailable)
 *
 * LIGHTHOUSE_API_KEY is NOT required — if absent, profiles work via Storj only.
 */
export async function publishProfile(profileData: Omit<UserProfile, 'cid'>): Promise<string> {
  // 1. Upload profile JSON (Storj primary, Lighthouse secondary)
  const profileJson = JSON.stringify(profileData);
  const profileBlob = new Blob([profileJson], { type: 'application/json' });
  const profileResult = await uploadToIPFS(profileBlob, `profile-${profileData.address}-${Date.now()}.json`);

  // Use Storj URL if available (permanent, no IPFS gateway required).
  // Fall back to IPFS CID if only Lighthouse succeeded.
  const profileRef = profileResult.storjUrl || profileResult.cid;
  if (!profileRef) {
    throw new Error('Profile upload failed: no storage backend returned a valid reference');
  }

  // 2. Update index via server-side API
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: profileData.address.toLowerCase(), profileCid: profileRef }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'index update failed' })) as { error?: string };
    throw new Error(err.error || 'Failed to update profile index');
  }

  // 3. Cache locally (use the ref as cid field — works for both URLs and CIDs)
  cacheProfile(profileData.address.toLowerCase(), { ...profileData, cid: profileRef });

  return profileRef;
}

/**
 * Verify profile signature matches address
 */
export async function verifyProfileSignature(profile: UserProfile): Promise<boolean> {
  try {
    const { ethers } = await import('ethers');
    const message = `Hexseal Profile\n${JSON.stringify({
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
