/**
 * fileStorage.ts — upload encrypted chat files to the relayer (local disk, 7-day TTL).
 *
 * Small files (≤ 20 MB):  encrypt in memory → single presigned PUT
 * Large files (> 20 MB):  encrypt in 8 MB chunks → multipart upload
 *   Each chunk is uploaded as one multipart part directly from the browser.
 *   The relayer presigns all part URLs upfront and completes the upload
 *   server-side (reads ETags via ListParts — no CORS ETag header needed).
 *
 * Files live in /storage/files/ on the relayer with a 7-day TTL.
 * `fileKey` is the opaque filename used to reconstruct the download URL.
 */

import { encryptFile, encryptFileChunked, CHUNK_SIZE } from '@/lib/fileCrypto';

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3001';

/** Maximum allowed file size (5 GB). */
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;

/** Files larger than this use multipart upload + chunked encryption. */
const MULTIPART_THRESHOLD = 20 * 1024 * 1024; // 20 MB

// ─── Single-PUT upload (small files) ─────────────────────────────────────────

export async function uploadEncryptedFile(
  encryptedBlob: File | Blob,
  originalName: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<{ url: string; fileKey: string }> {
  const ext = originalName.includes('.') ? `.${originalName.split('.').pop()!.slice(0, 10)}` : '';

  const presignRes = await fetch(`${RELAYER_URL}/files/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ext }),
    signal,
  });
  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? 'Failed to get upload URL');
  }
  const { uploadUrl, downloadUrl, key: fileKey } = await presignRes.json() as {
    uploadUrl: string; downloadUrl: string; key: string;
  };

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (onProgress) xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`Storage error ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(encryptedBlob);
  });

  return { url: downloadUrl, fileKey };
}

/** Reconstruct the download URL for a file key (local relayer URLs never expire). */
export function refreshDownloadUrl(fileKey: string): Promise<string> {
  return Promise.resolve(`${RELAYER_URL}/files/${fileKey}`);
}

// ─── Multipart upload (large files) ──────────────────────────────────────────

async function uploadEncryptedFileMultipart(
  file: File,
  originalName: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<{ url: string; fileKey: string; keyHex: string; ivHex: string; chunkCount: number }> {
  const ext        = originalName.includes('.') ? `.${originalName.split('.').pop()!.slice(0, 10)}` : '';
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  // 1. Create multipart upload + get presigned URLs for all parts at once
  const createRes = await fetch(`${RELAYER_URL}/files/multipart/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ext, chunkCount }),
    signal,
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? 'Failed to start multipart upload');
  }
  const { uploadId, key: fileKey, partUrls } = await createRes.json() as {
    uploadId: string;
    key: string;
    partUrls: string[];
  };

  try {
    // 2. Encrypt in 8 MB chunks; upload each chunk as a multipart part
    const { keyHex, ivHex } = await encryptFileChunked(file, async (chunk, index, total) => {
      signal?.throwIfAborted();
      const res = await fetch(partUrls[index], {
        method: 'PUT',
        body: chunk,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal,
      });
      if (!res.ok) throw new Error(`Part ${index + 1} upload failed (${res.status})`);
      onProgress?.(Math.round(((index + 1) / total) * 95)); // 0 → 95%
    });

    // 3. Complete — relayer reads ETags via ListParts to avoid CORS ETag header issues
    const completeRes = await fetch(`${RELAYER_URL}/files/multipart/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key: fileKey }),
      signal,
    });
    if (!completeRes.ok) {
      const err = await completeRes.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? 'Failed to complete multipart upload');
    }
    const { downloadUrl } = await completeRes.json() as { downloadUrl: string };

    onProgress?.(100);
    return { url: downloadUrl, fileKey, keyHex, ivHex, chunkCount };

  } catch (err) {
    // Best-effort abort to free relayer storage
    fetch(`${RELAYER_URL}/files/multipart/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key: fileKey }),
    }).catch(() => {});
    throw err;
  }
}

// ─── Unified entry point ──────────────────────────────────────────────────────

export type UploadResult = {
  url: string;
  fileKey: string;
  keyHex: string;
  ivHex: string;
  chunked: boolean;
  chunkCount?: number;
  chunkSize?: number;
};

/** Encrypt and upload a file. Picks single-PUT or multipart based on size. */
export async function uploadFileWithEncryption(
  file: File,
  originalName: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  if (file.size > MAX_FILE_SIZE) {
    const mb = MAX_FILE_SIZE / (1024 * 1024 * 1024);
    throw new Error(`File too large. Maximum size is ${mb} GB.`);
  }

  if (file.size <= MULTIPART_THRESHOLD) {
    const { encryptedBlob, keyHex, ivHex } = await encryptFile(file);
    signal?.throwIfAborted();
    onProgress?.(50);
    const { url, fileKey } = await uploadEncryptedFile(encryptedBlob, originalName, (p) => onProgress?.(50 + p / 2), signal);
    return { url, fileKey, keyHex, ivHex, chunked: false };
  }

  const { url, fileKey, keyHex, ivHex, chunkCount } = await uploadEncryptedFileMultipart(file, originalName, onProgress, signal);
  return { url, fileKey, keyHex, ivHex, chunked: true, chunkCount, chunkSize: CHUNK_SIZE };
}
