// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Exclusive audio ownership for inline preview / trailer / hero videos.
 *
 * The problem this solves: every preview player (the homepage hero, the
 * featured-pick "sub-hero", hover cards, and the inline `MediaPreviewPlayer`)
 * used to share ONE global `localStorage['media-hover-muted']` flag. Unmuting
 * any single player flipped that shared flag, so several videos that happened to
 * be on screen and playing at the same time would all emit audio at once.
 *
 * The rule enforced here: AT MOST ONE preview may emit audio at any moment. A
 * player "claims" audio when the user unmutes it; claiming transfers ownership,
 * so every other player observes (reactively) that it no longer owns audio and
 * mutes itself. Muting — or unmounting — the current owner releases audio back
 * to nobody, leaving every player silent until the user unmutes one again.
 *
 * Players start muted by default (owner === null). That is also what the
 * browser autoplay policy requires, so there is no surprise audio on load.
 */

let ownerId = $state<string | null>(null);
let counter = 0;

/**
 * Mint a process-unique audio-owner id. A monotonic counter (rather than a
 * random id) keeps ids stable and inspectable and avoids `Math.random`.
 */
export function nextPreviewAudioId(prefix = 'preview'): string {
    counter += 1;
    return `${prefix}-${counter}`;
}

/**
 * The single source of truth for "which preview owns audio". Exposed as an
 * object with getters/methods because reassigned `$state` can't be exported
 * directly from a `.svelte.ts` module — reads through these accessors are still
 * tracked by `$effect`/`$derived` in consuming components.
 */
export const previewAudio = {
    /** The id of the single player currently allowed to emit audio, or null. */
    get owner(): string | null {
        return ownerId;
    },
    /** True when `id` is the current audio owner. */
    owns(id: string): boolean {
        return ownerId === id;
    },
    /** Claim exclusive audio for `id`, muting whichever player held it before. */
    claim(id: string): void {
        ownerId = id;
    },
    /** Release audio iff `id` currently holds it (no-op otherwise). */
    release(id: string): void {
        if (ownerId === id) ownerId = null;
    },
};
