// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side authentication monitoring
 * Detects when user authentication has expired and handles gracefully
 */

import { browser, version } from '$app/environment';
import { base } from '$app/paths';
import { url } from './paths.js';
import { Z } from '$lib/utils/z-index';

// Track consecutive API failures
let consecutiveAuthFailures = 0;
const MAX_AUTH_FAILURES = 3;

// Track last successful API call
let lastSuccessfulCall = Date.now();
const MAX_TIME_SINCE_SUCCESS = 5 * 60 * 1000; // 5 minutes

// Reload protection - use localStorage to persist across tab reloads
const RELOAD_COOLDOWN_KEY = 'dashboard-last-reload';
const RELOAD_COOLDOWN_MS = 60 * 1000; // Don't reload more than once per minute
const RELOAD_LOOP_KEY = 'dashboard-reload-loop-detected';
const MAX_RELOADS_PER_SESSION = 2; // Max reloads before we stop trying

// Reload protection for new-deployment reloads - separate key/cooldown from the
// auth reload tracking above so a version-triggered reload doesn't consume the
// auth reload budget (and vice versa).
const UPDATE_RELOAD_COOLDOWN_KEY = 'lumastra-update-reload';
const UPDATE_RELOAD_COOLDOWN_MS = 60 * 1000; // Don't reload more than once per minute

// Global flag to prevent multiple simultaneous reload attempts
let reloadInProgress = false;

// Global flag to stop all polling when auth fails (prevents 401 spam)
let authFailureDetected = false;

// Interval ID for auth monitoring (prevents duplicate intervals)
let authMonitorInterval: ReturnType<typeof setInterval> | null = null;

type ReloadTrackingData = {
    timestamp: number;
    count: number;
};

function parseReloadTrackingData(raw: string | null): ReloadTrackingData | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        const timestamp = Number(record.timestamp);
        const count = Number(record.count);
        if (!Number.isFinite(timestamp) || !Number.isFinite(count)) {
            return null;
        }
        return { timestamp, count };
    } catch {
        /* expected: JSON.parse failure on corrupt localStorage reload-tracking data */
        return null;
    }
}

/**
 * Check if auth has failed and polling should stop
 */
export function isAuthFailed(): boolean {
    return authFailureDetected;
}

/**
 * Reset auth failure state (for manual refresh/retry)
 */
export function resetAuthFailure() {
    authFailureDetected = false;
    consecutiveAuthFailures = 0;
    reloadInProgress = false;
}

/**
 * Monitor API responses for auth issues
 */
export function reportApiCall(success: boolean, isAuthRelated = false) {
    if (!browser) return;

    if (success) {
        consecutiveAuthFailures = 0;
        lastSuccessfulCall = Date.now();
    } else if (isAuthRelated) {
        consecutiveAuthFailures++;

        console.warn(`[AuthMonitor] Auth failure ${consecutiveAuthFailures}/${MAX_AUTH_FAILURES}`);

        if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
            console.warn('[AuthMonitor] Too many auth failures detected');
            authFailureDetected = true;
            void handleAuthExpiration();
        }
    }
}

/**
 * Check if authentication might be expired based on patterns
 */
export function checkAuthHealth(): boolean {
    if (!browser) return true;

    const timeSinceSuccess = Date.now() - lastSuccessfulCall;

    if (timeSinceSuccess > MAX_TIME_SINCE_SUCCESS && consecutiveAuthFailures > 0) {
        console.warn('[AuthMonitor] Auth health check failed - long time since success + failures');
        void handleAuthExpiration();
        return false;
    }

    return true;
}

/**
 * Check if we can safely reload (prevent infinite reload loops)
 */
function canReload(): boolean {
    if (!browser) return false;

    try {
        // Check if we've detected a reload loop (persistent across reloads)
        const loopData = parseReloadTrackingData(localStorage.getItem(RELOAD_LOOP_KEY));
        if (loopData) {
            const timeSinceLoop = Date.now() - loopData.timestamp;

            // If loop was detected less than 5 minutes ago, don't reload
            if (timeSinceLoop < 5 * 60 * 1000) {
                console.error(
                    '[AuthMonitor] Reload loop detected - preventing automatic reload. Please refresh manually.',
                );
                return false;
            } else {
                // Clear old loop detection
                localStorage.removeItem(RELOAD_LOOP_KEY);
            }
        }

        // Check cooldown using localStorage (persists across reloads)
        const lastReloadData = parseReloadTrackingData(localStorage.getItem(RELOAD_COOLDOWN_KEY));
        if (lastReloadData) {
            const timeSinceReload = Date.now() - lastReloadData.timestamp;

            if (timeSinceReload < RELOAD_COOLDOWN_MS) {
                console.warn('[AuthMonitor] Skipping reload - too soon since last reload');
                return false;
            }

            // Check if we've reloaded too many times in this session
            if (lastReloadData.count >= MAX_RELOADS_PER_SESSION) {
                console.error(
                    '[AuthMonitor] Too many reloads detected - stopping automatic reloads',
                );
                localStorage.setItem(
                    RELOAD_LOOP_KEY,
                    JSON.stringify({
                        timestamp: Date.now(),
                        count: lastReloadData.count,
                    }),
                );
                return false;
            }
        }

        return true;
    } catch (error) {
        // If we can't access storage, be conservative and don't reload
        console.error('[AuthMonitor] Storage access error:', error);
        return false;
    }
}

/**
 * Show user-friendly auth error notification
 */
function showAuthErrorNotification(
    title = 'Authentication Required',
    message = 'Your session has expired. Please refresh the page to re-authenticate.',
) {
    if (!browser) return;

    // Create a notification div if it doesn't exist
    let notification = document.getElementById('auth-error-notification');
    if (!notification) {
        notification = document.createElement('div');
        notification.id = 'auth-error-notification';
        notification.innerHTML = `
            <div style="
                position: fixed;
                top: 20px;
                right: 20px;
                background: #ef4444;
                color: white;
                padding: 16px 24px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: ${Z.SYSTEM_OVERLAY};
                max-width: 400px;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <div style="font-weight: bold; margin-bottom: 8px;">${title}</div>
                <div style="font-size: 14px; margin-bottom: 12px;">${message}</div>
                <button onclick="window.location.reload()" style="
                    background: white;
                    color: #ef4444;
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-weight: bold;
                ">Refresh Now</button>
            </div>
        `;
        document.body.appendChild(notification);
    }
}

/**
 * Distinguish "the server shipped a new build" from genuine session expiry.
 * Stale clients hitting a new deploy produce auth-shaped failures; reloading
 * with the new build fixes them, and the auth banner would be misleading.
 */
async function isNewVersionDeployed(): Promise<boolean> {
    try {
        const res = await fetch(`${base}/_app/version.json`, { cache: 'no-store' });
        if (!res.ok) return false;
        const data: unknown = await res.json();
        return (
            typeof data === 'object' &&
            data !== null &&
            'version' in data &&
            typeof (data as { version: unknown }).version === 'string' &&
            (data as { version: string }).version !== version
        );
    } catch {
        return false;
    }
}

/**
 * Check if we can safely reload for a new-deployment reload (separate
 * cooldown/key from the auth-expiry reload tracking).
 */
function canReloadForUpdate(): boolean {
    if (!browser) return false;

    try {
        const lastReload = Number(localStorage.getItem(UPDATE_RELOAD_COOLDOWN_KEY));
        if (Number.isFinite(lastReload) && lastReload > 0) {
            const timeSinceReload = Date.now() - lastReload;
            if (timeSinceReload < UPDATE_RELOAD_COOLDOWN_MS) {
                console.warn('[AuthMonitor] Skipping update reload - too soon since last reload');
                return false;
            }
        }
        return true;
    } catch (error) {
        // If we can't access storage, be conservative and don't reload
        console.error('[AuthMonitor] Storage access error:', error);
        return false;
    }
}

/**
 * Handle authentication expiration (exported for use by api.ts)
 */
export async function handleAuthExpiration(): Promise<void> {
    if (!browser) return;

    // Prevent multiple simultaneous reload attempts (critical for preventing 10 reloads/second)
    if (reloadInProgress) {
        return;
    }

    // A deploy landing under a stale client produces auth-shaped failures
    // that are not a real session expiry - reload to pick up the new build
    // instead of showing the (misleading) session-expired banner.
    if (await isNewVersionDeployed()) {
        consecutiveAuthFailures = 0;

        if (!canReloadForUpdate()) {
            console.warn('[AuthMonitor] New version detected but reload skipped (cooldown active)');
            showAuthErrorNotification(
                'Update Available',
                'A new version was deployed. Please refresh the page.',
            );
            return;
        }

        reloadInProgress = true;

        try {
            localStorage.setItem(UPDATE_RELOAD_COOLDOWN_KEY, String(Date.now()));
        } catch {
            /* expected: localStorage may be unavailable or full */
        }

        window.location.reload();
        return;
    }

    // Prevent infinite reload loops
    if (!canReload()) {
        console.error('[AuthMonitor] Auth issue detected but reload prevented (cooldown active)');
        // Show notification instead of reloading
        showAuthErrorNotification();
        return;
    }

    // Set flag immediately to prevent any other calls from proceeding
    reloadInProgress = true;

    // Record this reload attempt with count tracking
    try {
        const lastReloadData = parseReloadTrackingData(localStorage.getItem(RELOAD_COOLDOWN_KEY));
        let reloadCount = 1;

        if (lastReloadData) {
            const timeSinceReload = Date.now() - lastReloadData.timestamp;

            // If within 5 minutes, increment count; otherwise reset
            if (timeSinceReload < 5 * 60 * 1000) {
                reloadCount = lastReloadData.count + 1;
            }
        }

        localStorage.setItem(
            RELOAD_COOLDOWN_KEY,
            JSON.stringify({
                timestamp: Date.now(),
                count: reloadCount,
            }),
        );
    } catch {
        /* expected: localStorage may be unavailable or full */
    }

    // Clear any cached data (but keep reload tracking)
    try {
        localStorage.removeItem('dashboard-cache');
    } catch {
        /* expected: localStorage may be unavailable */
    }

    // Show notification instead of automatic reload
    // This gives users control and prevents reload loops
    showAuthErrorNotification();

    // Optional: Auto-reload after a delay if user doesn't click the button
    // Disabled to prevent reload loops - users must manually refresh
    // setTimeout(() => {
    //     window.location.reload();
    // }, 5000);
}

/**
 * Periodic auth health check
 */
export function startAuthMonitoring() {
    if (!browser) return;

    // Guard against duplicate intervals
    if (authMonitorInterval !== null) return;

    // Check auth health every 2 minutes
    authMonitorInterval = setInterval(
        () => {
            checkAuthHealth();
        },
        2 * 60 * 1000,
    );
}

/**
 * Stop periodic auth health check and clear the interval
 */
export function stopAuthMonitoring() {
    if (authMonitorInterval !== null) {
        clearInterval(authMonitorInterval);
        authMonitorInterval = null;
    }
}

/**
 * Determine whether a non-ok 401/403 response is a genuine SESSION-expiry
 * signal, as opposed to an ordinary data-endpoint denial that the caller
 * already surfaces via its own returned `error`/`code`.
 *
 * The web app authenticates via a session cookie / forward-auth header — NOT a
 * Bearer token. So the distinction is:
 * - A 401 on the Bearer-only `/api/v1/*` surface means a call hit the WRONG
 *   surface (the web has no Bearer) — a call-site bug, not a dead session. It
 *   must NOT raise the overlay. (This is what caused the false "session expired"
 *   banner before the For-You rails were repointed off `/api/v1`.)
 * - On the app's own (session/forward-auth) surface, a genuinely dead session
 *   manifests as: a non-JSON redirect-to-login body; OR a JSON 401 whose `code`
 *   is absent (forward-auth `handleMissingAuthHeaders` + built-in session expiry
 *   both return a codeless `{error,message}`), `unauthorized` (generic
 *   no-principal denial used by ~162 defs), or `invalid_token` (JWT expiry).
 *   Per-RESOURCE denials by a VALID session (403, or narrower 401 codes like
 *   `scope_required`) are NOT session expiry and must not nuke it.
 */
async function isSessionExpirySignal(response: Response): Promise<boolean> {
    // A 401/403 on the Bearer-only token surface is never a browser-session signal.
    try {
        if (new URL(response.url).pathname.startsWith('/api/v1/')) return false;
    } catch {
        // response.url empty/relative — fall through to body inspection.
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
        !contentType.includes('application/json') &&
        !contentType.includes('application/problem+json')
    ) {
        // Non-JSON 401/403 (HTML login page, redirect, empty body) — genuine expiry.
        return true;
    }

    try {
        const cloned = response.clone();
        const data = (await cloned.json()) as { code?: string | null };
        const code = data?.code;
        // Codeless or whole-session codes → the session itself is dead. Narrower
        // per-resource codes (scope_required, forbidden, not_found, …) → not expiry.
        if (code === undefined || code === null) return true;
        return code === 'unauthorized' || code === 'invalid_token';
    } catch {
        // Unparseable JSON body on a 401/403 — be conservative, treat as expiry.
        return true;
    }
}

/** Header marking a response synthesized locally (no request was sent). */
export const AUTH_SUPPRESSED_HEADER = 'x-auth-monitor-suppressed';

/**
 * After the session is declared dead, refuse to send further requests that
 * could only 401 again: background pollers (manual runs, watch parties, ...)
 * would otherwise hit the server forever from a stale tab, each one logging a
 * missing-auth line. Only idempotent reads are suppressed, and never the auth
 * endpoints, so signing back in from the same page still works.
 */
function shouldSuppressRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
    if (!authFailureDetected) return false;
    const method = (
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let path = raw;
    try {
        path = new URL(raw, 'http://localhost').pathname;
    } catch {
        // keep raw
    }
    const rel = base && path.startsWith(base) ? path.slice(base.length) : path;
    return !rel.startsWith('/api/auth/');
}

/** Keep request timeouts per attempt, excluding the dependency backoff delay. */
export interface FetchAttemptLifecycle {
    onAttempt?: () => void;
    onResponse?: () => void;
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}

/** Retry reads, plus mutations explicitly rejected before their route handler ran. */
async function fetchAvailable(
    input: RequestInfo | URL,
    init?: RequestInit,
    lifecycle?: FetchAttemptLifecycle,
): Promise<Response> {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const signal = init?.signal ?? request?.signal;
    const deadline = Date.now() + 180_000;
    let backoffMs = 1000;
    for (;;) {
        signal?.throwIfAborted();
        lifecycle?.onAttempt?.();
        // Request objects are streams; clone for each read attempt.
        const response = await fetch(request ? request.clone() : input, init);
        lifecycle?.onResponse?.();
        const safeAuthRetry =
            response.headers.get('X-Lumastra-Auth-Retry') === 'true' &&
            (init?.body == null || typeof init.body === 'string');
        if (
            !browser ||
            response.status !== 503 ||
            response.headers.get('X-Lumastra-Auth-Unavailable') !== 'true' ||
            (method !== 'GET' && method !== 'HEAD' && !safeAuthRetry)
        ) {
            return response;
        }
        // An outage supplies no evidence about session validity. Bound the entire
        // retry sequence even when the API client refreshes its per-attempt timeout.
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
        const date = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
        const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : date - Date.now();
        const delayMs =
            Math.max(backoffMs, Number.isFinite(serverDelay) ? serverDelay : 0) *
            (1 + Math.random() * 0.2);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return response;
        if (delayMs >= remainingMs) {
            await waitForRetry(remainingMs, signal);
            return response; // Keep the final body readable by the caller.
        }
        await response.body?.cancel();
        await waitForRetry(delayMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
    }
}

/**
 * Enhanced fetch wrapper with auth monitoring
 * Automatically prefixes paths with base path for subfolder deployment
 */
export async function monitoredFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    lifecycle?: FetchAttemptLifecycle,
): Promise<Response> {
    if (browser && shouldSuppressRequest(input, init)) {
        return new Response(
            JSON.stringify({
                error: 'Session expired',
                message: 'Your session has expired. Please refresh the page to re-authenticate.',
            }),
            {
                status: 401,
                headers: { 'content-type': 'application/json', [AUTH_SUPPRESSED_HEADER]: 'true' },
            },
        );
    }
    try {
        // Prefix string URLs with base path for subfolder support
        const fetchUrl = typeof input === 'string' ? url(input) : input;
        const response = await fetchAvailable(fetchUrl, init, lifecycle);

        const isAuthStatus = !response.ok && (response.status === 401 || response.status === 403);
        // Scope "auth-related" (counted toward the consecutive-failure banner
        // trigger) to genuine session-expiry signals — an ordinary JSON 401
        // from a single data endpoint is handled by the caller via the
        // returned ApiResult and must not itself move the global counter.
        const isAuthFailure = isAuthStatus && (await isSessionExpirySignal(response));

        // Report the API call result
        reportApiCall(response.status !== 503 && !isAuthFailure, isAuthFailure);

        // Only trigger reload after multiple consecutive failures (handled in reportApiCall)
        // Don't reload immediately on first 401 - this prevents aggressive reloading
        // The reportApiCall function will trigger handleAuthExpiration after MAX_AUTH_FAILURES

        return response;
    } catch (error) {
        // Admin IA redesign, spec §7 error-classification fix: a network
        // failure (offline, DNS, CORS) or a request that hit our OWN
        // `apiFetch` timeout (surfaces here as an AbortError, since that
        // timeout aborts the same underlying `fetch()`) is NEVER a
        // session-expiry signal. This used to report `isAuthRelated = true`
        // unconditionally, so three unrelated network blips or three timed-
        // out admin fetches in a row would trip `handleAuthExpiration()` and
        // show "Your session has expired" even though the session was fine —
        // the exact false-positive the error contract forbids. Auth failures
        // are detected exclusively from a real HTTP 401/403 response above
        // (via `isSessionExpirySignal`); a thrown/rejected fetch never
        // reaches that branch, so it must never count toward the auth
        // failure streak either.
        console.warn('[AuthMonitor] Network error:', error);
        reportApiCall(false, false);
        throw error;
    }
}
