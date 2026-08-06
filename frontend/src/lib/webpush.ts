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

/** Минимум от `PushSubscription`, который нужен для сверки ключа. Отдельный тип
 *  — чтобы правило можно было проверить тестами без браузера. */
export interface KeyedSubscription {
  options?: { applicationServerKey?: ArrayBuffer | ArrayBufferView | null } | null;
}

/**
 * Создана ли подписка ИМЕННО этим ключом VAPID.
 *
 * Подписка криптографически привязана к ключу, которым создана, и браузер НЕ
 * выбрасывает её при ротации серверного ключа: `getSubscription()` продолжает
 * бодро отдавать мёртвую подписку, а каждая отправка отваливается с
 * 403 VapidPkHashMismatch. Снаружи это выглядит как «уведомления включены».
 *
 * Пустой ключ (переменная окружения не задана) — это не «совпадает со всем», а
 * «сверять не с чем»: false.
 */
export function subscriptionMatchesVapidKey(
  sub: KeyedSubscription | null | undefined,
  base64Key: string,
): boolean {
  if (!sub || !base64Key) return false;
  const existing = sub.options?.applicationServerKey;
  if (!existing) return false;
  let key: Uint8Array;
  try { key = urlBase64ToUint8Array(base64Key); }
  catch { return false; }
  const a = existing instanceof ArrayBuffer
    ? new Uint8Array(existing)
    : new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
  if (a.length !== key.length) return false;
  return a.every((byte, i) => byte === key[i]);
}

/** Живая подписка, которой ещё можно доставить: она есть И создана текущим
 *  ключом VAPID. Ровно это `enablePush` проверяет у себя перед переподпиской —
 *  а тот, кто ТОЛЬКО СПРАШИВАЕТ состояние, обязан спрашивать о том же самом,
 *  иначе интерфейс показывает включённым то, что заведомо не доставляется. */
export function isPushSubscriptionUsable(sub: KeyedSubscription | null | undefined): boolean {
  return subscriptionMatchesVapidKey(sub, VAPID_PUBLIC_KEY);
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
    if (subscription && !subscriptionMatchesVapidKey(subscription, VAPID_PUBLIC_KEY)) {
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
/**
 * Сказать всем зарегистрированным арбитрам, что открыт спор.
 *
 * ⚠️ ЭТО ЗАМЕНА, А НЕ НОВОЕ. До 6 августа 2026 то же самое делал
 * `notifyArbiters` через личку XMTP — с той же оговоркой «лучшим усилием» и
 * тем же охватом «кто подключил канал, тот и узнает». Канал сменился, охват и
 * обещание — нет.
 *
 * Сервер этого не делает и делать не может дёшево: `Agreement.arbiter` в
 * момент открытия спора ещё `address(0)` (разбор — `relayer/app.js`, ветка
 * `both+arbiter`), а «оповестить всех зарегистрированных» — решение продукта,
 * а не просмотр поля. Поэтому зовёт тот, кто спор и открыл.
 *
 * Потолок нужен: `getArbiters()` растёт без ограничения сверху, и цикл без
 * потолка означал бы, что одно нажатие человека рассылает столько запросов,
 * сколько арбитров успело зарегистрироваться.
 */
const ARBITER_FANOUT_CAP = 50;

export function notifyArbitersOfDispute(arbiters: readonly string[], dealAddress: string): void {
  for (const arbiter of arbiters.slice(0, ARBITER_FANOUT_CAP)) {
    notifyPush(
      arbiter,
      'A dispute was opened',
      `/arbiter?deal=${dealAddress.toLowerCase()}`,
      `dispute-${dealAddress.toLowerCase()}`,
    );
  }
}

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
): Promise<'ok' | 'error'> {
  // Отметка «человек сказал нет» ставится ПОСЛЕ того, как отписка на устройстве
  // реально произошла, а не до неё.
  //
  // Раньше она стояла первой строкой и безусловно. Замысел был правильный —
  // `Notification.permission` скриптом не отзывается, и этот флаг единственный
  // durable-след явного отказа, он же держит интерфейс от того, чтобы рисовать
  // выключённые пуши как «протухшие, включи заново». Но цена оказалась
  // несоразмерной: `sub.unsubscribe()` ниже умеет упасть, и тогда подписка
  // остаётся живой, пуши продолжают приходить — а флаг уже записан, меню
  // кошелька убирает пункт «Отключить», и выключение выглядит состоявшимся.
  // Отключение, которое не отключило, но выглядит отключённым, — это ровно
  // тот класс, ради которого вся эта правка.
  //
  // Отсутствие подписки отметку по-прежнему ставит: отключать нечего, отказ
  // всё равно durable.
  const markOptOut = () => {
    try { localStorage.setItem(PUSH_DISABLED_KEY(address), '1'); } catch { /* unavailable */ }
  };

  const reg = await getSwRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) { markOptOut(); return 'ok'; }
  try {
    await sub.unsubscribe();
  } catch {
    // Подписка жива, доставка продолжается — врать «выключено» нельзя.
    return 'error';
  }
  markOptOut();

  // The relayer requires proof this address's own wallet actually requested
  // the unsubscribe — without it, anyone who knows a wallet address could
  // silently delete another user's push subscription with zero verification.
  // If signing isn't available or the user doesn't complete it, the LOCAL
  // unsubscribe above still took effect (no more pushes will arrive on this
  // device) — the relayer's own dead-subscription cleanup (a 404/410 on the
  // next send attempt) will drop the stale server-side record regardless.
  // Поэтому дальше исход уже 'ok' в любом случае: доставка на это устройство
  // прекращена, а это и есть то, что обещает кнопка.
  if (!signMessage) return 'ok';
  let sig: string;
  try {
    sig = await signMessage(`hexseal:push-unsubscribe:${address.toLowerCase()}:${sub.endpoint}`);
  } catch {
    return 'ok';
  }

  await fetch(`${RELAYER_URL}/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase(), endpoint: sub.endpoint, sig }),
  }).catch(() => {});
  return 'ok';
}
