// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for queue-depth-throttle — threshold table coverage +
 * classesOverDepthThreshold derivation.
 *
 * Run with: npx vitest run src/lib/server/tasks/queue-depth-throttle.test.ts
 */

import { describe, it, expect } from 'vitest';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { QUEUE_DEPTH_SKIP_THRESHOLD, classesOverDepthThreshold } from './queue-depth-throttle.js';

describe('QUEUE_DEPTH_SKIP_THRESHOLD', () => {
    // QUEUE_DEPTH_SKIP_THRESHOLD is kept as Record<string, number> (not keyed
    // over the ResourceClass union — see the in-file comment for why), so
    // this test is the exhaustiveness substitute: a resource class added to
    // the SDK without a corresponding threshold here silently never backs
    // off and floods straight to its hard backpressure cap.
    it('has a threshold entry for every declared resource class', () => {
        for (const cls of RESOURCE_CLASSES) {
            expect(typeof QUEUE_DEPTH_SKIP_THRESHOLD[cls]).toBe('number');
        }
    });

    it('includes discovery below its backpressure hard cap (10000)', () => {
        expect(QUEUE_DEPTH_SKIP_THRESHOLD.discovery).toBeGreaterThan(0);
        expect(QUEUE_DEPTH_SKIP_THRESHOLD.discovery).toBeLessThan(10_000);
    });
});

describe('classesOverDepthThreshold', () => {
    it('reports a class once its waiting+delayed depth reaches the threshold', () => {
        const over = classesOverDepthThreshold({
            discovery: { waiting: 6000, delayed: 0 },
            cpu: { waiting: 1, delayed: 0 },
        });

        expect(over.has('discovery')).toBe(true);
        expect(over.has('cpu')).toBe(false);
    });

    it('never throttles a class with no threshold entry', () => {
        const over = classesOverDepthThreshold({
            'unknown-class': { waiting: 1_000_000, delayed: 0 },
        });

        expect(over.size).toBe(0);
    });

    it('returns an empty set for an empty input map', () => {
        expect(classesOverDepthThreshold({}).size).toBe(0);
    });
});
