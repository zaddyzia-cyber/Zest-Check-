self.addEventListener('install', event => {
  event.waitUntil(caches.open('smart-film-cache-v1').then(cache => cache.addAll(['./','./index.html','./app.js','./manifest.webmanifest'])));
});
self.addEventListener('fetch', event => {
  event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
});