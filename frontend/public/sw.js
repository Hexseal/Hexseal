// Hexseal Service Worker — handles background push notifications

self.addEventListener('push', (event) => {
  let data = { title: 'Hexseal', body: '', url: '/' };
  try { data = { ...data, ...event.data?.json() }; } catch {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Don't show notification if the user is already looking at that exact page
      const alreadyOpen = list.some(c => c.focused && c.url.includes(data.url.split('?')[0]));
      if (alreadyOpen) return;
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        // tag groups notifications from the same sender/deal — new message replaces old
        tag: data.tag || data.url,
        renotify: true,
        data: { url: data.url },
      });
    })
  );

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
