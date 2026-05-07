'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalletClient, usePublicClient } from 'wagmi';
import {
  initXmtpClient,
  findOrCreateDealGroup,
  tryAddGroupMember,
  loadGroupMessages,
  normalizeGroupMessage,
  buildInboxAddressMap,
  encodeFileMessage,
  type ChatMessage,
  type XmtpClient,
  type XmtpGroup,
} from '@/lib/xmtp';
import { encryptFile } from '@/lib/fileCrypto';

// XHR-based upload so we get real progress events
function uploadToIPFS(
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
        resolve(JSON.parse(xhr.responseText) as { url: string });
      } else {
        const body = JSON.parse(xhr.responseText || '{}') as { error?: string };
        reject(new Error(body.error ?? 'Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.open('POST', '/api/ipfs/upload');
    xhr.send(form);
  });
}

// ─── Agreement ABI ────────────────────────────────────────────────────────────

const AGREEMENT_ABI = [
  {
    name: 'getDetails',
    type: 'function',
    inputs: [],
    outputs: [
      { name: 'client_',       type: 'address' },
      { name: 'executor_',     type: 'address' },
      { name: 'arbiter_',      type: 'address' },
      { name: 'amount_',       type: 'uint256' },
      { name: 'termsHash_',    type: 'bytes32' },
      { name: 'deadlineDays_', type: 'uint256' },
      { name: 'fundedAt_',     type: 'uint256' },
      { name: 'activatedAt_',  type: 'uint256' },
      { name: 'markedDoneAt_', type: 'uint256' },
      { name: 'disputedAt_',   type: 'uint256' },
      { name: 'resolvedAt_',   type: 'uint256' },
      { name: 'status_',       type: 'uint8'   },
    ],
    stateMutability: 'view',
  },
] as const;

const STATUS_COMPLETED = 3;
const STATUS_RESOLVED  = 5;
const STATUS_REFUNDED  = 6;
const CLOSED_STATUSES  = new Set([STATUS_COMPLETED, STATUS_RESOLVED, STATUS_REFUNDED]);
const ZERO_ADDR        = '0x0000000000000000000000000000000000000000';

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDealChat(agreementAddress: string) {
  const { data: walletClient } = useWalletClient();
  const publicClient           = usePublicClient();

  const [messages,       setMessages]       = useState<ChatMessage[]>([]);
  const [isLoading,      setIsLoading]      = useState(true);
  const [isInitialized,  setIsInitialized]  = useState(false);
  const [isClosed,       setIsClosed]       = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const clientRef  = useRef<XmtpClient | null>(null);
  const groupRef   = useRef<XmtpGroup | null>(null);
  const streamRef  = useRef<{ return: () => void } | null>(null);

  useEffect(() => {
    if (!walletClient || !publicClient || !agreementAddress) return;

    let cancelled = false;

    async function init() {
      try {
        setIsLoading(true);
        setError(null);

        const myAddress = walletClient!.account?.address?.toLowerCase();
        if (!myAddress) throw new Error('Wallet not connected');

        // 1. Read Agreement contract
        const details = await publicClient!.readContract({
          address: agreementAddress as `0x${string}`,
          abi: AGREEMENT_ABI,
          functionName: 'getDetails',
        });
        const [client_, executor_, arbiter_,,,,,,,,,  status_] = details;

        // 2. Access check
        const participants = [client_, executor_, arbiter_]
          .filter(Boolean)
          .map((a) => (a as string).toLowerCase());
        if (!participants.includes(myAddress)) {
          throw new Error('Access denied: you are not a participant of this deal');
        }

        if (cancelled) return;
        setIsClosed(CLOSED_STATUSES.has(Number(status_)));

        // 3. Init XMTP (asks for wallet signature on first use)
        const xmtp = await initXmtpClient(walletClient!);
        if (cancelled) return;
        clientRef.current = xmtp;

        // 4. Find or create deal group
        const memberAddresses = [client_ as string, executor_ as string].filter(Boolean);
        const group = await findOrCreateDealGroup(xmtp, agreementAddress, memberAddresses);
        if (cancelled) return;
        groupRef.current = group;

        // 5. Auto-add arbiter if deal is DISPUTED (status 4)
        if (
          Number(status_) === 4 &&
          arbiter_ &&
          (arbiter_ as string).toLowerCase() !== ZERO_ADDR
        ) {
          try {
            await tryAddGroupMember(group, arbiter_ as string, xmtp);
          } catch { /* Non-critical */ }
        }

        const myInboxId = xmtp.inboxId ?? '';

        // 6. Load message history
        const history = await loadGroupMessages(group, myInboxId, myAddress);
        if (cancelled) return;
        setMessages(history);

        // 7. Subscribe to new messages
        const stream = await group.stream();
        streamRef.current = stream;

        const members = await group.members();
        const inboxToAddr = buildInboxAddressMap(members);

        const loop = async () => {
          for await (const msg of stream) {
            if (cancelled) break;
            const chat = normalizeGroupMessage(msg, myInboxId, myAddress, inboxToAddr);
            if (!chat) continue;
            setMessages((prev) => {
              // Skip exact duplicate (e.g. two streams in StrictMode)
              if (prev.some((m) => m.id === chat.id)) return prev;
              // Replace matching optimistic message with the real one
              if (chat.isFromMe) {
                let optIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].id.startsWith('opt-') && prev[i].text === chat.text) {
                    optIdx = i; break;
                  }
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize chat');
        }
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
  }, [walletClient, publicClient, agreementAddress]);

  // ── Send message ─────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    const xmtp  = clientRef.current;
    const group = groupRef.current;
    if (!xmtp || !group) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';
    setMessages((prev) => [...prev, { id: `opt-${Date.now()}`, from: myAddress, text, timestamp: Date.now(), isFromMe: true }]);
    await group.sendText(text);
  }, []);

  // ── Send file (encrypt → upload → XMTP) ──────────────────────────────────
  const sendFile = useCallback(async (file: File) => {
    const xmtp  = clientRef.current;
    const group = groupRef.current;
    if (!xmtp || !group) throw new Error('Chat not initialized');

    const myAddress = xmtp.accountIdentifier?.identifier?.toLowerCase() ?? '';

    // 1. Encrypt in browser
    const { encryptedBlob, keyHex, ivHex } = await encryptFile(file);
    const encryptedFile = new File([encryptedBlob], file.name + '.enc', { type: 'application/octet-stream' });

    // 2. Upload encrypted blob with progress
    setUploadProgress(0);
    let url: string;
    try {
      ({ url } = await uploadToIPFS(encryptedFile, setUploadProgress));
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
    await group.sendText(encoded);
  }, []);

  return {
    messages,
    sendMessage,
    sendFile,
    isLoading,
    isInitialized,
    isClosed,
    error,
    uploadProgress,
  };
}
