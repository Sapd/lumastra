// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reactive wall-clock that ticks on an interval, so relative-time labels
 * ("5m ago") advance while a long-lived panel stays open instead of freezing at
 * mount time. Read `.value` inside a `$derived`/template; the interval is cleaned
 * up automatically on component destroy.
 */
export function useNow(intervalMs = 30_000): { readonly value: number } {
    let now = $state(Date.now());
    $effect(() => {
        const id = setInterval(() => {
            now = Date.now();
        }, intervalMs);
        return () => clearInterval(id);
    });
    return {
        get value(): number {
            return now;
        },
    };
}
