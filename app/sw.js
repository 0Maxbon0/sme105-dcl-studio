const CACHE = "eeciv-v1.8.9-layout-1";
const FILES = [
  "./",
  "./index.html",
  "./styles.css?v=11",
  "./manifest.webmanifest",
  "./sw.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/app.js?v=17",
  "./js/ui.js",
  "./js/strings.js",
  "./js/protocol.js",
  "./js/session.js",
  "./js/session-outcome.js",
  "./js/session-history.js",
  "./js/ignition-review.js",
  "./js/chart-series.js",
  "./js/dashboard-layout.js",
  "./js/test-history.js",
  "./js/dtc-history.js",
  "./js/koer-guide.js",
  "./js/kline.js",
  "./js/kline-ui.js",
  "./js/cart.js",
  "./js/pids.js",
  "./js/reference.js",
  "./js/recording.js",
  "./js/recording-review.js",
  "./js/review-controls.js",
  "./js/throttle-display.js",
  "./js/display-format.js",
  "./js/bit-presentation.js",
  "./js/diagnostics.js",
  "./js/exports.js",
  "./js/codes-db.js",
  "./js/controller.js",
  "./js/combined.js",
  "./js/live-dashboard.js",
  "./js/ble.js",
  "./js/mock-transport.js",
  "./vendor/jszip.min.js",
  "./vendor/native-bridge.js",
  "./data/codes.js",
  "./demo/read-0e.txt",
  "./demo/koeo.txt",
  "./demo/live-engine-off.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(request);
      if (hit) return hit;
      throw error;
    }
  })());
});
