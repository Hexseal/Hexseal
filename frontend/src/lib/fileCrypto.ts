'use client';

/**
 * fileCrypto.ts — Client-side AES-256-GCM encryption/decryption
 *
 * Files are encrypted in the browser before upload to IPFS.
 * The key + IV travel exclusively through XMTP (E2E encrypted).
 * The blob on IPFS is useless without the key — opaque bytes.
 */

// ─── Hex helpers ─────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

export type EncryptedFile = {
  encryptedBlob: Blob;   // AES-GCM ciphertext (upload this to IPFS)
  keyHex: string;        // 256-bit key, hex-encoded (send via XMTP)
  ivHex:  string;        // 96-bit IV,  hex-encoded (send via XMTP)
};

export async function encryptFile(file: File): Promise<EncryptedFile> {
  const buffer = await file.arrayBuffer();

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);

  const rawKey = await crypto.subtle.exportKey('raw', key);

  return {
    encryptedBlob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    keyHex: bytesToHex(new Uint8Array(rawKey)),
    ivHex:  bytesToHex(iv),
  };
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

// Simple in-memory cache: encrypted URL → decrypted object URL
// Avoids re-fetching + re-decrypting the same file on re-renders.
// Object URLs live for the session; browser cleans up on unload.
const _cache = new Map<string, string>();

export async function decryptToObjectUrl(
  encryptedUrl: string,
  keyHex: string,
  ivHex: string,
  mime?: string,
): Promise<string> {
  const cacheKey = `${encryptedUrl}:${keyHex}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(encryptedUrl);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
  const ciphertext = await response.arrayBuffer();

  const keyBytes = hexToBytes(keyHex);
  const ivBytes  = hexToBytes(ivHex);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer },
    key,
    ciphertext,
  );

  const blob = new Blob([plaintext], { type: mime || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  _cache.set(cacheKey, objectUrl);
  return objectUrl;
}

export async function decryptAndSave(
  encryptedUrl: string,
  keyHex: string,
  ivHex: string,
  filename: string,
  mime?: string,
): Promise<void> {
  const objectUrl = await decryptToObjectUrl(encryptedUrl, keyHex, ivHex, mime);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Don't revoke — it may be cached for subsequent uses
}
