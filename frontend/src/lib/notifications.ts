export type NotifType =
  | 'deal_new'
  | 'deal_active'
  | 'deal_done'
  | 'deal_completed'
  | 'deal_disputed'
  | 'deal_resolved'
  | 'deal_refunded'
  | 'job_applied'
  | 'job_accepted'
  | 'job_cancelled'
  | 'job_posted'
  | 'service_requested'
  | 'service_accepted'
  | 'service_rejected'
  | 'service_posted'
  | 'offer_minted'
  | 'dispute_claimed'
  | 'dispute_new'
  | 'dispute_arbiter_claimed'
  | 'message_new';

export interface AppNotification {
  id: string;
  type: NotifType;
  title: string;
  body: string;
  link?: string;
  timestamp: number;
  read: boolean;
  txHash?: string;
  // Stable idempotency key (e.g. an XMTP message id). When set, pushNotif skips
  // if a notification with the same dedupeKey already exists — so the same chat
  // message can never land in the centre twice (live stream vs. cold-start backfill).
  dedupeKey?: string;
}

const MAX = 100;
const key = (addr: string) => `hexseal_notifs_${addr.toLowerCase()}`;
const wmKey = (addr: string) => `hexseal_msgwm_${addr.toLowerCase()}`;

export function loadNotifs(address: string): AppNotification[] {
  try {
    return JSON.parse(localStorage.getItem(key(address)) || '[]');
  } catch {
    return [];
  }
}

function saveNotifs(address: string, notifs: AppNotification[]) {
  try {
    localStorage.setItem(key(address), JSON.stringify(notifs));
  } catch {}
}

export function pushNotif(
  address: string,
  notif: Omit<AppNotification, 'id' | 'timestamp' | 'read'>
): AppNotification | null {
  const notifs = loadNotifs(address);
  if (notif.txHash && notifs.some(n => n.txHash === notif.txHash && n.type === notif.type)) {
    return null;
  }
  if (notif.dedupeKey && notifs.some(n => n.dedupeKey === notif.dedupeKey)) {
    return null;
  }
  const newNotif: AppNotification = {
    ...notif,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    read: false,
  };
  const updated = [newNotif, ...notifs].slice(0, MAX);
  saveNotifs(address, updated);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('hexseal-notif-update'));
  }
  return newNotif;
}

export function markReadById(address: string, id: string): AppNotification[] {
  const updated = loadNotifs(address).map(n => (n.id === id ? { ...n, read: true } : n));
  saveNotifs(address, updated);
  return updated;
}

export function markAllAsRead(address: string): AppNotification[] {
  const updated = loadNotifs(address).map(n => ({ ...n, read: true }));
  saveNotifs(address, updated);
  return updated;
}

export function clearAllNotifs(address: string): AppNotification[] {
  saveNotifs(address, []);
  return [];
}

// ─── Chat-message backfill watermark ──────────────────────────────────────────
// Newest inbound-message timestamp (XMTP sentAtNs) we've already accounted for —
// notified live OR reconciled on startup. Both paths only advance it, so a given
// message is turned into an in-app notification at most once, ever, across reloads.

export function loadMsgWatermark(address: string): bigint | null {
  try {
    const v = localStorage.getItem(wmKey(address));
    return v ? BigInt(v) : null;
  } catch {
    return null;
  }
}

export function bumpMsgWatermark(address: string, ns: bigint): void {
  try {
    const cur = loadMsgWatermark(address);
    if (cur === null || ns > cur) localStorage.setItem(wmKey(address), ns.toString());
  } catch { /* localStorage unavailable */ }
}

export interface MsgMeta { id: string; sentAtNs: bigint }

// Pure selection: given the current watermark and the inbound messages found on a
// (re)start, decide which become notifications and what the new watermark is.
// - First run ever (watermark === null): set the baseline to the newest message and
//   notify NOTHING — never flood the centre with pre-existing history.
// - Otherwise: notify messages strictly newer than the watermark that aren't already
//   in the store (idempotent via dedupeKey), oldest-first; advance to the newest seen.
export function selectUnnotifiedMessages(
  watermark: bigint | null,
  candidates: MsgMeta[],
  inStore: (dedupeKey: string) => boolean,
): { toNotify: MsgMeta[]; watermark: bigint | null } {
  if (candidates.length === 0) return { toNotify: [], watermark };
  const maxTs = candidates.reduce(
    (m, c) => (c.sentAtNs > m ? c.sentAtNs : m),
    candidates[0].sentAtNs
  );
  if (watermark === null) return { toNotify: [], watermark: maxTs };
  const toNotify = candidates
    .filter((c) => c.sentAtNs > watermark && !inStore(c.id))
    .sort((a, b) => (a.sentAtNs < b.sentAtNs ? -1 : a.sentAtNs > b.sentAtNs ? 1 : 0));
  return { toNotify, watermark: maxTs > watermark ? maxTs : watermark };
}

export function fmtUSDC(amount: bigint | undefined | null): string {
  if (amount == null) return '0';
  return (Number(amount) / 1e6).toFixed(2);
}

export function notifIcon(type: NotifType): string {
  const icons: Record<NotifType, string> = {
    deal_new: '🤝',
    deal_active: '⚡',
    deal_done: '📋',
    deal_completed: '✅',
    deal_disputed: '⚠️',
    deal_resolved: '⚖️',
    deal_refunded: '↩️',
    job_applied: '📩',
    job_accepted: '🎉',
    job_cancelled: '❌',
    job_posted: '📋',
    service_requested: '📬',
    service_accepted: '✅',
    service_rejected: '🚫',
    service_posted: '🛎️',
    offer_minted: '🎨',
    dispute_claimed: '⚖️',
    dispute_new: '🆕',
    dispute_arbiter_claimed: '🤝',
    message_new: '💬',
  };
  return icons[type] ?? '🔔';
}
