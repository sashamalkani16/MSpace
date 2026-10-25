self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || '' };
  }

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'MSpace reminder',
      {
        body: data.body || '',
        tag: data.tag || 'mspace-reminder',
        icon: './icon-192.png',
        badge: './icon-192.png'
      }
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }

    await self.clients.openWindow('./');
  })());
});