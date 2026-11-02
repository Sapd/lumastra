// Media Dashboard PWA Service Worker
// Designed to work with forward authentication (Authentik)
// Version is auto-incremented on build - see scripts/increment-sw-version.js
const CACHE_NAME = 'media-dashboard-v1.1.205-dev';

// Detect base path from service worker location
// If sw.js is at /lumastra/sw.js, base is '/lumastra'
// If sw.js is at /sw.js, base is ''
const SW_PATH = new URL(self.location).pathname;
const BASE_PATH = SW_PATH.replace(/\/sw\.js$/, '') || '';

// Helper to prefix path with base
function withBase(path) {
    if (!BASE_PATH) return path;
    if (path.startsWith(BASE_PATH)) return path;
    return BASE_PATH + path;
}

// Static assets to cache (only immutable assets that don't require auth)
const STATIC_CACHE_PATTERNS = [
    // Fonts
    /\/fonts\//,
    // App icons and logos
    /\/lumastra-.*\.(png|webp|ico)$/,
    /\/favicon\.(png|ico)$/,
    // Manifest
    /\/manifest\.json$/,
];

// Patterns that should NEVER be cached (require auth or are dynamic)
const NEVER_CACHE_PATTERNS = [
    /\/api\//, // All API routes - auth required
    /\/outpost\./, // Authentik outpost routes - auth related
    /\.m3u8$/, // HLS manifests - dynamic
    /\.ts$/, // HLS video segments
    /\.mp4$/, // Video files
    /\.mkv$/, // Video files
    /range=/i, // Range requests (video streaming)
];

// App shell pages ('/', '/browse', '/watch/*') used to be cached here and
// served as a network-timeout / network-error fallback (stale-while-revalidate
// style). REMOVED for security fix C7: the cached body is personalized SSR
// HTML (watching sections, hero, active streams visible to privileged
// viewers, isAdmin, announcements — see src/routes/+page.server.ts and
// +layout.server.ts) and this SW cannot read the HttpOnly session cookie, so
// it has no way to tell a cached entry apart from what the CURRENT visitor is
// authorized to see. On a shared device/browser, a slow or failed network
// request could replay one user's personalized page to the next user signed
// in after them, even past logout. These paths now fall through to "Other
// navigation requests" below: network-first, offline page on failure — never
// a cached, personalized HTML fallback.

// Check if URL matches any pattern
function matchesPattern(url, patterns) {
    const path = new URL(url).pathname;
    return patterns.some((pattern) => pattern.test(path) || pattern.test(url));
}

// Check if request is for static asset (cacheable with cache-first)
function isStaticAsset(url) {
    const pathname = new URL(url).pathname;

    // Check if it matches static cache patterns
    if (matchesPattern(url, STATIC_CACHE_PATTERNS)) {
        return true;
    }

    // Also cache built JS/CSS with hashes (immutable)
    // SvelteKit uses _app/immutable for hashed assets
    if (pathname.includes('/_app/immutable/')) {
        return true;
    }

    return false;
}

// Is this response an HTML document? Authentik serves its login page as
// text/html when it intercepts a request whose session is missing/expired.
// Handing that HTML to a <script type=module> / stylesheet loader is exactly
// what breaks the app on Firefox: "Loading module … blocked because of a
// disallowed MIME type". Detect it so we never do that.
function isHtmlResponse(response) {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    return contentType.includes('text/html');
}

// A network response is only safe to hand back for a hashed JS/CSS asset if it
// is a real, non-redirected success that is NOT an HTML auth page. Anything
// else (302→login, opaque redirect, error, or HTML body) must be refused so the
// import fails cleanly instead of poisoning the module loader or the cache.
function isUsableAssetResponse(response) {
    if (!response || !response.ok) return false;
    if (response.type === 'opaqueredirect' || response.redirected) return false;
    if (isHtmlResponse(response)) return false;
    return true;
}

// Install event - cache initial static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker', CACHE_NAME, 'base:', BASE_PATH);

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Pre-cache essential static files (with base path prefix)
            const filesToCache = [
                '/manifest.json',
                '/branding/lumastra-logo-horizontal-ondark.svg',
                '/branding/lumastra-icon.svg',
                '/favicon.png',
            ].map(withBase);

            return cache.addAll(filesToCache).catch((err) => {
                // Non-critical if some files fail to cache
                console.warn('[SW] Some static files failed to cache:', err);
            });
        }),
    );

    // Activate immediately
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker', CACHE_NAME);

    event.waitUntil(
        caches
            .keys()
            .then((cacheNames) => {
                const deletions = cacheNames
                    .filter((cacheName) => {
                        // Delete ALL old caches when version changes
                        return (
                            (cacheName.startsWith('media-dashboard-') ||
                                cacheName.startsWith('lumastra-')) &&
                            cacheName !== CACHE_NAME
                        );
                    })
                    .map((cacheName) => {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    });
                return Promise.all(deletions);
            })
            .then(() => {
                // Claim clients immediately
                return self.clients.claim();
            })
            .then(() => {
                // Notify all clients that a new SW is active
                // This allows clients to reload if needed
                return self.clients.matchAll({ type: 'window' }).then((clients) => {
                    clients.forEach((client) => {
                        client.postMessage({
                            type: 'SW_ACTIVATED',
                            version: CACHE_NAME,
                        });
                    });
                });
            }),
    );
});

// Fetch event - smart caching strategy
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = request.url;

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip requests to other origins - let browser handle auth redirects naturally
    if (!url.startsWith(self.location.origin)) {
        return;
    }

    // NEVER cache patterns - always go to network
    if (matchesPattern(url, NEVER_CACHE_PATTERNS)) {
        return;
    }

    // Skip range requests (video streaming)
    if (request.headers.get('range')) {
        return;
    }

    // Static assets - cache-first strategy (immutable)
    if (isStaticAsset(url)) {
        // Rewrite manifest.json requests to the canonical root path.
        // When the browser is on /watch/item-id it resolves a relative
        // manifest href as /watch/manifest.json, which Authentik intercepts.
        // Always serve manifest.json from the pre-cached root path instead.
        const canonicalRequest = /\/manifest\.json$/.test(new URL(url).pathname)
            ? new Request(new URL(withBase('/manifest.json'), self.location.origin).href)
            : request;

        event.respondWith(
            caches.match(canonicalRequest).then((cachedResponse) => {
                // Serve from cache only if it's a real asset. An earlier version of
                // this SW could cache an auth-intercepted HTML page under a JS/CSS
                // URL; refuse such a poisoned entry (and drop it) instead of feeding
                // HTML to the module loader.
                if (cachedResponse && !isHtmlResponse(cachedResponse)) {
                    return cachedResponse;
                }
                if (cachedResponse) {
                    caches.open(CACHE_NAME).then((cache) => cache.delete(canonicalRequest));
                }

                // Not in cache, fetch and cache for next time.
                return fetch(canonicalRequest)
                    .then((networkResponse) => {
                        // If the network returned an auth redirect / HTML login page
                        // (not a real asset), NEVER hand it back as the asset — that
                        // is the "disallowed MIME type" failure. Fail the request
                        // cleanly so auth-check.js / a reload can re-establish the
                        // session; the durable fix is exempting /_app/ from auth.
                        if (!isUsableAssetResponse(networkResponse)) {
                            return Response.error();
                        }
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(canonicalRequest, responseToCache);
                        });
                        return networkResponse;
                    })
                    .catch(() => Response.error());
            }),
        );
        return;
    }

    // All navigation requests - network-first (respects auth)
    // Covers '/', '/browse', '/watch/*' too (security fix C7: personalized
    // SSR HTML is never read from or written to CacheStorage here — see the
    // comment near "Static assets to cache" above). A slow/erroring network
    // falls back to the generic offline page only, never to a cached page
    // body that could belong to a different user.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch((err) => {
                console.warn('[SW] Navigation failed, network unavailable:', err);
                return createOfflinePage();
            }),
        );
        return;
    }

    // All other requests - network only (no caching)
    // This ensures authenticated resources are always fetched fresh
});

// Create offline page response
function createOfflinePage() {
    return new Response(
        `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Offline - Lumastra</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: #0f172a;
          color: #e2e8f0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          padding: 1rem;
          text-align: center;
        }
        h1 { color: #3b82f6; margin-bottom: 0.5rem; }
        p { color: #94a3b8; margin: 0.5rem 0; }
        button {
          margin-top: 1rem;
          padding: 0.75rem 1.5rem;
          background: #3b82f6;
          color: white;
          border: none;
          border-radius: 0.5rem;
          font-size: 1rem;
          cursor: pointer;
        }
        button:hover { background: #2563eb; }
      </style>
    </head>
    <body>
      <h1>You're Offline</h1>
      <p>Lumastra requires an internet connection.</p>
      <p>Please check your connection and try again.</p>
      <button onclick="location.reload()">Retry</button>
    </body>
    </html>`,
        {
            status: 503,
            headers: { 'Content-Type': 'text/html' },
        },
    );
}

// Handle messages from the app
// `event.data` is either a bare string (the original, still used by
// pwa.ts:skipWaiting/getVersion) or `{ type: '...' }` (used by
// clearServiceWorkerCaches() on logout, C7) — accept both shapes.
self.addEventListener('message', (event) => {
    const type = typeof event.data === 'string' ? event.data : event.data?.type;

    if (type === 'skipWaiting') {
        self.skipWaiting();
    }

    if (type === 'getVersion') {
        event.ports[0]?.postMessage({ version: CACHE_NAME });
    }

    // Force clear ALL caches (useful for debugging/manual refresh, and as a
    // companion to the client-side caches.delete() wipe on logout — see
    // clearServiceWorkerCaches() in pwa.ts). Not scoped to CACHE_NAME: a
    // stale cache from a previous version could still be around if the
    // activate handler hasn't run yet.
    if (type === 'clearCache') {
        caches
            .keys()
            .then((names) => Promise.all(names.map((name) => caches.delete(name))))
            .then(() => {
                console.log('[SW] Cache cleared');
                event.ports[0]?.postMessage({ cleared: true });
            });
    }
});

// Handle notification clicks (Notifications API only — this SW never
// subscribes to Web Push; frames come from notifications-desktop.ts calling
// registration.showNotification() while a tab is open).
// Focus an existing client and navigate it to the deep link carried in the
// notification's `data.url`; if no client is open, open a new window there
// instead.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const rawUrl = (event.notification.data && event.notification.data.url) || '/';
    const targetUrl = withBase(rawUrl);

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    return client.focus().then((focusedClient) => {
                        // Navigate the focused tab to the deep link. This is the
                        // COMMON path (Notifications API only fires while a tab
                        // is already open, so a matching client almost always
                        // exists) — without this, targetUrl was dead code and
                        // the click just focused whatever page was already up.
                        const target = focusedClient || client;
                        if ('navigate' in target) {
                            return target.navigate(targetUrl).catch(() => {
                                // expected: cross-origin or a client that
                                // dropped navigation mid-flight — focus already
                                // succeeded, so leave the tab where it is.
                            });
                        }
                        return undefined;
                    });
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(targetUrl);
            }
        }),
    );
});

console.log('[SW] Service worker loaded', CACHE_NAME);
