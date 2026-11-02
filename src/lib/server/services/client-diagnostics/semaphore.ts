// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * At most two bundle decodes at once per process; others wait up to `waitMs`.
 *
 * A freed slot is handed DIRECTLY to the next queued waiter — `inUse` is
 * decremented only when no waiter is queued. Decrementing first and letting
 * the woken waiter re-increment itself later (its resume is a subsequent
 * microtask, never the same synchronous step as the release) would leave a
 * window where a brand-new caller arriving in that gap observes the freed
 * capacity and takes it immediately, so `inUse` reaches 3 once the woken
 * waiter also resumes and increments. The waiter queue is capped so a caller
 * cannot pile up unboundedly behind two permanently busy slots; a caller
 * arriving when the queue is already full is rejected immediately rather
 * than waiting `waitMs` just to be told the same thing.
 */

export class BundleBusyError extends Error {}

const MAX_SLOTS = 2;
const MAX_WAITERS = 8;
let inUse = 0;
const waiters: Array<() => void> = [];

export async function withBundleSlot<T>(fn: () => Promise<T>, waitMs = 5_000): Promise<T> {
    if (inUse >= MAX_SLOTS) {
        if (waiters.length >= MAX_WAITERS) {
            throw new BundleBusyError('bundle upload capacity exhausted');
        }
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = waiters.indexOf(wake);
                if (i >= 0) waiters.splice(i, 1);
                reject(new BundleBusyError('bundle upload capacity exhausted'));
            }, waitMs);
            const wake = (): void => {
                clearTimeout(timer);
                resolve();
            };
            waiters.push(wake);
        });
        // Woken only via the handoff below, which never decremented `inUse`
        // for this slot — it was passed straight to us. Do NOT increment
        // again here, or two holders of the "same" slot get counted.
    } else {
        inUse++;
    }
    try {
        return await fn();
    } finally {
        const next = waiters.shift();
        if (next) {
            // Atomic handoff: pass the slot directly to the next waiter.
            // `inUse` never reflects "free" capacity in between, so no
            // synchronous new caller can steal it out from under the waiter.
            next();
        } else {
            inUse--;
        }
    }
}
