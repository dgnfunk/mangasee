// Only explicit downloads enter this cache. Never cache login or mutable API responses.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    event.request.method !== "GET" ||
    !/^\/api\/books\/[^/]+\/(page\/\d+|file|cover)$/.test(url.pathname)
  )
    return;
  event.respondWith(
    caches
      .open("mangasee-downloads-v1")
      .then(
        async (cache) =>
          (await cache.match(event.request)) || fetch(event.request),
      ),
  );
});
