'use client';

import { useEffect, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { usePathname } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { initXmtpClient, dealGroupName } from '@/lib/xmtp';
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

        // Build a map: conversationId → group name (for deal groups)
        const groups = await client.conversations.listGroups();
        const groupNameById = new Map<string, string>();
        for (const g of groups) groupNameById.set(g.id, g.name ?? '');

        for await (const msg of stream) {
          if (cancelledRef.current) break;

          // Skip own messages
          if (msg.senderInboxId === client.inboxId) continue;

          // Skip when user is already viewing chat/deal pages
          if (isChatPage(pathnameRef.current)) continue;

          const content = typeof msg.content === 'string' ? msg.content : null;
          if (!content) continue;

          // Parse file messages to show a friendly preview
          let body: string;
          if (content.startsWith('{')) {
            try {
              const p = JSON.parse(content) as { _type?: string; name?: string };
              body = (p._type === 'enc_file' || p._type === 'file') && p.name
                ? `📎 ${p.name}`
                : content.slice(0, 80);
            } catch {
              body = content.slice(0, 80);
            }
          } else {
            body = content.length > 80 ? content.slice(0, 80) + '…' : content;
          }

          // Determine link: deal group → /deal/{address}/chat, DM → /chat
          const groupName = groupNameById.get(msg.conversationId ?? '');
          let link = '/chat';
          if (groupName?.startsWith('HSEAL-')) {
            // Group name format: HSEAL-0x{agreementAddress}
            const agreementAddr = groupName.slice(5); // strip "HSEAL-"
            link = `/deal/${agreementAddr}/chat`;
          }

          const saved = pushNotif(address!, {
            type: 'message_new',
            title: 'New Message 💬',
            body,
            link,
          });

          if (saved) {
            // Native OS notification when tab is in background
            if (
              document.visibilityState !== 'visible' &&
              Notification.permission === 'granted' &&
              'serviceWorker' in navigator
            ) {
              navigator.serviceWorker.ready.then((reg) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                reg.showNotification('New Message 💬', {
                  body,
                  icon: '/icon-192.png',
                  badge: '/icon-192.png',
                  tag: link,
                  data: { url: link },
                } as any);
              }).catch(() => {});
            } else {
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
