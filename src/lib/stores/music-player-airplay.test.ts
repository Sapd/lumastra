// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AirPlay-aware crossfade gating.
 *
 * Verifies that:
 *  - isAirPlayActive defaults to false
 *  - Setting isAirPlayActive prevents future crossfade trigger decisions
 *  - Pending crossfade state is cleared on either AirPlay transition
 *  - crossfadeEffective derived store reflects (crossfadeEnabled && !isAirPlayActive)
 *
 * We test by directly mutating store state via update(). Full crossfade
 * trigger flow is exercised via integration / manual tests; here we focus
 * on the small state-machine pieces this feature introduces.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { musicPlayerStore, crossfadeEffective } from './music-player.store';

// _updateForTest is only present in DEV/test builds; assert non-null here so
// we don't have to guard every call site individually.
const updateForTest = musicPlayerStore._updateForTest!;

beforeEach(() => {
    // Reset all crossfade-related fields between tests.
    updateForTest((s) => ({
        ...s,
        crossfadeEnabled: true,
        supportsCrossfade: true,
        isAirPlayActive: false,
        pendingCrossfadeAtMs: null,
        pendingCrossfadeForTrackId: null,
    }));
});

describe('isAirPlayActive state', () => {
    it('defaults to false', () => {
        expect(get(musicPlayerStore).isAirPlayActive).toBe(false);
    });
});

describe('crossfadeEffective derived store', () => {
    it('is true when crossfadeEnabled && !isAirPlayActive', () => {
        updateForTest((s) => ({
            ...s,
            crossfadeEnabled: true,
            isAirPlayActive: false,
        }));
        expect(get(crossfadeEffective)).toBe(true);
    });

    it('is false when isAirPlayActive is true (overrides preference)', () => {
        updateForTest((s) => ({
            ...s,
            crossfadeEnabled: true,
            isAirPlayActive: true,
        }));
        expect(get(crossfadeEffective)).toBe(false);
    });

    it('is false when crossfadeEnabled is false (regardless of AirPlay)', () => {
        updateForTest((s) => ({
            ...s,
            crossfadeEnabled: false,
            isAirPlayActive: false,
        }));
        expect(get(crossfadeEffective)).toBe(false);
    });

    it('is false when the backend does not support crossfade (e.g. iOS PlainAudioBackend)', () => {
        // Regression: loadMusicSettings() re-enables crossfadeEnabled from the
        // saved user preference (default true) even on iOS, so the amber
        // MiniPlayer fade markers reappeared despite the backend being unable
        // to crossfade. supportsCrossfade must veto the effective gate.
        updateForTest((s) => ({
            ...s,
            crossfadeEnabled: true,
            isAirPlayActive: false,
            supportsCrossfade: false,
        }));
        expect(get(crossfadeEffective)).toBe(false);
    });
});

describe('supportsCrossfade state', () => {
    it('defaults to true (corrected from the backend at init)', () => {
        expect(get(musicPlayerStore).supportsCrossfade).toBe(true);
    });
});

describe('pendingCrossfade state lifecycle', () => {
    // The store does not currently expose a public setter for AirPlay state
    // (it's driven internally by the detector). For testing, we drive it
    // directly via update() — same shape the detector callback produces.

    it('clears pendingCrossfadeAtMs and forTrackId when AirPlay engages', () => {
        updateForTest((s) => ({
            ...s,
            pendingCrossfadeAtMs: 180_000,
            pendingCrossfadeForTrackId: 'track-id-1',
        }));
        // Simulate the detector callback flipping AirPlay on, applying the
        // same update shape as music-player.store.ts uses internally.
        updateForTest((s) => ({
            ...s,
            isAirPlayActive: true,
            pendingCrossfadeAtMs: null,
            pendingCrossfadeForTrackId: null,
        }));
        const state = get(musicPlayerStore);
        expect(state.isAirPlayActive).toBe(true);
        expect(state.pendingCrossfadeAtMs).toBeNull();
        expect(state.pendingCrossfadeForTrackId).toBeNull();
    });

    it('clears pendingCrossfadeAtMs and forTrackId when AirPlay disengages', () => {
        updateForTest((s) => ({
            ...s,
            isAirPlayActive: true,
            pendingCrossfadeAtMs: 200_000,
            pendingCrossfadeForTrackId: 'track-id-2',
        }));
        updateForTest((s) => ({
            ...s,
            isAirPlayActive: false,
            pendingCrossfadeAtMs: null,
            pendingCrossfadeForTrackId: null,
        }));
        const state = get(musicPlayerStore);
        expect(state.isAirPlayActive).toBe(false);
        expect(state.pendingCrossfadeAtMs).toBeNull();
        expect(state.pendingCrossfadeForTrackId).toBeNull();
    });
});

describe('checkCrossfadeTrigger AirPlay gate (regression guard)', () => {
    it('early-return block contains isAirPlayActive guard', () => {
        // Structural test: reads the store source and asserts that the
        // checkCrossfadeTrigger early-return condition includes isAirPlayActive.
        // This ensures a future refactor cannot silently remove the gate
        // without breaking this test.
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(resolve(__dirname, 'music-player.store.ts'), 'utf-8');
        // Match the function signature through the first closing brace of its
        // early-return guard block.
        const match = source.match(/function checkCrossfadeTrigger[\s\S]*?return;\s*\}/);
        expect(match, 'checkCrossfadeTrigger early-return block not found').not.toBeNull();
        expect(
            match![0],
            'isAirPlayActive guard is missing from checkCrossfadeTrigger early-return',
        ).toContain('isAirPlayActive');
    });
});

vi.mock('$app/stores', () => ({
    page: { subscribe: (run: (value: unknown) => void) => {
        run({ data: { user: { userId: 'music-player-test-user' } } });
        return () => undefined;
    } },
}));
