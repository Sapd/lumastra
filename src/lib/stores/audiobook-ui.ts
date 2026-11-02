// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UI state for the audiobook player that must outlive its components.
 *
 * Deliberately NOT folded into `audiobook-player.store.ts`: that store is the
 * playback contract and is unit-tested without a DOM. Whether a sheet is open
 * is not part of it.
 *
 * The sleep timer lives here rather than in a component because it must survive
 * the full-screen player being closed — that is the entire point of a sleep
 * timer — and because "end of chapter" needs the book's position, which no
 * component owns.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import { audiobookPlayerStore } from './audiobook-player.store';

export const audiobookFullScreenOpen = writable(false);

export type SleepTimerMode =
    | { kind: 'off' }
    | { kind: 'duration'; endsAt: number; mediaId: string | null }
    | {
          kind: 'end_of_chapter';
          chapterIndex: number;
          /**
           * Book time the armed chapter ends at.
           *
           * Carried so the watcher can tell "playback reached the boundary" from
           * "the listener jumped somewhere else": a chapter-index change alone
           * is not evidence the chapter finished.
           */
          chapterEndMs: number;
          mediaId: string | null;
      };

export const sleepTimer = writable<SleepTimerMode>({ kind: 'off' });

/** Seconds remaining on a countdown timer, or null. Recomputed on a 1 s tick. */
export const sleepTimerRemainingMs: Readable<number | null> = derived(
    sleepTimer,
    ($timer, set) => {
        if ($timer.kind !== 'duration') {
            set(null);
            return;
        }
        const update = (): void => set(Math.max(0, $timer.endsAt - Date.now()));
        update();
        const handle = setInterval(update, 1000);
        return () => clearInterval(handle);
    },
    null as number | null,
);

let watcher: ReturnType<typeof setInterval> | null = null;

/**
 * Stop playback when the timer expires.
 *
 * A hard pause, not a fade. `setVolume` is documented as a no-op on iOS
 * (hardware-only), so a fade-out finish is not available on the platform where
 * most bedtime listening happens; rather than fade on some platforms and cut on
 * others, it cuts everywhere. The audiobook backend does have a gain graph on
 * iOS — but a fade that exists on three platforms and not the fourth is a
 * behaviour difference nobody asked for.
 */
function ensureWatcher(): void {
    if (watcher !== null) return;
    watcher = setInterval(() => {
        const timer = get(sleepTimer);
        if (timer.kind === 'off') {
            stopWatcher();
            return;
        }
        const state = get(audiobookPlayerStore);
        // `!state.book` catches stop(); the mediaId comparison catches the
        // ordinary "play a different book" path, which goes straight through
        // load() and never nulls `book`. Without it an end-of-chapter timer set
        // on book A survives into book B holding a raw chapter INDEX, and pauses
        // book B the moment its chapter numbering happens to line up.
        if (!state.book || (timer.mediaId !== null && state.mediaId !== timer.mediaId)) {
            sleepTimer.set({ kind: 'off' });
            stopWatcher();
            return;
        }
        if (timer.kind === 'duration' && Date.now() >= timer.endsAt) {
            audiobookPlayerStore.pause();
            sleepTimer.set({ kind: 'off' });
            stopWatcher();
            return;
        }
        if (timer.kind === 'end_of_chapter') {
            const index = state.currentChapter?.index ?? null;
            if (index === null) return;
            // Two conditions, because a chapter-index change on its own is not
            // evidence the chapter FINISHED — the chapter sheet, prev/next and a
            // scrub across a boundary all change it. So require the NEXT chapter
            // specifically, and require the position to be near its start.
            //
            // Position is not compared to the armed chapter's end directly: on a
            // book whose chapters and files coincide, the gapless advance rebases
            // the timeline on the incoming deck's MEASURED position, so the exact
            // end is stepped over rather than observed.
            const advancedByOne = index === timer.chapterIndex + 1;
            const nearTheBoundary =
                Math.abs(state.bookPositionMs - timer.chapterEndMs) <= NATURAL_BOUNDARY_WINDOW_MS;
            if (advancedByOne && nearTheBoundary) {
                audiobookPlayerStore.pause();
                sleepTimer.set({ kind: 'off' });
                stopWatcher();
            }
        }
    }, 1000);
}

function stopWatcher(): void {
    if (watcher !== null) {
        clearInterval(watcher);
        watcher = null;
    }
}

/**
 * How close to the armed chapter's end a boundary crossing must land to count as
 * "the chapter finished" rather than "the listener jumped".
 *
 * Sized off the watcher's own 1 s tick plus the gapless advance's lead (150 ms),
 * with room for a throttled background timer. A seek that happens to land inside
 * this window of a chapter boundary is indistinguishable from a natural
 * crossing — and pausing is the recoverable direction to be wrong in.
 */
const NATURAL_BOUNDARY_WINDOW_MS = 3_000;

export function setSleepTimerMinutes(minutes: number): void {
    sleepTimer.set({
        kind: 'duration',
        endsAt: Date.now() + minutes * 60_000,
        mediaId: get(audiobookPlayerStore).mediaId,
    });
    ensureWatcher();
}

export function setSleepTimerEndOfChapter(): void {
    const state = get(audiobookPlayerStore);
    const chapter = state.currentChapter;
    if (!chapter) return;
    sleepTimer.set({
        kind: 'end_of_chapter',
        chapterIndex: chapter.index,
        chapterEndMs: chapter.endMs,
        mediaId: state.mediaId,
    });
    ensureWatcher();
}

export function cancelSleepTimer(): void {
    sleepTimer.set({ kind: 'off' });
    stopWatcher();
}
