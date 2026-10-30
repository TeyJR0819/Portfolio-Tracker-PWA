// Service worker: saves the app files so the dashboard opens offline.
//
// To release an update: change CACHE_VERSION below. Phones then fetch fresh files.
// Live data (Supabase and CoinGecko) is never cached here; the app handles that itself.

const CACHE_VERSION = 'v10';
const CACHE_NAME = `portfolio-shell-${CACHE_VERSION}`;

const APP_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/animations.css',
  './js/main.js',
  './js/config.js',
  './js/state.js',
  './js/logic/calculations.js',
  './js/logic/catalog.js',
  './js/logic/export-csv.js',
  './js/logic/format.js',
  './js/logic/ledger.js',
  './js/logic/quotes.js',
  './js/logic/reconcile.js',
  './js/logic/trade-import.js',
  './js/services/app-config.js',
  './js/services/auth.js',
  './js/services/database.js',
  './js/services/prices.js',
  './js/services/service-worker-registration.js',
  './js/services/storage.js',
  './js/ui/animations.js',
  './js/ui/charts.js',
  './js/ui/currency-toggle.js',
  './js/ui/columns.js',
  './js/ui/dom.js',
  './js/ui/entry-drawer.js',
  './js/ui/lock-screen.js',
  './js/ui/metrics.js',
  './js/ui/overlay.js',
  './js/ui/setup-wizard.js',
  './js/ui/signin-screen.js',
  './js/ui/broker-check.js',
  './js/ui/trade-import.js',
  './js/ui/status.js',
  './js/ui/table.js',
  './js/ui/tabs.js',
  './js/ui/toast.js',
  './js/ui/views/index.js',
  './js/ui/views/summary-view.js',
  './js/ui/views/cash-view.js',
  './js/ui/views/stocks-view.js',
  './js/ui/views/transactions-view.js',
  './js/ui/views/mmf-view.js',
  './js/ui/views/crypto-view.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

const LIBRARY_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so an online visit always gets the newest files.
// The saved copy is used only when the network fails.
async function fetchWithFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const saved = await caches.match(request, { ignoreSearch: true });
    if (saved) return saved;
    if (request.mode === 'navigate') return caches.match('./index.html');
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isOwnFile = url.origin === self.location.origin;
  const isApiCall = url.pathname.includes('/api/'); // Live data is never served from the saved copy.
  const isLibrary = url.hostname === LIBRARY_HOST;

  if (!isApiCall && (isOwnFile || isLibrary)) {
    event.respondWith(fetchWithFallback(request));
  }
});
