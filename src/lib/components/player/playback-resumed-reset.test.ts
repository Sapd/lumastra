// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reset that runs when playback (re)starts for an item.
 *
 * Background: this block lived inline in `onPlay()`. `onPlay()` early-returns
 * for the entire restart window, and on the in-place episode advance no later
 * `play` event ever arrives (the element never pauses in between), so the block
 * is swallowed for good. The advance replayed exactly ONE line of it —
 * `bootstrapFirstPlay()` — leaving `hasEnded` true from the `onEnded()` that
 * triggered the advance moments earlier.
 *
 * `hasEnded` gates the reconnect auto-resume, the stall watchdog (via
 * updatePlaybackIntent) and rebuildPlaybackSession's autoResume. So from the
 * second episode onward: tunnel → reconnect → `.play()` never called, watchdog
 * off → audio stops permanently.
 *
 * These tests run against the REAL playerStore singleton and assert observable
 * state, not call counts, so they cannot pass by mocking the thing under test.
 *
 * What they prove:
 *  - every field the swallowed block used to write is written. Each is seeded to
 *    the OPPOSITE value first, so dropping any single line fails — that is the
 *    exact defect class here (a block reduced to one of its lines).
 *  - `hasEnded` is cleared BEFORE `updatePlaybackIntent()` runs, captured by
 *    recording the flag's value at the moment the intent callback fires. A reset
 *    that clears it afterwards re-arms the watchdog from the stale value and
 *    would pass a naive end-state assertion.
 *
 * What they do NOT prove: that PlayerController actually calls this from both
 * `onPlay()` and the advance's `onRestored` (both call sites are in the
 * controller; only an end-to-end player harness could observe that).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { playerStore } from './playerStore.svelte';
import { applyPlaybackResumedReset } from './playback-resumed-reset';

describe('applyPlaybackResumedReset', () => {
    beforeEach(() => {
        // Seed the post-onEnded / post-error state the reset has to undo.
        playerStore.setPlaying(false);
        playerStore.setError('previous episode failed');
        playerStore.setPausedByUser(true);
        playerStore.setReconnectNeedsTap(true);
        playerStore.setEnded(true);
    });

    function makeDeps(hasEndedBox: { value: boolean }) {
        return {
            setHasEnded: (v: boolean) => {
                hasEndedBox.value = v;
            },
            updatePlaybackIntent: vi.fn(),
            setMediaSessionPlaybackState: vi.fn(),
        };
    }

    it('clears every flag the swallowed onPlay() block used to clear', () => {
        const hasEnded = { value: true };
        const deps = makeDeps(hasEnded);

        applyPlaybackResumedReset(playerStore, deps);

        expect({
            isPlaying: playerStore.isPlaying,
            error: playerStore.error,
            pausedByUser: playerStore.pausedByUser,
            reconnectNeedsTap: playerStore.reconnectNeedsTap,
            ended: playerStore.hasEnded,
            controllerHasEnded: hasEnded.value,
        }).toEqual({
            isPlaying: true,
            error: null,
            pausedByUser: false,
            reconnectNeedsTap: false,
            ended: false,
            controllerHasEnded: false,
        });
        expect(deps.updatePlaybackIntent).toHaveBeenCalledOnce();
        expect(deps.setMediaSessionPlaybackState).toHaveBeenCalledWith('playing');
    });

    it('clears hasEnded BEFORE re-arming the stall watchdog', () => {
        // Ordering, not just end state: updatePlaybackIntent() reads hasEnded to
        // decide whether the watchdog should run. If the flag is still true when
        // it fires, the watchdog stays disabled for the whole next episode even
        // though the flag ends up false.
        const hasEnded = { value: true };
        let hasEndedWhenIntentRan: boolean | null = null;

        applyPlaybackResumedReset(playerStore, {
            setHasEnded: (v: boolean) => {
                hasEnded.value = v;
            },
            updatePlaybackIntent: () => {
                hasEndedWhenIntentRan = hasEnded.value;
            },
            setMediaSessionPlaybackState: () => {},
        });

        expect(hasEndedWhenIntentRan).toBe(false);
    });
});
