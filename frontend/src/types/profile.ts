/**
 * User Profile types for Hexseal
 */

export interface UserProfile {
  address: string;
  displayName: string;
  bio: string;
  role?: 'client' | 'executor' | 'both';
  specializations: string[];
  links: {
    telegram?: string;
    github?: string;
    twitter?: string;
    discord?: string;
    website?: string;
  };
  avatarCid?: string;  // IPFS CID (Lighthouse — secondary/decentralised)
  avatarUrl?: string;  // Direct URL (relayer public storage — primary)
  createdAt: number;
  updatedAt: number;
  signature?: string;
  cid: string;
}

export interface ProfilesIndex {
  profiles: Record<string, string>; // address -> CID
  updatedAt: number;
}

export interface OnChainStats {
  completedDeals: number;
  refundedDeals: number;
  disputedDeals: number;
  totalVolume: bigint;
  avgCompletionTime: number; // in days
  activeNow: number;
  memberSince: number; // unix timestamp
}
