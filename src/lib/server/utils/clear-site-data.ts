// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `Clear-Site-Data` header for logout responses (security fix C7).
 *
 * The service-worker app-shell cache (static/sw.js) used to keep the previous
 * user's personalized SSR HTML in CacheStorage across logout — on a shared
 * device/browser, a second user's slow or offline navigation could replay the
 * first user's cached page (watching sections, admin flag, other users'
 * active streams, …). Stamping `Clear-Site-Data: "cache"` on the logout
 * response tells the browser to wipe CacheStorage for this origin as part of
 * the logout response itself — belt and suspenders alongside the client-side
 * `caches.delete()` wipe in `clearUserData()`/`nativeSignOut()` and the
 * service worker no longer caching personalized HTML at all.
 *
 * Deliberately scoped to `"cache"` only, NOT `"storage"`: `"storage"` would
 * also wipe localStorage/IndexedDB, which holds per-DEVICE state that must
 * survive logout on a shared browser — `dashboard_device_id`
 * (src/lib/components/player/device-id.ts) feeds the Devices settings
 * section, push-token registration, telemetry, stream-url-builder.ts, SSE
 * watch-state and audiobook playback; wiping it on every logout would mint a
 * fresh device id per login and orphan device rows / push tokens. The
 * curated, per-user-only localStorage/sessionStorage/cookie wipe lives in
 * `$lib/auth/clear-user-client-state.ts` instead, which explicitly excludes
 * per-device keys.
 *
 * Only honoured by the browser on same-origin secure contexts (HTTPS, or
 * localhost for dev). See
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Clear-Site-Data
 */
const CLEAR_SITE_DATA_VALUE = '"cache"';

/** Stamp the Clear-Site-Data header onto a logout response and return it. */
export function withClearSiteData(response: Response): Response {
    response.headers.set('Clear-Site-Data', CLEAR_SITE_DATA_VALUE);
    return response;
}
