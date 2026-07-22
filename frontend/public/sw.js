// Hexseal Service Worker

// ─── App Badge helpers ────────────────────────────────────────────────────────

async function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  try {
    const all = await self.registration.getNotifications();
    if (all.length > 0) {
      await navigator.setAppBadge(all.length);
    } else {
      await navigator.clearAppBadge();
    }
  } catch {}
}

// ─── Push ─────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  // 'New message', not 'Hexseal': the OS shows the app name as the source already.
  let data = { title: 'New message', body: '', url: '/' };
  try { data = { ...data, ...event.data?.json() }; } catch {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // Suppress if user is already looking at the exact page this notification links to
      const alreadyOpen = list.some(c => c.focused && c.url.includes(data.url.split('?')[0]));
      if (alreadyOpen) return;

      await self.registration.showNotification(data.title, {
        body:      data.body,
        icon:      '/icon-192.png',
        badge:     '/icon-192.png',
        tag:       data.tag || data.url,   // same sender/deal → replace previous
        renotify:  true,
        data:      { url: data.url },
      });

      await updateBadge();
    })
  );
});

// ─── Notification click ───────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      await updateBadge();

      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
