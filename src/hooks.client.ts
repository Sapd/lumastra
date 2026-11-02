// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { HandleClientError } from '@sveltejs/kit';
import { version } from '$app/environment';
import { apiUrl } from '$lib/shared/api-urls';
import { isClientDiagnosticsEnabled, reportJsError } from '$lib/client-diagnostics/web-reporter';
import { diagnosticPathTemplate } from '$lib/client-diagnostics/route-template';
import { scrubClientText } from '$lib/client-diagnostics/scrub';

// Client-side framework safety net for uncaught errors thrown while
// navigating (load functions and the following render). Mirrors the server
// `handleError` in hooks.server.ts: logs structured context and returns a
// sanitized client message with a stable errorId so internal details never
// reach the rendered error page, while still giving support/logs a
// correlatable identifier.
// `crypto.randomUUID()` is only available in secure contexts — direct
// plain-HTTP LAN access (a supported mode) is NOT one, and this handler must
// never itself throw. Fall back to a non-crypto correlation id there.
function makeErrorId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}

/**
 * Send the report the errorId is supposed to be searchable by.
 *
 * Both error pages render this id and ask the user to quote it. Without this
 * call it existed only in the reporter's browser console, so the id they quoted
 * matched nothing an operator could look up — the visible half of a correlation
 * with no other half. `/api/dev/client-errors` is not that sink: it 404s
 * outside dev by design.
 *
 * `sendBeacon` rather than `fetch`: this fires on the way to an error page and
 * often immediately before a reload or navigation, which is exactly the case
 * `fetch` loses and the beacon queue survives. It also cannot be awaited or
 * observed, which is the right shape here — the handler's job is to return a
 * message, not to succeed at reporting.
 *
 * Only the PATH is sent, never the full URL: a query string on this app
 * routinely carries search terms, and those are the user's content, not
 * diagnostics. The server re-does this reduction rather than trusting it.
 *
 * The URL goes through `apiUrl('internal', …)` rather than a root-absolute
 * string. `sendBeacon` is not `fetch`, so the global fetch interceptor cannot
 * rewrite it, and on a subpath install a root-absolute path resolves against
 * the origin and 404s — silently, because a beacon has no response to inspect.
 * The repo's own `no-hardcoded-api-path` rule caught this; the dev sink already
 * did it correctly.
 *
 * Every failure path is swallowed. A `handleError` that throws replaces a
 * useful error page with a blank one, so reporting must never be able to do
 * that — including the `Blob`/`sendBeacon` constructors themselves, which are
 * absent in some embedded webviews.
 */
function reportToServer(payload: Record<string, unknown>): void {
    try {
        if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
        navigator.sendBeacon(
            apiUrl('internal', '/client-errors'),
            new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        );
    } catch {
        // Reporting must never break the error page it is reporting about.
    }
}

export const handleError: HandleClientError = ({ error, event, status, message }) => {
    const errorId = makeErrorId();
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Unhandled client error', {
        errorId,
        routeId: event.route?.id ?? null,
        status,
        error: err,
    });
    // The admin switch (FEATURE_CLIENT_DIAGNOSTICS) off: no report. Still unknown
    // (the root layout itself failed to load) still reports — that is the case the
    // error page exists for, and the server applies the switch again.
    if (isClientDiagnosticsEnabled() === false) {
        return { message: message || 'An unexpected error occurred', errorId };
    }
    reportToServer({
        errorId,
        routeId: event.route?.id ?? null,
        status,
        name: err.name,
        // Scrubbed here as well as on the server: a credential in an error text
        // (a failed URL with ?grant=…) must not cross the network at all.
        message: scrubClientText(err.message),
        stack: err.stack ? scrubClientText(err.stack) : undefined,
        // The route TEMPLATE, never the visited path: a path segment can be a
        // search term, a name or a share token.
        url: event.route?.id ?? diagnosticPathTemplate(event.url.pathname),
        // The build this tab runs. Most prod js_errors are a tab left open across a
        // deploy (old chunk hashes 404, loads fail mid-roll); without the build an
        // operator cannot tell that apart from a real regression.
        version,
    });
    return { message: message || 'An unexpected error occurred', errorId };
};

if (typeof window !== 'undefined') {
    // Errors outside SvelteKit's load/render (event handlers, timers, promises
    // nobody awaited) never reach handleError. They go to Admin → Client
    // diagnostics as js_error, deduplicated and rate-limited per tab.
    window.addEventListener('error', (event: ErrorEvent) => {
        // A failed <img>/<script> load also dispatches `error` (capture only); a
        // cross-origin script error carries no error object and says nothing.
        if (!(event instanceof ErrorEvent) || event.error == null) return;
        reportJsError('window_error', event.error, event.filename);
    });
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        reportJsError('unhandled_rejection', event.reason);
    });

    window.addEventListener('vite:preloadError', () => {
        // A chunk from the old build failed to load after a deploy. Reload once
        // to pick up the new build; the sessionStorage guard prevents loops.
        const key = 'lumastra-preload-error-reload';
        const last = Number(sessionStorage.getItem(key) || 0);
        if (Date.now() - last > 30_000) {
            sessionStorage.setItem(key, String(Date.now()));
            // Keep the import rejected while the reload is pending. Preventing
            // this event makes Vite resolve the failed import as undefined;
            // SvelteKit then crashes reading the route node's `universal`.
            window.location.reload();
        }
    });
}
