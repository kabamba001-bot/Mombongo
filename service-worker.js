const CACHE_NAME = 'mombongo-v4';
const FILES_TO_CACHE = [
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
      // On met en cache chaque fichier séparément : si un seul échoue (ex: police
      // externe injoignable), les autres restent quand même sauvegardés.
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

// Stratégie "cache d'abord" : l'app s'ouvre TOUJOURS instantanément avec la
// dernière version enregistrée, même hors ligne ou avec un réseau très lent.
// En parallèle, on va chercher une version plus récente en arrière-plan pour
// la prochaine ouverture — sans jamais bloquer l'ouverture actuelle.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

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

      // Si on a une version en cache, on la sert tout de suite.
      // Sinon (premier chargement), on attend le réseau.
      return cached || networkFetch;
    })
  );
});
