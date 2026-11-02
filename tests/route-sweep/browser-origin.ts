// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which origin the sweep's BROWSER uses, as opposed to its Node request contexts.
 *
 * Through a tunnel the browser would load the app as http://127.0.0.1:<port>
 * while the app's ORIGIN is its public hostname. Every mutating request the
 * page makes by itself (the home hero's preview-session heartbeat PATCH and its
 * stop DELETE, for instance) then carries the tunnel's Origin, and csrf.ts
 * correctly refuses it with 403. The page is fine; the browser is somewhere a
 * real user never is.
 *
 * Rewriting the Origin header does not help: Chromium sets it below the
 * interception layer for these requests (tried with page.route and
 * context.route plus `serviceWorkers: 'block'`; the 403s continued).
 *
 * So when SWEEP_CSRF_ORIGIN names a different host than SWEEP_BASE_URL, the
 * browser loads the app under that host name instead, and Chromium's own
 * resolver sends the connection to the tunnel:
 *
 *   --host-resolver-rules=MAP preprod.example 127.0.0.1:<port>
 *
 * Origin and Host are then the target's own host, the same as for a real user.
 * The scheme stays http because the tunnel is plain HTTP; csrf.ts compares
 * hosts, not schemes, exactly so a TLS-terminating proxy works. Chromium treats
 * a plain-http public host as an insecure context (127.0.0.1 is secure), so the
 * origin is also marked secure, or APIs gated on a secure context would behave
 * differently from both the tunnel run and production.
 *
 * Node request contexts (fixture resolution, API tiers) do not use Chromium's
 * resolver and keep talking to SWEEP_BASE_URL.
 */

export interface SweepBrowserOrigin {
    /** baseURL for the browser project. */
    baseURL: string;
    /** Extra Chromium launch arguments; empty when no mapping is needed. */
    launchArgs: string[];
    /** True when the browser runs under the target's host instead of the tunnel's. */
    mapped: boolean;
}

export function sweepBrowserOrigin(
    baseUrl: string,
    csrfOrigin: string | undefined,
): SweepBrowserOrigin {
    const base = new URL(baseUrl);
    const csrf = csrfOrigin?.trim() ? new URL(csrfOrigin.trim()) : null;
    if (!csrf || csrf.hostname.toLowerCase() === base.hostname.toLowerCase()) {
        return { baseURL: baseUrl, launchArgs: [], mapped: false };
    }

    if (base.protocol !== 'http:') {
        throw new Error(
            `SWEEP_CSRF_ORIGIN (${csrf.origin}) differs from SWEEP_BASE_URL (${base.origin}), and the ` +
                'browser can only be mapped onto a plain-http tunnel. Point SWEEP_BASE_URL at the ' +
                "app's http port or unset SWEEP_CSRF_ORIGIN.",
        );
    }
    const host = csrf.hostname.toLowerCase();
    const browserOrigin = `http://${host}`;
    // Every port of the host goes to the tunnel; the default http port is the
    // only one the browser should ever ask for.
    const target = `${base.hostname}:${base.port || '80'}`;
    const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
    return {
        baseURL: `${browserOrigin}${path}`,
        launchArgs: [
            `--host-resolver-rules=MAP ${host} ${target}`,
            `--unsafely-treat-insecure-origin-as-secure=${browserOrigin}`,
        ],
        mapped: true,
    };
}
