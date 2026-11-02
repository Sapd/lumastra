// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch State Version Store
 *
 * Cross-instance invalidation signal for watched-state changes. The cache
 * layer (Valkey) handles server-side invalidation, but multiple useModalData
 * instances live in parallel (e.g. series modal + episode sub-modal on top).
 * When one toggles watched state, the others' local caches go stale until
 * something forces a re-fetch.
 *
 * Every successful watched-state mutation (mark / unmark / set-progress)
 * bumps this counter. Debounced user SSE watch changes bump it too, so imports
 * and playback on another device also refresh open series details. Subscribers reset their watchedState / nextEpisodeState
 * to idle so the fallback effects re-fetch.
 */

import { writable } from 'svelte/store';

export const watchStateVersion = writable(0);

export function bumpWatchStateVersion(): void {
    watchStateVersion.update((v) => v + 1);
}
