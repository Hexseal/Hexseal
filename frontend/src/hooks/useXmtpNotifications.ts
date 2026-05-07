'use client';

import { useEffect, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { usePathname } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { initXmtpClient } from '@/lib/xmtp';
import { pushNotif } from '@/lib/notifications';

const flagKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// Suppresses message notifications when user is already viewing chat
function isChatPage(pathname: string): boolean {
  return pathname.startsWith('/chat') || pathname.startsWith('/deal/');
}

export function useXmtpNotifications() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const streamRef = useRef<{ return: () => void } | null>(null);
  const cancelledRef = useRef(false);

  // Keep the latest walletClient in a ref — avoids restarting the stream
  // every time wagmi returns a new object reference for the same wallet.
  const walletClientRef = useRef(walletClient);
  useEffect(() => { walletClientRef.current = walletClient; });

  // Keep pathname ref up to date without restarting the stream
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Restart only when the wallet ADDRESS changes, not the walletClient reference.
  useEffect(() => {
    if (!address) return;

    const wc = walletClientRef.current;
    if (!wc) return;

    // Only stream if user has explicitly enabled XMTP on this device
    if (localStorage.getItem(flagKey(address)) !== '1') return;

    cancelledRef.current = false;

    async function startStream() {
      try {
        const client = await initXmtpClient(walletClientRef.current!);
        if (cancelledRef.current) return;

        await client.conversations.sync();
        if (cancelledRef.current) return;

        const stream = await client.conversations.streamAllMessages();
        if (cancelledRef.current) { stream.return(); return; }
        streamRef.current = stream;

        for await (const msg of stream) {
          if (cancelledRef.current) break;

          // Skip own messages
          if (msg.senderInboxId === client.inboxId) continue;

          // Skip when user is already viewing chat/deal pages
          if (isChatPage(pathnameRef.current)) continue;

          // Only notify for plain text messages
          const content = typeof msg.content === 'string' ? msg.content : null;
          if (!content && typeof msg.content !== 'string') continue;

          const body = content
            ? content.slice(0, 80) + (content.length > 80 ? '…' : '')
            : 'You have a new message';

          const saved = pushNotif(address!, {
            type: 'message_new',
            title: 'New Message 💬',
            body,
            link: '/chat',
          });

          if (saved) {
            toast(`💬  New Message\n${body}`, {
              duration: 5000,
              style: {
                background: '#050505',
                color: '#f0f0f0',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                fontSize: '13px',
                maxWidth: '320px',
                whiteSpace: 'pre-line',
              },
            });
          }
        }
      } catch {
        // Silent fail — XMTP not available, user not registered, or network error
      }
    }

    startStream();

    return () => {
      cancelledRef.current = true;
      streamRef.current?.return();
      streamRef.current = null;
    };
  }, [address]); // only address — walletClient is read via ref
}
