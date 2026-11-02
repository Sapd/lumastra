// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    classifyEpisodeAvailability,
    isEpisodeVisible,
    type EpisodeAvailability,
} from './episode-availability.js';

/** Fixed local-noon clock so the today-boundary cases are unambiguous. */
const NOW = new Date(2026, 6, 30, 12, 0, 0); // 2026-07-30 12:00 local

describe('classifyEpisodeAvailability', () => {
    it('reports available when a file is present', () => {
        expect(
            classifyEpisodeAvailability({ premiereDate: '2012-03-04', hasFile: true }, NOW),
        ).toBe('available');
    });

    it('treats undefined hasFile as present (legacy payloads)', () => {
        expect(classifyEpisodeAvailability({ premiereDate: '2012-03-04' }, NOW)).toBe('available');
    });

    it('reports missing for an aired episode with no file', () => {
        expect(
            classifyEpisodeAvailability({ premiereDate: '2012-03-04', hasFile: false }, NOW),
        ).toBe('missing');
    });

    it('reports unreleased for a future premiere date', () => {
        expect(
            classifyEpisodeAvailability(
                { premiereDate: '2026-08-28T00:00:00.000Z', hasFile: false },
                NOW,
            ),
        ).toBe('unreleased');
    });

    it('treats an episode airing today as released, not unreleased', () => {
        expect(
            classifyEpisodeAvailability({ premiereDate: '2026-07-30', hasFile: false }, NOW),
        ).toBe('missing');
    });

    // The regression this module exists for: Dawn: Prophecy S2 — an announced
    // season whose episodes carry no air date at all — rendered the red
    // "Not on disk" badge, whose tooltip claims the episode has already aired.
    it('reports undated (NOT missing) when no premiere date is known', () => {
        expect(classifyEpisodeAvailability({ hasFile: false }, NOW)).toBe('undated');
        expect(classifyEpisodeAvailability({ premiereDate: null, hasFile: false }, NOW)).toBe(
            'undated',
        );
        expect(classifyEpisodeAvailability({ premiereDate: '', hasFile: false }, NOW)).toBe(
            'undated',
        );
    });

    it('reports undated when the premiere date is unparseable', () => {
        expect(
            classifyEpisodeAvailability({ premiereDate: 'not-a-date', hasFile: false }, NOW),
        ).toBe('undated');
    });

    it('does not claim undated for a dateless episode that has a file', () => {
        expect(classifyEpisodeAvailability({ hasFile: true }, NOW)).toBe('available');
    });
});

// `premiere_date` is a Postgres DATE — a bare calendar date with no time and no
// zone, serialised as UTC midnight purely as a transport artefact. The rule these
// tests pin down is "has the show's air DATE arrived where the viewer is": the air
// day is recovered from the UTC components (which reproduce the stored date
// exactly), and compared against the viewer's LOCAL calendar day.
//
// Reading UTC midnight as a real release *instant* instead would put the boundary
// at a different local hour for every offset — which is the defect this module
// replaced. Do not "fix" these into a UTC-vs-UTC comparison.
describe('classifyEpisodeAvailability — viewer timezone boundary', () => {
    const withTimezone = <T>(tz: string, fn: () => T): T => {
        const previous = process.env.TZ;
        process.env.TZ = tz;
        try {
            return fn();
        } finally {
            process.env.TZ = previous;
        }
    };

    it('UTC+14: an episode dated today is released once the local date arrives', () => {
        // Kiritimati local 2026-07-30 00:05 — still 2026-07-29T10:05Z.
        const result = withTimezone('Pacific/Kiritimati', () =>
            classifyEpisodeAvailability(
                { premiereDate: '2026-07-30T00:00:00.000Z', hasFile: false },
                new Date(Date.UTC(2026, 6, 29, 10, 5)),
            ),
        );
        expect(result).toBe('missing');
    });

    it('UTC-11: an episode dated tomorrow stays unreleased while it is still today locally', () => {
        // Midway local 2026-07-29 18:00 — already 2026-07-30T05:00Z.
        const result = withTimezone('Pacific/Midway', () =>
            classifyEpisodeAvailability(
                { premiereDate: '2026-07-30T00:00:00.000Z', hasFile: false },
                new Date(Date.UTC(2026, 6, 30, 5, 0)),
            ),
        );
        expect(result).toBe('unreleased');
    });

    it('recovers the stored calendar date unshifted in a negative-offset zone', () => {
        // The naive `new Date(str)` → local-getters path would read 2026-08-27 here.
        const result = withTimezone('America/Los_Angeles', () =>
            classifyEpisodeAvailability(
                { premiereDate: '2026-08-28T00:00:00.000Z', hasFile: false },
                new Date(Date.UTC(2026, 7, 28, 12, 0)),
            ),
        );
        expect(result).toBe('missing');
    });

    it('holds across a DST transition', () => {
        // Berlin springs forward 2026-03-29; the boundary is a date compare, so the
        // missing hour cannot shift it.
        const result = withTimezone('Europe/Berlin', () =>
            classifyEpisodeAvailability(
                { premiereDate: '2026-03-29T00:00:00.000Z', hasFile: false },
                new Date(Date.UTC(2026, 2, 29, 1, 30)),
            ),
        );
        expect(result).toBe('missing');
    });
});

describe('isEpisodeVisible', () => {
    const cases: Array<[EpisodeAvailability, boolean, boolean, boolean]> = [
        // availability,  showUnaired, showMissing, expected
        ['available', false, false, true],
        ['unreleased', true, false, true],
        ['unreleased', false, true, false],
        ['missing', false, true, true],
        ['missing', true, false, false],
        // undated rides with the "missing" toggle — it is not on disk.
        ['undated', false, true, true],
        ['undated', true, false, false],
    ];

    it.each(cases)('%s (unaired=%s, missing=%s) → %s', (a, showUnaired, showMissing, expected) => {
        expect(isEpisodeVisible(a, { showUnaired, showMissing })).toBe(expected);
    });
});
