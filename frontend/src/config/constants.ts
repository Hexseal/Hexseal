export { appChainId as CHAIN_ID } from '@/config/chain';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Agreement lifecycle windows (must match Agreement.sol)
export const ACTIVATION_WINDOW = BigInt(3 * 86400);   // 3 days
export const AUTO_APPROVE_WINDOW = BigInt(5 * 86400); // 5 days

// Input validation limits for deal/job/service forms
export const MAX_DEAL_AMOUNT = 1_000_000; // USDC (6 decimals → $1M)
export const MAX_DEADLINE_DAYS = 365;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;

// Default fallback region fee (Asia/LATAM, region 1)
export const DEFAULT_REGION_FEE = BigInt(4_000_000); // $4 USDC
