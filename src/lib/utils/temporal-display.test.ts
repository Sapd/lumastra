// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    formatTemporalContext,
    formatLiveContext,
    formatUpcomingContext,
    formatFutureContext,
    formatEndedContext,
} from './temporal-display.js';

// Mock paraglide messages to return predictable strings
vi.mock('$lib/paraglide/messages.js', () => ({
    temporal_ends_in_minutes: ({ minutes }: { minutes: number }) => `Ends in ${minutes} min`,
    temporal_ends_in_hours_minutes: ({ hours, minutes }: { hours: number; minutes: number }) =>
        `Ends in ${hours} hr ${minutes} min`,
    temporal_ends_soon: () => 'Ends soon',
    temporal_ended_minutes_ago: ({ minutes }: { minutes: number }) => `Ended ${minutes} min ago`,
    temporal_ended_hours_ago: ({ hours }: { hours: number }) => `Ended ${hours} hr ago`,
    temporal_in_minutes: ({ minutes }: { minutes: number }) => `In ${minutes} min`,
    temporal_in_hours: ({ hours }: { hours: number }) => `In ${hours} hr`,
    temporal_tonight: ({ time }: { time: string }) => `Tonight ${time}`,
    temporal_tomorrow: ({ time }: { time: string }) => `Tomorrow ${time}`,
    temporal_live: () => 'LIVE',
    temporal_live_aria: () => 'Live now',
}));

describe('formatLiveContext', () => {
    it('shows "Ends in X min" when endTime is in the future', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const end = '2026-03-11T20:25:00Z';
        expect(formatLiveContext('', end, now)).toBe('Ends in 25 min');
    });

    it('shows hours and minutes for long programs', () => {
        const now = new Date('2026-03-11T18:00:00Z');
        const end = '2026-03-11T19:10:00Z';
        expect(formatLiveContext('', end, now)).toBe('Ends in 1 hr 10 min');
    });

    it('shows "Ends soon" when less than 1 minute remains', () => {
        const now = new Date('2026-03-11T20:59:30Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatLiveContext('', end, now)).toBe('Ends soon');
    });

    it('shows "Ends soon" when program ends exactly now', () => {
        const now = new Date('2026-03-11T21:00:00Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatLiveContext('', end, now)).toBe('Ends soon');
    });
});

describe('formatUpcomingContext', () => {
    it('shows "In 1 min" for singular minute', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const start = '2026-03-11T20:00:45Z';
        expect(formatUpcomingContext(start, undefined, now)).toBe('In 1 min');
    });

    it('shows "In X min" for less than 60 minutes', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const start = '2026-03-11T20:45:00Z';
        expect(formatUpcomingContext(start, undefined, now)).toBe('In 45 min');
    });

    it('shows "In X hr" for 1-3 hours', () => {
        const now = new Date('2026-03-11T18:00:00Z');
        const start = '2026-03-11T20:00:00Z';
        expect(formatUpcomingContext(start, undefined, now)).toBe('In 2 hr');
    });

    it('shows "Tonight HH:MM" for evening programs > 3 hours away', () => {
        const now = new Date('2026-03-11T14:00:00Z');
        const start = '2026-03-11T20:15:00Z';
        const result = formatUpcomingContext(start, undefined, now);
        expect(result).toMatch(/^Tonight /);
    });

    it('shows absolute time for non-evening programs > 3 hours away', () => {
        const now = new Date('2026-03-11T08:00:00Z');
        const start = '2026-03-11T14:30:00Z';
        const result = formatUpcomingContext(start, undefined, now);
        // Should NOT start with "Tonight" since 14:30 is before 18:00
        expect(result).not.toMatch(/^Tonight/);
        expect(result).not.toMatch(/^In /);
    });
});

describe('formatFutureContext', () => {
    it('shows "Tomorrow HH:MM" for next day', () => {
        const now = new Date('2026-03-11T22:00:00Z');
        const start = '2026-03-12T14:30:00Z';
        const result = formatFutureContext(start, undefined, now);
        expect(result).toMatch(/^Tomorrow /);
    });

    it('shows day name + time for within-week dates', () => {
        const now = new Date('2026-03-11T10:00:00Z'); // Wednesday
        const start = '2026-03-14T20:00:00Z'; // Saturday
        const result = formatFutureContext(start, undefined, now);
        // Should contain a day abbreviation, not "Tomorrow"
        expect(result).not.toMatch(/^Tomorrow/);
        expect(result).toMatch(/\d/); // contains time digits
    });
});

describe('formatEndedContext', () => {
    it('shows "Ended X min ago" for recent programs', () => {
        const now = new Date('2026-03-11T21:05:00Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatEndedContext(end, now)).toBe('Ended 5 min ago');
    });

    it('shows "Ended X hr ago" for programs ended over an hour ago', () => {
        const now = new Date('2026-03-11T23:00:00Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatEndedContext(end, now)).toBe('Ended 2 hr ago');
    });

    it('shows "Ended 1 min ago" for just-ended programs', () => {
        const now = new Date('2026-03-11T21:00:10Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatEndedContext(end, now)).toBe('Ended 1 min ago');
    });
});

describe('formatTemporalContext', () => {
    it('dispatches live status correctly', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const start = '2026-03-11T19:30:00Z';
        const end = '2026-03-11T20:25:00Z';

        expect(formatTemporalContext('live', start, end, undefined, now)).toBe('Ends in 25 min');
    });

    it('dispatches upcoming_today status correctly', () => {
        const now = new Date('2026-03-11T18:00:00Z');
        const start = '2026-03-11T18:30:00Z';
        const end = '2026-03-11T19:30:00Z';

        expect(formatTemporalContext('upcoming_today', start, end, undefined, now)).toBe(
            'In 30 min',
        );
    });

    it('dispatches future status correctly', () => {
        const now = new Date('2026-03-11T22:00:00Z');
        const start = '2026-03-12T14:30:00Z';
        const end = '2026-03-12T16:00:00Z';

        const result = formatTemporalContext('future', start, end, undefined, now);
        expect(result).toMatch(/^Tomorrow /);
    });

    it('dispatches ended status correctly', () => {
        const now = new Date('2026-03-11T21:05:00Z');
        const end = '2026-03-11T21:00:00Z';
        expect(formatTemporalContext('ended', '', end, undefined, now)).toBe('Ended 5 min ago');
    });

    it('handles unknown status with time range fallback', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const start = '2026-03-11T19:00:00Z';
        const end = '2026-03-11T20:30:00Z';
        const result = formatTemporalContext('unknown', start, end, undefined, now);
        expect(result).toContain('–');
    });
});

describe('locale support', () => {
    it('passes locale to toLocaleTimeString for upcoming programs', () => {
        const now = new Date('2026-03-11T14:00:00Z');
        const start = '2026-03-11T20:15:00Z';

        const resultDefault = formatUpcomingContext(start, undefined, now);
        const resultDe = formatUpcomingContext(start, 'de-DE', now);

        // Both should produce "Tonight <time>" — the time format may differ by locale
        expect(resultDefault).toMatch(/^Tonight /);
        expect(resultDe).toMatch(/^Tonight /);
    });

    it('passes locale to toLocaleDateString for future programs', () => {
        const now = new Date('2026-03-11T10:00:00Z');
        const start = '2026-03-14T20:00:00Z'; // Saturday

        const resultEn = formatFutureContext(start, 'en-US', now);
        const resultDe = formatFutureContext(start, 'de-DE', now);

        // Both contain time digits but day name may differ (Sat vs Sa.)
        expect(resultEn).toMatch(/\d/);
        expect(resultDe).toMatch(/\d/);
        // Day names should differ between locales
        expect(resultEn).not.toBe(resultDe);
    });
});

describe('boundary cases', () => {
    it('midnight crossover: program spanning midnight', () => {
        const now = new Date('2026-03-11T23:50:00Z');
        const end = '2026-03-12T00:10:00Z';
        expect(formatLiveContext('', end, now)).toBe('Ends in 20 min');
    });

    it('program starts exactly now — upcoming shows In 1 min', () => {
        const now = new Date('2026-03-11T20:00:00Z');
        const start = '2026-03-11T20:00:00Z';
        expect(formatUpcomingContext(start, undefined, now)).toBe('In 1 min');
    });
});
