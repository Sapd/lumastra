// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage forecast producer: a library disk that fills within about two months
 * at the current pace. It must stay silent for every volume without a real
 * estimate (too few snapshots, not filling), and its fingerprint must not move
 * with each day's slightly different estimate, or an ack would not hold.
 */

import { describe, it, expect } from 'vitest';
import { adaptStorageForecast } from './adapters.js';
import type { LibraryVolumeGrowth } from '$lib/schemas/admin-library-storage-growth.js';

const GIB = 1024 ** 3;

function vol(over: Partial<LibraryVolumeGrowth> = {}): LibraryVolumeGrowth {
    return {
        id: '64769',
        libraries: ['Movies', 'Series'],
        freeBytes: 300 * GIB,
        totalBytes: 50_000 * GIB,
        measuredOn: '2026-10-21',
        estimate: {
            state: 'filling',
            daysUntilFull: 30,
            daysUntilFullLow: 25,
            daysUntilFullHigh: 40,
            bytesPerDay: 10 * GIB,
        },
        ...over,
    };
}

describe('adaptStorageForecast', () => {
    it('warns about the soonest disk that fills within two months', () => {
        const alerts = adaptStorageForecast([
            vol({
                id: 'a',
                libraries: ['Music'],
                estimate: {
                    state: 'filling',
                    daysUntilFull: 50,
                    daysUntilFullLow: 40,
                    bytesPerDay: GIB,
                },
            }),
            vol({ id: 'b' }),
        ]);
        expect(alerts).toHaveLength(1);
        const [alert] = alerts;
        expect(alert.id).toBe('storage:forecast');
        expect(alert.severity).toBe('warning');
        expect(alert.domain).toBe('storage');
        expect(alert.title).toContain('4 weeks');
        expect(alert.detail).toContain('Movies, Series');
        expect(alert.detail).toContain('300 GB');
        expect(alert.detail).toContain('10 GB a day');
    });

    it('stays silent when nothing fills within two months or there is no estimate', () => {
        expect(adaptStorageForecast([])).toEqual([]);
        expect(
            adaptStorageForecast([
                vol({
                    estimate: {
                        state: 'filling',
                        daysUntilFull: 61,
                        daysUntilFullLow: 30,
                        bytesPerDay: GIB,
                    },
                }),
                vol({ estimate: { state: 'not_filling' } }),
                vol({ estimate: { state: 'insufficient_data', snapshotDays: 3 } }),
            ]),
        ).toEqual([]);
    });

    it('leaves a low-confidence median to the tile unless even the slow end fills soon', () => {
        const low = (high: number | undefined) =>
            adaptStorageForecast([
                vol({
                    estimate: {
                        state: 'filling',
                        daysUntilFull: 30,
                        daysUntilFullLow: 10,
                        ...(high === undefined ? {} : { daysUntilFullHigh: high }),
                        bytesPerDay: GIB,
                        confidence: 'low',
                    },
                }),
            ]);
        expect(low(200)).toEqual([]);
        expect(low(undefined)).toEqual([]);
        expect(low(50)).toHaveLength(1);
    });

    it('says "full or fills within days" instead of "about 1 week" for a full disk', () => {
        const [alert] = adaptStorageForecast([
            vol({
                estimate: {
                    state: 'filling',
                    daysUntilFull: 0,
                    daysUntilFullLow: 0,
                    bytesPerDay: GIB,
                },
            }),
        ]);
        expect(alert.title).toBe('The media library disk is full or fills within days');
    });

    it('keeps one fingerprint while the estimate drifts within a bucket', () => {
        const at = (days: number): string | undefined =>
            adaptStorageForecast([
                vol({
                    estimate: {
                        state: 'filling',
                        daysUntilFull: days,
                        daysUntilFullLow: days,
                        bytesPerDay: GIB,
                    },
                }),
            ])[0]?.fingerprint;
        expect(at(40)).toBe(at(55));
        expect(at(20)).not.toBe(at(40));
        expect(at(3)).toBe('weeks:1');
    });
});
