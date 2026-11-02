// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Per-session aggregate of client-reported `delivery_window` events. */
export interface DeliveryAggregate {
    windowCount: number;
    p10Bps: number | null;
    p50Bps: number | null;
    /** Sum of AVPlayer `downloadOverdue` deltas (native only; 0 on web). */
    overdueCount: number;
}

/** p10 below this fraction of the media bitrate counts as a collapse. */
export const INTERRUPTION_P10_RATIO = 0.8;
/** p50 at or above this fraction says the link is normally ample. */
export const INTERRUPTION_P50_RATIO = 1.5;
/** Fewer windows than this cannot carry a meaningful 10th percentile. */
export const INTERRUPTION_MIN_WINDOWS = 3;
/** AVPlayer reported this many late segment downloads in one session. */
export const INTERRUPTION_MIN_OVERDUE = 3;

/**
 * "Delivery interruptions": the link is usually ample and periodically
 * collapses. Distinct from a slow link (p50 itself below need), which the
 * bandwidth-ratio diagnosis already names. Prod 2026-09-12: one viewer lost
 * 15-20 % of wall-clock at 5, 6 and 16 Mbit/s alike — an average said
 * "fine", the p10 said everything.
 */
export function classifyDeliveryInterruption(
    d: DeliveryAggregate,
    mediaBitrateBps: number | undefined,
): boolean {
    if (d.overdueCount >= INTERRUPTION_MIN_OVERDUE) return true;
    if (d.windowCount < INTERRUPTION_MIN_WINDOWS) return false;
    if (!mediaBitrateBps || mediaBitrateBps <= 0) return false;
    if (d.p10Bps == null || d.p50Bps == null) return false;
    return (
        d.p10Bps < INTERRUPTION_P10_RATIO * mediaBitrateBps &&
        d.p50Bps >= INTERRUPTION_P50_RATIO * mediaBitrateBps
    );
}
