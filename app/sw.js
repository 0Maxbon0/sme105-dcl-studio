const CACHE_NAME = 'eeciv-v2.0.2';
const FILES = [
  "./",
  "./index.html",
  "./styles.css?v=18",
  "./manifest.webmanifest",
  "./brand/logos/basita-ar-dark.svg",
  "./brand/logos/basita-ar-light.svg",
  "./brand/logos/basita-en-dark.svg",
  "./brand/logos/basita-en-light.svg",
  "./brand/tokens.css",
  "./brand/typography/readex-pro/font-face.css",
  "./brand/typography/readex-pro/readex-pro-1.woff2",
  "./brand/typography/readex-pro/readex-pro-2.woff2",
  "./brand/typography/readex-pro/readex-pro-3.woff2",
  "./brand/typography/readex-pro/readex-pro-4.woff2",
  "./brand/typography/sora/font-face.css",
  "./brand/typography/sora/sora-1.woff2",
  "./brand/typography/sora/sora-2.woff2",
  "./brand/typography/typography.css",
  "./sw.js",
  "./icons/icon.svg",
  "./icons/escort-profile.svg",
  "./brand/motion/loading-transparent.svg",
  "./brand/motion/unravel-credit-light.mp4",
  "./brand/motion/unravel-credit-dark.mp4",
  "./brand/motion/unravel-credit-light.png",
  "./brand/motion/unravel-credit-dark.png",
  "./brand/motion/loading-light.svg",
  "./brand/motion/loading-dark.svg",
  "./brand/audio/basita-resolution-micro.mp3",
  "./icons/nav-dashboard.svg",
  "./icons/nav-faults.svg",
  "./icons/nav-lab.svg",
  "./icons/nav-history.svg",
  "./icons/nav-kline.svg",
  "./icons/nav-settings.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/app.js?v=27",
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
  "./js/analysis-ui.js",
  "./js/frame-inspector.js",
  "./js/capture-comparison.js",
  "./js/codes-db.js",
  "./js/controller.js",
  "./js/combined.js",
  "./js/live-dashboard.js",
  "./js/ble.js",
  "./js/wifi.js",
  "./js/mock-transport.js",
  "./vendor/jszip.min.js",
  "./vendor/native-bridge.js",
  "./data/codes.js",
  "./demo/read-0e.txt",
  "./demo/koeo.txt",
  "./demo/live-engine-off.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
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
