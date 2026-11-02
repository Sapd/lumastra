// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/utils/countdown.ts
//
// Shared countdown formatter. Handles durations ≥ 1 hour (which `mm:ss`
// truncates) — used by the maintenance banner (client-facing countdown)
// and the admin maintenance-notice card. Kept as a single helper so the
// two displays stay in sync even if one side changes its tick cadence.

/**
 * Format a remaining duration as `mm:ss` or `Hh mm:ss`.
 *
 * - Negative or zero → `'0:00'`
 * - Seconds round UP so a countdown never shows `0:00` while still active
 * - Hours are prepended only when ≥ 1 hour remains — keeps short countdowns
 *   compact
 *
 * @param remainingMs remaining duration in milliseconds
 */
export function formatCountdown(remainingMs: number): string {
    if (remainingMs <= 0) return '0:00';
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}h ${mm}:${ss}` : `${mm}:${ss}`;
}
