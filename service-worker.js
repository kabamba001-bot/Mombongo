const CACHE_NAME = 'mombongo-v5';
const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Chaque fichier est mis en cache séparément : si un seul échoue
      // (ex: réseau coupé pile à ce moment), les autres restent quand même sauvegardés.
      return Promise.allSettled(
        FILES_TO_CACHE.map((url) => cache.add(url).catch(() => null))
      );
    })
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

  const isNavigation = event.request.mode === 'navigate' ||
    (event.request.headers.get('accept') || '').includes('text/html');

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => null);

      // 1. Si le fichier demandé est déjà en cache, on le sert tout de suite.
      // 2. Sinon on essaie le réseau.
      // 3. Si le réseau échoue ET que c'est une page (navigation), on retombe
      //    sur index.html en dernier recours, pour éviter l'écran bloqué.
      return cached || networkFetch.then((response) => {
        if (response) return response;
        if (isNavigation) {
          return caches.match('./index.html').then((fallback) => fallback || Response.error());
        }
        return Response.error();
      });
    })
  );
});
