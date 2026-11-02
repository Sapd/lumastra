// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ends watch parties whose host is gone (see `sweepAbsentHosts`). Once a minute,
 * leader-gated per window like the sessions cache: exactly one replica claims
 * the bucket lock in Valkey and sweeps; the others no-op. Without Valkey there is
 * no party state to sweep, and acquireLock's in-memory fallback covers dev.
 */

import { config } from '../config.js';
import { acquireLock, isCoordinationValkeyReady } from '../cache/valkey.js';
import { Logger } from '../utils/logger.js';
import { sweepAbsentHosts, sweepStaleGuests } from './watch-together.service.js';

const logger = Logger.for('WatchTogetherHostSweeper');

export const HOST_SWEEP_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/** One sweep if this replica wins the window's lock. Exported for tests. */
export async function sweepIfLeader(now: number = Date.now()): Promise<string[]> {
    if (!config.FEATURE_WATCH_TOGETHER || !isCoordinationValkeyReady() || inFlight) return [];
    const bucket = Math.floor(now / HOST_SWEEP_INTERVAL_MS);
    const won = await acquireLock(
        `lock:wt-host-sweep:${bucket}`,
        Math.floor(HOST_SWEEP_INTERVAL_MS / 1000) - 1,
        config.INSTANCE_ID,
    );
    if (won === null) return [];
    inFlight = true;
    try {
        await sweepStaleGuests(now);
        return await sweepAbsentHosts(config.WATCH_TOGETHER_HOST_ABSENT_MINUTES * 60_000, now);
    } finally {
        inFlight = false;
    }
}

export function startWatchTogetherHostSweeper(): void {
    if (timer) return;
    const scheduleNext = (): void => {
        timer = setTimeout(() => {
            void sweepIfLeader().catch((error) =>
                logger.warn('Host sweep tick failed', {}, error as Error),
            );
            if (timer) scheduleNext();
        }, HOST_SWEEP_INTERVAL_MS);
        timer.unref?.();
    };
    scheduleNext();
}

export function stopWatchTogetherHostSweeper(): void {
    if (timer) clearTimeout(timer);
    timer = null;
}
