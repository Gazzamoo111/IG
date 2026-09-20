const STATIC_CACHE = "mova-static-v6";
const MEDIA_CACHE = "mova-media-v1";

const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./mova-logo.png",
  "./mova-icon.svg",
  "./media/motion.html",
  "./media/showcase.html"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => ![STATIC_CACHE, MEDIA_CACHE].includes(key))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(STATIC_CACHE);
    cache.put("./index.html", response.clone()).catch(() => {});
    return response;
  } catch (_) {
    return (await caches.match("./index.html")) || (await caches.match("./"));
  }
}

async function motionResponse(request) {
  const base = await caches.match("./media/motion.html");
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(MEDIA_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    return (await caches.match(request)) || base || Response.error();
  }
}

async function staticResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    return cached || Response.error();
  }
}

async function mediaResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      const cache = await caches.open(MEDIA_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    return cached || Response.error();
  }
}

self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_MEDIA" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.slice(0, 24);
  event.waitUntil((async () => {
    const cache = await caches.open(MEDIA_CACHE);
    for (const url of urls) {
      try {
        const parsed = new URL(url, self.location.origin);
        if (parsed.pathname.endsWith("/media/motion.html")) continue;
        const request = new Request(parsed.href, { mode: parsed.origin === self.location.origin ? "same-origin" : "cors" });
        const existing = await cache.match(request);
        if (existing) continue;
        const response = await fetch(request);
        if (response.ok || response.type === "opaque") {
          await cache.put(request, response.clone());
        }
      } catch (_) {}
    }
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin && url.pathname.endsWith("/media/motion.html")) {
    event.respondWith(motionResponse(request));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.endsWith("/media/showcase.html")) {
    event.respondWith(staticResponse(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staticResponse(request));
    return;
  }

  const isMedia = ["image", "video"].includes(request.destination);
  const hasRange = request.headers.has("range");
  if (isMedia && !hasRange) {
    event.respondWith(mediaResponse(request));
  }
});
