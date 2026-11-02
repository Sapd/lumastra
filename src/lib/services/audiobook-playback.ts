// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one entry point for starting an audiobook.
 *
 * The store's transport is injected (`configure`), and forgetting to do that
 * fails as "Player transport not configured" at the moment the listener taps
 * play. Wiring it here, idempotently, means no call site can get that wrong —
 * and no call site needs to know that the transport is injected at all.
 *
 * Must be reached from a user gesture: WebKit refuses both `play()` and
 * `AudioContext` without a trusted one (measured), so a resume-after-navigation
 * that skips the gesture silently produces nothing at all.
 */

import { get } from 'svelte/store';
import { audiobookPlayerStore } from '$lib/stores/audiobook-player.store';
import { audiobookSessionTransport } from '$lib/api/audiobooks';
import { getDeviceId } from '$lib/components/player/device-id';
import * as m from '$lib/paraglide/messages';

let configured = false;

function ensureConfigured(): void {
    if (configured) return;
    audiobookPlayerStore.configure({
        deps: audiobookSessionTransport,
        // Per-device, not per-install. AudiobookShelf closes any OTHER open
        // session for the same (user, deviceId), so one shared id would make
        // starting a book on a phone silently kill the laptop's session.
        deviceId: getDeviceId(),
        synthesizeChapterTitle: (partNumber) =>
            m.audiobook_chapter_synthetic_part({ number: String(partNumber) }),
        untaggedTailTitle: m.audiobook_chapter_untagged_tail(),
    });
    configured = true;
}

/**
 * Resolves false when nothing is playing.
 *
 * Callers MUST act on that. On failure the store's `book` stays null, and both
 * player surfaces are gated on `book !== null` — so `state.error` has nowhere to
 * render and an ignored `false` is a completely silent failure.
 */
export function playAudiobook(
    mediaId: string,
    options: { autoplay?: boolean; positionMs?: number } = {},
): Promise<boolean> {
    ensureConfigured();
    return audiobookPlayerStore.load(mediaId, options);
}

/** The message to show when {@link playAudiobook} resolves false. */
export function audiobookStartFailureMessage(): string {
    return get(audiobookPlayerStore).error?.message ?? 'Could not start this book';
}

/** Test seam — the module-level `configured` latch would otherwise persist. */
export function resetAudiobookPlaybackWiring(): void {
    configured = false;
}
