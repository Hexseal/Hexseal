'use client';

import { useState, useEffect } from 'react';
import { fetchProfile } from '@/lib/profiles-ipfs';
import { resolveMediaUrl } from '@/lib/mediaUrl';
import type { UserProfile } from '@/types/profile';

const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://dweb.link';

export function useProfile(address: string | undefined) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!address) { setProfile(null); return; }
    let cancelled = false;
    setIsLoading(true);
    fetchProfile(address)
      .then(p => { if (!cancelled) setProfile(p); })
      .catch(() => { if (!cancelled) setProfile(null); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

  const rawAvatarUrl = profile?.avatarUrl
    ?? (profile?.avatarCid ? `${gateway}/ipfs/${profile.avatarCid}` : null);
  // Route relay/ngrok URLs through /api/media proxy so the browser never hits ngrok
  // directly (which can return an interstitial page instead of the actual image).
  const avatarUrl = resolveMediaUrl(rawAvatarUrl);

  return {
    profile,
    displayName: profile?.displayName ?? null,
    avatarUrl,
    isLoading,
  };
}
