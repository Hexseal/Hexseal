'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePathname } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { SortDirection } from '@xmtp/browser-sdk';
import { getXmtpClientIfCached, xmtpCrumb } from '@/lib/xmtp';
import { useXmtp } from '@/contexts/XmtpContext';
import {
  pushNotif,
  loadNotifs,
  loadMsgWatermark,
  bumpMsgWatermark,
  selectUnnotifiedMessages,
} from '@/lib/notifications';

const flagKey = (addr: string) => `xmtp-registered-${addr.toLowerCase()}`;

// Suppresses message notifications when user is already viewing chat
function isChatPage(pathname: string): boolean {
  return pathname.startsWith('/chat') || pathname.startsWith('/deal/');
}

// Friendly one-line preview for the notification body. File messages show the
// attachment name; text is truncated. Shared by the live stream and the backfill.
function messageBody(content: string): string {
  if (content.startsWith('{')) {
    try {
      const p = JSON.parse(content) as { _type?: string; name?: string };
      return (p._type === 'enc_file' || p._type === 'file') && p.name
        ? `📎 ${p.name}`
        : content.slice(0, 80);
    } catch {
      return content.slice(0, 80);
    }
  }
  return content.length > 80 ? content.slice(0, 80) + '…' : content;
}

// Deep link for a message: pair groups → /chat?peer={the other member}. Shared by
// the live stream and the backfill so both point at the exact same conversation.
function messageLink(
  conversationId: string | undefined,
  groupNameById: Map<string, string>,
  myAddrLc: string,
): string {
  const groupName = groupNameById.get(conversationId ?? '');
  if (groupName?.startsWith('HSEAL-PAIR-')) {
    // HSEAL-PAIR-{addrA}-{addrB} (sorted, lowercase, neither address contains '-').
    const rest = groupName.slice('HSEAL-PAIR-'.length);
    const [a, b] = rest.split('-');
    if (a && b) {
      const peer = a === myAddrLc ? b : a;
      return `/chat?peer=${peer}`;
    }
  }
  return '/chat';
}

export function useXmtpNotifications() {
  const { address } = useAccount();
  const { status } = useXmtp();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  // Message ids we've already raised a notification for — dedups across stream
  // restarts / redelivery so a single message never produces multiple notifications.
  const notifiedRef = useRef<Set<string>>(new Set());

  // Keep pathname ref up to date without restarting the stream
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // An installed PWA gets aggressively suspended when backgrounded (iOS especially),
  // which kills the streamAllMessages subscription. Nothing used to restart it, so
  // after the first background→foreground cycle notifications went silent for good —
  // no toast, no bell count, nothing written to the notification centre — until a full
  // reload. Bump a key on foreground so the stream is re-established, the same way
  // usePairConversations re-syncs on focus.
  const [restartKey, setRestartKey] = useState(0);
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === 'visible') setRestartKey(k => k + 1);
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
    };
  }, []);

  useEffect(() => {
    if (!address) return;

    // Only stream if user has explicitly enabled XMTP on this device
    if (localStorage.getItem(flagKey(address)) !== '1') return;

    // Per-run cancellation + stream handle — MUST be local, not shared refs. restartKey
    // re-runs this effect on every foreground; a shared cancel flag got reset to false
    // by the new run while an old for-await loop was still alive, so several streams ran
    // at once and each fired a notification (3 toasts for one message).
    let cancelled = false;
    let stream: { return: () => void } | null = null;

    (async () => {
      try {
        // Only use an already-initialized client — never trigger wallet signatures automatically.
        // If the client isn't cached yet, the user must explicitly click Enable Messaging.
        const client = getXmtpClientIfCached(address!);
        if (!client) return;
        if (cancelled) return;

        xmtpCrumb('notif:sync-start');
        await client.conversations.sync();
        if (cancelled) return;

        xmtpCrumb('notif:streamAll-start');
        const s = await client.conversations.streamAllMessages();
        if (cancelled) { s.return(); return; }
        stream = s;

        // Build a map: conversationId → group name (for deal groups)
        xmtpCrumb('notif:listGroups-start');
        const groups = await client.conversations.listGroups();
        xmtpCrumb('notif:ready');
        const groupNameById = new Map<string, string>();
        for (const g of groups) groupNameById.set(g.id, g.name ?? '');

        // ── Backfill: reconcile messages that arrived while this tab was dead ──
        // The live stream below only fires for messages received while the tab is
        // alive. A suspended / again-cold PWA gets those as service-worker push (OS
        // banner) but they never reach the in-app store, so the centre + badges go
        // stale. On every (re)start, pull recent inbound messages and top the store
        // up for anything newer than the watermark (idempotent via dedupeKey).
        try {
          const myAddrLc = address!.toLowerCase();
          const openPeer = isChatPage(pathnameRef.current)
            ? new URLSearchParams(window.location.search).get('peer')?.toLowerCase() ?? null
            : null;
          type Cand = { id: string; sentAtNs: bigint; content: string; convId: string };
          const cands: Cand[] = [];
          for (const g of groups) {
            if (cancelled) return;
            const raw = await g.messages({ limit: BigInt(30), direction: SortDirection.Descending });
            for (const m of raw) {
              if (m.senderInboxId === client.inboxId) continue;
              const c = typeof m.content === 'string' ? m.content : null;
              if (!c || !m.sentAtNs) continue;
              if (c.startsWith('{')) {
                try { if ((JSON.parse(c) as { _type?: string })._type === 'deal_ctx') continue; }
                catch { /* not JSON — treat as text */ }
              }
              cands.push({ id: m.id, sentAtNs: m.sentAtNs, content: c, convId: g.id });
            }
          }
          if (cancelled) return;
          const store = loadNotifs(address!);
          const seen = new Set(store.filter(n => n.dedupeKey).map(n => n.dedupeKey!));
          const { toNotify, watermark } = selectUnnotifiedMessages(
            loadMsgWatermark(address!),
            cands.map(c => ({ id: c.id, sentAtNs: c.sentAtNs })),
            (k) => seen.has(k),
          );
          const byId = new Map(cands.map(c => [c.id, c]));
          for (const meta of toNotify) {
            const src = byId.get(meta.id);
            if (!src) continue;
            const link = messageLink(src.convId, groupNameById, myAddrLc);
            // Don't badge the conversation the user is looking at right now.
            if (openPeer && link === `/chat?peer=${openPeer}`) continue;
            notifiedRef.current.add(meta.id);
            pushNotif(address!, {
              type: 'message_new',
              title: 'New Message',
              body: messageBody(src.content),
              link,
              dedupeKey: meta.id,
            });
          }
          if (watermark !== null) bumpMsgWatermark(address!, watermark);
        } catch { /* backfill is best-effort; the live stream still runs below */ }

        for await (const msg of s) {
          if (cancelled) break;

          // Any inbound activity anywhere → refresh the conversation list live
          // (bumps last-message preview + ordering) even for chats that aren't
          // currently open. Without this the sidebar only updated on the 30s poll,
          // on window focus, or on a manual swipe-to-refresh. Fires before the
          // skips below because those are about NOTIFICATIONS, not the list.
          window.dispatchEvent(new Event('hexseal-conv-update'));

          // Skip own messages
          if (msg.senderInboxId === client.inboxId) continue;

          const content = typeof msg.content === 'string' ? msg.content : null;
          if (!content) continue;

          // Skip silent deal-context markers — not a real message, never notify on these
          if (content.startsWith('{')) {
            try {
              const probe = JSON.parse(content) as { _type?: string };
              if (probe._type === 'deal_ctx') continue;
            } catch { /* not JSON — falls through to normal text handling below */ }
          }

          // Advance the backfill watermark for every real inbound message so the
          // cold-start reconciler never re-notifies one already handled live.
          if (msg.sentAtNs) bumpMsgWatermark(address!, msg.sentAtNs);

          // Notify each message at most once — dedups across stream restarts / redelivery.
          if (notifiedRef.current.has(msg.id)) continue;
          notifiedRef.current.add(msg.id);
          if (notifiedRef.current.size > 500) {
            notifiedRef.current = new Set([...notifiedRef.current].slice(-250));
          }

          const body = messageBody(content);
          const link = messageLink(msg.conversationId, groupNameById, address!.toLowerCase());

          // Suppress ONLY the conversation the user is actually looking at. The old
          // check skipped every /chat and /deal/ page wholesale, so a message from a
          // different peer while you had any chat open produced nothing at all — no
          // toast and no entry in the notification centre. Now it's per-conversation.
          const openPeer = isChatPage(pathnameRef.current)
            ? new URLSearchParams(window.location.search).get('peer')?.toLowerCase() ?? null
            : null;
          if (openPeer && link === `/chat?peer=${openPeer}`) continue;

          const saved = pushNotif(address!, {
            type: 'message_new',
            title: 'New Message',
            body,
            link,
            dedupeKey: msg.id,
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
                reg.showNotification('New Message', {
                  body,
                  icon: '/icon-192.png',
                  badge: '/icon-192.png',
                  tag: link,
                  data: { url: link },
                } as any);
              }).catch(() => {});
            } else {
              toast(`New Message\n${body}`, {
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
    })();

    return () => {
      cancelled = true;
      stream?.return();
    };
  // status dep: re-run when XmtpContext transitions to 'ready' so the stream
  // starts even if XMTP init completed after this hook's first render.
  // restartKey dep: re-establish the stream when the PWA returns to the foreground,
  // since a suspended app has its subscription torn down.
  }, [address, status, restartKey]);
}
