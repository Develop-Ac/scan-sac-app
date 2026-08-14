// Service worker do Scan SAC (app de scan do atendimento ao cliente).
// Suba CACHE_VERSION a cada mudanca de assets para forcar atualizacao nos tablets.
const CACHE_VERSION = 'scan-sac-v35';

const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './styles.css',
  './app.js',
  './scan.js',
  './db.js',
  './manifest.webmanifest',
  './fonts/fonts.css',
  './fonts/inter.woff2',
  './fonts/montserrat.woff2',
  './brand/ac-icone.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './apple-touch-icon.png',
  './apple-touch-icon-precomposed.png',
  './vendor/opencv.js',
  './vendor/jscanify.min.js',
  './vendor/jspdf.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // So intercepta assets da propria origem. Backend/MinIO (cross-origin) passam direto.
  if (url.origin !== self.location.origin) return;

  // config.js: network-first (refletir o ambiente atual; cai no cache offline).
  if (url.pathname.endsWith('/config.js')) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return resp;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Demais assets: cache-first (funciona offline).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return resp;
        })
        .catch(() => cached);
    }),
  );
});
