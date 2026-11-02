// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildStorageForecast, pickForecastVolume } from './storage-forecast';
import type { LibraryVolumeGrowth } from '$lib/schemas/admin-library-storage-growth';

const TB = 1e12;

function vol(estimate: LibraryVolumeGrowth['estimate'], id = 'v1', libraries = ['Movies']) {
    return {
        id,
        libraries,
        freeBytes: 4 * TB,
        totalBytes: 10 * TB,
        measuredOn: '2026-10-20',
        estimate,
    } satisfies LibraryVolumeGrowth;
}

function filling(days: number, low = days, high: number | null = days) {
    return {
        state: 'filling' as const,
        daysUntilFull: days,
        daysUntilFullLow: low,
        ...(high === null ? {} : { daysUntilFullHigh: high }),
        bytesPerDay: 1e9,
    };
}

describe('pickForecastVolume', () => {
    it('is null without volumes', () => {
        expect(pickForecastVolume([])).toBeNull();
        expect(buildStorageForecast([])).toBeNull();
    });

    it('prefers the filling volume that runs full first', () => {
        const a = vol(filling(900), 'a');
        const b = vol(filling(200), 'b');
        const c = vol({ state: 'insufficient_data', snapshotDays: 3 }, 'c');
        expect(pickForecastVolume([a, c, b])?.id).toBe('b');
    });

    it('falls back to insufficient_data, then not_filling', () => {
        const nf = vol({ state: 'not_filling' }, 'nf');
        const ins = vol({ state: 'insufficient_data', snapshotDays: 2 }, 'ins');
        expect(pickForecastVolume([nf, ins])?.id).toBe('ins');
        expect(pickForecastVolume([nf])?.id).toBe('nf');
    });
});

describe('buildStorageForecast', () => {
    it('shows months with a band in the same unit', () => {
        const f = buildStorageForecast([vol(filling(548, 365, 913))]);
        expect(f?.text).toBe('≈ 18 months until full (12–30 months, at the current pace)');
        expect(f?.tone).toBe('neutral');
        expect(f?.title).toBeUndefined();
    });

    it('omits the band when it rounds to the central value', () => {
        const f = buildStorageForecast([vol(filling(548, 546, 550))]);
        expect(f?.text).toBe('≈ 18 months until full (at the current pace)');
    });

    it('words an open-ended upper bound', () => {
        const f = buildStorageForecast([vol(filling(548, 365, null))]);
        expect(f?.text).toBe('≈ 18 months until full (12 months or later, at the current pace)');
    });

    it('uses weeks below about eight weeks and flags critical', () => {
        const f = buildStorageForecast([vol(filling(40, 40, 40))]);
        expect(f?.text).toBe('≈ 6 weeks until full (at the current pace)');
        expect(f?.tone).toBe('critical');
    });

    it('uses a singular unit', () => {
        const f = buildStorageForecast([vol(filling(14, 14, 14))]);
        expect(f?.text).toBe('≈ 2 weeks until full (at the current pace)');
        const g = buildStorageForecast([vol(filling(31, 31, 31))]);
        expect(g?.text).toBe('≈ 4 weeks until full (at the current pace)');
    });

    it('switches to months at eight weeks and to years at two years', () => {
        expect(buildStorageForecast([vol(filling(56))])?.text).toBe(
            '≈ 2 months until full (at the current pace)',
        );
        expect(buildStorageForecast([vol(filling(1095))])?.text).toBe(
            '≈ 3 years until full (at the current pace)',
        );
    });

    it('caps at more than 10 years', () => {
        const f = buildStorageForecast([vol(filling(5000))]);
        expect(f?.text).toBe('More than 10 years until full (at the current pace)');
    });

    it('handles under a week', () => {
        const f = buildStorageForecast([vol(filling(3))]);
        expect(f?.text).toBe('Less than a week until full (at the current pace)');
        expect(f?.tone).toBe('critical');
    });

    it('tone thresholds: warning below 183 days, critical below 61', () => {
        expect(buildStorageForecast([vol(filling(60))])?.tone).toBe('critical');
        expect(buildStorageForecast([vol(filling(61))])?.tone).toBe('warning');
        expect(buildStorageForecast([vol(filling(182))])?.tone).toBe('warning');
        expect(buildStorageForecast([vol(filling(183))])?.tone).toBe('neutral');
    });

    it('describes insufficient data and not filling as neutral', () => {
        expect(
            buildStorageForecast([vol({ state: 'insufficient_data', snapshotDays: 5 })]),
        ).toEqual({
            text: 'Disk-full estimate after 14 days of measurements (5 so far)',
            tone: 'neutral',
        });
        expect(buildStorageForecast([vol({ state: 'not_filling' })])).toEqual({
            text: 'Not filling up at the current pace',
            tone: 'neutral',
        });
    });

    it('lists every volume in the title when there are several', () => {
        const f = buildStorageForecast([
            vol(filling(300), 'a', ['Movies', 'Series']),
            vol({ state: 'not_filling' }, 'b', []),
        ]);
        expect(f?.title).toBe('Movies, Series: 4.0 TB free of 10.0 TB\nb: 4.0 TB free of 10.0 TB');
    });
});

describe('buildStorageForecast precision', () => {
    const base = {
        id: '1',
        libraries: ['Movies'],
        freeBytes: 1,
        totalBytes: 2,
        measuredOn: '2026-10-21',
    };

    it('states confidence, basis, pattern and the approximate prior', () => {
        const f = buildStorageForecast([
            {
                ...base,
                estimate: {
                    state: 'filling',
                    daysUntilFull: 300,
                    daysUntilFullLow: 200,
                    daysUntilFullHigh: 500,
                    bytesPerDay: 1,
                    confidence: 'low',
                    basisDays: 20,
                    model: 'bursty',
                    approximatePrior: true,
                },
            },
        ]);
        expect(f?.precision).toBe(
            'Low confidence · based on 20 days of measurements · growth comes in bursts · partly from file dates',
        );
    });

    it('mentions one-off cleanups left out of the pace', () => {
        const filling = buildStorageForecast([
            {
                ...base,
                estimate: {
                    state: 'filling',
                    daysUntilFull: 300,
                    daysUntilFullLow: 250,
                    daysUntilFullHigh: 400,
                    bytesPerDay: 1,
                    confidence: 'medium',
                    ignoredDeletions: 1,
                },
            },
        ]);
        expect(filling?.precision).toBe('Medium confidence · ignores 1 large cleanup');
        const flat = buildStorageForecast([
            { ...base, estimate: { state: 'not_filling', ignoredDeletions: 2 } },
        ]);
        expect(flat?.precision).toBe('ignores 2 large cleanups');
    });

    it('claims nothing when the server sends no confidence', () => {
        const f = buildStorageForecast([
            {
                ...base,
                estimate: {
                    state: 'filling',
                    daysUntilFull: 300,
                    daysUntilFullLow: 300,
                    bytesPerDay: 1,
                },
            },
        ]);
        expect(f?.precision).toBeUndefined();
    });
});
