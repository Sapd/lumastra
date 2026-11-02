// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AutoplaySeed, PlaybackContext } from '$lib/schemas/autoplay-seed';
import { MusicTrackSchema, QueueItemSchema } from '$lib/schemas/music';
import type { MusicTrack, QueueItem } from '$lib/schemas/music';

const STORAGE_VERSION = 3;
const STORAGE_KEY = 'lumastra:music-playback';
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface PersistedPlaybackState {
    autoplaySeed: AutoplaySeed | null;
    playbackContext: PlaybackContext | null;
    currentTrack: MusicTrack | null;
    position: number;
    queue: QueueItem[];
    /**
     * Session play history, newest first. Restored so a reload does not hand the
     * smart queue an empty exclude list and let it re-pick tracks already played.
     */
    history: MusicTrack[];
    volume: number;
    wasPlaying: boolean;
    savedAt: number;
}

export function savePlaybackState(state: PersistedPlaybackState): void {
    // Security fix C13 (fix round 1, 2026-09-16): the guard lives HERE, at
    // the actual storage boundary, not in music-player.store.ts's
    // persistState() — persistState() is not this module's only possible
    // caller, and a review of the original fix found that a test asserting
    // against a hand-rolled `if (!isPlaybackPersistenceSuppressed())
    // localStorage.setItem(...)` re-implemented the guard instead of
    // exercising it, so deleting the real one turned no test red. Putting
    // the check in the single function that actually touches localStorage
    // makes it both testable directly and unbypassable by any future
    // second caller.
    if (isPlaybackPersistenceSuppressed()) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, version: STORAGE_VERSION }));
    } catch {
        // localStorage full or unavailable — silently ignore
    }
}

export function loadPlaybackState(): PersistedPlaybackState | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;

        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
            !parsed ||
            parsed.version !== STORAGE_VERSION ||
            typeof parsed.savedAt !== 'number' ||
            Date.now() - parsed.savedAt > MAX_AGE_MS
        ) {
            clearPlaybackState();
            return null;
        }

        const rest = parsed;
        const rawQueue = Array.isArray(rest.queue) ? rest.queue : [];
        const mappedQueue: QueueItem[] = rawQueue.flatMap((item: unknown) => {
            const result = QueueItemSchema.safeParse(item);
            return result.success ? [{ ...result.data, id: result.data.track.id }] : [];
        });
        // Dedup by id. QueueItem.id === track.id, and in-app queue mutations
        // already guard against repeats — but a legacy/corrupt persisted queue
        // (e.g. the old MusicTrack[] format that listed a track twice) would
        // restore duplicate ids, which makes the queue panel's keyed `{#each}`
        // throw `each_key_duplicate`. Keep first occurrence.
        const seenQueueIds = new Set<string>();
        const queue: QueueItem[] = mappedQueue.filter((q) => {
            if (seenQueueIds.has(q.id)) return false;
            seenQueueIds.add(q.id);
            return true;
        });

        // Absent for states saved before history was persisted → empty, which
        // just means the first picks after that upgrade see no session context.
        const history: MusicTrack[] = (Array.isArray(rest.history) ? rest.history : []).filter(
            (t: unknown): t is MusicTrack => MusicTrackSchema.safeParse(t).success,
        );

        const parsedTrack = MusicTrackSchema.safeParse(rest.currentTrack);
        const restoredTrack = parsedTrack.success ? parsedTrack.data : null;
        const rawPosition =
            typeof rest.position === 'number' && Number.isFinite(rest.position) ? rest.position : 0;
        // Clamp the restored position to [0, duration - epsilon]. A position at
        // or beyond the end (e.g. saved at a track boundary) would otherwise
        // immediately re-trigger `handleTrackEnded` on hydrate. When within the
        // last 2s of the track, restore at 0 so the user replays from the top.
        const NEAR_END_EPSILON_MS = 2_000;
        const durationMs = restoredTrack?.durationMs ?? 0;
        let position = Math.max(0, rawPosition);
        if (durationMs > 0) {
            if (position >= durationMs - NEAR_END_EPSILON_MS) {
                position = 0;
            }
        }

        // A station context saved before ids became version-bound holds an index,
        // not a stationId; it cannot be resumed.
        const savedContext = (rest.playbackContext as PlaybackContext | null) ?? null;
        const playbackContext =
            savedContext?.type === 'station' &&
            typeof (savedContext as { stationId?: unknown }).stationId !== 'string'
                ? null
                : savedContext;

        return {
            autoplaySeed: (rest.autoplaySeed as AutoplaySeed | null) ?? null,
            playbackContext,
            currentTrack: restoredTrack,
            position,
            queue,
            history,
            volume: typeof rest.volume === 'number' ? rest.volume : 0.8,
            wasPlaying: rest.wasPlaying === true,
            savedAt: parsed.savedAt,
        };
    } catch {
        /* expected: JSON.parse failure on corrupt/migrated localStorage data */
        return null;
    }
}

export function clearPlaybackState(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* expected: localStorage may be unavailable (private browsing, quota) */
    }
}

/**
 * Security fix C13 (2026-09-16): logout must guarantee `lumastra:
 * music-playback` never resurfaces for the next signed-in user on a shared
 * device. Adding the key to `USER_SPECIFIC_KEYS` alone is not sufficient —
 * `music-player.store.ts`'s module-level `beforeunload` listener calls
 * `persistState()` unconditionally on every page unload, including the
 * navigation triggered by the logout redirect, which runs AFTER
 * `clearUserClientState()`'s wipe and would re-write the previous user's
 * queue/track/history right back.
 *
 * `clearUserClientState()` calls `suppressPlaybackPersistence()`, and
 * `savePlaybackState()` (fix round 1: moved here from
 * music-player.store.ts's `persistState()`, the actual storage boundary)
 * checks `isPlaybackPersistenceSuppressed()` before saving — so the late
 * `beforeunload` write becomes a no-op instead of undoing the wipe. The
 * flag is in-memory only and both logout paths finish with a full
 * navigation (`window.location.assign`/`.href`), which tears down the JS
 * realm and naturally resets it — it is not meant to be un-suppressed
 * mid-session.
 */
let persistenceSuppressed = false;

/**
 * Logout reaches other tabs too. The snapshot is shared by every tab of the
 * origin, and a tab still playing the old user's music refreshes it on every
 * progress tick — suppressing only the tab that logged out would let another
 * tab write the queue straight back. So the logout is broadcast, and each tab
 * suppresses its own writes and stops (see music-player.store.ts).
 */
const SESSION_ENDED_CHANNEL = 'lumastra:music-session-ended';
let sessionEndedChannel: BroadcastChannel | null = null;

function suppressHere(): void {
    persistenceSuppressed = true;
    clearPlaybackState();
}

export function suppressPlaybackPersistence(): void {
    suppressHere();
    try {
        // Kept open: the logout navigation follows immediately, and closing
        // right after posting would race the delivery.
        sessionEndedChannel ??= new BroadcastChannel(SESSION_ENDED_CHANNEL);
        sessionEndedChannel.postMessage('ended');
    } catch {
        /* expected: BroadcastChannel unavailable — other tabs keep old behaviour */
    }
}

/**
 * Run `onEnded` when ANOTHER tab logs out, after suppressing this tab's
 * snapshot writes. Returns an unsubscribe function.
 */
export function onPlaybackSessionEndedElsewhere(onEnded: () => void): () => void {
    if (typeof BroadcastChannel === 'undefined') return () => {};
    const channel = new BroadcastChannel(SESSION_ENDED_CHANNEL);
    channel.onmessage = () => {
        suppressHere();
        onEnded();
    };
    return () => channel.close();
}

export function isPlaybackPersistenceSuppressed(): boolean {
    return persistenceSuppressed;
}

/** Test-only: undo suppression so specs don't leak state across cases. */
export function resumePlaybackPersistence(): void {
    persistenceSuppressed = false;
}
