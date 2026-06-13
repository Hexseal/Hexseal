'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useWalletClient, useReadContract, useAccount } from 'wagmi';
import { useXmtpStatus } from './useXmtpStatus';
import { AGREEMENT_ABI } from '@/config/contracts';
import type { Abi } from 'viem';
import {
  initXmtpClient,
  findOrCreateDealGroup,
  loadGroupMessages,
  normalizeGroupMessage,
  buildInboxAddressMap,
  encodeFileMessage,
  getBotAddress,
  type ChatMessage,
  type XmtpClient,
  type XmtpGroup,
} from '@/lib/xmtp';
import { uploadFileWithEncryption } from '@/lib/fileStorage';

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';

function pushChatNotif(to: string, body: string, url: string) {
  fetch(`${RELAYER_URL}/push/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, title: 'New Message 💬', body, url }),
  }).catch(() => {});
}

export function useDealGroupChat(agreementAddr: string) {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const { isEnabled } = useXmtpStatus();
  const [messages, setMessages]             = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading]           = useState(true);
  const [isInitialized, setIsInitialized]   = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [hasMore, setHasMore]               = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [streamDead, setStreamDead]         = useState(false);
  const [needsSetup, setNeedsSetup]         = useState(false);
  const clientRef   = useRef<XmtpClient | null>(null);
  const groupRef    = useRef<XmtpGroup  | null>(null);
  const oldestNsRef = useRef<bigint | null>(null);

  // Read client_ and executor_ from agreement on-chain
  const { data: details } = useReadContract({
    address: agreementAddr as `0x${string}`,
    abi: AGREEMENT_ABI as Abi,
    functionName: 'getDetails',
    query: { enabled: !!agreementAddr },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = details as any;
  const clientAddr   = (d?.client_   ?? d?.[0])?.toLowerCase() as string | undefined;
  const executorAddr = (d?.executor_ ?? d?.[1])?.toLowerCase() as string | undefined;

  useEffect(() => {
    if (!walletClient || !agreementAddr || !isEnabled) {
      if (!isEnabled) { setIsLoading(false); setNeedsSetup(true); }
      return;
    }
    if (!clientAddr || !executorAddr) return;

    let cancelled = false;
    setStreamDead(false);

    (async () => {
      try {
        const xmtp = await initXmtpClient(walletClient);
        if (cancelled) return;
        clientRef.current = xmtp;

        const botAddr = await getBotAddress();
        const members = [clientAddr, executorAddr];
        if (botAddr) members.push(botAddr);

        const group = await findOrCreateDealGroup(xmtp, agreementAddr, members);
        if (cancelled) return;
        groupRef.current = group;

        const loaded = await loadGroupMessages(group, xmtp.inboxId ?? '', address ?? '');
        if (cancelled) return;
        setMessages(loaded.messages);
        setHasMore(loaded.hasMore);
        oldestNsRef.current = loaded.oldestNs;
        setIsInitialized(true);
        setIsLoading(false);

        const stream = await group.stream();
        const inboxToAddr = buildInboxAddressMap(await group.members());
        for await (const msg of stream) {
          if (cancelled) break;
          const norm = normalizeGroupMessage(msg, xmtp.inboxId ?? '', address ?? '', inboxToAddr);
          if (!norm) continue;
          setMessages(prev => {
            if (prev.some(m => m.id === norm.id)) return prev;
            return [...prev, norm];
          });
        }
        if (!cancelled) setStreamDead(true);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Chat error';
          setError(msg);
          setIsLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [walletClient, agreementAddr, isEnabled, clientAddr, executorAddr, address]);

  const loadMore = useCallback(async () => {
    const group  = groupRef.current;
    const client = clientRef.current;
    if (!group || !client || !oldestNsRef.current) return;
    const loaded = await loadGroupMessages(group, client.inboxId ?? '', address ?? '', oldestNsRef.current);
    oldestNsRef.current = loaded.oldestNs;
    setHasMore(loaded.hasMore);
    setMessages(prev => [...loaded.messages, ...prev]);
  }, [address]);

  const sendMessage = useCallback(async (text: string) => {
    const group = groupRef.current;
    if (!group || !text.trim()) return;
    await group.sendText(text.trim());
    if (clientAddr && clientAddr !== address?.toLowerCase()) {
      pushChatNotif(clientAddr, text.trim(), `/deal/${agreementAddr}`);
    }
    if (executorAddr && executorAddr !== address?.toLowerCase()) {
      pushChatNotif(executorAddr, text.trim(), `/deal/${agreementAddr}`);
    }
  }, [agreementAddr, address, clientAddr, executorAddr]);

  const sendFile = useCallback(async (
    file: File,
    onProgress?: (pct: number) => void,
  ) => {
    const group = groupRef.current;
    if (!group) return;
    setUploadProgress(0);
    const result = await uploadFileWithEncryption(file, file.name, (pct) => {
      setUploadProgress(pct);
      onProgress?.(pct);
    });
    setUploadProgress(null);
    const msg = encodeFileMessage(
      file.name, result.url, file.size, file.type,
      result.keyHex, result.ivHex,
      result.chunked ? { chunked: true, chunkCount: result.chunkCount ?? 0, chunkSize: result.chunkSize ?? 0 } : undefined,
      result.storjKey,
    );
    await group.sendText(msg);
  }, []);

  const reconnect = useCallback(() => {
    setStreamDead(false);
    setIsInitialized(false);
    setIsLoading(true);
    setMessages([]);
  }, []);

  return {
    messages, sendMessage, sendFile, loadMore,
    hasMore, isLoading, isInitialized,
    error, uploadProgress, streamDead, reconnect, needsSetup,
  };
}
