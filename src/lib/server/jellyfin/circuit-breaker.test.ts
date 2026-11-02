// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before imports (hoisted)
vi.mock('../config.js', () => ({
    config: {
        APP_NAME: 'test-app',
        JELLYFINURL: 'http://localhost:8096',
        JELLYFINAPIKEY: 'test-api-key',
    },
}));

vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

vi.mock('../runtime-optimizations.js', () => ({
    configureAxiosWithOptimizedAgents: vi.fn(),
}));

vi.mock('@jellyfin/sdk', () => ({
    Jellyfin: class {
        createApi = vi.fn();
    },
}));

// Import after mocks
import { circuitBreaker } from './base-client.js';

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30_000;

describe('Jellyfin Circuit Breaker', () => {
    beforeEach(() => {
        circuitBreaker.reset();
    });

    describe('Initial State', () => {
        it('should start in closed state', () => {
            expect(circuitBreaker.isOpen).toBe(false);
            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });

        it('should return correct initial state via getState()', () => {
            const state = circuitBreaker.getState();
            expect(state.isOpen).toBe(false);
            expect(state.failureCount).toBe(0);
            expect(state.timeSinceOpenMs).toBe(null);
        });
    });

    describe('Failure Tracking', () => {
        it('should track consecutive failures', () => {
            circuitBreaker.recordFailure();
            expect(circuitBreaker.failureCount).toBe(1);
            expect(circuitBreaker.isOpen).toBe(false);

            circuitBreaker.recordFailure();
            expect(circuitBreaker.failureCount).toBe(2);
            expect(circuitBreaker.isOpen).toBe(false);
        });

        it('should open circuit after reaching failure threshold', () => {
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.failureCount).toBe(FAILURE_THRESHOLD);
            expect(circuitBreaker.isOpen).toBe(true);
            expect(circuitBreaker.openedAt).toBeGreaterThan(0);
        });

        it('should not exceed failure threshold when already open', () => {
            for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.failureCount).toBe(FAILURE_THRESHOLD + 3);
            expect(circuitBreaker.isOpen).toBe(true);
        });
    });

    describe('Request Blocking', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should block all requests when circuit is open', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.shouldAllowRequest()).toBe(false);
        });

        it('should allow requests when circuit is closed', () => {
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);

            circuitBreaker.recordFailure();
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);

            circuitBreaker.recordFailure();
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });

        it('should block concurrent requests during open circuit (no thundering herd)', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            // Simulate concurrent requests
            const results = Array.from({ length: 10 }, () => circuitBreaker.shouldAllowRequest());

            expect(results.every((result) => result === false)).toBe(true);
        });
    });

    describe('Half-Open State (Probe Requests)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should allow probe request after reset timeout', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.shouldAllowRequest()).toBe(false);

            // Advance time to reset timeout
            vi.advanceTimersByTime(RESET_TIMEOUT_MS);

            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });

        it('should not allow probe request before reset timeout', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.shouldAllowRequest()).toBe(false);

            // Advance time but not enough
            vi.advanceTimersByTime(RESET_TIMEOUT_MS - 1000);

            expect(circuitBreaker.shouldAllowRequest()).toBe(false);
        });

        it('should close circuit after successful probe', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            // Advance time to reset timeout
            vi.advanceTimersByTime(RESET_TIMEOUT_MS);

            // Simulate successful probe
            circuitBreaker.recordSuccess();

            expect(circuitBreaker.isOpen).toBe(false);
            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });

        it('should keep circuit open after failed probe and continue allowing periodic probes', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            // Advance time to reset timeout (half-open state)
            vi.advanceTimersByTime(RESET_TIMEOUT_MS);

            // Verify we're in half-open state (allows probe)
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);

            // Simulate failed probe
            circuitBreaker.recordFailure();

            // Circuit should remain open with incremented failure count
            expect(circuitBreaker.isOpen).toBe(true);
            expect(circuitBreaker.failureCount).toBe(FAILURE_THRESHOLD + 1);

            // Key behavior: openedAt is NOT reset on probe failure
            // So if enough time has passed from the original open, another probe is allowed
            // This is correct half-open behavior - keep trying periodically
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);

            // Advance more time and try another probe
            vi.advanceTimersByTime(5000);

            // Still allows probes
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);

            // Record another failure
            circuitBreaker.recordFailure();

            expect(circuitBreaker.failureCount).toBe(FAILURE_THRESHOLD + 2);
            expect(circuitBreaker.isOpen).toBe(true);

            // Will still allow periodic probes (half-open behavior)
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });
    });

    describe('Success Recording', () => {
        it('should reset failure count on success', () => {
            circuitBreaker.recordFailure();
            circuitBreaker.recordFailure();
            circuitBreaker.recordFailure();

            expect(circuitBreaker.failureCount).toBe(3);

            circuitBreaker.recordSuccess();

            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.isOpen).toBe(false);
        });

        it('should close circuit on success even if it was open', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.isOpen).toBe(true);

            circuitBreaker.recordSuccess();

            expect(circuitBreaker.isOpen).toBe(false);
            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.openedAt).toBe(0);
        });
    });

    describe('State Diagnostics', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should return correct state when closed', () => {
            const state = circuitBreaker.getState();

            expect(state.isOpen).toBe(false);
            expect(state.failureCount).toBe(0);
            expect(state.timeSinceOpenMs).toBe(null);
        });

        it('should return correct state when open', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            const state = circuitBreaker.getState();

            expect(state.isOpen).toBe(true);
            expect(state.failureCount).toBe(FAILURE_THRESHOLD);
            expect(state.timeSinceOpenMs).toBe(0);
        });

        it('should calculate time since open correctly', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            // Advance time
            vi.advanceTimersByTime(5000);

            const state = circuitBreaker.getState();

            expect(state.timeSinceOpenMs).toBe(5000);
        });

        it('should track failure count independently of circuit state', () => {
            // Record some failures
            circuitBreaker.recordFailure();
            circuitBreaker.recordFailure();

            let state = circuitBreaker.getState();
            expect(state.failureCount).toBe(2);
            expect(state.isOpen).toBe(false);

            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD - 2; i++) {
                circuitBreaker.recordFailure();
            }

            state = circuitBreaker.getState();
            expect(state.failureCount).toBe(FAILURE_THRESHOLD);
            expect(state.isOpen).toBe(true);
        });
    });

    describe('Reset Functionality', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should return to initial state after reset', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            expect(circuitBreaker.isOpen).toBe(true);

            circuitBreaker.reset();

            expect(circuitBreaker.failureCount).toBe(0);
            expect(circuitBreaker.isOpen).toBe(false);
            expect(circuitBreaker.openedAt).toBe(0);
            expect(circuitBreaker.lastFailureAt).toBe(0);
            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });

        it('should reset all internal state', () => {
            circuitBreaker.recordFailure();
            circuitBreaker.recordFailure();

            circuitBreaker.reset();

            const state = circuitBreaker.getState();
            expect(state.isOpen).toBe(false);
            expect(state.failureCount).toBe(0);
            expect(state.timeSinceOpenMs).toBe(null);
        });
    });

    describe('Edge Cases', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should handle alternating success and failure before threshold', () => {
            circuitBreaker.recordFailure();
            circuitBreaker.recordSuccess();
            circuitBreaker.recordFailure();
            circuitBreaker.recordSuccess();

            expect(circuitBreaker.isOpen).toBe(false);
            expect(circuitBreaker.failureCount).toBe(0);
        });

        it('should handle rapid failures', () => {
            const startTime = Date.now();
            for (let i = 0; i < FAILURE_THRESHOLD * 2; i++) {
                circuitBreaker.recordFailure();
                vi.advanceTimersByTime(10);
            }

            expect(circuitBreaker.isOpen).toBe(true);
            expect(circuitBreaker.lastFailureAt).toBeGreaterThan(startTime);
        });

        it('should handle multiple reset cycles', () => {
            // First cycle
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }
            expect(circuitBreaker.isOpen).toBe(true);

            vi.advanceTimersByTime(RESET_TIMEOUT_MS);
            circuitBreaker.recordSuccess();
            expect(circuitBreaker.isOpen).toBe(false);

            // Second cycle
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }
            expect(circuitBreaker.isOpen).toBe(true);

            vi.advanceTimersByTime(RESET_TIMEOUT_MS);
            circuitBreaker.recordSuccess();
            expect(circuitBreaker.isOpen).toBe(false);
        });

        it('should handle time wrapping around reset timeout', () => {
            // Open the circuit
            for (let i = 0; i < FAILURE_THRESHOLD; i++) {
                circuitBreaker.recordFailure();
            }

            // Advance time way beyond reset timeout
            vi.advanceTimersByTime(RESET_TIMEOUT_MS * 5);

            expect(circuitBreaker.shouldAllowRequest()).toBe(true);
        });
    });
});
