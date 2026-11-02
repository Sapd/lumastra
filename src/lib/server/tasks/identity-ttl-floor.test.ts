// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { deriveIdentityTtlFloor, IDENTITY_CLAIM_MARGIN_MS } from './identity-ttl-floor.js';

// Minimal helper to build a TaskDefinition without the full suite of required
// fields being repeated in every test case.
function makeTask(overrides: Partial<Parameters<typeof defineTask>[0]> & { id?: string } = {}) {
    return defineTask({
        id: overrides.id ?? 'test-task',
        name: 'Test Task',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        async execute() {
            return { success: true };
        },
        ...overrides,
    });
}

describe('IDENTITY_CLAIM_MARGIN_MS', () => {
    it('is 10_000 ms (10 s)', () => {
        expect(IDENTITY_CLAIM_MARGIN_MS).toBe(10_000);
    });
});

describe('deriveIdentityTtlFloor', () => {
    it('returns margin-only when neither timeout.hard nor schedule.every is declared', () => {
        const task = makeTask();
        expect(deriveIdentityTtlFloor(task)).toBe(IDENTITY_CLAIM_MARGIN_MS);
    });

    it('derives floor from timeout.hard when no schedule is declared', () => {
        // timeout.hard = '130m' = 7_800_000 ms → floor = 7_800_000 + 10_000
        const task = makeTask({ timeout: { hard: '130m', soft: '120m' } });
        expect(deriveIdentityTtlFloor(task)).toBe(7_800_000 + IDENTITY_CLAIM_MARGIN_MS);
    });

    it('derives floor from schedule.every when it exceeds timeout.hard', () => {
        // schedule.every = '1h' = 3_600_000; timeout.hard = '30m' = 1_800_000
        // → floor = max(1_800_000, 3_600_000) + 10_000 = 3_610_000
        const task = makeTask({
            schedule: { every: '1h' },
            timeout: { hard: '30m', soft: '25m' },
        });
        expect(deriveIdentityTtlFloor(task)).toBe(3_600_000 + IDENTITY_CLAIM_MARGIN_MS);
    });

    it('uses timeout.hard when it exceeds schedule.every', () => {
        // file-library-scan: every='1h'=3_600_000, hard='120m'=7_200_000
        // → floor = max(7_200_000, 3_600_000) + 10_000 = 7_210_000
        const task = makeTask({
            schedule: { every: '1h' },
            timeout: { hard: '120m', soft: '110m' },
        });
        expect(deriveIdentityTtlFloor(task)).toBe(7_200_000 + IDENTITY_CLAIM_MARGIN_MS);
    });

    it('file-library-scan: configured 130m ttl beats derived floor of ~120m10s', () => {
        // configured ttl = 130m = 7_800_000; derived floor = 7_200_000 + 10_000 = 7_210_000
        // → configured wins: max(7_210_000, 7_800_000) = 7_800_000
        const task = makeTask({
            schedule: { every: '1h' },
            timeout: { hard: '120m', soft: '110m' },
        });
        const floor = deriveIdentityTtlFloor(task);
        const configuredTtlMs = 130 * 60_000; // 7_800_000
        const effectiveTtl = Math.max(floor, configuredTtlMs);
        expect(floor).toBe(7_210_000);
        expect(effectiveTtl).toBe(7_800_000); // configured ttl wins
    });

    it('stage-sweep: 60s-scheduled task gets a floor >= 70s', () => {
        // stage-sweep: every='60s'=60_000, hard='5m'=300_000
        // → floor = max(300_000, 60_000) + 10_000 = 310_000 ms
        // NOTE: stage-sweep does NOT use exclusiveWith, but if it did, the
        // derived floor would be ~310s (~5m10s), dominated by the hard timeout.
        const task = makeTask({
            schedule: { every: '60s' },
            timeout: { hard: '5m', soft: '4m' },
        });
        const floor = deriveIdentityTtlFloor(task);
        expect(floor).toBeGreaterThanOrEqual(70_000);
        // Exact value: max(300_000, 60_000) + 10_000 = 310_000
        expect(floor).toBe(310_000);
    });

    it('a task with only schedule.every (no timeout) gets floor = every_ms + margin', () => {
        // every='5m'=300_000 → floor = 300_000 + 10_000
        const task = makeTask({ schedule: { every: '5m' } });
        expect(deriveIdentityTtlFloor(task)).toBe(300_000 + IDENTITY_CLAIM_MARGIN_MS);
    });
});
