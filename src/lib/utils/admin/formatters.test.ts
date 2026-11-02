// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counter-honesty formatters (spec §5). Boundaries covered: 0, negatives,
 * 100 %, and the week/month bucket edges that commit d80cbd775 already
 * fixed for `formatRelativeTime` — `relativeDurationWords` (shared by
 * `formatOverdue`/`formatExpiry`) reapplies the same day-based cutoffs, so
 * the same boundary tests are repeated here for the new formatter.
 */

import { describe, it, expect } from 'vitest';
import {
    formatCount,
    formatPercent,
    formatDurationMs,
    formatOverdue,
    formatExpiry,
    formatAttempts,
    formatRepeats,
    formatAgo,
    formatCheckedAgo,
    formatBytes,
    personName,
    countWithUnit,
    progressPercent,
    humanDuration,
} from './formatters';

function extractCount(formatted: string): number {
    const match = formatted.match(/\d+/);
    if (!match) throw new Error(`no numeral found in "${formatted}"`);
    return Number(match[0]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('formatCount', () => {
    it('always names the unit', () => {
        expect(formatCount(18, 'runs')).toContain('18');
        expect(formatCount(1, 'runs')).not.toContain('18');
    });

    it('appends a window label when given hours or days', () => {
        expect(formatCount(18, 'runs', { hours: 24 })).toMatch(/18.*24/s);
        expect(formatCount(68, 'items', { days: 7 })).toMatch(/68.*7/s);
    });

    it('omits the window separator when no window is given', () => {
        expect(formatCount(5, 'files')).not.toContain('·');
    });

    it('never renders a negative count', () => {
        expect(formatCount(-5, 'items')).not.toContain('-5');
        expect(extractCount(formatCount(-5, 'items'))).toBe(0);
    });

    it('renders zero honestly', () => {
        expect(extractCount(formatCount(0, 'tasks'))).toBe(0);
    });

    it('countWithUnit is an alias of formatCount', () => {
        expect(countWithUnit(3, 'sessions')).toBe(formatCount(3, 'sessions'));
    });
});

describe('formatPercent', () => {
    it('never renders 100 % while work remains', () => {
        const result = formatPercent(9999, 10000);
        expect(result).not.toContain('100');
        expect(result).toContain('99.9');
    });

    it('renders exactly 100 % once done reaches total', () => {
        expect(formatPercent(10, 10)).toContain('100');
    });

    it('clamps done above total to 100 % (never > 100)', () => {
        const result = formatPercent(15, 10);
        expect(extractCount(result)).toBe(100);
        expect(result).not.toContain('150');
    });

    it('renders an em dash, not 0 % or NaN %, when total is 0', () => {
        const result = formatPercent(0, 0);
        expect(result).not.toContain('NaN');
        expect(result).not.toContain('0 %');
        expect(result).toBe('—');
    });

    it('renders a clean integer away from the 100 % boundary', () => {
        expect(formatPercent(42, 100)).toContain('42');
        expect(formatPercent(42, 100)).not.toContain('.');
    });

    it('never renders negative progress for negative `done`', () => {
        expect(formatPercent(-5, 10)).not.toContain('-');
    });

    it('progressPercent is an alias of formatPercent', () => {
        expect(progressPercent(3, 4)).toBe(formatPercent(3, 4));
    });
});

describe('formatDurationMs', () => {
    it('never renders a negative duration', () => {
        expect(formatDurationMs(-999_999)).not.toContain('-');
    });

    it('renders hours/minutes below the 48 h boundary', () => {
        const twoHours = 2 * 60 * 60 * 1000 + 34 * 60 * 1000;
        expect(formatDurationMs(twoHours)).toMatch(/2h/);
        expect(formatDurationMs(twoHours)).toMatch(/34m/);
    });

    it('switches to whole days at the 48 h boundary', () => {
        const justUnder = 47 * 60 * 60 * 1000 + 59 * 60 * 1000;
        expect(formatDurationMs(justUnder)).not.toMatch(/day/);

        const exactlyFortyEight = 48 * 60 * 60 * 1000;
        expect(extractCount(formatDurationMs(exactlyFortyEight))).toBe(2);

        const sevenDays = 7 * DAY_MS;
        expect(extractCount(formatDurationMs(sevenDays))).toBe(7);
    });

    it('humanDuration is an alias of formatDurationMs', () => {
        expect(humanDuration(5000)).toBe(formatDurationMs(5000));
    });
});

describe('formatOverdue', () => {
    it('never renders a negative duration when the due date is in the future', () => {
        const future = new Date(Date.now() + DAY_MS).toISOString();
        const result = formatOverdue(future);
        expect(result).not.toMatch(/-\d/);
        expect(result.toLowerCase()).toContain('not overdue');
    });

    it('renders "N days overdue" style copy for a past due date', () => {
        const now = Date.now();
        const sevenDaysAgo = new Date(now - 7 * DAY_MS).toISOString();
        const result = formatOverdue(sevenDaysAgo, now);
        expect(extractCount(result)).toBe(7);
        expect(result.toLowerCase()).toContain('overdue');
    });

    it('handles an unparseable date without throwing or going negative', () => {
        expect(() => formatOverdue('not-a-date')).not.toThrow();
        expect(formatOverdue('not-a-date')).not.toMatch(/-\d/);
    });

    it('stays in exact days at week/month/year scale — never rolls over and never zero-counts (the class of bug d80cbd775 fixed for formatRelativeTime)', () => {
        const now = Date.now();
        for (const days of [7, 28, 29, 30, 179, 360, 364, 365, 400]) {
            const due = new Date(now - days * DAY_MS).toISOString();
            const result = formatOverdue(due, now);
            expect(extractCount(result)).toBe(days);
        }
    });
});

describe('formatExpiry', () => {
    it('future date: "Expires in ..." with state active/expiring, never negative', () => {
        const now = Date.now();
        const in3Days = new Date(now + 3 * DAY_MS).toISOString();
        const result = formatExpiry(in3Days, now);
        expect(result.state).toBe('expiring');
        expect(result.label.toLowerCase()).toContain('expires');
        expect(result.label).not.toMatch(/-\d/);
    });

    it('far future date is "active", not "expiring"', () => {
        const now = Date.now();
        const in60Days = new Date(now + 60 * DAY_MS).toISOString();
        expect(formatExpiry(in60Days, now).state).toBe('active');
    });

    it('past date (the API-Tokens bug): "Expired 179 days ago", never "-179 days"', () => {
        const now = Date.now();
        const expired179DaysAgo = new Date(now - 179 * DAY_MS).toISOString();
        const result = formatExpiry(expired179DaysAgo, now);
        expect(result.state).toBe('expired');
        expect(result.label).not.toMatch(/-\d/);
        expect(result.label.toLowerCase()).toContain('expired');
        expect(extractCount(result.label)).toBe(179);
    });

    it('handles an exact-instant expiry (diff === 0) as expired, not negative', () => {
        const now = Date.now();
        const result = formatExpiry(new Date(now).toISOString(), now);
        expect(result.state).toBe('expired');
        expect(result.label).not.toMatch(/-\d/);
    });

    it('handles an unparseable date without throwing', () => {
        expect(() => formatExpiry('garbage')).not.toThrow();
    });
});

describe('formatAttempts', () => {
    it('renders 0 as "before the first attempt", never "after 0 attempts"', () => {
        const result = formatAttempts(0);
        expect(result.toLowerCase()).not.toContain('after 0');
        expect(result.toLowerCase()).toContain('before');
    });

    it('renders N as "after N attempts"', () => {
        const result = formatAttempts(3);
        expect(result.toLowerCase()).toContain('after');
        expect(extractCount(result)).toBe(3);
    });

    it('clamps negative attempts to the zero case', () => {
        expect(formatAttempts(-1).toLowerCase()).toContain('before');
    });
});

describe('formatRepeats', () => {
    it('renders "×N in <window>"', () => {
        const result = formatRepeats(50, { hours: 24 });
        expect(result).toContain('50');
        expect(result).toContain('24');
    });

    it('never renders a negative repeat count', () => {
        expect(formatRepeats(-3, { hours: 1 })).not.toContain('-3');
    });
});

describe('formatCheckedAgo', () => {
    it('renders seconds granularity for a recent check', () => {
        const now = Date.now();
        const twelveSecondsAgo = new Date(now - 12_000).toISOString();
        expect(formatCheckedAgo(twelveSecondsAgo, now)).toContain('12');
    });

    it('never renders a negative "ago" when the timestamp is in the future (clock skew)', () => {
        const now = Date.now();
        const future = new Date(now + 5000).toISOString();
        expect(formatCheckedAgo(future, now)).not.toMatch(/-\d/);
    });

    it('rolls over to minutes and hours', () => {
        const now = Date.now();
        expect(formatCheckedAgo(new Date(now - 90_000).toISOString(), now)).toContain('1');
        expect(formatCheckedAgo(new Date(now - 2 * 60 * 60 * 1000).toISOString(), now)).toContain(
            '2',
        );
    });
});

describe('formatAgo', () => {
    it('reads "{time} ago" — distinct wording from formatCheckedAgo\'s "checked" prefix', () => {
        const result = formatAgo(5 * 60_000);
        expect(result).toContain('ago');
        expect(result).not.toContain('checked');
        expect(extractCount(result)).toBe(5);
    });

    it('never renders a negative duration for a negative (future) input', () => {
        expect(formatAgo(-5000)).not.toMatch(/-\d/);
    });

    it('renders a dash, not "NaN … ago", for an unparseable timestamp', () => {
        expect(formatAgo(Date.now() - Date.parse('not-a-date'))).toBe('—');
    });

    it('rolls over minutes → hours → days like the other relative-word formatters', () => {
        const HOUR_MS = 60 * 60 * 1000;
        const DAY_MS = 24 * HOUR_MS;
        expect(extractCount(formatAgo(3 * HOUR_MS))).toBe(3);
        expect(extractCount(formatAgo(9 * DAY_MS))).toBe(9);
    });
});

describe('formatBytes', () => {
    it('wraps the existing metric-formatters helper', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(5 * 1e9)).toContain('GB');
    });
});

describe('personName', () => {
    it('prefers the username when present', () => {
        expect(personName('alice', '11111111-1111-1111-1111-111111111111')).toBe('alice');
    });

    it('never renders a raw UUID as a person name (API-Tokens bug)', () => {
        const uuid = '11111111-1111-1111-1111-111111111111';
        const result = personName(null, uuid);
        expect(result).not.toBe(uuid);
        expect(result.toLowerCase()).toContain('unknown');
    });

    it('falls back to a non-UUID id when no username is available', () => {
        expect(personName(undefined, 'service-account')).toBe('service-account');
    });

    it('falls back to "unknown user" with neither username nor id', () => {
        expect(personName(null, null).toLowerCase()).toContain('unknown');
    });

    it('treats a blank username as absent', () => {
        expect(personName('   ', 'service-account')).toBe('service-account');
    });
});
