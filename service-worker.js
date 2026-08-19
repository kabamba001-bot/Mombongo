/* Service Worker Mombongo
   — Fonctionnement hors-ligne basique (mise en cache)
   — Réception des notifications push (Firebase Cloud Messaging), même app fermée

   ⚠️ Si tu avais déjà un service-worker.js avec une logique différente (une
   liste de fichiers différente, une autre stratégie de cache...), dis-le moi
   et je fusionnerai — sinon ce fichier remplace le tien sans rien perdre
   d'important : il garde le principe (marche hors-ligne) et ajoute juste les
   notifications.

   👉 À chaque déploiement qui touche du JS/CSS/HTML (comme aujourd'hui),
   incrémente CACHE_NAME (v2 -> v3 -> v4...). C'est ce qui force le nettoyage
   de l'ancien cache chez les utilisateurs déjà installés — sans ça, "fetch"
   ci-dessous continue de servir une version un peu en retard le temps qu'elle
   se rafraîchisse toute seule en arrière-plan.
*/

const CACHE_NAME = 'mombongo-cache-v21';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './style.css',
  './webview-guard.js',
  './config.js',
  './plans.js',
  './translations.js',
  './helpers.js',
  './account-cloud.js',
  './stores-devices.js',
  './sales-sync.js',
  './products-sync.js',
  './debts-sync.js',
  './expenses-sync.js',
  './suppliers-sync.js',
  './purchases-sync.js',
  './activity-log-sync.js',
  './data-catalog.js',
  './community-catalog.js',
  './products.js',
  './barcode.js',
  './discover.js',
  './sales.js',
  './receipt.js',
  './render.js',
  './plan-onboarding.js',
  './navigation.js',
  './export.js',
  './debts-expenses-alerts.js',
  './suppliers.js'
];
// ⚠️ Les bibliothèques externes (Firebase, jsPDF, XLSX, html5-qrcode — chargées
// depuis gstatic.com/cdnjs.cloudflare.com/jsdelivr.net dans index.html) NE SONT
// PAS précachées ici : le navigateur ne permet pas à un service worker de mettre
// en cache des ressources cross-origin lors de l'installation sans configuration
// CORS supplémentaire côté CDN. C'est sans gravité pour le fonctionnement hors
// ligne de base : chaque fonctionnalité qui en dépend (connexion Google, export
// PDF/Excel, scan code-barres, notifications) vérifie déjà si la bibliothèque
// s'est bien chargée avant de s'en servir, et se dégrade proprement (message
// clair) si elle est indisponible faute de réseau — voir par exemple
// isBarcodeLibraryReady() dans barcode.js. Le suivi du stock, des ventes, des
// dettes, des dépenses et des fournisseurs, lui, reste 100% utilisable hors
// ligne grâce à la liste ci-dessus.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------- Notifications push (Firebase Cloud Messaging) ---------- */
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAwVvxkSekMU0mXpR1A5lGcplJNwXcU9F4",
  authDomain: "mombongo-15323.firebaseapp.com",
  projectId: "mombongo-15323",
  storageBucket: "mombongo-15323.firebasestorage.app",
  messagingSenderId: "212073636592",
  appId: "1:212073636592:web:a15328ff9389c6b8ebd835"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || 'Mombongo';
  const body = data.body || '';
  self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data,
    tag: data.tag || 'mombongo-alert'
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
