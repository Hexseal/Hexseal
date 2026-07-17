'use client';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0))) as Uint8Array<ArrayBuffer>;
}

export async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && !!VAPID_PUBLIC_KEY;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = await getSwRegistration();
  return reg?.pushManager.getSubscription() ?? null;
}

export async function enablePush(
  address: string,
  signMessage?: (msg: string) => Promise<string>
): Promise<'ok' | 'denied' | 'error'> {
  if (!isPushSupported() || !address) return 'error';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await getSwRegistration();
  if (!reg) return 'error';

  try {
    // Reuse an existing subscription — don't force-rotate it on every call.
    // Rotation only happens when the user explicitly disables then re-enables push,
    // or when the browser invalidates the subscription (VAPID key change, etc.).
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    if (!signMessage) return 'ok';

    const msg = `hexseal:push-subscribe:${address.toLowerCase()}:${subscription.endpoint}`;
    const sig = await signMessage(msg);

    const res = await fetch(`${RELAYER_URL}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.toLowerCase(), subscription, sig }),
    });

    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

// Sends a push notification via the relayer, routed through the Next.js API so
// the relayer secret never reaches the browser. `from` is never accepted here —
// the server drops any client-supplied sender to prevent notification impersonation.
export function notifyPush(to: string, body: string, url?: string, tag?: string): void {
  fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body, url, tag }),
  }).catch(() => {});
}

export async function disablePush(address: string): Promise<void> {
  const reg = await getSwRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();
  await fetch(`${RELAYER_URL}/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase(), endpoint: sub.endpoint }),
  }).catch(() => {});
}
