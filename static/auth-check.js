// Auth check script - runs asynchronously without blocking page load
// This prevents the service worker from caching the page when not authenticated
(async function () {
    // Don't run auth check if already on an external auth page, or on the
    // first-run onboarding page (/setup is public and legitimately unauthenticated
    // — running the check there 401s and triggers a reload loop until the guard
    // trips). The /login, /auth/* etc. pages are likewise public sign-in surfaces.
    var authPatterns = [
        '/auth/',
        '/login',
        '/setup',
        '/oauth',
        '/saml',
        'authentik',
        'keycloak',
        'auth0',
    ];
    var currentUrl = window.location.href.toLowerCase();
    for (var i = 0; i < authPatterns.length; i++) {
        if (currentUrl.includes(authPatterns[i])) {
            return;
        }
    }

    // Detect base path from service worker location or global
    var basePath = window.__LUMASTRA_BASE__ || '';
    if (!basePath) {
        // Try to detect from script src
        var scripts = document.querySelectorAll('script[src*="/_app/"]');
        if (scripts.length > 0) {
            var src = scripts[0].getAttribute('src');
            var appIndex = src.indexOf('/_app/');
            if (appIndex > 0) {
                basePath = src.substring(0, appIndex);
            }
        }
    }

    // Helper to prefix path with base
    function withBase(path) {
        if (!basePath) return path;
        return basePath + path;
    }

    // Reload loop protection - use localStorage to persist across reloads
    const RELOAD_KEY = 'lumastra-auth-check-reload';
    const RELOAD_LOOP_KEY = 'lumastra-auth-check-loop';
    const MAX_RELOADS = 2;
    const RELOAD_WINDOW = 5 * 60 * 1000; // 5 minutes

    function canReload() {
        try {
            // Check if loop was detected
            const loopDetected = localStorage.getItem(RELOAD_LOOP_KEY);
            if (loopDetected) {
                const loopData = JSON.parse(loopDetected);
                const timeSinceLoop = Date.now() - loopData.timestamp;

                // If loop detected less than 5 minutes ago, don't reload
                if (timeSinceLoop < RELOAD_WINDOW) {
                    console.error('[AuthCheck] Reload loop detected - stopping automatic reloads');
                    return false;
                } else {
                    // Clear old loop detection
                    localStorage.removeItem(RELOAD_LOOP_KEY);
                }
            }

            // Check reload count
            const lastReloadStr = localStorage.getItem(RELOAD_KEY);
            if (lastReloadStr) {
                const lastReloadData = JSON.parse(lastReloadStr);
                const timeSinceReload = Date.now() - lastReloadData.timestamp;

                // If outside the time window, reset count
                if (timeSinceReload > RELOAD_WINDOW) {
                    localStorage.removeItem(RELOAD_KEY);
                    return true;
                }

                // Check if too many reloads
                if (lastReloadData.count >= MAX_RELOADS) {
                    console.error('[AuthCheck] Too many reloads - marking as loop');
                    localStorage.setItem(
                        RELOAD_LOOP_KEY,
                        JSON.stringify({
                            timestamp: Date.now(),
                            count: lastReloadData.count,
                        }),
                    );
                    return false;
                }

                // Within window but under limit - update count
                localStorage.setItem(
                    RELOAD_KEY,
                    JSON.stringify({
                        timestamp: Date.now(),
                        count: lastReloadData.count + 1,
                    }),
                );
            } else {
                // First reload
                localStorage.setItem(
                    RELOAD_KEY,
                    JSON.stringify({
                        timestamp: Date.now(),
                        count: 1,
                    }),
                );
            }

            return true;
        } catch (e) {
            console.error('[AuthCheck] Storage error:', e);
            return false; // Don't reload if we can't check
        }
    }

    try {
        // Check authentication status asynchronously
        const response = await fetch(withBase('/api/auth/check'), {
            method: 'GET',
            credentials: 'same-origin',
            redirect: 'manual', // Don't follow redirects automatically
            cache: 'no-store',
        });

        // If we get a redirect response (302), follow it
        if (
            response.type === 'opaqueredirect' ||
            response.status === 302 ||
            response.status === 301
        ) {
            // Check if there's a Location header
            const location = response.headers.get('Location');
            if (location) {
                window.location.href = location;
            } else if (canReload()) {
                // Fallback: reload the page which will trigger Authentik redirect
                console.log('[AuthCheck] Redirect detected, reloading...');
                window.location.reload();
            }
            return;
        }

        // If we get any error status, reload to trigger auth (with protection)
        if (!response.ok && response.status >= 400) {
            if (canReload()) {
                console.log('[AuthCheck] Auth error detected, reloading...');
                window.location.reload();
            } else {
                console.error('[AuthCheck] Reload prevented - too many attempts');
            }
            return;
        }

        // If we get here, we're authenticated - continue with app load
        // Clear reload tracking on successful auth
        try {
            localStorage.removeItem(RELOAD_KEY);
            localStorage.removeItem(RELOAD_LOOP_KEY);
        } catch {
            // Ignore
        }
    } catch (error) {
        // Network error or CORS issue - likely means auth redirect is needed
        console.warn('[AuthCheck] Network error:', error);
        // Don't reload on network errors - let the app handle it
    }
})();
