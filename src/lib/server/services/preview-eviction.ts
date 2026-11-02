// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PreviewSession } from './preview-session.service.js';

/**
 * Ordered by LAST HEARTBEAT, not createdAt. updateSessionHeartbeat writes only
 * lastHeartbeatAt, so a createdAt sort meant heartbeating did NOT keep a
 * session's LRU position warm (contrary to the comment that claimed it) -- a
 * live, actively-playing preview could be evicted in favour of a brand-new one.
 */
const at = (s: PreviewSession): number => (s.lastHeartbeatAt ?? s.createdAt).valueOf();

/**
 * How close two sessions' `at()` values have to be to count as "comparably
 * cold" for the snippet-vs-trailer tiebreak below. One heartbeat cycle
 * (`HEARTBEAT_INTERVAL` in `MediaPreviewPlayer.svelte`) -- two sessions that
 * are both being actively heartbeated will naturally drift apart by up to
 * one cycle purely from scheduling, and that drift should not by itself
 * make one of them "the cold one" for tiebreak purposes.
 */
const COMPARABLE_COLDNESS_WINDOW_MS = 10_000;

/**
 * Pick which of a user's previews to evict when the per-user cap is hit.
 *
 * Coldness (last heartbeat, or createdAt if never heartbeated) is the
 * PRIMARY ordering. Snippet-vs-trailer is only a TIEBREAK among sessions
 * that are comparably cold -- i.e. within `COMPARABLE_COLDNESS_WINDOW_MS`
 * of the single coldest session found.
 *
 * This used to be the other way around: `pool = snippets.length > 0 ?
 * snippets : sessions` filtered to snippets BEFORE picking the coldest.
 * That pre-filter was meant to protect a playing trailer's sound from being
 * cut by a hover, which is a real goal -- but retention (the preview memo
 * keeping recently-unmounted sessions alive for reuse, see
 * `preview-session-cache.ts`) means a user can now easily be holding
 * several retained-but-ice-cold trailer sessions alongside one live hover
 * snippet. The old pre-filter collapsed the eviction pool down to that one
 * live snippet -- exempting the ice-cold retained trailers from
 * consideration entirely -- and killed the visible preview while the dead
 * ones survived.
 *
 * Making coldness primary and snippet-preference a narrow tiebreak keeps
 * the original protection (a live trailer is not evicted in favour of a
 * comparably live hover snippet -- the snippet still goes first) without
 * exempting anything that is actually the coldest session outright.
 */
export function pickEvictionVictim(sessions: PreviewSession[]): PreviewSession {
    if (sessions.length === 0) {
        throw new Error(
            'pickEvictionVictim requires at least one session; both call sites must guard on length >= cap before calling',
        );
    }

    const coldest = sessions.reduce((a, b) => (at(a) <= at(b) ? a : b));
    const comparablyCold = sessions.filter(
        (s) => at(s) - at(coldest) <= COMPARABLE_COLDNESS_WINDOW_MS,
    );
    const coldestSnippetAmongComparable = comparablyCold
        .filter((s) => !s.isTrailer)
        .reduce<PreviewSession | null>(
            (best, s) => (best === null || at(s) < at(best) ? s : best),
            null,
        );

    return coldestSnippetAmongComparable ?? coldest;
}
