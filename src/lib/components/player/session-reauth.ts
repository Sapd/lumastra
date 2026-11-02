// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recover web playback from a lost browser session.
 *
 * Behind a forward-auth proxy (Authentik) the proxy can drop a tab's session
 * while a film is playing. The proxy lets `/api/*` through without identity
 * headers, so every segment and heartbeat 401s and the player stops on
 * "authorization rejected", even though a top-level page load would sign the
 * user straight back in (usually silently, via the IdP's own session). The
 * same holds for a native-login session that expired mid-film.
 *
 * So when playback sees a 401 (or Safari's status-less native error), the
 * player asks `/api/auth/check` whether the session itself is gone. Only if it
 * is, it reloads the watch page once with `?t=<position>`: the page load goes
 * through the proxy's sign-in, and the fresh player resumes where it stopped.
 * A 401 that is not a dead session (e.g. a PlaySessionId owned by someone
 * else) leaves the normal error handling alone.
 */

import { url as appUrl } from '$lib/paths';
import { WATCH_LANDING_PARAMS } from '$lib/shared/watch-landing-params';

/** sessionStorage key holding the time of the last re-auth reload (ms). */
export const REAUTH_RELOAD_KEY = 'lumastra-player-reauth-at';

/**
 * At most one re-auth reload per tab in this window. If the reload does not
 * bring the session back (sign-in failed, proxy misconfigured), the next 401
 * falls through to the normal error UI instead of reloading in a loop.
 */
export const REAUTH_RELOAD_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * What `/api/auth/check` says about the browser session: `lost` on a 401 or
 * when the proxy redirects the probe to its sign-in, `alive` on 2xx, and
 * `unknown` for anything else (offline, 5xx), which says nothing either way.
 */
export type SessionProbeResult = 'lost' | 'alive' | 'unknown';

export async function probeBrowserSession(
    fetchImpl: typeof fetch = fetch,
): Promise<SessionProbeResult> {
    try {
        const res = await fetchImpl(appUrl('/api/auth/check'), {
            cache: 'no-store',
            credentials: 'same-origin',
            redirect: 'manual',
        });
        if (res.status === 401 || res.type === 'opaqueredirect') return 'lost';
        return res.ok ? 'alive' : 'unknown';
    } catch {
        /* expected: offline / aborted — not evidence either way */
        return 'unknown';
    }
}

/**
 * Claim this tab's re-auth reload. Returns false when one already happened
 * within the cooldown, or when sessionStorage is unavailable (then the loop
 * guard cannot work, so do not reload at all). A stored time in the future
 * (clock changed) counts as expired rather than blocking recovery.
 */
export function claimReauthReload(storage: Storage | null, now: number): boolean {
    if (!storage) return false;
    try {
        const last = Number(storage.getItem(REAUTH_RELOAD_KEY));
        const elapsed = now - last;
        if (
            Number.isFinite(last) &&
            last > 0 &&
            elapsed >= 0 &&
            elapsed < REAUTH_RELOAD_COOLDOWN_MS
        ) {
            return false;
        }
        storage.setItem(REAUTH_RELOAD_KEY, String(now));
        return true;
    } catch {
        /* expected: storage disabled (private mode, blocked site data) */
        return false;
    }
}

/**
 * The page to load for re-auth, or null when there is none to resume on.
 * On a watch page: that page, keeping its playback params (its id may be in
 * another format than the player's, and in-place episode switches update the
 * URL). Elsewhere: `fallbackItemId`'s watch page, if the caller gives one
 * (null for live, which has no VOD watch page to resume). `positionSeconds`
 * becomes `?t=`; null or under 1 s drops it. One-shot landing params are
 * dropped so they cannot override `t`, hold playback or replay a re-check.
 * The result is always a same-origin path.
 */
export function buildReauthUrl(
    currentHref: string,
    basePath: string,
    fallbackItemId: string | null,
    positionSeconds: number | null,
): string | null {
    const current = new URL(currentHref);
    const t =
        positionSeconds !== null && Number.isFinite(positionSeconds) && positionSeconds >= 1
            ? Math.floor(positionSeconds)
            : null;

    const onWatchPage = current.pathname.startsWith(`${basePath}/watch/`);
    if (!onWatchPage && !fallbackItemId) return null;
    const target = onWatchPage
        ? new URL(current.href)
        : new URL(`${basePath}/watch/${encodeURIComponent(fallbackItemId ?? '')}`, current.origin);

    for (const key of WATCH_LANDING_PARAMS) target.searchParams.delete(key);
    if (t !== null) target.searchParams.set('t', String(t));
    else target.searchParams.delete('t');

    // A path starting with `//` would make assign() protocol-relative.
    const path = target.pathname.replace(/^\/{2,}/, '/') + target.search;
    return new URL(path, current.origin).origin === current.origin ? path : null;
}
