'use client';

import { useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { usePathname } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { getXmtpClientIfCached, xmtpCrumb } from '@/lib/xmtp';
import { useXmtp } from '@/contexts/XmtpContext';
import { pushNotif } from '@/lib/notifications';

const flagKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// Suppresses message notifications when user is already viewing chat
function isChatPage(pathname: string): boolean {
  return pathname.startsWith('/chat') || pathname.startsWith('/deal/');
}

export function useXmtpNotifications() {
  const { address } = useAccount();
  const { status } = useXmtp();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const streamRef = useRef<{ return: () => void } | null>(null);
  const cancelledRef = useRef(false);

  // Keep pathname ref up to date without restarting the stream
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!address) return;

    // Only stream if user has explicitly enabled XMTP on this device
    if (localStorage.getItem(flagKey(address)) !== '1') return;

    cancelledRef.current = false;

    async function startStream() {
      try {
        // Only use an already-initialized client — never trigger wallet signatures automatically.
        // If the client isn't cached yet, the user must explicitly click Enable Messaging.
        const client = getXmtpClientIfCached(address!);
        if (!client) return;
        if (cancelledRef.current) return;

        xmtpCrumb('notif:sync-start');
        await client.conversations.sync();
        if (cancelledRef.current) return;

        xmtpCrumb('notif:streamAll-start');
        const stream = await client.conversations.streamAllMessages();
        if (cancelledRef.current) { stream.return(); return; }
        streamRef.current = stream;

        // Build a map: conversationId → group name (for deal groups)
        xmtpCrumb('notif:listGroups-start');
        const groups = await client.conversations.listGroups();
        xmtpCrumb('notif:ready');
        const groupNameById = new Map<string, string>();
        for (const g of groups) groupNameById.set(g.id, g.name ?? '');

        for await (const msg of stream) {
          if (cancelledRef.current) break;

          // Any inbound activity anywhere → refresh the conversation list live
          // (bumps last-message preview + ordering) even for chats that aren't
          // currently open. Without this the sidebar only updated on the 30s poll,
          // on window focus, or on a manual swipe-to-refresh. Fires before the
          // skips below because those are about NOTIFICATIONS, not the list.
          window.dispatchEvent(new Event('hexseal-conv-update'));

          // Skip own messages
          if (msg.senderInboxId === client.inboxId) continue;

          // Skip when user is already viewing chat/deal pages
          if (isChatPage(pathnameRef.current)) continue;

          const content = typeof msg.content === 'string' ? msg.content : null;
          if (!content) continue;

          // Skip silent deal-context markers — not a real message, never notify on these
          if (content.startsWith('{')) {
            try {
              const probe = JSON.parse(content) as { _type?: string };
              if (probe._type === 'deal_ctx') continue;
            } catch { /* not JSON — falls through to normal text handling below */ }
          }

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

          // Determine link: pair group → /chat?peer={the other member's address}
          const groupName = groupNameById.get(msg.conversationId ?? '');
          let link = '/chat';
          if (groupName?.startsWith('HSEAL-PAIR-')) {
            // Group name format: HSEAL-PAIR-{addrA}-{addrB} (sorted, lowercase,
            // neither address contains '-' so this split is unambiguous)
            const rest = groupName.slice('HSEAL-PAIR-'.length);
            const [a, b] = rest.split('-');
            if (a && b) {
              const myLc = address!.toLowerCase();
              const peer = a === myLc ? b : a;
              link = `/chat?peer=${peer}`;
            }
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
  // status dep: re-run when XmtpContext transitions to 'ready' so the stream
  // starts even if XMTP init completed after this hook's first render.
  }, [address, status]);
}
