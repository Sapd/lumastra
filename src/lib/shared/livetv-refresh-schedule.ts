// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Periodic cron forms supported by Live TV's interval-based refresh scheduler. */
export function parseLiveTvRefreshIntervalMs(
    expr: string,
    options: { stored?: boolean } = {},
): number | null {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minute, hour, day, month, weekday] = parts;
    if (day !== '*' || month !== '*') return null;
    const minuteStep = /^\*\/(\d+)$/.exec(minute);
    if (minuteStep && hour === '*' && weekday === '*') {
        const step = Number(minuteStep[1]);
        return Number.isSafeInteger(step * 60_000) && step >= 1 && (options.stored || step <= 59)
            ? step * 60_000
            : null;
    }
    const hourStep = /^\*\/(\d+)$/.exec(hour);
    if (hourStep && minute === '0' && weekday === '*') {
        const step = Number(hourStep[1]);
        return Number.isSafeInteger(step * 3_600_000) && step >= 1 && (options.stored || step <= 23)
            ? step * 3_600_000
            : null;
    }
    if (minute === '0' && hour === '*' && weekday === '*') return 3_600_000;
    if (!/^\d+$/.test(minute) || Number(minute) > 59 || !/^\d+$/.test(hour) || Number(hour) > 23)
        return null;
    if (weekday === '*') return 86_400_000;
    if (/^[0-6]$/.test(weekday)) return 7 * 86_400_000;
    return null;
}
