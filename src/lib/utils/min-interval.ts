// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Leading-edge gate with a trailing catch-up.
 *
 * Leading so the common case (one event, quiet before and after) is
 * instantaneous; trailing so a burst still reconciles to the final state
 * rather than dropping the last event. Mirrors the intent of
 * FOCUS_RECONCILE_MIN_INTERVAL_MS in notification-inbox.ts.
 *
 * Both branches run the callback inside their OWN try/catch — the gate does
 * not lean on whatever boundary the caller happens to be invoked from. That
 * used to be true only by accident: the leading branch runs synchronously,
 * so for a caller invoked from inside userEvents' dispatch() (which
 * try/catches each callback) a leading throw was already contained — but a
 * caller invoked from a raw DOM listener (visibilitychange/focus/pageshow)
 * has no such boundary, and a throw there would escape as an uncaught
 * exception from the event dispatch. Catching inside the gate itself makes
 * both branches safe regardless of what calls `run`.
 *
 * `cancel()` clears a pending trailing call without running it. Callers MUST
 * call it on teardown (unmount, navigation, reconnect) — otherwise a pending
 * trailing call fires after the caller is gone, which for a callback that
 * touches now-stale component/module state is exactly the spurious refetch
 * this gate exists to prevent.
 */
export function createMinInterval(ms: number): {
    run: (fn: () => void) => void;
    cancel: () => void;
} {
    let lastRunAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: (() => void) | null = null;

    function runSafely(fn: () => void): void {
        try {
            fn();
        } catch (err) {
            console.error('[MinInterval] callback error:', err);
        }
    }

    function cancel(): void {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
    }

    function run(fn: () => void): void {
        const now = Date.now();
        const elapsed = now - lastRunAt;
        if (elapsed >= ms) {
            lastRunAt = now;
            runSafely(fn);
            return;
        }
        pending = fn;
        if (timer === null) {
            timer = setTimeout(() => {
                timer = null;
                const toRun = pending;
                pending = null;
                if (toRun) {
                    lastRunAt = Date.now();
                    runSafely(toRun);
                }
            }, ms - elapsed);
        }
    }

    return { run, cancel };
}
