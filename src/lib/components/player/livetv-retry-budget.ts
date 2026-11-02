// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The automatic Live TV retry count of one station, kept in sessionStorage so that it
 * survives a controller recreate or a page reload. The budget is only spent back after
 * playback has been sustained; a feed that plays one segment and fails again must not get
 * a fresh budget each time (reconnect storm against one-connection providers).
 */

/** Playback this long without a failure gives the channel a full budget again. */
export const LIVETV_SUSTAINED_PLAYBACK_MS = 30_000;
/** A count older than this is stale: the viewer came back to the channel later. */
export const LIVETV_RETRY_BUDGET_WINDOW_MS = 120_000;

const keyFor = (stationId: string): string => `lumastra:livetv-retry:${stationId}`;

/** Retries already made for `stationId` within the window, else 0. Never throws. */
export function readLiveTvRetryBudget(stationId: string, now: number = Date.now()): number {
    try {
        const raw = sessionStorage.getItem(keyFor(stationId));
        if (!raw) return 0;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return 0;
        const { attempts, at } = parsed as { attempts?: unknown; at?: unknown };
        if (typeof attempts !== 'number' || typeof at !== 'number') return 0;
        if (!Number.isFinite(attempts) || attempts < 0) return 0;
        if (now - at > LIVETV_RETRY_BUDGET_WINDOW_MS || now < at) return 0;
        return Math.floor(attempts);
    } catch {
        return 0;
    }
}

export function writeLiveTvRetryBudget(
    stationId: string,
    attempts: number,
    now: number = Date.now(),
): void {
    try {
        sessionStorage.setItem(keyFor(stationId), JSON.stringify({ attempts, at: now }));
    } catch {
        // Storage can be blocked; the in-memory count still applies.
    }
}

export function clearLiveTvRetryBudget(stationId: string): void {
    try {
        sessionStorage.removeItem(keyFor(stationId));
    } catch {
        // Storage can be blocked.
    }
}
