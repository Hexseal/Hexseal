'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import {
  initXmtpClient,
  toIdentifier,
  loadDmMessages,
  normalizeDmMessage,
  encodeFileMessage,
  type ChatMessage,
  type XmtpClient,
  type XmtpDm,
} from '@/lib/xmtp';
import { encryptFile } from '@/lib/fileCrypto';

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3001';

function uploadToRelayer(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const { id } = JSON.parse(xhr.responseText) as { id: string };
        resolve({ url: `${RELAYER_URL}/files/${id}` });
      } else {
        const body = JSON.parse(xhr.responseText || '{}') as { error?: string };
        reject(new Error(body.error ?? 'Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.open('POST', `${RELAYER_URL}/files/upload`);
    xhr.send(form);
  });
}

export type { ChatMessage as DirectMessage };

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDirectChat(recipientAddress: string) {
  const { data: walletClient } = useWalletClient();

  const [messages,        setMessages]        = useState<ChatMessage[]>([]);
  const [isLoading,       setIsLoading]       = useState(true);
  const [isInitialized,   setIsInitialized]   = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [uploadProgress,  setUploadProgress]  = useState<number | null>(null);

  const clientRef = useRef<XmtpClient | null>(null);
  const dmRef     = useRef<XmtpDm | null>(null);
  const streamRef = useRef<{ return: () => void } | null>(null);

  useEffect(() => {
    if (!walletClient || !recipientAddress) return;

    let cancelled = false;

    async function init() {
      try {
        setIsLoading(true);
        setError(null);

        const myAddress = walletClient!.account?.address?.toLowerCase() ?? '';

        // 1. Init XMTP
        const xmtp = await initXmtpClient(walletClient!);
        if (cancelled) return;
        clientRef.current = xmtp;

        // 2. Check if recipient has XMTP identity
        const recipientId = toIdentifier(recipientAddress);
        const canMsg = await xmtp.canMessage([recipientId]);
        if (!canMsg.get(recipientId.identifier)) {
          throw new Error('This user has not set up XMTP messaging yet. They need to connect their wallet to a messaging-enabled app first.');
        }

        // 3. Find or create DM conversation
        await xmtp.conversations.sync(); // pull any existing convos from the network
        const dm = await xmtp.conversations.createDmWithIdentifier(recipientId);
        if (cancelled) return;
        dmRef.current = dm;
        await dm.sync();

        // 4. Load message history
        const history = await loadDmMessages(dm, xmtp.inboxId ?? '', myAddress, recipientAddress);
        if (cancelled) return;
        setMessages(history);

        // 5. Subscribe to new messages
        const stream = await dm.stream();
        streamRef.current = stream;

        const loop = async () => {
          for await (const msg of stream) {
            if (cancelled) break;
            const chat = normalizeDmMessage(msg, xmtp.inboxId ?? '', myAddress, recipientAddress);
            if (!chat) continue;
            setMessages((prev) => {
              if (prev.some((m) => m.id === chat.id)) return prev;
              if (chat.isFromMe) {
                let optIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].id.startsWith('opt-') && prev[i].text === chat.text) { optIdx = i; break; }
                }
                if (optIdx >= 0) return prev.map((m, i) => i === optIdx ? chat : m);
              }
              return [...prev, chat];
            });
          }
        };
        loop();

        if (!cancelled) setIsInitialized(true);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to initialize chat');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    init();

    return () => {
      cancelled = true;
      streamRef.current?.return();
      streamRef.current = null;
    };
  }, [walletClient, recipientAddress]);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    const xmtp = clientRef.current;
    const dm   = dmRef.current;
    if (!xmtp || !dm) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
    setMessages((prev) => [...prev, { id: `opt-${Date.now()}`, from: myAddress, text, timestamp: Date.now(), isFromMe: true }]);
    await dm.sendText(text);
  }, []);

  // ── Send file (encrypt → upload → XMTP) ──────────────────────────────────
  const sendFile = useCallback(async (file: File) => {
    const xmtp = clientRef.current;
    const dm   = dmRef.current;
    if (!xmtp || !dm) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';

    // 1. Encrypt in browser
    const { encryptedBlob, keyHex, ivHex } = await encryptFile(file);
    const encryptedFile = new File([encryptedBlob], file.name + '.enc', { type: 'application/octet-stream' });

    // 2. Upload encrypted blob with progress
    setUploadProgress(0);
    let url: string;
    try {
      ({ url } = await uploadToRelayer(encryptedFile, setUploadProgress));
    } finally {
      setUploadProgress(null);
    }

    // 3. Optimistic UI
    const encoded = encodeFileMessage(file.name, url, file.size, file.type || undefined, keyHex, ivHex);
    setMessages((prev) => [...prev, {
      id: `opt-${Date.now()}`,
      from: myAddress,
      text: file.name,
      attachment: { name: file.name, url, size: file.size, mime: file.type || undefined, key: keyHex, iv: ivHex },
      timestamp: Date.now(),
      isFromMe: true,
    }]);

    // 4. Send via XMTP (key + IV travel E2E encrypted)
    await dm.sendText(encoded);
  }, []);

  return { messages, sendMessage, sendFile, isLoading, isInitialized, error, uploadProgress };
}
