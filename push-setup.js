// push-setup.js
const PUBLIC_VAPID_KEY = "BBa2SEf1E3XMUsI-p_Wd3IKJwLcVlgkBuGGhG6WS_y1_E";

/**
 * 1. Convert VAPID key to proper format for browsers
 */
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * 2. Main setup function to call on UI button click or login
 */
async function setupPushNotifications() {
    // Check for compatibility
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.error('Push notifications are not supported in this browser.');
        return;
    }

    try {
        // Request Permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.warn('Notification permission denied.');
            return;
        }

        // Register Service Worker
        // IMPORTANT: sw.js must be in your /public folder to work properly
        const registration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/'
        });

        // Wait for service worker to be ready
        await navigator.serviceWorker.ready;

        // Get or Create Subscription
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
            });
        }

        console.log('Push Subscription Object:', JSON.stringify(subscription));

        // Send to Backend
        const response = await fetch('https://drkanaksbackend.onrender.com/subscribe', {
            method: 'POST',
            body: JSON.stringify({ subscription }),
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();
        if (data.status === 'success') {
            console.log('✅ Successfully subscribed on backend!');
        } else {
            console.error('❌ Backend subscription failed:', data.message);
        }

    } catch (error) {
        console.error('❌ Push Setup Fatal Error:', error);
    }
}

// Optional: Auto-trigger setup (Not recommended, use a button click instead)
// window.addEventListener('load', setupPushNotifications);
