/* Service worker de Gestion des fonds : rend l'application installable et charge l'interface
   même sur un réseau faible. Les données (API) ne sont jamais mises en cache : elles viennent
   toujours du serveur, donc de MongoDB Atlas. */
const VERSION = 'gf-v13';
const INTERFACE = [
  '/', '/index.html', '/css/app.css', '/js/core.js', '/js/docs.js', '/js/pages.js', '/js/stock.js',
  '/manifest.webmanifest', '/favicon.svg', '/icones/icon-192.png', '/icones/icon-512.png', '/icones/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(INTERFACE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    // Données : toujours en direct ; hors connexion, réponse explicite.
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ erreur: 'Hors connexion : vérifiez votre accès à Internet.' }), {
      status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })));
    return;
  }
  // Interface : réseau d'abord (mises à jour immédiates), cache en secours.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copie = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copie)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html'))));
});
