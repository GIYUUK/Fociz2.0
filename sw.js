const CACHE = 'fociz-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // ne jamais toucher aux appels à l'API : toujours en direct, jamais en cache
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(reponse => {
        const copie = reponse.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copie));
        return reponse;
      })
      .catch(() => caches.match(e.request))
  );
});
