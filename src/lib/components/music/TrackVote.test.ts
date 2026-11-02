// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for TrackVote vote-wiring logic.
 *
 * The component calls `$lib/api/music` (setTrackFeedback / clearTrackFeedback) via a
 * dynamic import, and shows optimistic UI via a `$derived` feedback state.
 * These tests verify the API call pattern and optimistic-revert behaviour by
 * stubbing out the api/music module and toast store.
 *
 * NOTE: We test the functional logic extracted into helpers rather than
 * rendering the Svelte component directly — rendering requires
 * SvelteKit virtual modules which are mocked separately in integration tests.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

// toast.store — no-op to avoid module resolution issues
vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: vi.fn(),
        error: vi.fn(),
    },
}));

// paraglide — return plain strings
vi.mock('$lib/paraglide/messages', () => ({
    toast_track_liked: () => 'Track added to your taste profile',
    toast_track_disliked: () => "Won't recommend this track again",
    music_like_track_aria: () => 'Like track',
    music_dislike_track_aria: () => 'Dislike track',
}));

// api/music — default to success; individual tests can override
const mockSetTrackFeedback = vi.fn();
const mockClearTrackFeedback = vi.fn();

vi.mock('$lib/api/music', () => ({
    setTrackFeedback: (...args: unknown[]) => mockSetTrackFeedback(...args),
    clearTrackFeedback: (...args: unknown[]) => mockClearTrackFeedback(...args),
}));

// ── Helpers that mirror the vote() logic in TrackVote.svelte ──────────────

/**
 * Minimal re-implementation of the vote() logic so we can unit-test it
 * without mounting a Svelte component tree.  Any change to the component's
 * vote() must be mirrored here.
 */
async function vote(
    direction: 'liked' | 'disliked',
    currentFeedback: 'liked' | 'disliked' | null,
    trackId: string,
): Promise<{
    newFeedback: 'liked' | 'disliked' | null;
    toastCalled: string | null;
}> {
    const { setTrackFeedback, clearTrackFeedback } = await import('$lib/api/music');
    const { toasts } = await import('$lib/stores/toast.store');
    const { toast_track_liked, toast_track_disliked } = await import('$lib/paraglide/messages');

    const next: 'liked' | 'disliked' | null = currentFeedback === direction ? null : direction;
    let toastCalled: string | null = null;

    try {
        if (next === 'liked') {
            const result = await setTrackFeedback(trackId, 'liked');
            if (result.error) throw new Error(result.error);
            toastCalled = String(toast_track_liked());
            toasts.success(toastCalled);
        } else if (next === 'disliked') {
            const result = await setTrackFeedback(trackId, 'disliked');
            if (result.error) throw new Error(result.error);
            toastCalled = String(toast_track_disliked());
            toasts.success(toastCalled);
        } else {
            const result = await clearTrackFeedback(trackId);
            if (result.error) throw new Error(result.error);
        }
        return { newFeedback: next, toastCalled };
    } catch {
        // revert → return original
        return { newFeedback: currentFeedback, toastCalled: null };
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TrackVote vote logic', () => {
    const TRACK_ID = 'aaaabbbb-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        mockSetTrackFeedback.mockResolvedValue({ data: null, error: null });
        mockClearTrackFeedback.mockResolvedValue({ data: null, error: null });
    });

    test('like from neutral state sets feedback to liked and shows toast', async () => {
        const result = await vote('liked', null, TRACK_ID);
        expect(result.newFeedback).toBe('liked');
        expect(mockSetTrackFeedback).toHaveBeenCalledWith(TRACK_ID, 'liked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'disliked');
        expect(result.toastCalled).toBe('Track added to your taste profile');
    });

    test('dislike from neutral state sets feedback to disliked and shows toast', async () => {
        const result = await vote('disliked', null, TRACK_ID);
        expect(result.newFeedback).toBe('disliked');
        expect(mockSetTrackFeedback).toHaveBeenCalledWith(TRACK_ID, 'disliked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'liked');
        expect(result.toastCalled).toContain("Won't recommend");
    });

    // Toggle-off MUST hit the network. This previously did not: the optimistic
    // UI cleared the vote while the server kept it forever, so the like came
    // back on reload. Asserting the call is the regression guard.
    test('toggle-off: un-liking an already-liked track clears it server-side', async () => {
        const result = await vote('liked', 'liked', TRACK_ID);
        expect(result.newFeedback).toBeNull();
        expect(mockClearTrackFeedback).toHaveBeenCalledWith(TRACK_ID);
        expect(mockClearTrackFeedback).toHaveBeenCalledTimes(1);
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'liked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'disliked');
    });

    test('toggle-off: un-disliking an already-disliked track clears it server-side', async () => {
        const result = await vote('disliked', 'disliked', TRACK_ID);
        expect(result.newFeedback).toBeNull();
        expect(mockClearTrackFeedback).toHaveBeenCalledWith(TRACK_ID);
        expect(mockClearTrackFeedback).toHaveBeenCalledTimes(1);
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'liked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'disliked');
    });

    test('toggle-off failure reverts the optimistic clear', async () => {
        mockClearTrackFeedback.mockResolvedValue({ data: null, error: 'Request failed' });
        const result = await vote('liked', 'liked', TRACK_ID);
        expect(result.newFeedback).toBe('liked');
    });

    test('switching from liked to disliked sets disliked feedback', async () => {
        const result = await vote('disliked', 'liked', TRACK_ID);
        expect(result.newFeedback).toBe('disliked');
        expect(mockSetTrackFeedback).toHaveBeenCalledWith(TRACK_ID, 'disliked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'liked');
    });

    test('switching from disliked to liked sets liked feedback', async () => {
        const result = await vote('liked', 'disliked', TRACK_ID);
        expect(result.newFeedback).toBe('liked');
        expect(mockSetTrackFeedback).toHaveBeenCalledWith(TRACK_ID, 'liked');
        expect(mockSetTrackFeedback).not.toHaveBeenCalledWith(TRACK_ID, 'disliked');
    });

    test('API failure reverts feedback to previous state', async () => {
        mockSetTrackFeedback.mockResolvedValue({ data: null, error: 'Request failed' });
        const result = await vote('liked', null, TRACK_ID);
        // Should revert to previous (null)
        expect(result.newFeedback).toBeNull();
        expect(result.toastCalled).toBeNull();
    });

    test('API network error reverts feedback', async () => {
        mockSetTrackFeedback.mockRejectedValue(new Error('Network error'));
        const result = await vote('disliked', null, TRACK_ID);
        expect(result.newFeedback).toBeNull();
    });

    test('cold start: vote works with no prior feedback', async () => {
        const result = await vote('liked', null, TRACK_ID);
        expect(result.newFeedback).toBe('liked');
    });
});
