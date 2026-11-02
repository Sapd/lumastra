// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SSE "connection unstable" warning debounce (pure logic).
 *
 * The watch-together SSE stream can be reset by edge/proxy idle timeouts every
 * ~30-60s. Each drop self-heals in well under a second (reconnect + Last-Event-ID
 * replay), so warning the viewer per blip would spam a toast. This module decides
 * when instability is *sustained* enough to warrant a single, cooled-down warning:
 *
 *   - repeated distinct outages inside a rolling window, OR
 *   - a single outage that stays down for a few seconds.
 *
 * Kept pure (no toast/DOM/`browser` access) so it is unit-testable in isolation;
 * the store owns the side effect (surfacing the toast).
 */

/** Rolling window over which repeated SSE outages count as sustained instability. */
export const SSE_INSTABILITY_WINDOW_MS = 90_000;
/** Min quiet time between warnings (avoids per-blip spam). */
export const SSE_INSTABILITY_WARN_COOLDOWN_MS = 60_000;
/** Distinct outages within the window before warning about repeated drops. */
export const SSE_INSTABILITY_REPEAT_THRESHOLD = 2;
/**
 * A single outage still failing at this reconnect attempt also warrants a warning.
 * With the SSE layer's 1s·2^(n-1) backoff, attempt 3 means the stream has been
 * down ~3s+ (1s + 2s of prior waits) — a real gap, not a clean self-healing blip.
 */
export const SSE_INSTABILITY_LONG_OUTAGE_ATTEMPT = 3;

export interface InstabilityState {
    /** Timestamps (ms) of distinct outage starts currently inside the rolling window. */
    outageStarts: number[];
    /** Last time (ms) a warning was surfaced (0 = never). */
    lastWarnAt: number;
}

export interface InstabilityDecision {
    /** Next tracking state to store. */
    state: InstabilityState;
    /** Whether a warning should be surfaced on this call. */
    warn: boolean;
}

/** Fresh tracking state for a new stream. */
export function initialInstabilityState(): InstabilityState {
    return { outageStarts: [], lastWarnAt: 0 };
}

/**
 * Evaluate a reconnect attempt against the current tracking state.
 *
 * @param state   current tracking state
 * @param attempt reconnect attempt number from the SSE layer. `attempt === 1`
 *                marks the start of a NEW outage (the SSE layer resets its
 *                counter to 0 on a successful open); higher attempts are the same
 *                outage still failing.
 * @param now     current time in ms (injected for testability)
 * @returns the next state and whether to warn now.
 */
export function evaluateReconnect(
    state: InstabilityState,
    attempt: number,
    now: number,
): InstabilityDecision {
    // A new outage (attempt 1) adds a marker; retries of the same outage don't.
    const withNew = attempt === 1 ? [...state.outageStarts, now] : state.outageStarts;
    // Keep only outages inside the rolling window.
    const outageStarts = withNew.filter((t) => now - t <= SSE_INSTABILITY_WINDOW_MS);

    const repeatedDrops = outageStarts.length >= SSE_INSTABILITY_REPEAT_THRESHOLD;
    const longSingleOutage = attempt >= SSE_INSTABILITY_LONG_OUTAGE_ATTEMPT;
    const sustained = repeatedDrops || longSingleOutage;

    // lastWarnAt === 0 means we have never warned for this stream — always allow
    // the first warning (independent of the absolute clock value).
    const cooledDown =
        state.lastWarnAt === 0 || now - state.lastWarnAt >= SSE_INSTABILITY_WARN_COOLDOWN_MS;
    const warn = sustained && cooledDown;

    return {
        state: { outageStarts, lastWarnAt: warn ? now : state.lastWarnAt },
        warn,
    };
}
