/**
 * Executor Offer types for Signature404 marketplace
 */

export type OfferCategory = 'Design' | 'Development' | 'Marketing' | 'Content' | 'Other';

export interface ExecutorOffer {
  title: string;
  description: string;
  price: number; // USDC with 6 decimals
  deadlineDays: number;
  category: OfferCategory;
  executor: string; // wallet address
  createdAt: number; // unix timestamp
  signature: string; // wallet signature of offer hash
  cid: string; // IPFS CID of this offer
}

export interface OffersIndex {
  offers: string[]; // array of CIDs
  updatedAt: number; // unix timestamp
}

export interface OfferVerification {
  isValid: boolean;
  signer?: string;
  error?: string;
}
