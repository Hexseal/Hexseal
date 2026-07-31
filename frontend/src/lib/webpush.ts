'use client';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:3001';

// ─── Shared registration bookkeeping ────────────────────────────────────────────
//
// Единственный источник правды о том, когда эта подписка последний раз
// доехала до релеера, и о явном отказе от пушей. Пишется на КАЖДОМ успешном
// enablePush(), читается всеми.
//
// Раньше рядом с явным тумблером жила фоновая перерегистрация: раз в 24 часа
// приложение само звало enablePush(), а тот требует подписи кошелька
// (`hexseal:push-subscribe:...`). На мобильном это значило, что раз в сутки
// приложение САМО выбрасывает человека в кошелёк — без нажатия, без объяснения,
// посреди чего угодно. На Android/Chrome + MetaMask такой уход стоит залипшего
// 'personal_sign already pending', который снимается только полным закрытием
// приложения кошелька. Автоматика убрана; TTL ниже остался, но теперь он
// только ПОКАЗЫВАЕТ протухание (isPushRegistrationStale), а не действует сам.
const PUSH_REG_KEY      = (addr: string) => `hexseal-push-reg-${addr.toLowerCase()}`;
const PUSH_DISABLED_KEY = (addr: string) => `hexseal-push-disabled-${addr.toLowerCase()}`;
const PUSH_REG_TTL      = 24 * 60 * 60 * 1000; // 24h

/** Подписка числится включённой, но её регистрация на релеере старше TTL.
 *  Ничего не делает — это флаг ДЛЯ ИНТЕРФЕЙСА: он обязан показать, что пуши
 *  могли перестать доходить, и предложить включить заново нажатием. Молчать
 *  здесь нельзя: релеер перезапускается, и человек иначе просто перестанет
 *  получать уведомления, ничего об этом не узнав.
 *
 *  Явный отказ (disable) протухшим не считается — там нечему протухать. */
export function isPushRegistrationStale(address: string): boolean {
  try {
    if (localStorage.getItem(PUSH_DISABLED_KEY(address)) === '1') return false;
    const raw = localStorage.getItem(PUSH_REG_KEY(address));
    if (raw === null) return false; // ни разу не регистрировались — это не «протухло»
    return Date.now() - Number(raw) >= PUSH_REG_TTL;
  } catch {
    return false; // localStorage недоступен — не пугаем человека наугад
  }
}

/** True only if THIS address has a recorded successful registration and hasn't
 *  been explicitly opted out. A live device PushSubscription alone (checked by
 *  the caller separately) doesn't mean push works for a given address — it's
 *  device/service-worker-scoped, not account-scoped, so it stays truthy across
 *  a wallet-account switch on the same device even though the relayer has never
 *  seen the new address. Callers should treat "subscribed" as BOTH a live
 *  device subscription AND this returning true. */
export function isPushRegisteredForAddress(address: string): boolean {
  try {
    if (localStorage.getItem(PUSH_DISABLED_KEY(address)) === '1') return false;
    return localStorage.getItem(PUSH_REG_KEY(address)) !== null;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return new Uint8Array([...raw].map(c => c.charCodeAt(0))) as Uint8Array<ArrayBuffer>;
}

/** True if `sub` was created with exactly this applicationServerKey. Used to detect a
 *  rotated VAPID key, which permanently breaks delivery to the old subscription. */
function usesAppServerKey(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = sub.options?.applicationServerKey;
  if (!existing) return false;
  const a = new Uint8Array(existing as ArrayBuffer);
  if (a.length !== key.length) return false;
  return a.every((byte, i) => byte === key[i]);
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

  // Captured BEFORE any await below, so we can tell whether a disablePush() call
  // raced in and set the opt-out flag WHILE this call was waiting on the wallet
  // signature / relayer round trip (see the write at the end of this function).
  const wasDisabledBefore = (() => {
    try { return localStorage.getItem(PUSH_DISABLED_KEY(address)) === '1'; }
    catch { return false; }
  })();

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await getSwRegistration();
  if (!reg) return 'error';

  try {
    const appServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    let subscription = await reg.pushManager.getSubscription();

    // A PushSubscription is cryptographically bound to the VAPID key it was created
    // with. The browser does NOT invalidate it when the server key is rotated — the
    // old comment claimed otherwise, and that assumption was the bug: getSubscription()
    // kept handing back a stale subscription, we happily reused and re-registered it,
    // and every send failed with 403 VapidPkHashMismatch forever. So regenerating VAPID
    // keys appeared to change nothing. Detect the mismatch and re-subscribe.
    if (subscription && !usesAppServerKey(subscription, appServerKey)) {
      try { await subscription.unsubscribe(); } catch { /* best effort */ }
      subscription = null;
    }

    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
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

    if (res.ok) {
      try {
        // An explicit disable that happened DURING this call must win over this
        // slower, now-superseded enable — otherwise a disablePush() the user fired
        // while this was still waiting on a signature gets silently reversed the
        // moment this finally resolves. wasDisabledBefore=true means the disabled
        // flag predates this call (this IS the user's own explicit re-enable
        // action) and should still clear it normally.
        const disabledNow = localStorage.getItem(PUSH_DISABLED_KEY(address)) === '1';
        if (wasDisabledBefore || !disabledNow) {
          localStorage.setItem(PUSH_REG_KEY(address), String(Date.now()));
          localStorage.removeItem(PUSH_DISABLED_KEY(address));
        }
      } catch { /* localStorage unavailable */ }
    }
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

export async function disablePush(
  address: string,
  signMessage?: (msg: string) => Promise<string>,
): Promise<void> {
  // Record the opt-out FIRST and unconditionally — regardless of whether an
  // active subscription is actually found below. Notification.permission can't
  // be revoked by script, so this flag is the only durable record that the user
  // explicitly said no — и именно он держит интерфейс от того, чтобы рисовать
  // выключённые пуши как «протухшие, включи заново».
  try { localStorage.setItem(PUSH_DISABLED_KEY(address), '1'); } catch { /* unavailable */ }

  const reg = await getSwRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();

  // The relayer requires proof this address's own wallet actually requested
  // the unsubscribe — without it, anyone who knows a wallet address could
  // silently delete another user's push subscription with zero verification.
  // If signing isn't available or the user doesn't complete it, the LOCAL
  // unsubscribe above still took effect (no more pushes will arrive on this
  // device) — the relayer's own dead-subscription cleanup (a 404/410 on the
  // next send attempt) will drop the stale server-side record regardless.
  if (!signMessage) return;
  let sig: string;
  try {
    sig = await signMessage(`hexseal:push-unsubscribe:${address.toLowerCase()}:${sub.endpoint}`);
  } catch {
    return;
  }

  await fetch(`${RELAYER_URL}/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase(), endpoint: sub.endpoint, sig }),
  }).catch(() => {});
}
