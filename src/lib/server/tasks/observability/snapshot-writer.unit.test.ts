// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the snapshot writer's pure helpers (Slice 3 §4.4, §9).
 *
 * percentileFromHistogram interpolation + readDurationAndRuns / splitRunTotals
 * extraction from a Prometheus-JSON-shaped metric array. No DB / Valkey.
 */

import { describe, it, expect } from 'vitest';
import {
    percentileFromHistogram,
    readDurationAndRuns,
    splitRunTotals,
    type PromMetric,
} from './snapshot-writer.js';

describe('percentileFromHistogram', () => {
    it('returns null for an empty histogram', () => {
        expect(percentileFromHistogram([], 0.95)).toBeNull();
        expect(percentileFromHistogram([{ le: Infinity, cumulative: 0 }], 0.5)).toBeNull();
    });

    it('interpolates a median within a bucket', () => {
        // 10 obs: 5 ≤ 1s, 10 ≤ 5s, 10 total. Median (5th) sits at the 1s
        // boundary → ~1000ms.
        const buckets = [
            { le: 1, cumulative: 5 },
            { le: 5, cumulative: 10 },
            { le: Infinity, cumulative: 10 },
        ];
        const p50 = percentileFromHistogram(buckets, 0.5);
        expect(p50).toBe(1000);
    });

    it('interpolates p95 into the upper bucket', () => {
        const buckets = [
            { le: 1, cumulative: 90 },
            { le: 10, cumulative: 100 },
            { le: Infinity, cumulative: 100 },
        ];
        const p95 = percentileFromHistogram(buckets, 0.95);
        // target = 95; lands between le=1 (cum 90) and le=10 (cum 100):
        // frac = (95-90)/10 = 0.5 → 1 + 0.5*(10-1) = 5.5s → 5500ms.
        expect(p95).toBe(5500);
    });

    it('clamps to the last finite boundary when target is in +Inf overflow', () => {
        const buckets = [
            { le: 1, cumulative: 5 },
            { le: Infinity, cumulative: 100 },
        ];
        // p95 target = 95 > 5 (le=1 cum), lands in +Inf → clamp to 1s.
        expect(percentileFromHistogram(buckets, 0.95)).toBe(1000);
    });
});

describe('readDurationAndRuns', () => {
    it('aggregates bucket counts across labels and reports total runs', () => {
        const metrics: PromMetric[] = [
            {
                name: 'lumastra_task_duration_seconds',
                type: 'histogram',
                values: [
                    {
                        labels: { le: '1' },
                        value: 3,
                        metricName: 'lumastra_task_duration_seconds_bucket',
                    },
                    {
                        labels: { le: '5' },
                        value: 5,
                        metricName: 'lumastra_task_duration_seconds_bucket',
                    },
                    {
                        labels: { le: '+Inf' },
                        value: 5,
                        metricName: 'lumastra_task_duration_seconds_bucket',
                    },
                    {
                        labels: {},
                        value: 7,
                        metricName: 'lumastra_task_duration_seconds_sum',
                    },
                    {
                        labels: {},
                        value: 5,
                        metricName: 'lumastra_task_duration_seconds_count',
                    },
                ],
            },
            {
                name: 'lumastra_task_runs_total',
                type: 'counter',
                values: [
                    { labels: { status: 'completed' }, value: 8 },
                    { labels: { status: 'failed' }, value: 2 },
                ],
            },
        ];
        const out = readDurationAndRuns(metrics);
        expect(out.p50Ms).not.toBeNull();
        expect(out.p95Ms).not.toBeNull();
        expect(out.totalRuns).toBe(10);
    });

    it('returns null percentiles when the duration histogram is absent', () => {
        const out = readDurationAndRuns([]);
        expect(out.p50Ms).toBeNull();
        expect(out.p95Ms).toBeNull();
        expect(out.totalRuns).toBe(0);
    });
});

describe('splitRunTotals', () => {
    it('splits completed vs failed/cancelled', () => {
        const metrics: PromMetric[] = [
            {
                name: 'lumastra_task_runs_total',
                type: 'counter',
                values: [
                    { labels: { status: 'completed' }, value: 8 },
                    { labels: { status: 'failed' }, value: 2 },
                    { labels: { status: 'cancelled' }, value: 1 },
                ],
            },
        ];
        const out = splitRunTotals(metrics);
        expect(out.completed).toBe(8);
        expect(out.failed).toBe(3);
    });
});
