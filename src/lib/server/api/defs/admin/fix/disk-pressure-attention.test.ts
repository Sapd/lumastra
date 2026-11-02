// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The thresholds are the whole design. A bell that lights up at normal disk
 * usage becomes decoration within a week, so the cases pinned here are the ones
 * that must NOT alert as much as the ones that must.
 */

import { describe, it, expect } from 'vitest';
import { classifyVolume, adaptDiskPressure } from './disk-pressure-attention.js';
import type { HostPressure, VolumeUsage } from '$lib/components/admin/fix/host-pressure.schema.js';

const GiB = 1024 * 1024 * 1024;

function volume(partial: Partial<VolumeUsage>): VolumeUsage {
    return {
        path: '/data',
        label: '/data',
        totalBytes: 500 * GiB,
        freeBytes: 250 * GiB,
        usedPercent: 50,
        ...partial,
    };
}

describe('classifyVolume', () => {
    it('says nothing at ordinary usage', () => {
        expect(classifyVolume(volume({}))).toBeNull();
    });

    it('says nothing at 95% on a large array, where 10% is still terabytes', () => {
        // The failure mode a percentage-only rule would have: 1 TB free is not
        // a problem, however alarming the percentage looks.
        expect(
            classifyVolume(
                volume({ totalBytes: 20000 * GiB, freeBytes: 1000 * GiB, usedPercent: 95 }),
            ),
        ).toBeNull();
    });

    it('warns when the percentage is high AND the absolute space is small', () => {
        expect(
            classifyVolume(volume({ totalBytes: 200 * GiB, freeBytes: 10 * GiB, usedPercent: 95 })),
        ).toBe('low');
    });

    it('does not warn on a small absolute amount when the disk is mostly empty', () => {
        // A tiny volume that is 50% used has little free space in absolute terms
        // but is not filling up — the percentage gate is what stops this.
        expect(
            classifyVolume(volume({ totalBytes: 16 * GiB, freeBytes: 8 * GiB, usedPercent: 50 })),
        ).toBeNull();
    });

    it('goes critical only when there is essentially nothing left', () => {
        expect(
            classifyVolume(volume({ totalBytes: 200 * GiB, freeBytes: 0, usedPercent: 100 })),
        ).toBe('critical');
    });

    it('ignores a volume that reports a zero total rather than calling it full', () => {
        expect(classifyVolume(volume({ totalBytes: 0, freeBytes: 0, usedPercent: 0 }))).toBeNull();
    });
});

describe('adaptDiskPressure', () => {
    const pressure = (volumes: VolumeUsage[]): HostPressure => ({
        generatedAt: new Date().toISOString(),
        memory: { limitBytes: null, usageBytes: null, hostTotalBytes: 8 * GiB, source: 'host' },
        volumes,
        unmeasured: [],
        pathsLookupFailed: false,
        cpu: { effectiveCores: 4, hostCores: 8, source: 'host' },
        containerized: true,
    });

    it('emits nothing on a healthy host', () => {
        expect(adaptDiskPressure(pressure([volume({})]))).toEqual([]);
    });

    it('emits one alert per volume under pressure, keyed stably by path', () => {
        const alerts = adaptDiskPressure(
            pressure([
                volume({}),
                volume({
                    path: '/config',
                    label: 'Config & cache',
                    totalBytes: 100 * GiB,
                    freeBytes: 1 * GiB,
                    usedPercent: 99,
                }),
            ]),
        );
        expect(alerts).toHaveLength(1);
        expect(alerts[0].id).toBe('degraded-component:disk:/config');
        expect(alerts[0].severity).toBe('warning');
        expect(alerts[0].type).toBe('degraded-component');
    });

    it('fingerprints by band so a percentage tick cannot evict an ack', () => {
        const at91 = adaptDiskPressure(
            pressure([volume({ totalBytes: 100 * GiB, freeBytes: 9 * GiB, usedPercent: 91 })]),
        );
        const at93 = adaptDiskPressure(
            pressure([volume({ totalBytes: 100 * GiB, freeBytes: 7 * GiB, usedPercent: 93 })]),
        );
        expect(at91[0].fingerprint).toBe(at93[0].fingerprint);
    });

    it('changes fingerprint when it gets genuinely worse, so the alert resurfaces', () => {
        const low = adaptDiskPressure(
            pressure([volume({ totalBytes: 100 * GiB, freeBytes: 9 * GiB, usedPercent: 91 })]),
        );
        const critical = adaptDiskPressure(
            pressure([volume({ totalBytes: 100 * GiB, freeBytes: 0, usedPercent: 100 })]),
        );
        expect(low[0].fingerprint).not.toBe(critical[0].fingerprint);
        expect(critical[0].severity).toBe('critical');
    });

    it('formats free space as a size, never as a bandwidth', () => {
        const alerts = adaptDiskPressure(
            pressure([volume({ totalBytes: 100 * GiB, freeBytes: 5 * GiB, usedPercent: 95 })]),
        );
        expect(alerts[0].detail).not.toContain('/s');
    });
});
