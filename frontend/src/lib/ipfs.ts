/**
 * File upload helpers — upload via Storj (through relayer presign).
 * fetchFromIPFS kept for reading legacy IPFS CIDs (avatarCid on old profiles).
 *
 * Server-side env vars:
 *   NEXT_PUBLIC_RELAYER_URL — relayer base URL (required)
 *
 * Client-side env vars (prefix NEXT_PUBLIC_):
 *   NEXT_PUBLIC_IPFS_GATEWAY  — override default IPFS read gateway (optional)
 */

export interface IPFSUploadResult {
  cid:      string;       // IPFS CID (from Lighthouse; '' if Lighthouse unavailable)
  url:      string;       // primary URL: Storj direct URL when available, else Lighthouse gateway
  storjUrl: string | null; // permanent Storj URL (null if Storj unavailable)
  ipfsUrl:  string | null; // Lighthouse IPFS gateway URL (null if Lighthouse unavailable)
}

/**
 * Upload content to own relayer server storage.
 * Always routes through the API — never exposes server URLs to the browser.
 * For profile uploads, pass `signature` (eth_sign of the JSON) so the relayer
 * can verify the uploader owns the wallet matching the profile address.
 */
export async function uploadToIPFS(
  content: string | Blob,
  filename: string = 'content.json',
  options?: { signature?: string },
): Promise<IPFSUploadResult> {
  const formData = new FormData();
  const blob = content instanceof Blob ? content : new Blob([content], { type: 'application/json' });
  formData.append('file', blob, filename);
  if (options?.signature) formData.append('signature', options.signature);

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
    cid:      result.cid      ?? '',
    url:      result.url      ?? '',
    storjUrl: result.storjUrl ?? null,
    ipfsUrl:  result.ipfsUrl  ?? null,
  };
}

// Public gateways for reading legacy IPFS CIDs (old avatarCid records).
// New uploads go to Storj — these are only needed for backward compat.
const IPFS_GATEWAYS = [
  process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://w3s.link',
  'https://w3s.link',
  'https://cloudflare-ipfs.com',
  'https://ipfs.io',
];

/**
 * Returns a stable public URL for a legacy IPFS CID.
 */
export function publicGatewayUrl(cid: string): string {
  const gw = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://w3s.link';
  return `${gw}/ipfs/${cid}`;
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
