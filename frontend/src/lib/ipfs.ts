/**
 * File upload helpers — routes through the relayer's local disk storage.
 * fetchFromIPFS kept for reading legacy IPFS CIDs (avatarCid on old profiles).
 *
 * Env vars:
 *   NEXT_PUBLIC_RELAYER_URL   — relayer base URL (required)
 *   NEXT_PUBLIC_IPFS_GATEWAY  — override IPFS read gateway for legacy CIDs (optional)
 */

export interface IPFSUploadResult {
  cid:      string;       // always '' for new uploads (legacy field)
  url:      string;       // relayer URL: ${RELAYER_URL}/public/<key>
  storjUrl: string | null; // same as url (legacy field name)
  ipfsUrl:  string | null; // always null for new uploads
}

/**
 * Upload content to relayer local storage (storage/public/ for avatars/profiles).
 * Always routes through the Next.js API — never calls the relayer from the browser.
 * For profile JSON uploads, pass `signature` so the relayer verifies wallet ownership.
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
