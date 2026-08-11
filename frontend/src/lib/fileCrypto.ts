'use client';

import { findStoredBagPass, BAG_PASS_HEADER } from '@/lib/storedBagPass';

/**
 * Пропуск склада на СКАЧИВАНИЕ вложения.
 *
 * ⚠️ Появился 10 августа 2026 вместе с замком выдачи на релеере (§5 замысла).
 * До этого `GET /files/:key` отдавал файл любому, кто знает адрес, — и это
 * было заперто тремя зелёными тестами.
 *
 * `hint` — адрес СВОЕГО кошелька, когда он известен вызывающему (карточки
 * вложения передают `self` из `useAccount()` — ChatPanel.tsx). Без подсказки
 * `findStoredBagPass` берёт самый долгоживущий пропуск устройства, а это на
 * двух-аккаунтном устройстве может оказаться пропуск ЧУЖОГО аккаунта: тогда
 * склад отвечает 403 `not_your_file` на собственном же вложении. Замечено
 * при итоговом ревью 4в-1 (fix-attachment-no-access).
 *
 * Пропуска нет — заголовка нет, запрос всё равно уходит: единственный
 * источник истины про доступ это сервер. Своё предсказание «не пустят» было
 * бы вторым мнением рядом с настоящим и разошлось бы с ним при первом
 * изменении правил.
 */
function downloadHeaders(hint?: string): Record<string, string> {
  const pass = findStoredBagPass(hint);
  return pass ? { [BAG_PASS_HEADER]: pass } : {};
}

// ─── Hex helpers ─────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// ─── Trusted attachment origin ────────────────────────────────────────────────

const RELAYER_ORIGIN = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001').origin; }
  catch { return null; }
})();

/** True only for http(s) URLs on this app's own relayer origin. A chat
 *  attachment's `url` field comes from the OTHER party's freely-crafted
 *  message JSON — without this check, a forged message could point it at a
 *  javascript: URI or an arbitrary external host, with nothing anywhere in
 *  the pipeline (client render, decrypt fetch, or the relayer itself) ever
 *  validating it. */
export function isTrustedAttachmentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === RELAYER_ORIGIN;
  } catch {
    return false;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Plaintext bytes per chunk for large-file encryption. */
export const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

// ─── Per-chunk IV derivation ─────────────────────────────────────────────────

function chunkIv(baseIv: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const iv = baseIv.slice() as Uint8Array<ArrayBuffer>;
  // XOR first 4 bytes with little-endian chunk index so each chunk has a unique IV
  iv[0] ^= (index >>> 0)  & 0xff;
  iv[1] ^= (index >>> 8)  & 0xff;
  iv[2] ^= (index >>> 16) & 0xff;
  iv[3] ^= (index >>> 24) & 0xff;
  return iv;
}

// ─── Small-file encryption (≤ 20 MB) ─────────────────────────────────────────

export type EncryptedFile = {
  encryptedBlob: Blob;
  keyHex: string;
  ivHex:  string;
};

/** Encrypts a small file entirely in memory. Do NOT use for files > 20 MB. */
export async function encryptFile(file: File): Promise<EncryptedFile> {
  const buffer = await file.arrayBuffer();
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return {
    encryptedBlob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    keyHex: bytesToHex(new Uint8Array(rawKey)),
    ivHex:  bytesToHex(iv),
  };
}

// ─── Large-file chunked encryption ───────────────────────────────────────────

/**
 * Encrypts `file` in 8 MB chunks, calling `onChunk` for each encrypted piece.
 * Only 8 MB is held in RAM at a time — safe for multi-GB files.
 *
 * Returns key + base IV after all chunks have been processed (chunks are
 * concatenated encrypted blobs; the receiver reconstructs per-chunk IVs from
 * the base IV + chunk index).
 */
export async function encryptFileChunked(
  file: File,
  onChunk: (data: Uint8Array<ArrayBuffer>, index: number, total: number) => Promise<void>,
): Promise<{ keyHex: string; ivHex: string; chunkCount: number }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const baseIv     = crypto.getRandomValues(new Uint8Array(12));
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  for (let i = 0; i < chunkCount; i++) {
    const start  = i * CHUNK_SIZE;
    const slice  = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const buffer = await slice.arrayBuffer() as ArrayBuffer; // only 8 MB in RAM
    const iv     = chunkIv(baseIv, i);
    const enc    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    await onChunk(new Uint8Array(enc), i, chunkCount);
  }

  const rawKey = await crypto.subtle.exportKey('raw', key);
  return { keyHex: bytesToHex(new Uint8Array(rawKey)), ivHex: bytesToHex(baseIv), chunkCount };
}

// ─── Small-file decryption (existing path, for images + small files) ──────────

const _cache = new Map<string, string>();

export async function decryptToObjectUrl(
  encryptedUrl: string,
  keyHex: string,
  ivHex: string,
  mime?: string,
  selfHint?: string,
): Promise<string> {
  if (!isTrustedAttachmentUrl(encryptedUrl)) throw new Error('Untrusted attachment URL');

  const cacheKey = `${encryptedUrl}:${keyHex}:${ivHex}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(encryptedUrl, { headers: downloadHeaders(selfHint) });
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
  const ciphertext = await response.arrayBuffer();

  const keyBytes = hexToBytes(keyHex);
  const ivBytes  = hexToBytes(ivHex);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    'AES-GCM', false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer },
    key, ciphertext,
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
  selfHint?: string,
): Promise<void> {
  const objectUrl = await decryptToObjectUrl(encryptedUrl, keyHex, ivHex, mime, selfHint);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  // target=_blank: some Android PWA/in-app-browser contexts ignore `download` on a
  // blob: URL and navigate the current window to it instead of saving — closing that
  // (a non-renderable blob shows blank) leaves the chat SPA unmounted, stranding the
  // user on a white page instead of back in the chat. Hinting a new context keeps the
  // navigation (if it happens) off the window the chat is actually running in.
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Streaming byte reader ────────────────────────────────────────────────────

class ByteReader {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(n: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.buf.length < n) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error('Unexpected end of encrypted stream');
      const merged = new Uint8Array(this.buf.length + value.length) as Uint8Array<ArrayBuffer>;
      merged.set(this.buf);
      merged.set(value, this.buf.length);
      this.buf = merged;
    }
    const result = this.buf.slice(0, n) as Uint8Array<ArrayBuffer>;
    this.buf = this.buf.slice(n) as Uint8Array<ArrayBuffer>;
    return result;
  }
}

// ─── Large-file chunked decryption ───────────────────────────────────────────

/**
 * Downloads and decrypts a chunked file.
 *
 * On Chrome/Edge uses showSaveFilePicker to stream directly to disk — no RAM limit.
 * On other browsers collects decrypted chunks as Blobs (browser may page to OS disk)
 * then triggers the download link. Works up to ~2 GB on Firefox/Safari.
 */
export async function decryptAndSaveChunked(
  encryptedUrl: string,
  keyHex: string,
  ivHex: string,
  filename: string,
  mime: string | undefined,
  chunkCount: number,
  chunkSize: number,   // plaintext bytes per chunk (CHUNK_SIZE)
  originalSize: number, // total plaintext file size
  onProgress?: (pct: number) => void,
  selfHint?: string,
): Promise<void> {
  if (!isTrustedAttachmentUrl(encryptedUrl)) throw new Error('Untrusted attachment URL');

  const keyBytes = hexToBytes(keyHex);
  const baseIv   = hexToBytes(ivHex);

  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);

  const response = await fetch(encryptedUrl, { headers: downloadHeaders(selfHint) });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  // ── Try streaming save to disk (Chrome / Edge) ────────────────────────────
  if ('showSaveFilePicker' in window) {
    let writable: FileSystemWritableFileStream | undefined;
    try {
      type SavePicker = (opts?: object) => Promise<FileSystemFileHandle>;
      const handle = await (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker({
        suggestedName: filename,
      });
      writable = await handle.createWritable();
      const br = new ByteReader(response.body!.getReader());

      for (let i = 0; i < chunkCount; i++) {
        const isLast   = i === chunkCount - 1;
        const plain    = isLast ? originalSize - i * chunkSize : chunkSize;
        const encSize  = plain + 16; // AES-GCM auth tag
        const encChunk = await br.read(encSize);
        const iv       = chunkIv(baseIv, i);
        const dec      = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, encChunk);
        await writable.write(new Uint8Array(dec));
        onProgress?.(Math.round(((i + 1) / chunkCount) * 100));
      }

      await writable.close();
      return;
    } catch (e: unknown) {
      if ((e as DOMException).name === 'AbortError') return; // user cancelled picker
      if (writable) {
        // A failure happened AFTER the picker succeeded — most likely an
        // AES-GCM authentication failure on a tampered/corrupted chunk, or a
        // disk write error. The partial file on disk is invalid either way.
        // Abort it and surface the real error instead of falling through to
        // the in-memory fallback, which would try to re-read the same
        // (already partially-consumed) response stream and fail confusingly.
        try { await writable.abort(); } catch { /* best-effort */ }
        throw e;
      }
      // showSaveFilePicker itself failed before any writable existed (API
      // unsupported, permission denied) — fall through to in-memory approach.
    }
  }

  // ── Fallback: collect decrypted chunks, trigger <a> download ─────────────
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const br = new ByteReader(response.body!.getReader());

  for (let i = 0; i < chunkCount; i++) {
    const isLast   = i === chunkCount - 1;
    const plain    = isLast ? originalSize - i * chunkSize : chunkSize;
    const encSize  = plain + 16;
    const encChunk = await br.read(encSize);
    const iv       = chunkIv(baseIv, i);
    const dec      = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, encChunk);
    chunks.push(new Uint8Array(dec));
    onProgress?.(Math.round(((i + 1) / chunkCount) * 100));
  }

  const blob = new Blob(chunks, { type: mime || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  // See the comment in decryptAndSave above — same Android PWA blob-navigation guard.
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
