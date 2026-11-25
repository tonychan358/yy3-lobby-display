// shortcut: REVIEW #17 intentionally not changed in fix1 — keep network-first shell caching with skipWaiting/clients.claim without versioned asset manifests.
var SHELL_CACHE = 'lobby-shell-v2';
var SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './logic.js',
  './app.js',
  './assets/logo.png',
  './assets/boy.png',
  './assets/campus.jpg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf('lobby-') === 0 && key !== SHELL_CACHE && key !== 'lobby-photos-v1') {
          return caches.delete(key);
        }
        return Promise.resolve();
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') {
    return;
  }
  var url = req.url || '';
  if (url.indexOf(self.location.origin) !== 0) {
    return;
  }
  // Cache-busted requests have a new URL every time and would grow the cache forever.
  if (url.indexOf('_=') !== -1) {
    return;
  }
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) {
          return cache.put(req, copy);
        }));
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true });
    })
  );
});
