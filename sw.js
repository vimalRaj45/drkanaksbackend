// sw.js - Advanced Push Handling
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Clinic Update';
  
  const options = {
    body: data.body || 'Your appointment has been updated.',
    icon: data.icon || 'https://drkanaks.com/icon-192.png', 
    badge: data.badge || 'https://drkanaks.com/badge.png',
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
  } else if (event.action === 'book-new') {
    targetUrl = 'https://drkanaks.com/book';
  }

  // Ensure absolute URL
  const urlToOpen = new URL(targetUrl, self.location.origin).href;

  const promiseChain = clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  }).then((windowClients) => {
    let matchingClient = null;

    // Professional window matching: match any client from the same origin
    const targetOrigin = new URL(urlToOpen).origin;
    for (let i = 0; i < windowClients.length; i++) {
        const windowClient = windowClients[i];
        const clientOrigin = new URL(windowClient.url).origin;
        if (clientOrigin === targetOrigin) {
            matchingClient = windowClient;
            break;
        }
    }

    if (matchingClient) {
        // Navigate the existing tab to the correct sub-route and focus it
        return matchingClient.navigate(urlToOpen).then(client => client.focus());
    } else {
        // If no tab is open, open a new window
        return clients.openWindow(urlToOpen);
    }
  });

  event.waitUntil(promiseChain);
});
