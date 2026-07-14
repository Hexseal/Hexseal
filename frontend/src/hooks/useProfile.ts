'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchProfile } from '@/lib/profiles-ipfs';
import { resolveMediaUrl } from '@/lib/mediaUrl';
import type { UserProfile } from '@/types/profile';

const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://dweb.link';

export const profileQueryKey = (address: string) =>
  ['profile', address.toLowerCase()] as const;

export function useProfile(address: string | undefined) {
  const { data: profile, isLoading } = useQuery<UserProfile | null>({
    queryKey: profileQueryKey(address ?? ''),
    queryFn: () => fetchProfile(address!),
    enabled: !!address,
    staleTime: 5 * 60 * 1000, // 5 min — profiles don't change often
    gcTime:   10 * 60 * 1000, // keep in cache 10 min after last subscriber
  });

  const rawAvatarUrl = profile?.avatarUrl
    ?? (profile?.avatarCid ? `${gateway}/ipfs/${profile.avatarCid}` : null);
  const avatarUrl = resolveMediaUrl(rawAvatarUrl) ?? rawAvatarUrl ?? null;

  return {
    profile: profile ?? null,
    displayName: profile?.displayName ?? null,
    avatarUrl,
    isLoading,
  };
}
