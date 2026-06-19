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
}

const MAX = 100;
const key = (addr: string) => `hexseal_notifs_${addr.toLowerCase()}`;

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
