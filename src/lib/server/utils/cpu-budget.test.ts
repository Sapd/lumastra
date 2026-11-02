// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    parseCgroupV2CpuMax,
    parseCgroupV1Cfs,
    computeCpuBudget,
    type CpuBudgetReaders,
} from './cpu-budget.js';

/** Build a reader set with sensible defaults, overridable per test. */
function readers(overrides: Partial<CpuBudgetReaders>): CpuBudgetReaders {
    return {
        readV2: () => null,
        readV1Quota: () => null,
        readV1Period: () => null,
        hostCores: () => 16,
        ...overrides,
    };
}

describe('parseCgroupV2CpuMax', () => {
    it('parses "<quota> <period>" into effective cores', () => {
        // Docker `cpus: 10` → 1000000us quota over a 100000us period = 10 cores.
        expect(parseCgroupV2CpuMax('1000000 100000')).toBe(10);
        expect(parseCgroupV2CpuMax('150000 100000')).toBeCloseTo(1.5);
    });

    it('returns null when unlimited ("max")', () => {
        expect(parseCgroupV2CpuMax('max 100000')).toBeNull();
    });

    it('tolerates trailing newline / extra whitespace', () => {
        expect(parseCgroupV2CpuMax('  800000   100000 \n')).toBe(8);
    });

    it('returns null for malformed or zero values', () => {
        expect(parseCgroupV2CpuMax('garbage')).toBeNull();
        expect(parseCgroupV2CpuMax('100000')).toBeNull();
        expect(parseCgroupV2CpuMax('0 100000')).toBeNull();
        expect(parseCgroupV2CpuMax('100000 0')).toBeNull();
    });
});

describe('parseCgroupV1Cfs', () => {
    it('parses quota/period microseconds into cores', () => {
        expect(parseCgroupV1Cfs('400000', '100000')).toBe(4);
    });

    it('returns null when quota is -1 (unlimited)', () => {
        expect(parseCgroupV1Cfs('-1', '100000')).toBeNull();
    });

    it('returns null for non-numeric or zero period', () => {
        expect(parseCgroupV1Cfs('x', '100000')).toBeNull();
        expect(parseCgroupV1Cfs('400000', '0')).toBeNull();
    });
});

describe('computeCpuBudget', () => {
    it('prefers cgroup-v2 cpu.max when present', () => {
        const b = computeCpuBudget(readers({ readV2: () => '800000 100000', hostCores: () => 16 }));
        expect(b).toEqual({ effectiveCores: 8, hostCores: 16, source: 'cgroup-v2' });
    });

    it('falls back to cgroup-v1 when v2 is absent', () => {
        const b = computeCpuBudget(
            readers({
                readV1Quota: () => '400000',
                readV1Period: () => '100000',
                hostCores: () => 16,
            }),
        );
        expect(b).toEqual({ effectiveCores: 4, hostCores: 16, source: 'cgroup-v1' });
    });

    it('uses the kernel default period when the v1 period file is missing', () => {
        // quota present but period unreadable → assume 100000µs, honour the cap.
        const b = computeCpuBudget(
            readers({ readV1Quota: () => '600000', readV1Period: () => null, hostCores: () => 16 }),
        );
        expect(b).toEqual({ effectiveCores: 6, hostCores: 16, source: 'cgroup-v1' });
    });

    it('falls back to host parallelism when no cgroup quota is set', () => {
        const b = computeCpuBudget(readers({ readV2: () => 'max 100000', hostCores: () => 6 }));
        expect(b).toEqual({ effectiveCores: 6, hostCores: 6, source: 'host' });
    });

    it('never reports more cores than the host can actually run', () => {
        // A quota above host capacity (e.g. cpus: 32 on an 8-core box) is clamped.
        const b = computeCpuBudget(readers({ readV2: () => '3200000 100000', hostCores: () => 8 }));
        expect(b.effectiveCores).toBe(8);
        expect(b.source).toBe('cgroup-v2');
    });

    it('never reports below 1 core', () => {
        const b = computeCpuBudget(readers({ readV2: () => null, hostCores: () => 0 }));
        expect(b.effectiveCores).toBe(1);
    });
});
