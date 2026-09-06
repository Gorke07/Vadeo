// Vadeo service worker — kurulabilirlik ve çevrimdışı kabuk.
// Ağ önce, önbellek yedek: sunucu erişilebilirken her zaman taze kod ve veri gelir,
// erişilemezken kabuk yine açılır ve uygulama kendi "Sunucuya ulaşılamadı" mesajını gösterir.
const CACHE = "vadeo-v1";
const SHELL = ["/", "/index.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Mali veri asla önbellekten servis edilmez: bayat bakiye yanlış karar verdirir.
  if (url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      // Uzantısız yollar uygulama rotası; çevrimdışında kabuğu dön.
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("/"))),
  );
});
