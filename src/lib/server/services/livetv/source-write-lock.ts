// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { acquireLock } from '$lib/server/cache/valkey.js';
import type { ProgressCallback } from './livetv-import.service.js';

/** Outlives the longest source writer: the 20-minute EPG hard timeout. */
export const LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS = 25 * 60;

/** Queue contenders wait before loading source settings; cancellation runs via progress. */
export async function waitForSourceWriteLock(
    sourceId: string,
    progress?: ProgressCallback,
): Promise<string> {
    const deadline = Date.now() + LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS * 1000;
    while (Date.now() < deadline) {
        const token = await acquireLock(
            `lock:livetv-source-write:${sourceId}`,
            LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS,
        );
        if (token) return token;
        await progress?.({
            phase: 'waiting',
            processed: 0,
            total: 1,
            message: m.livetv_admin_import_waiting(),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(m.livetv_admin_import_enqueue_failed());
}
