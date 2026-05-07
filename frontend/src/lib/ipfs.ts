/**
 * IPFS helpers — upload via Filebase (primary) + Pinata mirror (optional),
 * fetch with automatic public-gateway fallback so NFTs are always visible.
 *
 * Server-side env vars (in .env.local):
 *   FILEBASE_BUCKET / FILEBASE_KEY / FILEBASE_SECRET  — required
 *   PINATA_JWT                                        — optional mirror
 *
 * Client-side env vars (prefix NEXT_PUBLIC_):
 *   NEXT_PUBLIC_IPFS_GATEWAY  — your Filebase dedicated gateway URL
 */

export interface IPFSUploadResult {
  cid: string;
  url: string;
}

/**
 * Upload content to IPFS via Filebase
 * @param content - The content to upload (string or Blob)
 * @param filename - Optional filename for the upload
 * @returns IPFS CID and gateway URL
 */
export async function uploadToIPFS(
  content: string | Blob,
  filename: string = 'content.json'
): Promise<IPFSUploadResult> {
  // Always use the API route — never expose secrets to the browser
  const formData = new FormData();
  const blob = content instanceof Blob ? content : new Blob([content], { type: 'application/json' });
  formData.append('file', blob, filename);

  const response = await fetch('/api/ipfs/upload', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`IPFS upload failed: ${errorData.error || response.statusText}`);
  }

  const result = await response.json();
  return {
    cid: result.cid,
    url: result.url || `${process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://dweb.link'}/ipfs/${result.cid}`,
  };
}

// Public gateways tried in order on fetch. Filebase dedicate gateway is first
// (fastest for our pins), then Cloudflare (most reliable public CDN), then
// Pinata public gateway, then Protocol Labs ipfs.io as last resort.
const IPFS_GATEWAYS = [
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://corporate-orange-boa.myfilebase.com')
    : 'https://corporate-orange-boa.myfilebase.com',
  'https://coffee-deep-turtle-81.mypinata.cloud',
  'https://cloudflare-ipfs.com',
  'https://ipfs.io',
];

/**
 * Returns a public URL for a CID that should work for anyone (NFT metadata,
 * images, etc.). Uses Cloudflare as the default public gateway since it has
 * the best global CDN coverage.
 */
export function publicGatewayUrl(cid: string): string {
  return `https://cloudflare-ipfs.com/ipfs/${cid}`;
}

/**
 * Fetch content from IPFS with automatic gateway fallback.
 * Tries dedicated Filebase gateway first, then public CDN gateways.
 */
export async function fetchFromIPFS(cid: string): Promise<Response> {
  let lastError: unknown;
  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`Failed to fetch IPFS CID ${cid} from all gateways`);
}

/**
 * Convert IPFS CID to bytes32 for contract storage using keccak256 hash
 */
export function cidToBytes32(cid: string): `0x${string}` {
  const { keccak256 } = require('viem');
  return keccak256(new TextEncoder().encode(cid)) as `0x${string}`;
}

/**
 * Convert bytes32 back to CID string (for display)
 */
export function bytes32ToCid(bytes32: string): string {
  return bytes32.replace(/^0x/, '').replace(/0+$/, '') || '';
}
