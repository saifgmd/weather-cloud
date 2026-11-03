/* =====================================================================
 * Weather Cloud — Service Worker
 * Author: SAIF G.M.D
 * Version: 1.1.0
 *
 * Strategy
 *  - Our own files (page, app.js, styles…): network-first, so updates arrive
 *    on the next launch; the cache is the offline fallback.
 *  - Cross-origin requests (weather API, images, audio, video) and range
 *    requests are left to the browser. The app keeps the last forecast in
 *    localStorage for offline use.
 *
 * Bump CACHE_VERSION on every release to drop old caches.
 * ===================================================================== */

const CACHE_VERSION = "1.5.0";
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

  event.respondWith(networkFirst(req));
});

/**
 * Network-first for everything of our own: an update is used on the very
 * next launch (the page and app.js always match). The cache is only the
 * offline fallback — or used when the network is too slow to answer.
 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const isPage = req.mode === "navigate";
  const fromCache = () =>
    cache.match(isPage ? "./index.html" : req, { ignoreSearch: true });

  const network = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res && res.ok && res.type === "basic") {
      cache.put(isPage ? "./index.html" : req, res.clone());
    }
    return res;
  });

  try {
    // Slow connection: after 4 s fall back to the cached copy (if any)
    const timeout = new Promise((resolve) =>
      setTimeout(async () => resolve((await fromCache()) || network), 4000)
    );
    return await Promise.race([network, timeout]);
  } catch {
    return (await fromCache()) || Response.error();
  }
}
