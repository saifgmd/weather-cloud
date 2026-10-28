/* =====================================================================
 * Weather Cloud — Service Worker
 * Author: SAIF G.M.D
 * Version: 1.1.0
 *
 * Strategy
 *  - Pages (navigation): network-first, falls back to the cached app shell
 *    so the app opens offline and updates arrive right away when online.
 *  - Same-origin assets: stale-while-revalidate — instant from cache,
 *    refreshed in the background for the next visit.
 *  - Cross-origin requests (weather API, images, audio, video) and range
 *    requests are left to the browser. The app keeps the last forecast in
 *    localStorage for offline use.
 *
 * Bump CACHE_VERSION on every release to drop old caches.
 * ===================================================================== */

const CACHE_VERSION = "1.1.0";
const CACHE_NAME = `weather-cloud-v${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png"
];

// Install — cache the app shell (fails loudly if a file is missing)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate — remove caches from older versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("weather-cloud-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party: browser default
  if (req.headers.has("range")) return;            // audio/video seeking

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, event));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put("./index.html", res.clone());
    return res;
  } catch (err) {
    return (
      (await cache.match(req, { ignoreSearch: true })) ||
      (await cache.match("./index.html")) ||
      Response.error()
    );
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network); // refresh in the background
    return cached;
  }
  return (await network) || Response.error();
}
