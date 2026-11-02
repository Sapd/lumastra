// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Mission Control `/now` snapshot pure transforms (Slice 4).
 * Covers the saturation calc + amber-at-cap boundary, class-snapshot grouping,
 * the leader-present-vs-absent degradation, node identity join, and the health
 * summary fallback to 'unknown'.
 */

import { describe, it, expect } from 'vitest';
import {
    computeSaturation,
    isSaturated,
    buildClassSnapshots,
    buildNodeSnapshots,
    buildNowHealth,
    buildEmbeddingCoverage,
    type AssembleNowSnapshotInput,
} from './now-snapshot.js';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';

const NODE = (instanceId: string, version = '1.0.0'): LiveClusterNode => ({
    instanceId,
    role: 'web',
    version,
    hostname: 'h',
    startedAt: new Date().toISOString(),
    uptimeSeconds: 10,
    keyFingerprint: 'aaaaaaaaaaaaaaaa',
});

function baseInput(over: Partial<AssembleNowSnapshotInput> = {}): AssembleNowSnapshotInput {
    return {
        resourceClasses: ['cpu', 'io'],
        queueDepths: {
            cpu: { waiting: 3, active: 2, delayed: 0, paused: false },
            io: { waiting: 0, active: 1, delayed: 0, paused: false },
        },
        caps: { cpu: 2, io: 4 },
        leaders: [],
        nodes: [],
        selfInstanceId: 'self-1',
        healthStatus: 'healthy',
        healthAvailable: true,
        ...over,
    };
}

describe('computeSaturation', () => {
    it('returns active/cap when capped', () => {
        expect(computeSaturation(2, 4)).toBe(0.5);
        expect(computeSaturation(4, 4)).toBe(1);
    });

    it('returns null when cap is non-positive or non-finite', () => {
        expect(computeSaturation(2, 0)).toBeNull();
        expect(computeSaturation(2, -1)).toBeNull();
        expect(computeSaturation(2, Number.NaN)).toBeNull();
    });
});

describe('isSaturated (amber-at-cap boundary)', () => {
    it('is false below cap', () => {
        expect(isSaturated(1, 2)).toBe(false);
    });
    it('is true at exactly cap', () => {
        expect(isSaturated(2, 2)).toBe(true);
    });
    it('is true over cap', () => {
        expect(isSaturated(3, 2)).toBe(true);
    });
    it('is false when uncapped', () => {
        expect(isSaturated(5, 0)).toBe(false);
    });
});

describe('buildClassSnapshots', () => {
    it('emits one snapshot per RESOURCE_CLASSES entry with saturation', () => {
        const snaps = buildClassSnapshots(baseInput());
        expect(snaps.map((s) => s.resourceClass)).toEqual(['cpu', 'io']);
        const cpu = snaps.find((s) => s.resourceClass === 'cpu')!;
        expect(cpu.active).toBe(2);
        expect(cpu.cap).toBe(2);
        expect(cpu.saturationPct).toBe(1); // 2/2 — amber boundary
    });

    it('omits leaderInstanceId entirely when no leaders supplied (Slice 0 absent)', () => {
        const snaps = buildClassSnapshots(baseInput({ leaders: [] }));
        for (const s of snaps) expect('leaderInstanceId' in s).toBe(false);
    });

    it('attaches leader per class (null for a class without a holder) when leaders present', () => {
        const snaps = buildClassSnapshots(
            baseInput({
                leaders: [
                    { resourceClass: 'cpu', holderInstanceId: 'web-1' },
                    { resourceClass: 'io', holderInstanceId: null },
                ],
            }),
        );
        expect(snaps.find((s) => s.resourceClass === 'cpu')!.leaderInstanceId).toBe('web-1');
        expect(snaps.find((s) => s.resourceClass === 'io')!.leaderInstanceId).toBeNull();
    });

    it('defaults missing queue depth + cap to zero (null saturation)', () => {
        const snaps = buildClassSnapshots(
            baseInput({
                resourceClasses: ['embedding'],
                queueDepths: {},
                caps: {},
            }),
        );
        const emb = snaps[0];
        expect(emb.active).toBe(0);
        expect(emb.cap).toBe(0);
        expect(emb.saturationPct).toBeNull();
    });
});

describe('buildNodeSnapshots', () => {
    it('marks the self node and reports online + version', () => {
        const nodes = buildNodeSnapshots(
            baseInput({
                nodes: [NODE('self-1'), NODE('peer-2', '')],
                selfInstanceId: 'self-1',
            }),
        );
        expect(nodes).toEqual([
            {
                instanceId: 'self-1',
                isSelf: true,
                online: true,
                version: '1.0.0',
            },
            { instanceId: 'peer-2', isSelf: false, online: true, version: null },
        ]);
    });
});

describe('buildNowHealth', () => {
    it('passes through the status when available', () => {
        expect(buildNowHealth(baseInput())).toEqual({
            status: 'healthy',
            available: true,
        });
    });
    it('falls back to unknown + unavailable when status is null', () => {
        expect(buildNowHealth(baseInput({ healthStatus: null, healthAvailable: false }))).toEqual({
            status: 'unknown',
            available: false,
        });
    });
});

describe('buildEmbeddingCoverage', () => {
    it('computes missing + coveragePct for a normal case', () => {
        expect(buildEmbeddingCoverage({ eligible: 100, embedded: 40 })).toEqual({
            eligible: 100,
            embedded: 40,
            missing: 60,
            coveragePct: 0.4,
        });
    });
    it('returns null coveragePct when nothing is eligible (avoids 0/0)', () => {
        expect(buildEmbeddingCoverage({ eligible: 0, embedded: 0 })).toEqual({
            eligible: 0,
            embedded: 0,
            missing: 0,
            coveragePct: null,
        });
    });
    it('clamps when embedded transiently exceeds eligible', () => {
        const c = buildEmbeddingCoverage({ eligible: 10, embedded: 12 });
        expect(c.missing).toBe(0);
        expect(c.coveragePct).toBe(1);
    });
    it('reports full coverage as 1', () => {
        expect(buildEmbeddingCoverage({ eligible: 50, embedded: 50 }).coveragePct).toBe(1);
    });
});
