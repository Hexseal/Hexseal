// Hexseal Service Worker

// ─── Куда уведомлению разрешено вести ─────────────────────────────────────
//
// К-2. Раньше происхождение проверялось У УЖЕ ОТКРЫТОГО ОКНА
// (`client.url.startsWith(self.location.origin)`), а потом это окно уводили
// по ссылке ИЗ УВЕДОМЛЕНИЯ — её саму не проверял никто. Ветка «вкладок нет»
// не проверяла вообще ничего: `clients.openWindow(data.url)`.
//
// Замерено на этом самом файле: `{url: "https://evil.example/drain"}` давал
// `openWindow("https://evil.example/drain")` без вкладок и
// `client.navigate("https://evil.example/drain")` с открытой вкладкой. То
// есть чужой человек присылал настоящее уведомление от Hexseal и уводил
// открытую вкладку на свой сайт.
//
// Источник проверяется У ЦЕЛИ, и это последний рубеж: сервер ссылку из
// запроса больше не берёт вовсе (relayer/app.js, PUSH_KINDS), но служебный
// работник живёт на устройстве месяцами и переживает выкатки — он обязан
// защищаться сам, а не верить, что тот, кто прислал полезную нагрузку,
// добросовестен.
//
// `new URL(value, origin)` разбирает так же, как разберёт браузер, — поэтому
// сюда не проходят ни `//evil.example` (схема наследуется, происхождение
// чужое), ни `https://hexseal.com.evil.example` (чужой домен, начинающийся
// с нашего имени: строковый `startsWith` его бы пропустил), ни
// `javascript:`/`data:` (у них происхождение `null`).
const FALLBACK_URL = '/';

function sameOriginPath(value) {
  if (typeof value !== 'string' || value === '') return FALLBACK_URL;
  let target;
  try {
    target = new URL(value, self.location.origin);
  } catch {
    return FALLBACK_URL;
  }
  if (target.origin !== self.location.origin) return FALLBACK_URL;
  // Возвращаем ПУТЬ, а не полный адрес: он же ложится в тег уведомления и
  // сравнивается с открытыми вкладками ниже.
  return target.pathname + target.search + target.hash;
}

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

  // Обезвреживаем СРАЗУ, а не только при нажатии: `data.url` дальше едет и в
  // тег, и в сравнение с открытыми вкладками, и в `data` самого уведомления,
  // которое переживёт эту функцию. Одно место, где ссылка становится нашей,
  // лучше трёх мест, где её проверяют по-разному. Заодно снимает падение на
  // `data.url.split` когда `url` пришёл не строкой.
  const url = sameOriginPath(data.url);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // Suppress if user is already looking at the exact page this notification links to
      const alreadyOpen = list.some(c => c.focused && c.url.includes(url.split('?')[0]));
      if (alreadyOpen) return;

      await self.registration.showNotification(data.title, {
        body:      data.body,
        icon:      '/icon-192.png',
        badge:     '/icon-192.png',
        tag:       data.tag || url,   // same sender/deal → replace previous
        renotify:  true,
        data:      { url },
      });

      await updateBadge();
    })
  );
});

// ─── Notification click ───────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Проверяем ЗАНОВО, а не полагаемся на проверку при показе: уведомление
  // могло быть показано выпуском служебного работника, который её не делал —
  // они живут на устройстве вперемешку и обновляются не одновременно.
  const url = sameOriginPath(event.notification.data?.url);

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
