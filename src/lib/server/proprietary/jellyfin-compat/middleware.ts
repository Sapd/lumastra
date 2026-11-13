// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { applyLiveTvUserPolicy, liveTvRouteGate } from '$lib/server/auth/livetv-user-policy.js';
// Jellyfin Compatibility Layer — Auth Middleware
// Parses X-Emby-Authorization header, validates the Valkey session token,
// and populates locals with a UserContext matching the forward-auth shape.

import {
    AuthDependencyUnavailableError,
    isDependencyError,
    authUnavailableResponse,
} from '$lib/server/auth/dependency-unavailable.js';

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { Logger } from '$lib/server/utils/logger';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { toUserId } from '$lib/shared/user-id';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { validateSession } from './auth';
import { validateJellyfinCompatPat } from './pat-auth';
import { notifyJellyfinPatDenied } from '$lib/server/services/jellyfin-token-notice.service.js';
import { liveTvCredentialFingerprint } from '$lib/server/services/livetv/livetv-viewer-key.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { routedPathname } from '$lib/server/auth/routed-pathname';
import { buildPrincipal } from '$lib/server/api/principal.js';

const logger = Logger.for('JellyfinCompat:Middleware');

// AC #26: 60 failed-validation requests per IP per 60s window → 429.
// Counter is incremented only on actually-bogus tokens, NOT on valid-PAT-deny
// (so legitimate PAT holders cannot poison their own bucket by hitting a deny-route).
const FAILED_AUTH_LIMIT_PER_MINUTE = 60;
const FAILED_AUTH_WINDOW_SECONDS = 60;

/**
 * Options for withJellyfinAuth.
 */
export interface WithJellyfinAuthOptions {
    /**
     * Whether PAT-authenticated requests are accepted on this route.
     * - 'allow' (default): PATs with scopes=['jellyfin_compat'] or
     *   scopes=['jellyfin_compat_read'] are accepted.
     * - 'deny': valid PATs are rejected with 403. Use on routes that require
     *   a replayable session token (e.g. stream-fetch routes where the token
     *   is embedded as &api_key= in returned URLs).
     */
    pat?: 'allow' | 'deny';

    /**
     * Whether the route mutates state.
     * - 'read' (default): only GET/HEAD methods may reach the handler.
     *   Other methods are rejected with 403. Read-only PATs (scopes=
     *   ['jellyfin_compat_read']) are equally restricted.
     * - 'write': any method may reach the handler, BUT a read-only PAT is
     *   still rejected with 403 because its scope grants no write capability.
     *
     * Routes that export both GET and POST handlers should annotate each
     * export's mode explicitly (the GET stays default 'read'; the POST
     * declares 'write').
     */
    mode?: 'read' | 'write';
}

/**
 * True for HTTP methods that the read-mode gate considers safe.
 * Anything else (POST, DELETE, PATCH, PUT, etc.) is rejected when the
 * route is mode: 'read' or the credential is a read-only PAT.
 *
 * OPTIONS is allowed for CORS preflight. SvelteKit handles preflight
 * before this gate runs in production, but admitting OPTIONS here is
 * defensive: it keeps the read-mode contract honest if a future hook
 * change exposes preflights to route handlers, and matches RFC 9110
 * which classifies OPTIONS as a safe method.
 */
function isReadMethod(method: string): boolean {
    const m = method.toUpperCase();
    return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

/**
 * Parse the X-Emby-Authorization (or Authorization) header into key-value pairs.
 *
 * Supports all Jellyfin client header formats:
 *   Quoted:    MediaBrowser Client="Streamyfin", Token="abc123"
 *   Unquoted:  MediaBrowser Client=Swiftfin iOS, Token=abc123
 *   Mixed:     MediaBrowser Client="My App", Token=abc123, Version=1.0
 *   Minimal:   Token=abc123
 *   Bare:      Version=1.4.1
 */
export function parseEmbyAuthHeader(headerValue: string): Record<string, string> {
    const params: Record<string, string> = {};
    // Strip "MediaBrowser " or "Emby " prefix
    const stripped = headerValue.replace(/^MediaBrowser\s+/i, '').replace(/^Emby\s+/i, '');

    // Split by comma, then parse each Key=Value pair
    for (const part of stripped.split(',')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const key = part.slice(0, eqIdx).trim();
        let value = part.slice(eqIdx + 1).trim();
        // Strip surrounding quotes if present
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        if (key) {
            params[key] = DECODE_EXEMPT_KEYS.has(key)
                ? value
                : sanitizeDisplayName(decodeAuthValue(value), MAX_AUTH_VALUE_LENGTH);
        }
    }
    return params;
}

/**
 * Keys left byte-for-byte as sent.
 *
 * DeviceId is an opaque identity key, not display text — it decides which
 * device a session belongs to. Clients commonly use base64, which contains
 * literal `+`, and a client that does NOT form-encode would have that `+`
 * rewritten to a space by the decoder, silently splitting one device into two
 * across a reconnect. Leaving it untouched also keeps identity byte-identical
 * to every session issued before this decoding existed.
 */
const DECODE_EXEMPT_KEYS = new Set(['DeviceId', 'Token']);

/**
 * Decode one header value.
 *
 * Jellyfin clients form-encode these (matching the server's own
 * `WebUtility.UrlDecode` handling), so `+` means SPACE and non-ASCII arrives
 * percent-escaped. Without this, a TV named "Fernseher im Wohnzimmer" is stored
 * and displayed as "Fernseher+im+Wohnzimmer".
 *
 * Order matters: `+` → space first, then percent-decode — that is
 * form-urlencoded semantics, and it means a genuine `+` in a name (sent as
 * `%2B`) survives correctly rather than becoming a space.
 */
function decodeAuthValue(raw: string): string {
    const spaced = raw.replace(/\+/g, ' ');
    try {
        return decodeURIComponent(spaced);
    } catch {
        // Malformed percent-escape (a stray `%` in a device name). Keep the
        // plus-decoded form rather than throwing out of an auth path.
        return spaced;
    }
}

/**
 * Longest client/device string kept. Shorter than the shared default because a
 * settings row shows this inline next to a timestamp.
 */
const MAX_AUTH_VALUE_LENGTH = 96;

function pathUserAllowed(event: RequestEvent): boolean {
    const target = event.params.userId;
    if (target === undefined) return true;
    // Only caller-scoped state aliases share this check. Images are legitimately
    // read for other users (picker/Watch Together); user DTO, preferences and
    // password handlers retain their own authorization rules.
    const path = routedPathname(event.url);
    if (
        !/^\/j\/Users\/[^/]+\/(?:PlayedItems|FavoriteItems|PlayingItems|Items|Suggestions)(?:\/|$)/.test(
            path,
        )
    )
        return true;
    const compact = (id: string): string => id.replaceAll('-', '').toLowerCase();
    return (
        compact(target) === compact(event.locals.user?.userId ?? '') || localsIsAdmin(event.locals)
    );
}

/**
 * Middleware that authenticates Jellyfin-compatible clients via session token or PAT.
 *
 * Reads the X-Emby-Authorization (or Authorization) header, validates the
 * Token against Valkey, and populates event.locals with the same UserContext
 * shape as forward-auth so all downstream permission gates work identically.
 *
 * Token sources:
 * - Header (X-Emby-Authorization / Authorization): eligible for both session
 *   and PAT validation.
 * - Query string (api_key / token / ApiKey): eligible for session validation
 *   only. Query-string PATs are rejected without calling validateJellyfinCompatPat.
 *
 * @example
 * export const GET = withJellyfinAuth(async (event) => {
 *     return json({ username: event.locals.user.username });
 * });
 *
 * @example With pat: 'deny' (stream-fetch routes)
 * export const GET = withJellyfinAuth(handler, { pat: 'deny' });
 */
export function withJellyfinAuth(
    handler: RequestHandler,
    options?: WithJellyfinAuthOptions,
): RequestHandler {
    const patMode = options?.pat ?? 'allow';
    const routeMode = options?.mode ?? 'read';

    const authenticate = async (event: RequestEvent): Promise<Response> => {
        const endpoint = getEndpointName(event);
        // Only the /j credential decides on /j: never a principal left by
        // earlier code on the same event.
        event.locals.principal = undefined;

        // Parse both headers — Swiftfin puts metadata in X-Emby-Authorization
        // and token in Authorization. Streamyfin puts everything in X-Emby-Authorization.
        const embyHeader = event.request.headers.get('X-Emby-Authorization') || '';
        const authorizationHeader = event.request.headers.get('Authorization') || '';

        const embyParams = parseEmbyAuthHeader(embyHeader);
        const authParams =
            embyHeader !== authorizationHeader ? parseEmbyAuthHeader(authorizationHeader) : {};

        // Some clients (jellyfin-rpc, jellyfin-rpc2, Tautulli, others in the
        // Emby ecosystem) send the token in a bare single-value header rather
        // than packed in MediaBrowser Token=... — read those too.
        const bareTokenHeader =
            event.request.headers.get('X-Emby-Token') ||
            event.request.headers.get('X-MediaBrowser-Token') ||
            '';

        // Determine token and its source.
        // Header tokens are eligible for session + PAT validation.
        // Query-string tokens are eligible for session validation only.
        const headerToken =
            embyParams['Token'] || authParams['Token'] || bareTokenHeader.trim() || '';
        const queryToken =
            event.url.searchParams.get('api_key') ||
            event.url.searchParams.get('ApiKey') ||
            event.url.searchParams.get('token') ||
            '';

        const token = headerToken || queryToken;
        const tokenSource: 'header' | 'query' = headerToken ? 'header' : 'query';

        if (!token) {
            // WARN so 401s on /j/* routes are diagnosable in production logs.
            // Include header keys we did receive (values redacted) — clients
            // sometimes use slightly off header names (X-Emby-Token vs
            // X-Emby-Authorization, lowercase variants, etc.) and this is the
            // cheapest way to spot it without breaking client compatibility.
            const seenAuthHeaders = [
                'X-Emby-Authorization',
                'Authorization',
                'X-Emby-Token',
                'X-MediaBrowser-Token',
            ].filter((h) => Boolean(event.request.headers.get(h)));
            logger.warn('Jellyfin compat: missing Token in auth header', {
                endpoint,
                seenAuthHeaders,
                hasQueryApiKey:
                    event.url.searchParams.has('api_key') ||
                    event.url.searchParams.has('ApiKey') ||
                    event.url.searchParams.has('token'),
            });
            return ApiResponses.unauthorized('Authentication required', endpoint);
        }

        // Step 1: Try Valkey session — valid for both header and query tokens.
        // Pass pathname for the defense-in-depth /j/* prefix guard.
        const session = await validateSession(token, event.url.pathname).catch((error: unknown) => {
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            throw error;
        });
        if (session) {
            // Live-resolve groups, the admin pin, the age-rating pin
            // (`age_rating_pinned`/`max_age_rating`), disabled_at/deleted_at,
            // and the in-app merge via the SAME canonical resolver the
            // play-token and /j PAT paths use, instead of the session's
            // mint-time `session.groups` snapshot. Before this fix (security
            // review C9, 2026-09-15/16) an admin's per-user age cap and
            // library-group edits never took effect on an existing /j
            // session — the in-process L1 caches this reads through (10 min
            // TTL) are invalidated immediately by the admin PATCH path
            // (`invalidateUserMaxAgeCache`/`invalidateUserAdminCache` in
            // defs/admin/users/[username]/index.ts), so a lowered cap takes
            // effect on this session's very next request rather than being
            // frozen for the 30-day session TTL.
            //
            // SECURITY REVIEW 2026-09-16, task 6 (C6 + deleted_at follow-up):
            // this used to be TWO checks — this call, plus a second,
            // hand-rolled `SELECT is_admin, deleted_at, disabled_at` re-check
            // right above, gated on `getCachedIsAdmin(...) === null` so it
            // only ran on a cold isAdmin cache. That gate was wrong on its
            // own terms (isAdmin and disabled/deleted are cached and
            // invalidated independently — a warm isAdmin entry says nothing
            // about whether disabled/deleted is fresh) AND it duplicated the
            // disabled_at verdict `tokenAccess.disabled` below already
            // computes correctly through its OWN cache/DB seam, while
            // omitting deleted_at from THIS resolver entirely (it only read
            // `disabled_at`). Rather than re-gate that duplicate block on the
            // right cache entry, it was deleted: `resolveTokenUserAccess()`
            // now also resolves `deleted` (`users.deleted_at`) through the
            // same seam as `disabled`, cached and invalidated together
            // (`getCachedDeleted`/`setCachedDeleted`, cleared by the same
            // `invalidateUserAdminCache` call every disable/delete path
            // already makes) — so there is exactly ONE disabled/deleted
            // re-check on this path, unconditional on any other cache's
            // warmth, and both `/j` mint paths' fan-out sweep
            // (`revokeSessionsForUser`) and this re-check now agree on where
            // "is this account still live" is decided.
            const tokenAccess = await resolveTokenUserAccess(session.username);
            if (!tokenAccess) {
                // Missing users remain denied without destroying the session.
                // Dependency failures throw and become 503 below.
                return ApiResponses.unauthorized('Unable to verify account status', endpoint);
            }
            if (tokenAccess.disabled || tokenAccess.deleted) {
                const { revokeSession } = await import('./auth.js');
                await revokeSession(token);
                logger.info('jfcompat: session revoked for deactivated/disabled user', {
                    username: session.username,
                    disabled: tokenAccess.disabled,
                    deleted: tokenAccess.deleted,
                });
                return ApiResponses.unauthorized('Account deactivated', endpoint);
            }

            event.locals.user = {
                // session.userId is jellyfin_client_passwords.user_id, which FKs
                // users(id) — the stable users.id UUID (see validatePassword JOIN).
                userId: toUserId(session.userId),
                username: session.username,
                groups: tokenAccess.userGroups.join('|'),
                userGroups: tokenAccess.userGroups,
                ...tokenAccess.permissions,
                // A password session is the owner's full credential; set it
                // explicitly so /j play tokens never mint admin by default.
                mediaAccessIsAdmin: tokenAccess.permissions.ownerIsAdmin,
            };
            // The admin verdict (localsIsAdmin) reads the principal, never the user.
            event.locals.principal = buildPrincipal({
                kind: 'jellyfin_compat',
                userId: toUserId(session.userId),
                username: session.username,
                userGroups: tokenAccess.userGroups,
                // Plain read/write scopes, never a derived 'admin' scope set: a
                // Jellyfin client token lives on shared TVs, and nothing on /j
                // checks scopes. The admin verdict is isAdmin alone.
                tokenScopes: ['read', 'write'],
                sessionIsAdmin:
                    tokenAccess.permissions.ownerIsAdmin && session.origin !== 'quick_connect',
                credentialId: liveTvCredentialFingerprint('jf-session', token),
            });

            event.locals.authMethod = 'jellyfin_compat_session';
            (event.locals as unknown as Record<string, unknown>).jfToken = token;

            const jfClientName = embyParams['Client'] || authParams['Client'] || session.clientName;
            (event.locals as unknown as Record<string, unknown>).jfClientName = jfClientName;

            // Device identity for this request. Taken from the session (which was
            // bound to a device at token mint) rather than the per-request header,
            // which is unvalidated and can drift from the bound device.
            //
            // Jellyfin clients send a stable DeviceId, so /j devices are genuinely
            // distinguishable — they are not, as an earlier comment here claimed,
            // identity-less. Consumers must still handle a missing id: sessions
            // minted before this existed carry an empty string, and the PAT branch
            // below sets nothing at all.
            const jfClientVersion =
                embyParams['Version'] || authParams['Version'] || session.clientVersion || null;
            event.locals.jfDevice = {
                deviceId: session.deviceId || null,
                deviceName: session.deviceName || null,
                clientName: jfClientName || null,
                clientVersion: jfClientVersion,
            };
            event.locals.liveTvCredentialId = session.deviceId
                ? `jf-device:${session.deviceId}`
                : liveTvCredentialFingerprint('jf-session', token);

            await applyLiveTvUserPolicy(event.locals.user);
            const liveTvDenied = liveTvRouteGate(event);
            if (liveTvDenied) return liveTvDenied;

            logger.debug('Jellyfin compat: authenticated via session', {
                endpoint,
                username: session.username,
                clientName: session.clientName,
                deviceName: session.deviceName,
            });

            // Mode gate (post-auth): a read-only route refuses any non-safe
            // method even from a fully-authenticated session. Cheap defense
            // against accidental method exposure on read-annotated routes.
            if (routeMode === 'read' && !isReadMethod(event.request.method)) {
                logger.info('Jellyfin compat: write method rejected on read route (session)', {
                    endpoint,
                    method: event.request.method,
                    username: session.username,
                    clientName: session.clientName,
                });
                return ApiResponses.forbidden('This endpoint is read-only', endpoint);
            }

            // Legacy user-state /Users/{userId}/... routes alias the caller-scoped API.
            // Accept both UUID forms emitted by Jellyfin, and reject a foreign
            // path before any read or mutation. Only a real admin principal is exempt.
            if (!pathUserAllowed(event)) return ApiResponses.notFound('User');
            return handler(event);
        }

        // Step 2: PAT validation — header-source tokens only.
        // Query-string PATs are forbidden: skip validation entirely to avoid
        // a DB roundtrip on every poisoned query-string request.
        if (tokenSource === 'header') {
            // SECURITY: the PAT `allowed_ips` list is an AUTHORIZATION control,
            // so it must be keyed on the unforgeable peer.
            //
            // The comment that stood here said getClientIp() "returns the TCP
            // peer unless TRUSTED_PROXY_IPS is configured". That is backwards:
            // with TRUSTED_PROXY_IPS UNSET, getClientIp() trusts the immediate
            // peer to supply X-Forwarded-For and returns the header value (see
            // shouldHonorForwardedFor in client-ip.ts) — so a token holder could
            // satisfy an allowlist of 10.0.0.5 by sending
            // `X-Forwarded-For: 10.0.0.5` from anywhere. getClientIpStrict()
            // ignores forwarded headers unless the peer is explicitly allowlisted.
            //
            // Operator consequence: behind a reverse proxy with
            // TRUSTED_PROXY_IPS unset, this now sees the PROXY's address, so a
            // PAT restricted to a client address stops matching. That is the
            // control working — set TRUSTED_PROXY_IPS to restore per-client
            // resolution.
            const clientIp = getClientIpStrict(event);

            const patAuth = await validateJellyfinCompatPat(token, clientIp).catch(
                (error: unknown) => {
                    if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
                    logger.warn('Jellyfin compat: PAT validation failed', { error: String(error) });
                    return null; // Fall through to the same throttled 401 as an invalid PAT.
                },
            );
            if (patAuth) {
                if (patMode === 'deny') {
                    logger.info('Jellyfin compat: valid PAT rejected on pat:deny route', {
                        endpoint,
                        username: patAuth.username,
                        route: event.url.pathname,
                        method: event.request.method,
                    });
                    if (patAuth.isReadOnly) {
                        const { tokenId, userId } = patAuth;
                        void notifyJellyfinPatDenied({ tokenId, userId }).catch((err: unknown) => {
                            logger.error(
                                'Jellyfin compat: failed to notify PAT owner',
                                err as Error,
                                {
                                    tokenId,
                                },
                            );
                        });
                    }
                    // Return 403, NOT 401 — valid credential, wrong route type.
                    // Do NOT increment any rate-limit failure counter here.
                    return ApiResponses.forbidden(
                        'API key not permitted on this endpoint; use a session token',
                    );
                }

                // Spread the full patAuth shape so every UserPermissions field
                // (maxAgeRating, isAgeRestricted, hasRequestPermission, isModerator,
                // liveTvPriority, etc.) carries through to /j/* read-route gates.
                // patAuth has isAdmin: false already forced last in pat-auth.ts.
                // Exclude isReadOnly and tokenId — middleware concerns, not part
                // of the UserContext shape consumed by downstream handlers.
                const { isReadOnly: patIsReadOnly, tokenId: _tokenId, ...userFields } = patAuth;
                event.locals.user = { ...userFields, mediaAccessIsAdmin: false };
                // A /j API key is never admin.
                event.locals.principal = buildPrincipal({
                    kind: 'jellyfin_compat',
                    userId: userFields.userId,
                    username: userFields.username,
                    userGroups: userFields.userGroups ?? [],
                    tokenScopes: patIsReadOnly ? ['read'] : ['read', 'write'],
                    sessionIsAdmin: false,
                    credentialId: liveTvCredentialFingerprint('jf-pat', token),
                });

                event.locals.authMethod = 'jellyfin_compat_pat';
                event.locals.liveTvCredentialId = liveTvCredentialFingerprint('jf-pat', token);
                // PAT tokens cannot be replayed against jfcompat:session:* — use
                // empty string so embedded &api_key= params in returned URLs are
                // harmless (stream-fetch routes are pat: 'deny', so PAT holders
                // never reach URL-embedding code paths).
                (event.locals as unknown as Record<string, unknown>).jfToken = '';
                (event.locals as unknown as Record<string, unknown>).jfClientName =
                    embyParams['Client'] || authParams['Client'] || '';

                await applyLiveTvUserPolicy(event.locals.user);
                const liveTvDenied = liveTvRouteGate(event);
                if (liveTvDenied) return liveTvDenied;

                logger.debug('Jellyfin compat: authenticated via PAT', {
                    endpoint,
                    username: patAuth.username,
                    isReadOnly: patAuth.isReadOnly,
                });

                // Read-only PAT (scopes=['jellyfin_compat_read']) can never
                // hit a write method, regardless of the route's declared mode.
                // The scope itself promises read-only — honor that.
                if (patAuth.isReadOnly && !isReadMethod(event.request.method)) {
                    logger.info('Jellyfin compat: read-only PAT rejected on write route', {
                        endpoint,
                        method: event.request.method,
                        username: patAuth.username,
                        clientName: embyParams['Client'] || authParams['Client'] || '',
                    });
                    return ApiResponses.forbidden(
                        'API key is read-only and may not write to this endpoint',
                    );
                }

                // Mode gate for full-access PATs on read routes — mirrors the
                // session-path check so a write-capable PAT cannot reach a
                // read-annotated handler with an unsafe method.
                if (routeMode === 'read' && !isReadMethod(event.request.method)) {
                    logger.info('Jellyfin compat: write method rejected on read route (PAT)', {
                        endpoint,
                        method: event.request.method,
                        username: patAuth.username,
                        clientName: embyParams['Client'] || authParams['Client'] || '',
                    });
                    return ApiResponses.forbidden('This endpoint is read-only', endpoint);
                }

                // Legacy user-state /Users/{userId}/... routes alias the caller-scoped API.
                // Accept both UUID forms emitted by Jellyfin, and reject a foreign
                // path before any read or mutation. Only a real admin principal is exempt.
                if (!pathUserAllowed(event)) return ApiResponses.notFound('User');
                return handler(event);
            }
        }

        // Step 3: Both session and PAT validation failed (or token was query-source
        // and had no matching session). Increment IP failure counter; 429 over threshold.
        // (Valid-PAT-deny is handled above and does NOT reach here, by design.)
        // SECURITY: strict, not lenient — same reasoning as forward-auth.ts's
        // apiv1:auth_fail bucket. Keyed on the spoofable IP, an attacker rotates
        // X-Forwarded-For per request and gets a fresh bucket every time, so the
        // brute-force throttle stops existing. This surface bypasses the central
        // auth gate and is reachable by TV clients, which makes the throttle the
        // only thing standing there.
        const failureClientIp = getClientIpStrict(event);
        const rate = await checkRateLimit(
            `jfcompat:auth_fail:${failureClientIp}`,
            FAILED_AUTH_LIMIT_PER_MINUTE,
            FAILED_AUTH_WINDOW_SECONDS,
        );
        if (!rate.allowed) {
            logger.warn('Jellyfin compat: auth failure rate limit exceeded', {
                endpoint,
                clientIp: failureClientIp,
                resetAt: rate.resetAt,
            });
            return ApiResponses.rateLimited(rate.resetAt * 1000, endpoint);
        }
        // Log at WARN with the first 12 chars only — matches the `token_prefix`
        // column stored in personal_access_tokens, so an operator can cross-reference
        // the failing token against the DB without ever having full plaintext in logs.
        // Safe: PAT format is `pat_<48-hex>`; 12 chars = `pat_` + 8 hex (~32 bits) which
        // can't reconstruct the SHA-256-hashed credential.
        logger.warn('Jellyfin compat: invalid or expired token', {
            endpoint,
            tokenSource,
            tokenPrefix: token.slice(0, 12),
        });
        return ApiResponses.unauthorized('Invalid or expired token', endpoint);
    };
    return async (event: RequestEvent): Promise<Response> => {
        try {
            return await authenticate(event);
        } catch (error) {
            if (error instanceof AuthDependencyUnavailableError) return authUnavailableResponse();
            throw error;
        }
    };
}

/**
 * True when the request carries a Jellyfin credential in any of the places
 * withJellyfinAuth reads: X-Emby-Authorization / Authorization (`Token=`),
 * X-Emby-Token / X-MediaBrowser-Token, or `api_key` / `ApiKey` / `token`.
 * Says nothing about whether it is valid.
 */
export function hasJellyfinCredential(event: RequestEvent): boolean {
    const { headers } = event.request;
    const embyParams = parseEmbyAuthHeader(headers.get('X-Emby-Authorization') || '');
    const authParams = parseEmbyAuthHeader(headers.get('Authorization') || '');
    return Boolean(
        embyParams['Token'] ||
        authParams['Token'] ||
        (headers.get('X-Emby-Token') || '').trim() ||
        (headers.get('X-MediaBrowser-Token') || '').trim() ||
        event.url.searchParams.get('api_key') ||
        event.url.searchParams.get('ApiKey') ||
        event.url.searchParams.get('token'),
    );
}

/**
 * For /j routes that stay reachable without a session (a Jellyfin client or a
 * Seerr page loads an `<img>` it cannot sign) but must not hand personal data
 * to an anonymous caller. A valid Jellyfin session runs `handler`; no
 * credential, or one that does not validate, gets `anonymous()`: the same
 * answer either way, so a bad token tells the caller nothing more than none.
 */
export function withOptionalJellyfinAuth(
    handler: RequestHandler,
    anonymous: (event: RequestEvent) => Response | Promise<Response>,
): RequestHandler {
    const authed = withJellyfinAuth(handler);
    return async (event: RequestEvent): Promise<Response> => {
        if (!hasJellyfinCredential(event)) return anonymous(event);
        const response = await authed(event);
        // withJellyfinAuth answers 401 for an unknown/expired/deactivated token
        // (the handler never returns 401) and 403 for a refused PAT or method.
        if (response.status === 401 || response.status === 403) return anonymous(event);
        return response;
    };
}
