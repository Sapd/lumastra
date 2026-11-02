// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Compact "time ago" formatter for admin surfaces.
 *
 * Locale-aware via `Intl.RelativeTimeFormat` (short style: "5 min. ago" / "vor
 * 5 Min.") — this used to hand-roll English-only shorthand ("5m ago") that
 * stayed English even inside an otherwise-fully-German admin page. `now` is
 * injectable so callers can (a) drive re-evaluation from a reactive clock tick
 * to avoid a label freezing at mount time, and (b) test deterministically.
 * `locale` defaults to the current request/viewer locale (paraglide's
 * `getLocale()`) but is also injectable for the same testing reason.
 */
import { getLocale } from '$lib/paraglide/runtime.js';

function formatter(locale: string): Intl.RelativeTimeFormat {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
}

export function relativeTime(
    iso: string,
    now: number = Date.now(),
    locale: string = getLocale(),
): string {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return '';
    const diffMs = now - parsed;
    const rtf = formatter(locale);
    if (diffMs < 0) return rtf.format(0, 'second');
    const s = Math.floor(diffMs / 1000);
    if (s < 60) return rtf.format(0, 'second');
    const min = Math.floor(s / 60);
    if (min < 60) return rtf.format(-min, 'minute');
    const h = Math.floor(min / 60);
    if (h < 24) return rtf.format(-h, 'hour');
    const d = Math.floor(h / 24);
    if (d < 30) return rtf.format(-d, 'day');
    const mo = Math.floor(d / 30);
    return rtf.format(-mo, 'month');
}
