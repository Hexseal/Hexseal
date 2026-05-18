// Signature404 Service Worker — handles background push notifications

self.addEventListener('push', (event) => {
  let data = { title: 'Signature404', body: 'New update', url: '/' };
  try { data = { ...data, ...event.data?.json() }; } catch {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Don't show notification if the app is already open and focused
      const appFocused = list.some(c => c.focused);
      if (appFocused) return;
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.url,
        renotify: true,
        data: { url: data.url },
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
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
