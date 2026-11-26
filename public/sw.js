const offlineCache = 'vieira-link-offline-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(offlineCache).then(cache => cache.add('/offline.html')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
});
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('Vieira Link', {
    body: 'Nova mensagem de cliente. Toque para abrir a caixa de entrada.',
    icon: '/icons/vieira-192.png',
    tag: event.data?.text() || 'vieira-link-inbox',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL('/#conversations', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const panel = windows.find(client => new URL(client.url).pathname === '/');
    if (panel) {
      const opened = await panel.navigate(url);
      if (opened) return opened.focus();
    }
    return self.clients.openWindow(url);
  })());
});
