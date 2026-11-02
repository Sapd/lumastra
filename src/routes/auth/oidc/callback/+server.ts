// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /auth/oidc/callback — the OIDC redirect target.
 *
 * Validates the callback (state ↔ cookie binding, single-use transaction, ID-token
 * verification), resolves/provisions the local user (verified-email and opt-in
 * username linking, takeover-guarded), mints a normal `lumastra_session`, and lands
 * the user on their validated returnTo. All failures bounce to /login (or /setup
 * for the first-run-not-admin case) with a generic message — no internal detail
 * leaks to the browser.
 *
 * Each failure branch additionally mints a short CORRELATION REFERENCE, logs it
 * alongside the real cause, and appends it to the redirect as `&ref=…`. The
 * banner renders it as "(reference: a1b2c3d4)". That is an opaque grep key, not
 * internal detail — it preserves the no-leak principle above while giving a
 * self-hosting user something concrete to paste into a bug report and a
 * maintainer something to grep for. See $lib/shared/auth-failure-ref.
 *
 * Security posture (cf. the Audiobookshelf OIDC advisories):
 *   - tokens are NEVER placed in a URL: success delivers an HttpOnly, origin-scoped
 *     session cookie and redirects to a same-origin RELATIVE path only
 *     (sanitizeRedirect), so there is nothing to leak even if returnTo regressed;
 *   - every redirect carries Referrer-Policy: no-referrer so the OAuth `code` in
 *     this callback URL can't leak via Referer;
 *   - discovery/token/userinfo targets come only from admin config, not request
 *     input — no SSRF surface.
 *
 * Public surface (in NATIVE_AUTH_PUBLIC_PATHS). It is a GET, so the CSRF origin
 * guard (unsafe methods only) does not apply; the state↔cookie binding is the
 * login-CSRF defense.
 */

import type { RequestHandler } from './$types';
import { Logger } from '$lib/server/utils/logger.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { adminExists } from '$lib/server/database/queries/index.js';
import { config } from '$lib/server/config.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { setSessionCookie, sessionMaxAgeSeconds } from '$lib/server/auth/native-session.js';
import { invalidateAdminExistsCache } from '$lib/server/middleware/forward-auth.js';
import { ensureUserProfileExists } from '$lib/server/database/queries/user-ratings.queries.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import {
    handleCallback,
    resolveOrProvisionOidcUser,
    OidcFirstUserNotAdminError,
    OidcAccountDisabledError,
    OidcNotConfiguredError,
} from '$lib/server/services/oidc.service.js';
import { OIDC_TX_COOKIE, OIDC_TX_COOKIE_PATH, oidcRedirect } from '$lib/server/auth/oidc-cookie.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    AUTH_FAILURE_REF_PARAM,
    newAuthFailureRef,
    type AuthFailureMessage,
} from '$lib/shared/auth-failure-ref.js';
import { describeFetchFailure } from '$lib/server/utils/fetch-error-cause.js';
import { syncIdpAvatar } from '$lib/server/services/idp-avatar-sync.service.js';

const logger = Logger.for('OIDC:callback');

/**
 * Redirect carrying the generic message plus the correlation reference. `msg` is
 * typed to the shared allowlist so the login banner (which renders only known
 * strings) can never fall out of sync with what this route sends.
 */
const failureRedirect = (path: string, msg: AuthFailureMessage, ref: string): Response =>
    oidcRedirect(
        `${path}?error=${encodeURIComponent(msg)}&${AUTH_FAILURE_REF_PARAM}=${encodeURIComponent(ref)}`,
    );

const loginError = (msg: AuthFailureMessage, ref: string): Response =>
    failureRedirect('/login', msg, ref);

export const GET: RequestHandler = async (event) => {
    const cookieState = event.cookies.get(OIDC_TX_COOKIE) ?? null;
    // Consume the binding cookie regardless of outcome (single use).
    event.cookies.delete(OIDC_TX_COOKIE, { path: OIDC_TX_COOKIE_PATH });

    // Minted ONCE per request rather than per failure branch, so it can be handed
    // to oidc.service.ts before we know whether the request will fail. Several of
    // the log lines that actually explain a failure are emitted in there (e.g.
    // "groups claim resolved to no groups", which is the cause of the
    // first-user-not-admin bounce below), and they are only useful to a maintainer
    // if they carry the same reference the user was shown. Unused on success.
    const ref = newAuthFailureRef();

    // The IdP signalled an error (user cancelled, access denied, …).
    if (event.url.searchParams.get('error')) {
        logger.warn('OIDC provider returned an error', {
            error: event.url.searchParams.get('error'),
            ref,
        });
        return loginError('Sign-in was cancelled or failed.', ref);
    }

    // 1) Validate + verify + parse the verified claims.
    let result;
    try {
        result = await handleCallback({ currentUrl: event.url, cookieState, ref });
    } catch (error) {
        if (error instanceof OidcNotConfiguredError) {
            logger.warn('OIDC callback validation failed', { ref });
        } else {
            logger.warn('OIDC callback validation failed', {
                error: describeFetchFailure(error),
                ref,
            });
        }
        return loginError('Sign-in failed. Please try again.', ref);
    }

    const sql = await aiDbService.getSql();
    if (!sql) {
        logger.error('Database unavailable during OIDC callback', { ref });
        return loginError('Sign-in is temporarily unavailable.', ref);
    }

    // 2) Resolve / provision the local user (first-run requires an admin).
    const firstRun = !(await adminExists(sql, config.ADMIN_GROUPS));
    let resolved;
    try {
        resolved = await resolveOrProvisionOidcUser(sql, result.claims, {
            firstRunRequiresAdmin: firstRun,
            ref,
        });
    } catch (error) {
        if (error instanceof OidcFirstUserNotAdminError) {
            // Previously returned silently — an operator saw the /setup banner
            // with no matching log line at all, so there was nothing to grep.
            logger.warn('OIDC first user is not in an admin group', {
                groupsClaim: 'AUTH_OIDC_GROUPS_CLAIM',
                ref,
            });
            return failureRedirect(
                '/setup',
                'The first user must be in an admin group (see ADMIN_GROUPS).',
                ref,
            );
        }
        if (error instanceof OidcAccountDisabledError) {
            // Also previously silent.
            logger.warn('OIDC sign-in refused for a disabled account', { ref });
            return loginError('This account is disabled.', ref);
        }
        logger.error(
            'OIDC user resolution failed',
            error instanceof Error ? error : new Error(String(error)),
            { ref },
        );
        return loginError('Sign-in failed. Please try again.', ref);
    }

    // Best-effort: ensure FK-dependent profile rows exist (ratings/watchlist).
    // user_profiles.user_id is the users.id UUID (mig 16.46.0); resolved.userId
    // is that UUID from the OIDC user resolution.
    try {
        await ensureUserProfileExists(sql, toUserId(resolved.userId));
    } catch {
        /* non-fatal */
    }

    // 3) Mint a session and set the cookie. Tokens never touch the URL.
    const { token, expiresAt } = await getSessionService().create({
        userId: resolved.userId,
        userAgent: event.request.headers.get('user-agent'),
        ip: getClientIp(event),
        oidc: {
            iss: result.claims.issuer,
            sub: result.claims.subject,
            sid: result.sessionId ?? null,
        },
    });
    setSessionCookie(event.cookies, token, sessionMaxAgeSeconds(expiresAt));

    // Background: store the IdP's `picture` as the fallback avatar. Off the login
    // path (it may fetch a remote image); never throws.
    void syncIdpAvatar(sql, {
        userId: resolved.userId,
        username: resolved.username,
        picture: result.claims.picture ?? null,
        issuer: result.claims.issuer,
    });

    // First admin just onboarded via OIDC — first-run is over for everyone now.
    if (firstRun) invalidateAdminExistsCache();

    logger.info('OIDC login succeeded', {
        username: resolved.username,
        linkType: resolved.linkType,
        isAdmin: resolved.isAdmin,
    });

    // A first-run OIDC sign-in just created the admin — send them back into the
    // wizard to finish onboarding (preferences → library → scan) rather than
    // dropping them on the dashboard. This can't ride returnTo: sanitizeRedirect
    // deliberately rejects /setup (→ '/'). /setup gates itself — it resumes only
    // for an authenticated, library-less admin and bounces everyone else — so
    // routing there here is safe even if a library already exists.
    if (firstRun) {
        return oidcRedirect('/setup');
    }

    // returnTo was sanitized at login; re-sanitize defensively before the redirect.
    return oidcRedirect(sanitizeRedirect(result.returnTo, '/'));
};
