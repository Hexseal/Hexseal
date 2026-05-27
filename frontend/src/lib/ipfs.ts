/**
 * IPFS helpers — upload via Lighthouse.storage (lighthouse.storage),
 * fetch with automatic public-gateway fallback so NFTs are always visible.
 *
 * Server-side env vars:
 *   LIGHTHOUSE_API_KEY  — API key from lighthouse.storage dashboard
 *
 * Client-side env vars (prefix NEXT_PUBLIC_):
 *   NEXT_PUBLIC_IPFS_GATEWAY  — override default gateway (optional)
 */

export interface IPFSUploadResult {
  cid: string;
  url: string;
}

/**
 * Upload content to IPFS via Storacha.
 * Always routes through the API — never exposes keys to the browser.
 */
export async function uploadToIPFS(
  content: string | Blob,
  filename: string = 'content.json',
): Promise<IPFSUploadResult> {
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
    url: result.url || `${process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage'}/ipfs/${result.cid}`,
  };
}

// Public gateways tried in order on fetch.
// Lighthouse CDN first (our upload target) → cloudflare → w3s.link → ipfs.io.
const IPFS_GATEWAYS = [
  process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.lighthouse.storage',
  'https://gateway.lighthouse.storage',
  'https://cloudflare-ipfs.com',
  'https://w3s.link',
  'https://ipfs.io',
];

/**
 * Returns a stable public URL for a CID (NFT metadata, images, etc.).
 */
export function publicGatewayUrl(cid: string): string {
  return `https://gateway.lighthouse.storage/ipfs/${cid}`;
}

/**
 * Fetch content from IPFS with automatic gateway fallback.
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { keccak256 } = require('viem');
  return keccak256(new TextEncoder().encode(cid)) as `0x${string}`;
}

/**
 * Convert bytes32 back to CID string (for display)
 */
export function bytes32ToCid(bytes32: string): string {
  return bytes32.replace(/^0x/, '').replace(/0+$/, '') || '';
}
