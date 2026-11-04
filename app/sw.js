const CACHE = "eeciv-v1.0.0";
const FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./sw.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/app.js",
  "./js/ui.js",
  "./js/strings.js",
  "./js/protocol.js",
  "./js/session.js",
  "./js/cart.js",
  "./js/pids.js",
  "./js/codes-db.js",
  "./js/controller.js",
  "./js/ble.js",
  "./js/mock-transport.js",
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
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }));
});
