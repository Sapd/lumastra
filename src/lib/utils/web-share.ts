// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * web-share.ts
 *
 * Share helpers for the PWA-only share buttons (player controls + media
 * modal). Installed as an app there is no address bar, so the URL a user
 * would otherwise copy by hand is unreachable — hence the button.
 *
 * `shareOrCopy` prefers the OS share sheet and degrades to the clipboard,
 * which is what desktop PWAs without `navigator.share` land on.
 */

import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';

/**
 * Params worth handing to whoever opens the link. Everything else on a
 * watch URL (`playlist`, `position`, `info`, `resolved`) is the sharer's
 * own navigation state and is deliberately dropped.
 */
const SHAREABLE_WATCH_PARAMS = ['fileId', 'slug'] as const;

export interface WatchShareUrlOptions {
    /** Absolute origin, e.g. `window.location.origin`. */
    origin: string;
    /** Item to watch. */
    itemId: string;
    /** SvelteKit `base` — non-empty only on subfolder deployments. */
    basePath?: string;
    /** Playback position in seconds; omitted from the link when at/near 0. */
    currentTime?: number | null;
    /** The current URL's params, filtered through the allowlist above. */
    params?: URLSearchParams | null;
}

/** Build the deep link a recipient should open to watch this item. */
export function buildWatchShareUrl({
    origin,
    itemId,
    basePath = '',
    currentTime,
    params,
}: WatchShareUrlOptions): string {
    const url = new URL(`${basePath}/watch/${encodeURIComponent(itemId)}`, origin);

    if (params) {
        for (const key of SHAREABLE_WATCH_PARAMS) {
            const value = params.get(key);
            if (value) url.searchParams.set(key, value);
        }
    }

    // `set` (not `append`) so a `t` inherited from the sharer's URL is
    // replaced by the live position rather than duplicated.
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 1) {
        url.searchParams.set('t', String(Math.floor(currentTime)));
    }

    return url.toString();
}

/** A share sheet the user dismissed — expected, and not worth a toast. */
function isUserCancellation(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export interface ShareTarget {
    title: string;
    url: string;
}

/**
 * Hand `url` to the OS share sheet, falling back to the clipboard when the
 * platform has none or the sheet fails. A user-dismissed sheet is a no-op:
 * they said no, so neither copying nor toasting is wanted.
 */
export async function shareOrCopy({ title, url }: ShareTarget): Promise<void> {
    const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;

    if (nav?.share) {
        try {
            await nav.share({ title, url });
            return;
        } catch (error) {
            if (isUserCancellation(error)) return;
            // Anything else (permission, unsupported payload) — keep going
            // and try the clipboard rather than leaving the user empty-handed.
        }
    }

    try {
        // Not optional-chained past `clipboard`: a missing navigator or
        // clipboard must land in the catch, not silently resolve and toast
        // a copy that never happened.
        if (!nav?.clipboard) throw new Error('clipboard unavailable');
        await nav.clipboard.writeText(url);
        toasts.info(m.card_copy_link_done());
    } catch {
        toasts.error(m.card_copy_link_failed());
    }
}
