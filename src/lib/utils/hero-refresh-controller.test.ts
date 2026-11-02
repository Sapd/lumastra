// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createInitialState,
    handleInitialFetchComplete,
    handleValidationComplete,
    handleRefreshComplete,
    DEFAULT_CONFIG,
    type HeroRefreshState,
} from './hero-refresh-controller';

describe('hero-refresh-controller', () => {
    let mockNow: number;

    beforeEach(() => {
        mockNow = 1000000;
        vi.useFakeTimers();
        vi.setSystemTime(mockNow);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('createInitialState', () => {
        it('should create correct initial state', () => {
            const state = createInitialState();
            expect(state).toEqual({
                refreshInProgress: false,
                lastRefreshTime: 0,
                initialFetchComplete: false,
            });
        });
    });

    describe('handleInitialFetchComplete', () => {
        it('should skip validation for fresh data', () => {
            const state: HeroRefreshState = {
                ...createInitialState(),
                refreshInProgress: true,
            };

            const result = handleInitialFetchComplete(state, {
                nextUpCached: false,
            });

            expect(result.action).toEqual({
                type: 'skip_validation',
                reason: 'fresh_data',
            });
            expect(result.newState.lastRefreshTime).toBe(mockNow);
        });

        it('should skip validation for recent cache', () => {
            const state: HeroRefreshState = {
                ...createInitialState(),
                refreshInProgress: true,
            };

            const result = handleInitialFetchComplete(
                state,
                { nextUpCached: true, nextUpCachedAt: mockNow - 10000 }, // 10 seconds ago
                { ...DEFAULT_CONFIG, skipValidationThreshold: 30000 },
            );

            expect(result.action).toEqual({
                type: 'skip_validation',
                reason: 'recent_cache',
            });
            expect(result.newState.lastRefreshTime).toBe(mockNow);
        });

        it('should validate for old cache', () => {
            const state: HeroRefreshState = {
                ...createInitialState(),
                refreshInProgress: true,
            };

            const result = handleInitialFetchComplete(
                state,
                { nextUpCached: true, nextUpCachedAt: mockNow - 60000 }, // 60 seconds ago
                { ...DEFAULT_CONFIG, skipValidationThreshold: 30000 },
            );

            expect(result.action).toEqual({ type: 'validate' });
            // Should NOT set lastRefreshTime yet - wait for validation result
            expect(result.newState.lastRefreshTime).toBeUndefined();
        });

        it('should validate when cache has no timestamp', () => {
            const state: HeroRefreshState = {
                ...createInitialState(),
                refreshInProgress: true,
            };

            const result = handleInitialFetchComplete(state, {
                nextUpCached: true,
            });

            expect(result.action).toEqual({ type: 'validate' });
        });
    });

    describe('handleValidationComplete', () => {
        it('should trigger refresh when stale', () => {
            const result = handleValidationComplete(true);

            expect(result.action).toEqual({ type: 'refresh' });
            expect(result.newState).toEqual({ refreshInProgress: true });
        });

        it('should NOT trigger refresh when fresh', () => {
            const result = handleValidationComplete(false);

            expect(result.action).toEqual({ type: 'no_refresh' });
            expect(result.newState.lastRefreshTime).toBe(mockNow);
        });

        it('validation-triggered refresh should NOT check cooldown (bypasses it)', () => {
            // This is the critical bug we fixed - validation refresh should always work
            // The state machine doesn't include cooldown check for validation
            const result = handleValidationComplete(true);

            // It simply returns { type: 'refresh' } without any cooldown consideration
            expect(result.action).toEqual({ type: 'refresh' });
        });
    });

    describe('handleRefreshComplete', () => {
        it('should update state on success', () => {
            const result = handleRefreshComplete(true);

            expect(result).toEqual({
                refreshInProgress: false,
                lastRefreshTime: mockNow,
            });
        });

        it('should only clear flag on failure', () => {
            const result = handleRefreshComplete(false);

            expect(result).toEqual({
                refreshInProgress: false,
            });
            expect(result.lastRefreshTime).toBeUndefined();
        });
    });

    describe('full flow scenarios', () => {
        it('scenario: cached data with validation showing stale', () => {
            // This tests the bug we fixed - validation triggering refresh should work
            let state = createInitialState();

            // 1. Start initial fetch
            state = { ...state, refreshInProgress: true };

            // 2. Initial fetch completes with cached data
            const fetchResult = handleInitialFetchComplete(state, {
                nextUpCached: true,
                nextUpCachedAt: mockNow - 60000,
            });
            expect(fetchResult.action).toEqual({ type: 'validate' });
            state = { ...state, ...fetchResult.newState };

            // 3. Validation returns stale
            const validationResult = handleValidationComplete(true);
            expect(validationResult.action).toEqual({ type: 'refresh' });
            state = { ...state, ...validationResult.newState };

            // 4. State should allow refresh (refreshInProgress = true from validation)
            expect(state.refreshInProgress).toBe(true);

            // 5. Refresh completes
            const refreshResult = handleRefreshComplete(true);
            state = { ...state, ...refreshResult };

            expect(state.refreshInProgress).toBe(false);
            expect(state.lastRefreshTime).toBe(mockNow);
        });

        it('scenario: fresh data skips validation entirely', () => {
            let state = createInitialState();

            // 1. Start initial fetch
            state = { ...state, refreshInProgress: true };

            // 2. Initial fetch completes with FRESH data (not cached)
            const fetchResult = handleInitialFetchComplete(state, {
                nextUpCached: false,
            });

            expect(fetchResult.action).toEqual({
                type: 'skip_validation',
                reason: 'fresh_data',
            });
            expect(fetchResult.newState.lastRefreshTime).toBe(mockNow);

            // No validation step needed
        });

        it('scenario: validation refresh proceeds when no concurrent refresh', () => {
            let state = createInitialState();

            // 1. Start initial fetch
            state = { ...state, refreshInProgress: true };

            // 2. Initial fetch completes with stale cached data
            const fetchResult = handleInitialFetchComplete(state, {
                nextUpCached: true,
                nextUpCachedAt: mockNow - 60000,
            });
            state = { ...state, ...fetchResult.newState };

            // 3. No concurrent refresh in progress
            expect(state.refreshInProgress).toBe(false);

            // 4. Validation completes, returns stale
            const validationResult = handleValidationComplete(true);
            expect(validationResult.action).toEqual({ type: 'refresh' });

            // 5. Since refreshInProgress is still false, validation refresh proceeds
            state = { ...state, ...validationResult.newState };
            expect(state.refreshInProgress).toBe(true);
        });
    });
});
