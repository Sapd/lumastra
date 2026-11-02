// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign — counter-honesty formatters (spec §5) + a couple of
 * text-budget helpers (spec §7). Pure, client-safe, Paraglide-backed (en+de).
 *
 * These exist so no admin page hand-rolls its own `${n} attempts` / `${n}%` /
 * `${h}h ${m}m` string — every admin surface renders counts, percentages,
 * durations and attempt phrasing through the SAME rules, so two pages can
 * never contradict each other (spec §5: "0 items pending" above "68 in
 * backlog" class of bug) and self-contradictions ("gave up after 0
 * attempts") cannot be typed.
 *
 * Where an equivalent already existed (`$lib/utils/time-formatting.ts`,
 * `$lib/utils/metric-formatters.ts`), this module wraps/reuses it rather
 * than duplicating — see `formatDurationMs` and `formatBytes`.
 */

import * as m from '$lib/paraglide/messages.js';
import { formatDurationHoursMinutes } from '$lib/utils/time-formatting';
import { formatFileSize } from '$lib/utils/metric-formatters';

// =============================================================================
// Counts (spec §5: "every count names unit and window")
// =============================================================================

export type CountUnit =
    'items' | 'frames' | 'runs' | 'files' | 'events' | 'sessions' | 'users' | 'tasks';

/**
 * Clamps to a non-negative integer, treating non-finite input (`NaN`,
 * `Infinity`) as `0` rather than propagating it — `Math.trunc(NaN)` is
 * `NaN`, and `Math.max(0, NaN)` is still `NaN`, so without this guard a
 * `NaN` count/attempts/repeats value renders the literal word "NaN" (edge
 * case hunter finding 2026-07-10 #1).
 */
function safeNonNegativeInt(n: number): number {
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export interface TimeWindow {
    hours?: number;
    days?: number;
}

/**
 * Group a count for display: 9226 -> "9,226".
 *
 * Passed to the plural message in place of the bare number. The messages
 * interpolate the SAME value they select the plural from, so the grouped
 * string has to survive `Intl.PluralRules.select()` — it does, because a
 * separator only ever appears at >= 1000, which is `other` in both en and de,
 * and "1" coerces to 1. `formatters.test.ts` pins both ends of that.
 *
 * Counts are the most-read numbers on these pages ("Pending: 9226 items",
 * "1428 runs"), and an ungrouped five-digit figure is measurably harder to
 * read at a glance — which is the entire job of a status line.
 */
function groupCount(n: number): string {
    return n.toLocaleString();
}

const UNIT_LABEL: Record<CountUnit, (count: number) => string> = {
    items: (count) => m.admin_fmt_unit_items({ count: groupCount(count) }),
    frames: (count) => m.admin_fmt_unit_frames({ count: groupCount(count) }),
    runs: (count) => m.admin_fmt_unit_runs({ count: groupCount(count) }),
    files: (count) => m.admin_fmt_unit_files({ count: groupCount(count) }),
    events: (count) => m.admin_fmt_unit_events({ count: groupCount(count) }),
    sessions: (count) => m.admin_fmt_unit_sessions({ count: groupCount(count) }),
    users: (count) => m.admin_fmt_unit_users({ count: groupCount(count) }),
    tasks: (count) => m.admin_fmt_unit_tasks({ count: groupCount(count) }),
};

/** "last {hours} h" / "last {days} days" — the window suffix for `formatCount`. */
function windowLabel(window: TimeWindow): string | undefined {
    if (window.hours !== undefined) return m.admin_fmt_window_hours({ hours: window.hours });
    if (window.days !== undefined) return m.admin_fmt_window_days({ days: window.days });
    return undefined;
}

/**
 * Renders a count with its unit ALWAYS named, and — when given — a time
 * window ("18 runs · last 24 h" vs "68 items"). Negative/non-integer counts
 * are clamped/truncated defensively; a count can never render negative.
 */
export function formatCount(count: number, unit: CountUnit, window?: TimeWindow): string {
    const n = safeNonNegativeInt(count);
    const countLabel = UNIT_LABEL[unit](n);
    const win = window ? windowLabel(window) : undefined;
    return win ? `${countLabel} · ${win}` : countLabel;
}

/**
 * `personName` is the counter-honesty rule for people (spec §5: "people
 * render as usernames, never internal UUIDs" — the API-Tokens bug). Prefer
 * the resolved username; if only a raw id is available, render it UNLESS it
 * looks like a UUID (in which case a UUID is never operator-facing text).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function personName(
    username: string | null | undefined,
    fallbackId?: string | null,
): string {
    const trimmed = username?.trim();
    if (trimmed) return trimmed;
    if (fallbackId && !UUID_RE.test(fallbackId.trim())) return fallbackId.trim();
    return m.admin_fmt_unknown_user();
}

// =============================================================================
// Percent (spec §5: "never render 100 % while work remains")
// =============================================================================

/**
 * Formats `done / total` as a percentage that can NEVER read 100 % while
 * `done < total` — it caps at 99.9 % instead, showing a decimal only near
 * the boundary so ordinary percentages stay clean integers. `total <= 0`
 * (nothing to measure yet) renders "—", never "0 %" or "NaN %". A
 * non-finite `done` (e.g. a coverage numerator that hasn't loaded yet)
 * renders "—" too, rather than propagating `NaN` through the arithmetic
 * below into the literal string "NaN %".
 */
export function formatPercent(done: number, total: number): string {
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) {
        return m.admin_fmt_percent_unknown();
    }
    const clampedDone = Math.max(0, Math.min(done, total));
    if (clampedDone >= total) return m.admin_fmt_percent_value({ percent: '100' });

    const raw = (clampedDone / total) * 100;
    const rounded = Math.round(raw * 10) / 10;
    // Work remains: rounding can never touch 100.
    const capped = rounded >= 100 ? 99.9 : rounded;
    const display = capped >= 99 ? capped.toFixed(1) : String(Math.round(capped));
    return m.admin_fmt_percent_value({ percent: display });
}

// =============================================================================
// Durations
// =============================================================================

/**
 * Humanizes a duration in milliseconds. Negative input can never render a
 * negative duration — it clamps to 0. Past 48 h it switches to whole days
 * ("7 days"); below that it delegates to the existing
 * `formatDurationHoursMinutes` (seconds-based "2h 34m" formatter) rather
 * than duplicating hour/minute formatting.
 */
export function formatDurationMs(ms: number): string {
    const clampedMs = Math.max(0, ms);
    const totalSeconds = Math.floor(clampedMs / 1000);
    const totalHours = Math.floor(totalSeconds / 3600);
    if (totalHours >= 48) {
        const days = Math.floor(totalHours / 24);
        return m.admin_fmt_duration_days({ count: days });
    }
    return formatDurationHoursMinutes(totalSeconds);
}

/**
 * Internal relative-duration word bucketing, shared by `formatOverdue` and
 * `formatExpiry`. Deliberately stops at DAYS and never rolls over into
 * weeks/months/years — spec §5's own worked example is "Expired 179 days
 * ago" (not "~6 months ago"), and staying in days sidesteps the whole class
 * of zero-count bucket-boundary bugs commit d80cbd775 had to patch for
 * `formatRelativeTime`'s week/month rollover (`diffWeeks < 4` /
 * `diffMonths < 12` style checks left gaps at the 28-29 day and 360-364 day
 * boundaries). There is no such boundary here because there is no bucket to
 * transition into: the day count is exact at any scale.
 */
function relativeDurationWords(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    if (totalMinutes < 1) return m.admin_fmt_relative_lt_minute();
    if (totalMinutes < 60) return m.admin_fmt_relative_minutes({ count: totalMinutes });

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) return m.admin_fmt_relative_hours({ count: totalHours });

    const totalDays = Math.floor(totalHours / 24);
    return m.admin_fmt_relative_days({ count: totalDays });
}

/**
 * "7 days overdue". `dueIso` in the future (not actually overdue yet) or an
 * unparseable date NEVER renders a negative duration — it renders "Not
 * overdue" / "Unknown" instead.
 */
export function formatOverdue(dueIso: string, nowMs: number = Date.now()): string {
    const due = Date.parse(dueIso);
    if (!Number.isFinite(due)) return m.admin_fmt_overdue_unknown();
    const diffMs = nowMs - due;
    if (diffMs <= 0) return m.admin_fmt_overdue_none();
    return m.admin_fmt_overdue({ time: relativeDurationWords(diffMs) });
}

export type ExpiryState = 'active' | 'expiring' | 'expired';

/** Items expiring within this window are flagged 'expiring' rather than 'active'. */
const EXPIRING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Future → "Expires in 3 days" (state 'active'/'expiring'); past → "Expired
 * 179 days ago" (state 'expired') — NEVER "Expired in -179 days" or a raw
 * negative number (the API-Tokens bug spec §5 calls out by name).
 */
export function formatExpiry(
    expiresIso: string,
    nowMs: number = Date.now(),
): { label: string; state: ExpiryState } {
    const expires = Date.parse(expiresIso);
    if (!Number.isFinite(expires)) {
        return { label: m.admin_fmt_expiry_unknown(), state: 'active' };
    }
    const diffMs = expires - nowMs;
    if (diffMs <= 0) {
        return {
            label: m.admin_fmt_expired_ago({ time: relativeDurationWords(Math.abs(diffMs)) }),
            state: 'expired',
        };
    }
    return {
        label: m.admin_fmt_expires_in({ time: relativeDurationWords(diffMs) }),
        state: diffMs <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'active',
    };
}

// =============================================================================
// Attempts / repeats (spec §5 + §7: self-contradictions can't be typed)
// =============================================================================

/**
 * "before the first attempt" (0) / "after N attempts" — makes "gave up after
 * 0 attempts" impossible to render (spec §7).
 */
export function formatAttempts(attempts: number): string {
    const n = safeNonNegativeInt(attempts);
    if (n === 0) return m.admin_fmt_attempts_zero();
    return m.admin_fmt_attempts_n({ count: n });
}

/** "×50 in 24 h" — identical repeated events, aggregated (spec §5). */
export function formatRepeats(times: number, window: TimeWindow): string {
    const n = safeNonNegativeInt(times);
    const win =
        window.hours !== undefined
            ? m.admin_fmt_window_in_hours({ hours: window.hours })
            : window.days !== undefined
              ? m.admin_fmt_window_in_days({ days: window.days })
              : '';
    return m.admin_fmt_repeats({ count: n, window: win });
}

/**
 * Bare "{time} ago" — a generic last-occurrence age, distinct from
 * `formatCheckedAgo`'s health-verdict-specific "checked Xs ago" wording.
 * Reuses the same minute/hour/day bucketing as `formatOverdue`/`formatExpiry`
 * so every relative-age readout in the admin buckets identically (spec §2
 * "one vocabulary").
 */
export function formatAgo(ms: number): string {
    // An unparseable timestamp upstream arrives as NaN: a dash, not "NaN days ago".
    if (!Number.isFinite(ms)) return '—';
    return m.admin_fmt_ago({ time: relativeDurationWords(Math.max(0, ms)) });
}

// =============================================================================
// "checked Xs ago" (Home verdict banner, spec §3.1)
// =============================================================================

export function formatCheckedAgo(iso: string, nowMs: number = Date.now()): string {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return m.admin_fmt_checked_unknown();
    const diffMs = Math.max(0, nowMs - parsed);
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return m.admin_fmt_checked_seconds({ count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return m.admin_fmt_checked_minutes({ count: minutes });
    const hours = Math.floor(minutes / 60);
    return m.admin_fmt_checked_hours({ count: hours });
}

// =============================================================================
// Bytes — wraps the existing (language-neutral: GB/MB/KB) formatter.
// =============================================================================

export { formatFileSize as formatBytes };

// =============================================================================
// Aliases (same functions, alternate names some callers may reach for).
// =============================================================================

/** Alias of `formatCount` — spec §5 "counter honesty" naming. */
export const countWithUnit = formatCount;
/** Alias of `formatPercent` — spec §5 "never render 100 % while work remains". */
export const progressPercent = formatPercent;
/** Alias of `formatDurationMs` — spec §7 "durations humanize past 48 h". */
export const humanDuration = formatDurationMs;
