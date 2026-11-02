// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the UI tiers under the app's per-user SSE connect limiter.
 *
 * Every full page load opens `GET /api/events/user` (the deprecated shim of
 * `/api/v1/events`), whose def carries `rateLimit: { limit: 30, windowSec: 60 }`
 * keyed by user. The sweep drives every page as ONE user, so past 30 page loads
 * a minute the stream request answers 429 and Chromium logs
 * "Failed to load resource ... 429", which Tier A (correctly) reports.
 * The limiter is not touched; the sweep just stays under it.
 *
 * The budget is split across workers (each worker is its own process, so the
 * window is tracked per worker) and keeps a few connects spare for the requests
 * the other tier, `reload()` calls and any real user on the same account make.
 */
const WINDOW_MS = 60_000;
const TOTAL_BUDGET = 24; // of 30 per window
const navigations: number[] = [];

/** Same default as playwright.route-sweep.config.ts. */
const WORKERS = Number(process.env.SWEEP_WORKERS ?? (process.env.CI ? 1 : 2));

export async function paceNavigation(): Promise<void> {
    const workers = WORKERS;
    const budget = Math.max(1, Math.floor(TOTAL_BUDGET / Math.max(1, workers)));
    for (;;) {
        const now = Date.now();
        while (navigations.length > 0 && now - navigations[0]! >= WINDOW_MS) navigations.shift();
        if (navigations.length < budget) {
            navigations.push(now);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, navigations[0]! + WINDOW_MS - now + 50));
    }
}
