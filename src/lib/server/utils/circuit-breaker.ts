// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lightweight in-process circuit breaker.
 *
 * One breaker instance per logical dependency key (e.g. 'tmdb', 'sonarr',
 * 'radarr'). State machine: CLOSED → OPEN → HALF_OPEN.
 *
 *   CLOSED     – calls pass through; consecutive transient failures increment
 *                the failure counter.  When it reaches FAILURE_THRESHOLD the
 *                circuit trips to OPEN.
 *   OPEN       – calls are rejected immediately with CircuitOpenError without
 *                touching the network.  After COOLDOWN_MS the circuit moves to
 *                HALF_OPEN.
 *   HALF_OPEN  – one probe call is allowed through.  A success resets to
 *                CLOSED; a failure returns to OPEN for another cooldown.
 *
 * Only transient / infra failures (5xx, network, timeout) should be recorded
 * via `recordFailure()`.  Auth failures and 4xx errors must NOT increment the
 * counter — the caller is responsible for this distinction.
 *
 * Per-replica; no shared state (Valkey etc.).
 */

/** Consecutive transient failures before the circuit opens. */
const FAILURE_THRESHOLD = 5;

/** How long the circuit stays open before allowing a probe (ms). */
const COOLDOWN_MS = 60_000;

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Thrown when a call is rejected by an open circuit.
 *
 * Carries `isDependencyUnavailable = true` so it duck-types as a
 * `DependencyUnavailableError` (see `api/problem.ts`) everywhere in the
 * codebase — including `isDependencyUnavailable()` guard and the Arr
 * `getCalendar` catch path — without importing from that module.
 */
export class CircuitOpenError extends Error {
    /** Brand — satisfies the isDependencyUnavailable duck-type check. */
    readonly isDependencyUnavailable = true as const;
    readonly dependency: string;

    constructor(key: string) {
        super(`Circuit open for dependency '${key}' — fast-failing`);
        this.name = 'CircuitOpenError';
        this.dependency = key;
        Object.setPrototypeOf(this, CircuitOpenError.prototype);
    }
}

export class CircuitBreaker {
    private state: State = 'CLOSED';
    private failures = 0;
    private openedAt = 0;
    private readonly key: string;

    constructor(key: string) {
        this.key = key;
    }

    /**
     * Returns true when the circuit will allow the next call through.
     * Transitions OPEN → HALF_OPEN when the cooldown has elapsed.
     */
    get isAllowed(): boolean {
        if (this.state === 'CLOSED') return true;
        if (this.state === 'HALF_OPEN') return false; // probe already in-flight
        // OPEN — check cooldown
        if (Date.now() - this.openedAt >= COOLDOWN_MS) {
            this.state = 'HALF_OPEN';
            return true;
        }
        return false;
    }

    /**
     * Wrap a call with circuit-breaker logic.
     *
     * - Throws `CircuitOpenError` when the circuit is open.
     * - On success: calls `recordSuccess()`.
     * - On failure: calls `recordFailure()` only when `isTransient(err)`
     *   returns true (default: always).  Pass a predicate to exclude permanent
     *   failures (auth errors, 4xx) from tripping the breaker.
     */
    async execute<T>(
        fn: () => Promise<T>,
        isTransient: (err: unknown) => boolean = () => true,
    ): Promise<T> {
        if (!this.isAllowed) {
            throw new CircuitOpenError(this.key);
        }
        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (err) {
            // CircuitOpenError from a nested call — don't double-count.
            if (err instanceof CircuitOpenError) throw err;
            if (isTransient(err)) {
                this.recordFailure();
            }
            throw err;
        }
    }

    recordSuccess(): void {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    recordFailure(): void {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= FAILURE_THRESHOLD) {
            this.state = 'OPEN';
            this.openedAt = Date.now();
            this.failures = FAILURE_THRESHOLD; // cap so no overflow accumulation
        }
    }

    get currentState(): State {
        return this.state;
    }
}

/** Registry — one breaker per dependency key, created on first access. */
const registry = new Map<string, CircuitBreaker>();

export function getBreaker(key: string): CircuitBreaker {
    let breaker = registry.get(key);
    if (!breaker) {
        breaker = new CircuitBreaker(key);
        registry.set(key, breaker);
    }
    return breaker;
}
