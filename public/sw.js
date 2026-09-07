// Alarm App service worker — shows Web Push notifications when the page is
// closed or in the background, and opens/focuses the right room when tapped.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    // fall through with empty data
  }
  const title = data.title || '🚨 ALARM';
  const options = {
    body: data.body || 'An alarm is ringing in your room.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    // /api/ring sends one push per burst slot, each with a UNIQUE tag
    // (data.tag), so repeated notifications stack instead of the newest
    // replacing the previous one. Fall back to a shared per-room tag when
    // the payload carries none (e.g. older relays).
    tag: data.tag || `alarm-${data.roomId || 'room'}`,
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  const href = target.href;
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Prefer an existing window already on the exact room URL — just focus it.
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && client.url === href) {
          return client.focus();
        }
      }
      // Otherwise navigate the first window of this origin to the room.
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(href);
          return client.focus();
        }
      }
      // No window open at all: open the room (this wakes the installed PWA).
      return self.clients.openWindow(href);
    })(),
  );
});
