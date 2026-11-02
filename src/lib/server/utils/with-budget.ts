// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `withBudget` — race a promise against a wall-clock timeout, returning a
 * sentinel on timeout instead of rejecting.
 *
 * Used by SSR-aware primitives (effective-watching, effective-next-up) to
 * fail-open: if the inner work is slow, the caller substitutes a degraded-
 * but-correct fallback. The inner promise is allowed to settle in the
 * background (rejections suppressed) so we don't spam unhandledRejection.
 *
 * Why a sentinel instead of throwing? Callers want a single check for
 * "did the work happen?" — null vs value — without try/catch boilerplate.
 *
 * `budgetMs <= 0` or `undefined` means "no budget"; the inner promise is
 * awaited untimed.
 */
export function withBudget<T>(
    promise: Promise<T>,
    budgetMs: number | undefined,
): Promise<T | null> {
    if (budgetMs === undefined || budgetMs <= 0) {
        return promise.then(
            (value) => value,
            () => null,
        );
    }
    return new Promise<T | null>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(null);
        }, budgetMs);

        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}
