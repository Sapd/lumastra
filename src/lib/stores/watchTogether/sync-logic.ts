// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure sync logic for watch-together sessions.
 *
 * Extracted from WatchTogetherStoreImpl so it can be unit-tested
 * without Svelte rune context or browser dependencies.
 */

/**
 * Calculate estimated time (in seconds) until a guest catches up to the host.
 *
 * @param drift        Current drift from host in seconds (positive = behind)
 * @param playbackRate Effective playback rate (e.g. 1.05 for catch-up mode)
 * @returns Estimated seconds to sync, or null when already synced / no compensation
 */
export function calculateTimeToSync(drift: number, playbackRate: number): number | null {
    const absDrift = Math.abs(drift);

    // Already synced (within 0.5s)
    if (absDrift < 0.5) return null;

    // Rate is near 1.0 (no meaningful compensation) - can't estimate
    const rateAdjustment = Math.abs(playbackRate - 1.0);
    if (rateAdjustment < 0.01) return null;

    // Time to sync = drift / (rate - 1.0)
    return absDrift / rateAdjustment;
}

/**
 * Determine whether this device is the session host.
 *
 * @param sessionHostClientId clientId recorded on the session as host
 * @param myClientId          this device's clientId
 */
export function isHostDevice(
    sessionHostClientId: string | null | undefined,
    myClientId: string,
): boolean {
    return sessionHostClientId === myClientId;
}

/**
 * Determine whether an incoming SSE event originated from this device.
 *
 * Prefers clientId comparison when available; falls back to userId.
 *
 * @param eventClientId clientId attached to the event (may be undefined for legacy events)
 * @param eventUserId   userId attached to the event
 * @param myClientId    this device's clientId
 * @param myUserId      this device's userId (may be null)
 */
export function isOwnEvent(
    eventClientId: string | undefined,
    eventUserId: string,
    myClientId: string,
    myUserId: string | null,
): boolean {
    if (eventClientId && myClientId) {
        return eventClientId === myClientId;
    }
    return eventUserId === myUserId;
}
