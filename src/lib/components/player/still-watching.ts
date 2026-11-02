// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Are you still watching?" streak tracking.
 *
 * Counts episodes that started WITHOUT anyone asking for them — i.e. only the
 * auto-play countdown firing, never the Next Episode button or an episode the
 * viewer picked. Any interaction with the player resets the count, so someone
 * actually watching never sees the prompt.
 *
 * The count lives in sessionStorage because advancing an episode is a real
 * navigation to /watch/<id>: the player remounts, so component state would be
 * lost every single episode. sessionStorage is per-tab and dies with the tab,
 * which is exactly the lifetime a "still watching" streak should have.
 */

/**
 * Consecutive auto-played episodes allowed before we ask.
 *
 * The settings label (`settings_playback_still_watching`) states this number in
 * prose for every locale — change one and the copy has to change with it.
 */
export const STILL_WATCHING_AFTER_EPISODES = 2;

const STORAGE_KEY = 'lumastra:still-watching-streak';

interface Streak {
    count: number;
    /** Series the streak belongs to; `seriesName`, the only series handle the player has. */
    seriesKey: string | null;
    /** The episode the countdown advanced into — proof the next arrival was ours. */
    expectedItemId: string | null;
}

function readStreak(): Streak | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const { count, seriesKey, expectedItemId } = parsed as Partial<Streak>;
        if (typeof count !== 'number' || !Number.isFinite(count)) return null;
        if (seriesKey !== null && typeof seriesKey !== 'string') return null;
        if (expectedItemId !== null && typeof expectedItemId !== 'string') return null;
        return { count, seriesKey: seriesKey ?? null, expectedItemId: expectedItemId ?? null };
    } catch {
        // Corrupted value, or storage blocked in a private window. A viewer who
        // cannot be counted is never interrupted.
        return null;
    }
}

function writeStreak(streak: Streak): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(streak));
    } catch {
        // Best effort: without persistence the streak simply never builds up.
    }
}

/** Call when the auto-play countdown — and only the countdown — advances an episode. */
export function recordAutoplayedEpisode(seriesKey: string | null, nextItemId: string | null): void {
    const current = readStreak();
    const continues = current !== null && current.seriesKey === seriesKey;
    writeStreak({
        count: continues ? current.count + 1 : 1,
        seriesKey,
        expectedItemId: nextItemId,
    });
}

/**
 * Call when the player settles on an episode. The activity listener only exists
 * while the player is mounted, so an episode the viewer picked from a browse
 * page produces no input event to clear the streak with — and would inherit a
 * bank of auto-played episodes it did not earn. An arrival that is not the one
 * the countdown aimed at was chosen by a person, so the count starts over.
 */
export function noteEpisodeArrival(itemId: string | null): void {
    const streak = readStreak();
    if (streak === null) return;
    if (streak.expectedItemId !== itemId) resetStillWatchingStreak();
}

/** Call on any sign of a viewer: pointer movement, a key, a seek, play/pause. */
export function resetStillWatchingStreak(): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // See writeStreak.
    }
}

/** True when the next auto-play should ask instead of just playing. */
export function shouldPromptStillWatching(seriesKey: string | null): boolean {
    const streak = readStreak();
    if (streak === null || streak.seriesKey !== seriesKey) return false;
    return streak.count >= STILL_WATCHING_AFTER_EPISODES;
}

/**
 * Input events that mean a person is present. Deliberately raw DOM events
 * rather than the player's own callbacks: `onPlay` fires for an auto-played
 * episode too, so anything hung off playback would clear the streak on the
 * very advance it is supposed to be counting.
 */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Pointer moves arrive per frame; one storage write a second is plenty. */
const ACTIVITY_THROTTLE_MS = 1000;

/**
 * Clear the streak whenever the viewer does anything. Returns a teardown
 * function for the caller's effect cleanup.
 */
export function startViewerActivityTracking(
    target: EventTarget,
    now: () => number = () => Date.now(),
): () => void {
    let lastSeen = Number.NEGATIVE_INFINITY;

    const onActivity = () => {
        const at = now();
        if (at - lastSeen < ACTIVITY_THROTTLE_MS) return;
        lastSeen = at;
        resetStillWatchingStreak();
    };

    for (const event of ACTIVITY_EVENTS) {
        target.addEventListener(event, onActivity, { passive: true });
    }

    return () => {
        for (const event of ACTIVITY_EVENTS) {
            target.removeEventListener(event, onActivity);
        }
    };
}
