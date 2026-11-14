// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route policy rules. Every route id resolves to exactly one rule; there is
 * no catch-all, so a new top-level directory fails route-policy.test.ts until
 * it gets a row here. After any change run
 *
 *     npx vitest run src/lib/server/auth/route-policy -u
 *
 * and review the snapshot diff: every line is a route id × method whose access
 * changed. Patterns use normalised route ids (`normalizeRouteId`): groups
 * dropped, param names erased. `(private)` route ids are never matched here.
 *
 * Step 1 (shadow mode) records TODAY's effective behaviour, which is not always
 * what a route's own declaration says — see the design spec §1.7.
 */

import type { RouteRule } from './policy.js';

/** Top-level page directories that need a signed-in user (resolveAuth's default). */
const USER_PAGE_SEGMENTS = [
    'api-docs',
    'app',
    'assistant',
    'audiobooks',
    'browse',
    'device',
    'library',
    'livetv',
    'llms.txt',
    'music',
    'my',
    'my-stats',
    'p',
    'party',
    'playlists',
    'rate',
    'settings',
    'stats',
    'test-auth',
    'watch',
] as const;

/** `/api/<segment>/**` areas on the cookie/forward-auth surface that need a signed-in user. */
const USER_API_SEGMENTS = [
    'ai',
    'assistant',
    'audiobooks',
    'auth',
    'browse',
    'cache-warming',
    'calendar',
    'client-errors',
    'continue-watching',
    'dev',
    'diagnostics',
    'episode',
    'events',
    'feed',
    'for-you',
    'health',
    'home',
    'image',
    'integrations',
    'jellyfin',
    'jellyfin-connect',
    'jellyfin-sync',
    'keyword-movies',
    'keywords',
    'libraries',
    'library-status',
    'lists',
    'livetv',
    'media',
    'media-details',
    'mood-recommendations',
    'movie',
    'movie-details',
    'music',
    'my-stats',
    'network',
    'notifications',
    'oauth',
    'offline-playback-sessions',
    'onboarding',
    'people',
    'person',
    'play-sessions',
    'playback',
    'playlists',
    'plugins',
    'queues',
    'rate',
    'recommendations',
    'request',
    'requests',
    'runs',
    'scheduler',
    'search',
    'series',
    'server',
    'social',
    'stats',
    'subsonic-connect',
    'tasks',
    'test-auth',
    'trending',
    'upcoming',
    'user',
    'users',
    'watch-state',
    'watch-together',
    'watched',
    'watchlist',
    'webhooks',
] as const;

const NATIVE_PUBLIC =
    'pre-sign-in surface: reachable without a session (NATIVE_AUTH_PUBLIC_PATHS in forward-auth.ts)';
const JELLYFIN_PRE_LOGIN = 'Jellyfin protocol endpoint clients call before signing in';

/**
 * Admin rows outside /admin and /api/admin: the route or its def demands admin.
 * Recorded so the table is complete; steps 1–2 do NOT compare or enforce them
 * (no hooks gate exists there today, and the handler's 403 shape differs).
 */
const ADMIN_DECLARED_OUTSIDE_ADMIN_PREFIX: RouteRule[] = [
    // Access membership keeps its scope/admin ceiling on the addressed resource.
    '/api/v1/access/groups/[]/members',
    '/api/v1/access/groups/[]/members/[]',
    '/api/jellyfin-connect/admin/**',
    '/api/ai/embedding-preview',
    '/api/ai/force-suggestions',
    '/api/ai/generate-suggestions/**',
    '/api/media/[]/metadata',
    '/api/music/debug/crossfade',
    '/api/runs/[]/diagnostics',
    '/api/watch-stats',
    '/api/cache-stats/**',
    '/api/health/config',
    '/api/health/migration',
    '/api/setup/**',
    // Only an `integrations:read` service token whose owner is admin passes the
    // def's own scope check (admin sessions and PATs are refused there).
    '/api/v1/integrations/homepage',
    '/api/v1/integrations/upcoming',
    '/api/v1/integrations/watch-history',
    '/api/v1/runs/[]/diagnostics',
    '/api/v1/setup/onboarding',
].map((pattern) => ({ pattern, policy: 'admin-scoped' }));

export const ROUTE_POLICY_RULES: readonly RouteRule[] = [
    // ---- Pages and framework routes ----
    { pattern: '/', policy: 'user' },
    { pattern: '/admin/**', policy: 'admin' },
    { pattern: '/login', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/setup', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/setup/locked', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/manifest.json', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/logout', policy: 'user' },
    { pattern: '/auth/oidc/login', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/auth/oidc/callback', policy: 'public', reason: NATIVE_PUBLIC },
    {
        pattern: '/auth/oidc/backchannel-logout',
        policy: 'token-surface:oidc-backchannel',
        reason: 'IdP server-to-server POST, authenticated by the signed logout_token',
        authenticators: ['processBackchannelLogout'],
    },
    {
        pattern: '/metrics',
        policy: 'token-surface:metrics',
        reason: 'Prometheus scrape: public flag, static bearer, or a metrics:read scope',
        authenticators: ['secretMatches', 'enforce'],
    },
    ...USER_PAGE_SEGMENTS.map((s): RouteRule => ({ pattern: `/${s}/**`, policy: 'user' })),

    // ---- Jellyfin compatibility (/j) ----
    {
        pattern: '/j/**',
        policy: 'token-surface:j',
        reason: 'Jellyfin clients authenticate per route with explicit tokens, never native cookies/forward-auth; jellyfinCorsHandle grants credential-free CORS and anonymous OPTIONS only for admin-configured origins',
        authenticators: ['withJellyfinAuth', 'validatePassword'],
    },
    { pattern: '/j', policy: 'public', reason: 'Jellyfin root, probed by clients before sign-in' },
    { pattern: '/j/[...]', policy: 'public', reason: 'unknown-route catch-all, answers 404' },
    { pattern: '/j/web', policy: 'public', reason: 'Jellyfin web deeplink shim (HTML redirect)' },
    {
        pattern: '/j/web/[...]',
        policy: 'public',
        reason: 'Jellyfin web deeplink shim (HTML redirect)',
    },
    { pattern: '/j/QuickConnect/Enabled', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    {
        pattern: '/j/QuickConnect/Initiate',
        policy: 'public',
        reason: `${JELLYFIN_PRE_LOGIN}; rate-limited`,
    },
    {
        pattern: '/j/QuickConnect/Connect',
        policy: 'public',
        reason: `${JELLYFIN_PRE_LOGIN}; rate-limited`,
    },
    {
        pattern: '/j/Users/AuthenticateWithQuickConnect',
        policy: 'public',
        reason: 'exchanges an authorized QuickConnect secret for a session',
    },
    { pattern: '/j/Users/Public', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/System/Info/Public', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/System/Ping', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/System/Endpoint', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/Branding/Configuration', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/Branding/Splashscreen', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    {
        pattern: '/j/Branding/Css',
        policy: 'public',
        reason: `${JELLYFIN_PRE_LOGIN} (anonymous in Jellyfin's BrandingController; an empty stylesheet)`,
    },
    {
        pattern: '/j/Branding/Css.css',
        policy: 'public',
        reason: `${JELLYFIN_PRE_LOGIN} (anonymous in Jellyfin's BrandingController; an empty stylesheet)`,
    },
    {
        pattern: '/j/GetUtcTime',
        policy: 'public',
        reason: "clock sync; anonymous in Jellyfin's TimeSyncController, answers only server timestamps",
    },
    { pattern: '/j/Streamyfin/config', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/AudioMuseAI/info', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/Plugins/[]/Configuration', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    { pattern: '/j/PluginPages/User', policy: 'public', reason: JELLYFIN_PRE_LOGIN },
    {
        // GET: an anonymous caller (Seerr's <img> in a browser) gets only the generic
        // silhouette; the real avatar needs a Jellyfin credential
        // (withOptionalJellyfinAuth). POST/DELETE change the caller's own avatar and
        // run withJellyfinAuth (sessions only).
        pattern: '/j/UserImage',
        policy: { GET: 'public', '*': 'token-surface:j' },
        reason: 'user avatar: anonymous GET answers only the generic silhouette for every id; the real avatar needs a Jellyfin credential; upload/delete need a session',
        authenticators: ['withJellyfinAuth', 'withOptionalJellyfinAuth'],
    },
    {
        pattern: '/j/Users/[]/Images/[]',
        policy: 'public',
        reason: 'user avatar: anonymous GET answers only the generic silhouette for every id (upstream Jellyfin serves the real one); the real avatar needs a Jellyfin credential (withOptionalJellyfinAuth)',
    },
    {
        pattern: '/j/Items/[]/Images/[]',
        policy: 'public',
        reason: 'item artwork; public in the Jellyfin protocol, unknown ids get the same placeholder (docs/architecture/jellyfin-compat-security.md)',
    },
    {
        pattern: '/j/Items/[]/Images/[]/[]',
        policy: 'public',
        reason: 'item artwork by image index (/Images/Backdrop/0); same handler and placeholder as /j/Items/[]/Images/[]',
    },
    {
        pattern: '/j/LumastraNotice/[]/[]',
        policy: 'public',
        reason: 'stream-limit notice clip; the server-minted notice id is the credential',
    },

    // ---- OpenSubsonic and the OAuth device flow ----
    {
        pattern: '/subsonic/**',
        policy: 'token-surface:subsonic',
        reason: 'Subsonic clients send u/p, u/t/s or apiKey on every request',
        authenticators: ['parseSubsonicAuth', 'validateApiKey'],
    },
    {
        pattern: '/subsonic/[...]',
        policy: 'public',
        reason: 'unknown-route catch-all, answers 404',
    },
    {
        pattern: '/oauth/**',
        policy: 'token-surface:oauth',
        reason: 'device flow: the device code or refresh token is the credential',
        authenticators: ['handleDeviceCodeGrant', 'handleRefreshTokenGrant'],
    },
    { pattern: '/oauth/[...]', policy: 'public', reason: 'unknown-route catch-all, answers 404' },
    {
        pattern: '/oauth/device',
        policy: 'public',
        reason: 'device-code request: the start of the device flow, rate-limited',
    },
    // A browser account-link callback: needs the signed-in user. resolveAuth's
    // /oauth branch resolves a link-only identity for /oauth/links/* (design §5.3).
    { pattern: '/oauth/links/[]/callback', policy: 'user' },

    // ---- /api/v1: the token API (PAT, service token, device JWT, stream token) ----
    { pattern: '/api/v1/music/sonic-mixes/**', policy: 'user' },
    { pattern: '/api/music/sonic-mixes/**', policy: 'user' },
    { pattern: '/api/v1/**', policy: 'user' },
    {
        pattern: '/api/v1/oauth/device/approve',
        policy: { GET: 'user', POST: 'user' },
        reason: 'Bearer-only hooks authenticate; the def requires a full user OAuth token backed by an independent live session, no self-approval or delegated/admin credentials',
    },
    { pattern: '/api/v1/me/**', policy: 'user' },
    { pattern: '/api/user/stream-privacy', policy: { GET: 'user', POST: 'user' } },
    { pattern: '/api/v1/sync/changes', policy: { GET: 'user', HEAD: 'user' } },
    { pattern: '/api/v1/sync/user-state', policy: { GET: 'user', HEAD: 'user' } },
    { pattern: '/api/v1/sync/library', policy: { GET: 'user', HEAD: 'user' } },
    // The playback probe: a signed-in user; the def checks media:read and the title's library/age gate.
    { pattern: '/api/v1/media/[]/playability', policy: { POST: 'user' } },
    { pattern: '/api/media/[]/playability', policy: { POST: 'user' } },
    {
        pattern: '/api/v1/server',
        policy: { GET: 'public', HEAD: 'public', '*': 'user' },
        reason: 'pre-sign-in GET/HEAD discovery; optional validated bearer only, invalid credentials are anonymous',
        loosens:
            'discovery is public; only an authenticated principal receives capabilities and caller',
    },
    { pattern: '/api/v1/admin/**', policy: 'admin-scoped' },
    // Reviewed artwork boundary: predictable handles must authenticate and pass
    // library/age checks in the shared def; internal UUID artwork stays anonymous.
    {
        pattern: '/api/v1/media/[]/images/**',
        policy: { GET: 'token-surface:signed', HEAD: 'token-surface:signed', '*': 'user' },
        reason: 'internal UUID artwork stays anonymous (optional HMAC); external provider handles require a user and library/age access before lookup, including signed requests',
        authenticators: ['mount'],
    },
    {
        pattern: '/api/v1/admin/provider-calls',
        policy: 'admin',
        reason: 'Instance-wide provider traffic and failure counters are restricted to administrators',
    },
    {
        pattern: '/api/admin/provider-calls',
        policy: 'admin',
        reason: 'Internal mirror of the admin-only provider traffic counters',
    },
    {
        // User images are personal data (an uploaded avatar; initials generated from
        // a name). isAnonymousEntityImagePath() leaves them out of the anonymous
        // image exemptions, so the hooks backstop and forward-auth demand a credential
        // and the def's enforce({kind:'user'}) 401s a request without a principal.
        // Declared before the generic rule below; more literal segments win.
        pattern: '/api/v1/users/[]/images/**',
        policy: 'user',
    },
    {
        // The other /api/v1/<area>/<id>/images/** paths skip credential parsing and
        // the backstop (a substring test), and the def decides. Only the media byte
        // routes look at ?sig=; media/people/libraries artwork by unguessable id is
        // answered without a credential where the def says so, otherwise enforce().
        pattern: '/api/v1/*/[]/images/**',
        policy: { GET: 'token-surface:signed', HEAD: 'token-surface:signed', '*': 'user' },
        reason: 'artwork: optional HMAC ?sig= (media byte routes) or the def’s own auth; user images are excluded above',
        authenticators: ['verifySignedUrl', 'mount'],
    },
    {
        pattern: '/api/v1/media/[]/topshelf-preview/file/[]',
        policy: 'token-surface:signed',
        reason: 'Top Shelf MP4: HMAC ?sig= verified in-route',
        authenticators: ['mount'],
    },
    {
        pattern: '/api/v1/notifications/[]/push-image',
        policy: 'token-surface:signed',
        reason: 'iOS Notification Service Extension: HMAC ?sig= verified in-route',
        authenticators: ['mount'],
    },
    {
        pattern: '/api/v1/notifications/[]/push-content/[]',
        policy: 'token-surface:signed',
        reason: 'iOS Notification Service Extension: HMAC ?sig= verified in-route',
        authenticators: ['mount'],
    },
    // Retired singular audiobook byte paths (P9): GET and HEAD answer 410 route_retired to
    // anyone, so no credential is needed; every other method still requires a user.
    ...['file', 'remux'].map((kind): RouteRule => ({
        pattern: `/api/v1/audiobook/[]/${kind}/[]`,
        policy: { GET: 'public', HEAD: 'public', '*': 'user' },
        reason: 'retired singular audiobook byte route: answers 410 route_retired and reveals nothing',
    })),
    ...['files', 'remux', 'hls'].map((kind): RouteRule => ({
        pattern: `/api/v1/${kind === 'hls' ? 'audiobook' : 'audiobooks'}/[]/${kind}/**`,
        policy: 'token-surface:stream',
        reason: 'audiobook byte proxy: Bearer or grant, owned session and server-mapped track',
        authenticators: ['handleAudiobookFile', 'handleAudiobookRemux', 'handleAudiobookHls'],
    })),

    // ---- /api on the cookie / forward-auth surface ----
    { pattern: '/api/me/**', policy: 'user' },
    // Preview allocation and leases use account auth; media grants authorize bytes only.
    { pattern: '/api/playback/previews/**', policy: 'user' },
    { pattern: '/api/admin/api-conformance', policy: 'admin' },
    { pattern: '/api/admin/library/storage-growth', policy: 'admin' },
    { pattern: '/api/admin/activity-sharing-default', policy: 'admin' },
    { pattern: '/api/admin/**', policy: 'admin-scoped' },
    ...USER_API_SEGMENTS.map((s): RouteRule => ({ pattern: `/api/${s}/**`, policy: 'user' })),
    { pattern: '/api/auth/native/login', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/api/auth/native/logout', policy: 'public', reason: NATIVE_PUBLIC },
    { pattern: '/api/auth/native/setup', policy: 'public', reason: NATIVE_PUBLIC },
    {
        pattern: '/api/auth/plugin/**',
        policy: 'token-surface:plugin-auth',
        reason: 'auth-provider plugin login: establishes the session (AUTH_PLUGIN_PROVIDERS)',
        authenticators: ['getAuthProvider'],
    },
    {
        pattern: '/api/setup/oidc-test',
        policy: 'public',
        reason: 'first-run only: 404 once an admin exists',
    },
    {
        pattern: '/api/setup/oidc-config',
        policy: 'public',
        reason: 'first-run only: 404 once an admin exists',
    },
    {
        pattern: '/api/health',
        policy: 'public',
        reason: 'load-balancer health probe; detail only for admins',
    },
    {
        pattern: '/api/health/ready',
        policy: 'public',
        reason: 'readiness probe; per-component detail only for admins',
    },
    {
        pattern: '/api/plugin-webhooks/**',
        policy: 'token-surface:webhook',
        reason: 'plugin webhook: the per-integration shared secret is checked by the dispatcher (wrong secret = 404)',
        authenticators: ['dispatchIntegrationWebhook'],
    },
    ...ADMIN_DECLARED_OUTSIDE_ADMIN_PREFIX,
    // Holiday calendar plugin: everyone reads it, only admins edit it (found by
    // the preprod shadow run: non-admin writes get the handler's 403).
    {
        pattern: '/api/plugins/holidays/**',
        policy: { GET: 'user', HEAD: 'user', '*': 'admin-scoped' },
    },
];
