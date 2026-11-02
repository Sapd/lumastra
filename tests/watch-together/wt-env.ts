// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Environment shared by the WT web e2e config, globalSetup and spec. */

/** Port of the dedicated dev server (WT_PORT); 5193 avoids the TV run's 5191/5192. */
export function wtPort(): number {
    return Number(process.env.WT_PORT || 5193);
}

export function webUrl(): string {
    return (process.env.WT_WEB_URL || `http://127.0.0.1:${wtPort()}`).replace(/\/$/, '');
}

/** The two party members: non-admin, group Users, signed in by forward-auth headers. */
export const WT_USERS = ['test2', 'uitest'] as const;

/**
 * Parallel workers (WT_WORKERS, default 1). Scenarios are independent once no two of
 * them share a user: a user has one "current party" pointer and one stream budget, so
 * each worker gets its own pair (worker 0 keeps WT_USERS, so a one-worker run is
 * unchanged).
 */
export function wtWorkers(): number {
    return Math.max(1, Number(process.env.WT_WORKERS || 1));
}

/** The user pair of the worker in Playwright's `parallelIndex` slot. */
export function wtUsersFor(parallelIndex: number): readonly [string, string] {
    return parallelIndex === 0
        ? WT_USERS
        : [`wt-e2e-a${parallelIndex}`, `wt-e2e-b${parallelIndex}`];
}

/** Every user any worker of this run can sign in as (globalSetup provisions them). */
export function allWtUsers(): string[] {
    return Array.from({ length: wtWorkers() }, (_, i) => wtUsersFor(i)).flat();
}

/** Artifact directory (ndjson + summary.json). Small by design: CI keeps it on failure only. */
export function outDir(): string {
    return process.env.WT_E2E_DIR || './test-results/wt-web-e2e';
}
