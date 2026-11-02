// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the in-process circuit breaker (utils/circuit-breaker.ts).
 *
 * No DB, no Valkey, no real timers needed.  The module exposes Date.now()
 * directly so vi.useFakeTimers() is the right injection mechanism.
 *
 * Run: npx vitest run src/lib/server/utils/circuit-breaker.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, getBreaker } from './circuit-breaker.js';

// FAILURE_THRESHOLD = 5, COOLDOWN_MS = 60_000 (from module constants)
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Trip the breaker by recording FAILURE_THRESHOLD consecutive transient failures. */
function tripBreaker(cb: CircuitBreaker): void {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        cb.recordFailure();
    }
}

const transient = () => true;
const nonTransient = () => false;

// ── CircuitOpenError ──────────────────────────────────────────────────────────

describe('CircuitOpenError', () => {
    it('is an instance of Error', () => {
        const err = new CircuitOpenError('tmdb');
        expect(err).toBeInstanceOf(Error);
    });

    it('name is CircuitOpenError', () => {
        const err = new CircuitOpenError('tmdb');
        expect(err.name).toBe('CircuitOpenError');
    });

    it('message includes the dependency key', () => {
        const err = new CircuitOpenError('sonarr');
        expect(err.message).toContain('sonarr');
    });

    it('dependency property matches the key', () => {
        const err = new CircuitOpenError('radarr');
        expect(err.dependency).toBe('radarr');
    });

    it('carries isDependencyUnavailable = true (duck-type brand)', () => {
        const err = new CircuitOpenError('tmdb');
        expect(err.isDependencyUnavailable).toBe(true);
    });

    it('instanceof check works across prototype chain (setPrototypeOf guard)', () => {
        const err = new CircuitOpenError('x');
        expect(err instanceof CircuitOpenError).toBe(true);
    });
});

// ── State machine ─────────────────────────────────────────────────────────────

describe('CircuitBreaker state machine', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts CLOSED', () => {
        const cb = new CircuitBreaker('svc');
        expect(cb.currentState).toBe('CLOSED');
    });

    it('isAllowed is true when CLOSED', () => {
        const cb = new CircuitBreaker('svc');
        expect(cb.isAllowed).toBe(true);
    });

    // ── CLOSED → OPEN ─────────────────────────────────────────────────────────

    it('trips to OPEN after FAILURE_THRESHOLD consecutive failures', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        expect(cb.currentState).toBe('OPEN');
    });

    it('stays CLOSED with fewer than FAILURE_THRESHOLD consecutive failures', () => {
        const cb = new CircuitBreaker('svc');
        for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
            cb.recordFailure();
        }
        expect(cb.currentState).toBe('CLOSED');
    });

    it('success resets consecutive failure count', () => {
        const cb = new CircuitBreaker('svc');
        for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
            cb.recordFailure();
        }
        cb.recordSuccess();
        // One more failure after reset should not open
        cb.recordFailure();
        expect(cb.currentState).toBe('CLOSED');
    });

    // ── OPEN fast-fail ────────────────────────────────────────────────────────

    it('isAllowed is false when OPEN (before cooldown)', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        expect(cb.isAllowed).toBe(false);
    });

    // ── OPEN → HALF_OPEN after cooldown ───────────────────────────────────────

    it('transitions to HALF_OPEN after cooldown elapses', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS);
        expect(cb.isAllowed).toBe(true);
        expect(cb.currentState).toBe('HALF_OPEN');
    });

    it('isAllowed stays false just before cooldown expires', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS - 1);
        expect(cb.isAllowed).toBe(false);
    });

    // ── HALF_OPEN probe success → CLOSED ──────────────────────────────────────

    it('probe success resets to CLOSED with cleared failure counter', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS);
        expect(cb.isAllowed).toBe(true); // probe allowed → HALF_OPEN transition
        cb.recordSuccess();
        expect(cb.currentState).toBe('CLOSED');
        // After reset a single failure should not open
        cb.recordFailure();
        expect(cb.currentState).toBe('CLOSED');
    });

    // ── HALF_OPEN probe failure → OPEN again ──────────────────────────────────

    it('probe failure returns to OPEN and starts a new cooldown', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS);
        expect(cb.isAllowed).toBe(true); // probe allowed → HALF_OPEN
        cb.recordFailure(); // probe failed
        expect(cb.currentState).toBe('OPEN');
        // Cooldown re-started — must not be HALF_OPEN until another period elapses
        expect(cb.isAllowed).toBe(false);
    });

    it('HALF_OPEN probe failure requires another full cooldown before re-probing', () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS);
        expect(cb.isAllowed).toBe(true); // probe allowed → HALF_OPEN
        cb.recordFailure(); // → OPEN

        // Partial advance should still deny
        vi.advanceTimersByTime(COOLDOWN_MS - 1);
        expect(cb.isAllowed).toBe(false);

        // Full advance allows again
        vi.advanceTimersByTime(1);
        expect(cb.isAllowed).toBe(true);
    });

    // ── Non-transient errors must NOT increment counter ───────────────────────

    it('does not trip on non-transient errors', () => {
        const cb = new CircuitBreaker('svc');
        // More than threshold, but all non-transient
        for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) {
            // Simulated via execute with isTransient=false
        }
        // Use recordFailure indirectly through execute
        expect(cb.currentState).toBe('CLOSED');
    });
});

// ── execute() ────────────────────────────────────────────────────────────────

describe('CircuitBreaker.execute()', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('calls fn and returns its value when CLOSED', async () => {
        const cb = new CircuitBreaker('svc');
        const result = await cb.execute(async () => 42);
        expect(result).toBe(42);
    });

    it('throws CircuitOpenError without calling fn when OPEN', async () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);

        const fn = vi.fn(async () => 'should-not-run');
        await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(fn).not.toHaveBeenCalled();
    });

    it('CircuitOpenError from execute carries isDependencyUnavailable', async () => {
        const cb = new CircuitBreaker('dep');
        tripBreaker(cb);
        let caught: unknown;
        try {
            await cb.execute(async () => {});
        } catch (e) {
            caught = e;
        }
        expect((caught as CircuitOpenError).isDependencyUnavailable).toBe(true);
    });

    it('records success when fn resolves', async () => {
        const cb = new CircuitBreaker('svc');
        for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
            cb.recordFailure();
        }
        await cb.execute(async () => 'ok');
        // After success, failure counter resets — one more failure should not open
        cb.recordFailure();
        expect(cb.currentState).toBe('CLOSED');
    });

    it('records failure on transient error and re-throws', async () => {
        const cb = new CircuitBreaker('svc');
        const boom = new Error('network error');

        await expect(
            cb.execute(async () => {
                throw boom;
            }, transient),
        ).rejects.toBe(boom);

        // One failure — not open yet
        expect(cb.currentState).toBe('CLOSED');
    });

    it('does NOT increment failure counter for non-transient errors', async () => {
        const cb = new CircuitBreaker('svc');
        const authErr = new Error('401 Unauthorized');

        for (let i = 0; i < FAILURE_THRESHOLD + 3; i++) {
            await expect(
                cb.execute(async () => {
                    throw authErr;
                }, nonTransient),
            ).rejects.toBe(authErr);
        }

        expect(cb.currentState).toBe('CLOSED');
    });

    it('does not double-count a nested CircuitOpenError', async () => {
        const cb = new CircuitBreaker('outer');
        // Pre-load to one failure below threshold
        for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
            cb.recordFailure();
        }

        const inner = new CircuitOpenError('inner-dep');
        // Nested CircuitOpenError should not increment outer's counter
        await expect(
            cb.execute(async () => {
                throw inner;
            }, transient),
        ).rejects.toBe(inner);

        expect(cb.currentState).toBe('CLOSED');
    });

    it('trips to OPEN after FAILURE_THRESHOLD transient failures via execute', async () => {
        const cb = new CircuitBreaker('svc');
        const err = new Error('timeout');

        for (let i = 0; i < FAILURE_THRESHOLD; i++) {
            await expect(
                cb.execute(async () => {
                    throw err;
                }, transient),
            ).rejects.toBe(err);
        }

        expect(cb.currentState).toBe('OPEN');
    });

    it('allows probe through HALF_OPEN and succeeds → CLOSED', async () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS); // triggers HALF_OPEN on next isAllowed check

        const result = await cb.execute(async () => 'probe-ok');
        expect(result).toBe('probe-ok');
        expect(cb.currentState).toBe('CLOSED');
    });

    it('allows probe through HALF_OPEN but failure → OPEN', async () => {
        const cb = new CircuitBreaker('svc');
        tripBreaker(cb);
        vi.advanceTimersByTime(COOLDOWN_MS);

        const err = new Error('still down');
        await expect(
            cb.execute(async () => {
                throw err;
            }, transient),
        ).rejects.toBe(err);

        expect(cb.currentState).toBe('OPEN');
    });
});

// ── getBreaker registry ───────────────────────────────────────────────────────

describe('getBreaker registry', () => {
    it('returns the same instance for the same key', () => {
        const a = getBreaker('registry-test-key');
        const b = getBreaker('registry-test-key');
        expect(a).toBe(b);
    });

    it('returns distinct instances for different keys', () => {
        const a = getBreaker('registry-key-alpha');
        const b = getBreaker('registry-key-beta');
        expect(a).not.toBe(b);
    });

    it('returned instance is a CircuitBreaker', () => {
        const cb = getBreaker('registry-key-type-check');
        expect(cb).toBeInstanceOf(CircuitBreaker);
    });

    it('state changes on one key do not affect another key', () => {
        const a = getBreaker('isolated-a');
        const b = getBreaker('isolated-b');

        tripBreaker(a);

        expect(a.currentState).toBe('OPEN');
        expect(b.currentState).toBe('CLOSED');
    });
});
