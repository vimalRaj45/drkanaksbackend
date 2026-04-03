// sw.js - Advanced Push Handling
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Clinic Update';
  
  const options = {
    body: data.body || 'Your appointment has been updated.',
    icon: data.icon || 'https://drkanaks.com/icon-192.png', 
    badge: data.badge || 'https://drkanaks.com/badge.png',
    image: data.image || 'https://drkanaks.com/follicle.jpg',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || 'https://drkanaks.com/profile',
      ...data.data
    },
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  
  let targetUrl = event.notification.data.url;
  
  if (event.action === 'view-profile') {
    targetUrl = 'https://drkanaks.com/profile';
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
