// Alarm App service worker — shows Web Push notifications when the page is
// closed or in the background, and opens the right room when tapped.

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
  // Mark this open as coming from a notification tap so the room page can
  // record the check-in as "triggered by notification" (and then strip it).
  target.searchParams.set('via', 'notification');
  const href = target.href;
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(href);
          return client.focus();
        }
      }
      return self.clients.openWindow(href);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});