// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Xtream Codes credential validation and URL construction.
 *
 * Translates Xtream Codes credentials to M3U/XMLTV URLs for the import pipeline.
 * This module is a pure utility — no database persistence (Story 2.7's responsibility).
 */

import * as m from '$lib/paraglide/messages.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { isRecord, toString, parseNumber } from '$lib/utils/data-extraction.js';
import { Logger } from '$lib/server/utils/logger.js';
import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import { getLiveTvUpstreamDispatcher } from './upstream-proxy.js';
import { pinnedFetch } from '$lib/server/utils/ssrf-guard.js';
import { BODY_TOO_LARGE, readBoundedBodyText } from '$lib/server/utils/bounded-body-reader.js';

const logger = Logger.for('XtreamClient');

// ── Types ────────────────────────────────────────────────────────────────────

export interface XtreamCredentials {
    /** Xtream Codes server base URL (e.g., "http://provider.example.com:8080") */
    serverUrl: string;
    /** Xtream Codes username */
    username: string;
    /** Xtream Codes password */
    password: string;
}

export interface XtreamUrls {
    /** M3U Plus URL: {serverUrl}/get.php?username={u}&password={p}&type=m3u_plus */
    m3uUrl: string;
    /** XMLTV EPG URL: {serverUrl}/xmltv.php?username={u}&password={p} */
    xmltvUrl: string;
}

export type XtreamValidationResult =
    | {
          valid: true;
          /** Server-reported info from auth response */
          serverInfo: {
              /** Server name (if provided in auth response) */
              serverName: string | undefined;
              /** Expiration timestamp (if provided) */
              expiresAt: string | undefined;
              /** Max allowed connections (if provided) */
              maxConnections: number | undefined;
              /** Active connections count (if provided) */
              activeConnections: number | undefined;
              /** Whether account is active */
              isActive: boolean;
          };
          /** Generated URLs for import pipeline */
          urls: XtreamUrls;
      }
    | {
          valid: false;
          /** Human-readable error reason */
          reason: string;
          /** Error classification */
          errorType:
              | 'invalid_credentials'
              | 'server_unreachable'
              | 'invalid_response'
              | 'ssrf_blocked'
              | 'timeout';
      };

// ── Internal types ───────────────────────────────────────────────────────────

interface XtreamAuthParsed {
    status: string;
    expDate: string | undefined;
    maxConnections: number | undefined;
    activeCons: number | undefined;
    serverName: string | undefined;
}

// ── URL Construction ─────────────────────────────────────────────────────────

/** Strip trailing slash to avoid double slashes in URL construction. */
function stripTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Construct M3U and XMLTV URLs from Xtream Codes credentials.
 */
export function buildXtreamUrls(credentials: XtreamCredentials): XtreamUrls {
    const { serverUrl, username, password } = credentials;

    const baseUrl = stripTrailingSlash(serverUrl);

    const m3uUrl = new URL(`${baseUrl}/get.php`);
    m3uUrl.searchParams.set('username', username);
    m3uUrl.searchParams.set('password', password);
    m3uUrl.searchParams.set('type', 'm3u_plus');

    const xmltvUrl = new URL(`${baseUrl}/xmltv.php`);
    xmltvUrl.searchParams.set('username', username);
    xmltvUrl.searchParams.set('password', password);

    return {
        m3uUrl: m3uUrl.toString(),
        xmltvUrl: xmltvUrl.toString(),
    };
}

// ── Credential Validation ────────────────────────────────────────────────────

/**
 * Validate Xtream Codes credentials against the provider's auth endpoint.
 * Returns a result object — never throws.
 */
export async function validateXtreamCredentials(
    credentials: XtreamCredentials,
): Promise<XtreamValidationResult> {
    const { serverUrl, username, password } = credentials;

    // Extract hostname for safe logging (never log full URL with credentials)
    let hostname: string;
    try {
        hostname = new URL(serverUrl).hostname;
    } catch {
        // best-effort: malformed server URL is a validation failure, returned as a result.
        return {
            valid: false,
            reason: 'Invalid server URL format',
            errorType: 'invalid_response',
        };
    }

    // Step 1+2: Build the auth URL, then SSRF-validate and fetch it, following
    // any redirect manually so every hop is re-validated.
    const baseUrl = stripTrailingSlash(serverUrl);
    const authUrl = new URL(`${baseUrl}/player_api.php`);
    authUrl.searchParams.set('username', username);
    authUrl.searchParams.set('password', password);

    // Step 3: Make auth request
    let response: Response;
    let redirected: boolean;
    try {
        const outcome = await fetchAuthFollowingRedirects(authUrl.toString());
        response = outcome.response;
        redirected = outcome.redirected;
    } catch (err: unknown) {
        if (err instanceof XtreamSsrfBlockedError) {
            logger.warn('Xtream Codes SSRF blocked', { server: hostname });
            return {
                valid: false,
                reason: err.message,
                errorType: 'ssrf_blocked',
            };
        }
        if (err instanceof XtreamRedirectRejectedError) {
            const reason = redactLiveTvUrlsInText(err.message);
            logger.warn('Xtream Codes auth redirect rejected', {
                server: hostname,
                reason,
            });
            return {
                valid: false,
                reason: `Server redirect rejected: ${reason}`,
                errorType: 'invalid_response',
            };
        }
        if (isTimeoutError(err)) {
            logger.warn('Xtream Codes auth timeout', { server: hostname });
            return {
                valid: false,
                reason: 'Server did not respond within 10 seconds',
                errorType: 'timeout',
            };
        }
        // The auth URL carries `?username=&password=` — never echo it.
        const message = redactLiveTvUrlsInText(err instanceof Error ? err.message : String(err));
        logger.warn('Xtream Codes auth failed', {
            server: hostname,
            error: message,
        });
        return {
            valid: false,
            reason: `Server unreachable: ${message}`,
            errorType: 'server_unreachable',
        };
    }

    // Step 4: Handle HTTP error responses
    if (!response.ok) {
        // Free the pinned connection now rather than when the deadline fires.
        void response.body?.cancel().catch(() => {});
        if (redirected) {
            // The target was chosen by the provider, not by the operator.
            // Echoing its status (or mapping 401/403 to "bad credentials")
            // would answer "is this internal port open?" for the attacker.
            logger.warn('Xtream Codes auth redirect target returned an error', {
                server: hostname,
            });
            return {
                valid: false,
                reason: 'The server redirected to a target that returned an error',
                errorType: 'invalid_response',
            };
        }
        if (response.status === 401 || response.status === 403) {
            logger.info('Xtream Codes auth rejected', { server: hostname });
            return {
                valid: false,
                reason: 'Invalid username or password',
                errorType: 'invalid_credentials',
            };
        }
        logger.warn('Xtream Codes auth HTTP error', {
            server: hostname,
            status: response.status,
        });
        return {
            valid: false,
            reason: `Server returned HTTP ${response.status}`,
            errorType: 'invalid_response',
        };
    }

    // Step 5: Parse JSON response
    let body: unknown;
    try {
        const text = await readBoundedBodyText(response, MAX_AUTH_RESPONSE_BYTES);
        if (text === BODY_TOO_LARGE) {
            logger.warn('Xtream Codes auth response too large', { server: hostname });
            return {
                valid: false,
                reason: 'Server returned an unexpectedly large response',
                errorType: 'invalid_response',
            };
        }
        body = JSON.parse(text);
    } catch (err: unknown) {
        // The deadline also covers the body read: a server that sends headers
        // and then stalls is a timeout, not a malformed response.
        if (isTimeoutError(err)) {
            logger.warn('Xtream Codes auth timeout', { server: hostname });
            return {
                valid: false,
                reason: 'Server did not respond within 10 seconds',
                errorType: 'timeout',
            };
        }
        logger.warn('Xtream Codes auth non-JSON response', {
            server: hostname,
        });
        return {
            valid: false,
            reason: 'Server returned an invalid response',
            errorType: 'invalid_response',
        };
    }

    // Step 6: Parse auth response defensively
    const parsed = parseAuthResponse(body);
    if (!parsed) {
        // Distinguish between missing user_info (invalid response) and auth: 0 (invalid creds)
        const hasUserInfo = isRecord(body) && isRecord(body.user_info);
        if (hasUserInfo) {
            // Had user_info but auth: 0 → invalid credentials
            logger.info('Xtream Codes auth rejected', { server: hostname });
            return {
                valid: false,
                reason: 'Invalid username or password',
                errorType: 'invalid_credentials',
            };
        }
        // No user_info at all → invalid response format
        logger.warn('Xtream Codes auth invalid response structure', {
            server: hostname,
        });
        return {
            valid: false,
            reason: 'Server returned an invalid response',
            errorType: 'invalid_response',
        };
    }

    // Step 7: Check account status
    const isActive = parsed.status.trim().toLowerCase() === 'active';
    if (!isActive) {
        const knownStatus = ['Expired', 'Disabled', 'Banned'].find(
            (status) => status.toLowerCase() === parsed.status.trim().toLowerCase(),
        );
        logger.info('Xtream Codes account not active', {
            server: hostname,
            status: knownStatus ?? 'inactive',
        });
        return {
            valid: false,
            reason: knownStatus ? `Account is ${knownStatus}` : m.livetv_admin_xtream_inactive(),
            errorType: 'invalid_credentials',
        };
    }

    // Step 8: Build URLs and return success
    const urls = buildXtreamUrls(credentials);

    logger.info('Xtream Codes auth successful', {
        server: hostname,
        valid: true,
    });

    return {
        valid: true,
        serverInfo: {
            serverName: parsed.serverName ? redactLiveTvUrlsInText(parsed.serverName) : undefined,
            expiresAt: parsed.expDate,
            maxConnections: parsed.maxConnections,
            activeConnections: parsed.activeCons,
            isActive: true,
        },
        urls,
    };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Redirect hops followed before giving up. A 6th redirect is rejected. */
const MAX_REDIRECT_HOPS = 5;

/** A hop (the first or a redirect target) failed SSRF validation. */
class XtreamSsrfBlockedError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'XtreamSsrfBlockedError';
    }
}

/**
 * Largest `player_api.php` auth response accepted. A real one is a few hundred
 * bytes (user_info + server_info); anything near this is not an Xtream panel.
 */
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;

/** The request deadline fired: `AbortError` (DOMException) or Node's `TimeoutError`. */
function isTimeoutError(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
}

/** A redirect hop was refused: too many hops, or the target was unreachable. */
class XtreamRedirectRejectedError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'XtreamRedirectRejectedError';
    }
}

/**
 * SSRF-validate and fetch the auth URL, following redirects MANUALLY and
 * re-validating every hop under the same policy (security review 2026-09-12,
 * C6). Without this the provider could answer `302 Location: http://127.0.0.1:…`
 * and use the echoed status as an internal port oracle.
 *
 * Returns the final response plus whether any redirect was followed, so the
 * caller can report a redirected failure generically.
 */
async function fetchAuthFollowingRedirects(
    initialUrl: string,
): Promise<{ response: Response; redirected: boolean }> {
    // When a proxy dispatcher is active the request goes through it unpinned:
    // the proxy re-resolves DNS and CONNECTs to the original hostname.
    const dispatcher = getLiveTvUpstreamDispatcher();
    // One deadline for the whole chain (and the caller's body read), so a
    // redirect chain can't multiply the 10s budget by the hop count.
    const signal = AbortSignal.timeout(10_000);
    let currentUrl = initialUrl;

    for (let hop = 0; ; hop++) {
        const redirected = hop > 0;
        const ssrfResult = await validateUrl(currentUrl, {
            allowPrivateIps: config.LIVETV_ALLOW_PRIVATE_URLS,
        });
        if (!ssrfResult.valid) {
            throw new XtreamSsrfBlockedError(ssrfResult.reason);
        }

        let response: Response;
        try {
            // pinnedFetch pins a direct connection to the vetted address in the
            // transport (the URL keeps its hostname, so Host and TLS SNI stay
            // right) and routes a proxied one through the dispatcher unpinned.
            response = await pinnedFetch(
                { url: new URL(currentUrl), resolvedIp: ssrfResult.resolvedIp },
                {
                    // This loop follows redirects so every hop is re-validated.
                    redirect: 'manual',
                    signal,
                    dispatcher,
                },
            );
        } catch (err) {
            // A connect failure against an operator-supplied URL is worth
            // reporting verbatim; against a provider-chosen redirect target it
            // is a port oracle, so it collapses to one generic message. A
            // timeout reveals nothing about the target and keeps its own type.
            if (redirected && !isTimeoutError(err)) {
                throw new XtreamRedirectRejectedError('the redirect target could not be reached');
            }
            throw err;
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (!isRedirect) return { response, redirected };

        const location = response.headers.get('location');
        if (!location) return { response, redirected };
        void response.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECT_HOPS) {
            throw new XtreamRedirectRejectedError(`too many redirects (>${MAX_REDIRECT_HOPS})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
    }
}

/**
 * Defensively parse an Xtream Codes auth response.
 * Returns null if the response indicates invalid credentials or is malformed.
 */
function parseAuthResponse(body: unknown): XtreamAuthParsed | null {
    if (!isRecord(body)) return null;
    const userInfo = isRecord(body.user_info) ? body.user_info : null;
    if (!userInfo) return null;

    // auth: 0 means invalid credentials (some servers use this pattern)
    if (userInfo.auth === 0 || userInfo.auth === '0') return null;

    const serverInfo = isRecord(body.server_info) ? body.server_info : null;

    return {
        status: toString(userInfo.status) || 'Unknown',
        expDate: toString(userInfo.exp_date) || undefined,
        maxConnections: parseNumber(userInfo.max_connections),
        activeCons: parseNumber(userInfo.active_cons),
        serverName: serverInfo ? toString(serverInfo.url) || undefined : undefined,
    };
}
