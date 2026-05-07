/**
 * fileStorage.ts — upload encrypted files to Storj via relayer presigned URLs.
 *
 * Flow:
 *   1. Request presigned PUT URL from relayer (no file data sent to relayer)
 *   2. Browser PUTs encrypted blob directly to Storj
 *   3. Relayer returns a presigned GET URL (18-day expiry) stored in XMTP
 */

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3001';

export async function uploadEncryptedFile(
  encryptedBlob: File | Blob,
  originalName: string,
  onProgress?: (pct: number) => void,
): Promise<{ url: string }> {
  const ext = originalName.includes('.') ? `.${originalName.split('.').pop()!.slice(0, 10)}` : '';

  // 1. Get presigned PUT + GET URLs from relayer
  const presignRes = await fetch(`${RELAYER_URL}/files/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ext }),
  });
  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? 'Failed to get upload URL');
  }
  const { uploadUrl, downloadUrl } = await presignRes.json() as {
    uploadUrl: string;
    downloadUrl: string;
  };

  // 2. Upload encrypted blob directly to Storj (relayer not involved in data transfer)
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`Storage error ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(encryptedBlob);
  });

  return { url: downloadUrl };
}
