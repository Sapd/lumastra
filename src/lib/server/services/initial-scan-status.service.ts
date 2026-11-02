// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { InitialScanStatus } from '$lib/schemas/server-info.js';
import { getDb } from '$lib/server/database/connection.js';
import { getInitialScanKeys } from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { getScanProgressByKey } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js';
import { DependencyUnavailableError } from '$lib/server/api/problem.js';

const CACHE_MS = 5_000;
let cached: { value: InitialScanStatus; expiresAt: number } | undefined;
let pending: Promise<InitialScanStatus> | undefined;

async function computeStatus(): Promise<InitialScanStatus> {
    const progress = await getScanProgressByKey();
    if (progress.size === 0) return { initialScanRunning: false, itemsSoFar: 0 };
    const sql = getDb();
    if (!sql) throw new DependencyUnavailableError('Database unavailable', 'postgres');
    const initialKeys = await getInitialScanKeys(sql, [...progress.keys()]);
    return {
        initialScanRunning: initialKeys.length > 0,
        itemsSoFar: initialKeys.reduce(
            (sum, key) => sum + (progress.get(key)?.processedFiles ?? 0),
            0,
        ),
    };
}

/** Shared across callers per process; concurrent polls perform one refresh. */
export async function getInitialScanStatus(): Promise<InitialScanStatus> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (!pending) {
        pending = computeStatus()
            .then((value) => {
                cached = { value, expiresAt: Date.now() + CACHE_MS };
                return value;
            })
            .finally(() => {
                pending = undefined;
            });
    }
    return pending;
}
