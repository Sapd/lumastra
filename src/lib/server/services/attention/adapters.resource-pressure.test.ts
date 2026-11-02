// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resource-pressure and unclean-exit producers.
 *
 * A memory condition becomes an attention item only once it has held for
 * RESOURCE_PRESSURE_SUSTAIN_MS (the clocks come from pressure-since.ts). Clocks are
 * keyed by a STABLE subject, role@machine for a container and the host id for a
 * machine, so a redeploy with a new INSTANCE_ID keeps the clock and the ack. A
 * machine's memory is judged by the ratio AND an absolute floor, so a 256 GiB box
 * with 12.8 GiB free is not flagged, while a 32 GiB box with 1.28 GiB free is.
 */

import { describe, expect, it } from 'vitest';
import {
    RESOURCE_PRESSURE_SUSTAIN_MS,
    UNCLEAN_EXIT_THRESHOLD,
    adaptResourcePressure,
    adaptUncleanExits,
    resourcePressureConditions,
    type PressureCondition,
    type PressureNode,
} from './adapters.js';
import { ATTENTION_SOURCE_PREFIXES } from './attention-service.js';
import type { PressureClock } from './pressure-since.js';
import type { UncleanExitRow } from '$lib/server/database/queries/attention.queries.js';

const GiB = 1024 ** 3;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const CLUSTER_HREF = '/admin/system/health?tab=cluster';
const OLD = NOW - RESOURCE_PRESSURE_SUSTAIN_MS - 60_000;
const FRESH = NOW - 5 * 60_000;

/** A machine with plenty of memory free. */
const BOX_A = { id: 'boot:a', name: 'box-a', memTotalBytes: 32 * GiB, memAvailableBytes: 28 * GiB };
const BOX_B = { id: 'boot:b', name: 'box-b', memTotalBytes: 32 * GiB, memAvailableBytes: 28 * GiB };

function pnode(over: Partial<PressureNode> & { instanceId: string }): PressureNode {
    return { role: 'web', hostname: `${over.instanceId}-ctr`, host: BOX_A, ...over };
}

/** A container at `used` of a 1 GiB limit (exact in binary, so the ratio is exact). */
function web(instanceId: string, used: number, host = BOX_A): PressureNode {
    return pnode({
        instanceId,
        role: 'web',
        host,
        resources: { memoryUsedBytes: used * GiB, memoryLimitBytes: GiB },
    });
}

function condition(
    over: Partial<PressureCondition> &
        Pick<PressureCondition, 'key' | 'subject' | 'kind' | 'level'>,
): PressureCondition {
    return {
        ratio: 0.9,
        where: 'box-a',
        role: 'web',
        usedBytes: 0.9 * GiB,
        limitBytes: GiB,
        ...over,
    };
}

/** Clocks as trackPressureSince returns them: each condition with its first-seen time. */
function clocks(
    ...entries: Array<[PressureCondition, number]>
): Map<string, PressureClock<PressureCondition>> {
    return new Map(entries.map(([c, first]) => [c.key, { first, last: NOW, value: c }] as const));
}

const WEB_WARN = condition({
    key: 'container:web@boot:a',
    subject: 'web@boot:a',
    kind: 'container',
    level: 'warn',
    ratio: 0.9,
});
const WEB_CRIT = condition({
    key: 'container:web@boot:a:critical',
    subject: 'web@boot:a',
    kind: 'container',
    level: 'critical',
    ratio: 0.97,
});

describe('resourcePressureConditions', () => {
    it('a container at 90 % of its limit gives one warn condition, keyed by role and machine', () => {
        const conditions = resourcePressureConditions([web('web-1', 0.9)]);
        expect(conditions.map((c) => c.key)).toEqual(['container:web@boot:a']);
        expect(conditions[0]).toMatchObject({
            subject: 'web@boot:a',
            kind: 'container',
            level: 'warn',
            role: 'web',
        });
    });

    it('a container at 97 % gives a warn key and a separate critical key', () => {
        const conditions = resourcePressureConditions([web('web-1', 0.97)]);
        expect(conditions.map((c) => [c.key, c.level]).sort()).toEqual([
            ['container:web@boot:a', 'warn'],
            ['container:web@boot:a:critical', 'critical'],
        ]);
    });

    it('ignores a cache-dominated working set and its old peak, retaining real OOM risk', () => {
        const node = pnode({
            instanceId: 'worker-cache',
            role: 'worker',
            resources: {
                memoryUsedBytes: 5.56 * GiB,
                memoryPeakBytes: 5.8 * GiB,
                memoryLimitBytes: 6 * GiB,
                memoryPressureBytes: 0.81 * GiB,
                memoryReclaimableFileBytes: 4.75 * GiB,
                memoryPressurePeakBytes: 1.1 * GiB,
            },
        });
        expect(resourcePressureConditions([node])).toEqual([]);
        node.resources!.memoryPressureBytes = 5.8 * GiB;
        node.resources!.memoryReclaimableFileBytes = 0.1 * GiB;
        const conditions = resourcePressureConditions([node]);
        expect(conditions.map((c) => c.level)).toEqual(['warn', 'critical']);
        const alerts = adaptResourcePressure(
            clocks(...conditions.map((c): [PressureCondition, number] => [c, OLD])),
            NOW,
        );
        expect(alerts[0].severity).toBe('critical');
        expect(alerts[0].detail).toContain('excluding reclaimable file cache');
        expect(alerts[0].detail).toContain('Current reclaimable file cache: 102 MiB');
    });

    it('falls back to the working-set peak only when memory.stat is unavailable', () => {
        const node = web('legacy', 0.4);
        node.resources!.memoryPeakBytes = 0.99 * GiB;
        expect(resourcePressureConditions([node]).map((c) => c.kind)).toEqual(['containerPeak']);
        node.resources!.memoryPressureBytes = 0.4 * GiB;
        expect(resourcePressureConditions([node])).toEqual([]);
    });

    it('a node without a memory limit gives no container condition', () => {
        const conditions = resourcePressureConditions([
            pnode({ instanceId: 'web-1', resources: { memoryUsedBytes: 0.99 * GiB } }),
        ]);
        expect(conditions).toEqual([]);
    });

    it('two replicas of one role on one machine collapse to the fuller one, in either order', () => {
        const forward = resourcePressureConditions([web('web-1', 0.9), web('web-2', 0.97)]);
        const backward = resourcePressureConditions([web('web-2', 0.97), web('web-1', 0.9)]);
        for (const conditions of [forward, backward]) {
            expect(conditions.map((c) => c.key).sort()).toEqual([
                'container:web@boot:a',
                'container:web@boot:a:critical',
            ]);
            const critical = conditions.find((c) => c.level === 'critical');
            expect(critical?.ratio).toBeCloseTo(0.97);
            expect(critical?.usedBytes).toBe(0.97 * GiB);
        }
    });

    it('a restart with a NEW instance id keeps the same keys', () => {
        const before = resourcePressureConditions([web('old-1', 0.9)]).map((c) => c.key);
        const after = resourcePressureConditions([web('new-2', 0.9)]).map((c) => c.key);
        expect(after).toEqual(before);
        expect(after).toEqual(['container:web@boot:a']);
    });

    it('different roles on one machine are separate subjects', () => {
        const conditions = resourcePressureConditions([
            web('web-1', 0.9),
            pnode({
                instanceId: 'worker-1',
                role: 'worker',
                resources: { memoryUsedBytes: 0.9 * GiB, memoryLimitBytes: GiB },
            }),
        ]);
        expect(conditions.map((c) => c.key).sort()).toEqual([
            'container:web@boot:a',
            'container:worker@boot:a',
        ]);
    });

    it('two services on one 32 GiB machine at 4 % available give the host warn and critical once', () => {
        const box = {
            id: 'name:box',
            name: 'box',
            memTotalBytes: 32 * GiB,
            memAvailableBytes: 0.04 * 32 * GiB,
        };
        const conditions = resourcePressureConditions([
            pnode({ instanceId: 'web-1', host: box }),
            pnode({ instanceId: 'worker-1', role: 'worker', host: box }),
        ]);
        const hostConditions = conditions.filter((c) => c.kind === 'host');
        expect(hostConditions.map((c) => [c.key, c.level]).sort()).toEqual([
            ['host:name:box', 'warn'],
            ['host:name:box:critical', 'critical'],
        ]);
        expect(hostConditions[0].subject).toBe('name:box');
        expect(hostConditions[0].ratio).toBeCloseTo(0.96);
    });

    it('a 256 GiB machine at 5 % available (12.8 GiB) yields no condition', () => {
        const big = {
            id: 'boot:big',
            name: 'big',
            memTotalBytes: 256 * GiB,
            memAvailableBytes: 0.05 * 256 * GiB,
        };
        expect(resourcePressureConditions([pnode({ instanceId: 'web-1', host: big })])).toEqual([]);
    });

    it('non-finite memory figures are skipped, not turned into conditions', () => {
        const conditions = resourcePressureConditions([
            pnode({
                instanceId: 'web-1',
                resources: { memoryUsedBytes: Number.NaN, memoryLimitBytes: GiB },
                host: { ...BOX_A, memAvailableBytes: Number.NaN },
            }),
        ]);
        expect(conditions).toEqual([]);
    });
});

describe('adaptResourcePressure', () => {
    it('stays quiet until the subject has held for the sustain window', () => {
        expect(adaptResourcePressure(clocks([WEB_WARN, FRESH]), NOW)).toEqual([]);
    });

    it.each([undefined, null, {}, { kind: 'container' }, { ...WEB_WARN, subject: null }])(
        'drops a malformed clock value %j without losing a healthy alert',
        (value) => {
            const input = clocks([WEB_WARN, OLD]);
            input.set('broken', {
                first: OLD,
                last: NOW,
                value,
            } as PressureClock<PressureCondition>);

            expect(() => adaptResourcePressure(input, NOW)).not.toThrow();
            expect(adaptResourcePressure(input, NOW)).toEqual(
                adaptResourcePressure(clocks([WEB_WARN, OLD]), NOW),
            );
        },
    );

    it('the sustain window counts at exactly its length', () => {
        const alerts = adaptResourcePressure(
            clocks([WEB_WARN, NOW - RESOURCE_PRESSURE_SUSTAIN_MS]),
            NOW,
        );
        expect(alerts).toHaveLength(1);
    });

    it('a sustained warn container is a warning keyed on its subject, linked to the cluster view', () => {
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD]), NOW);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            id: 'resource-pressure:container',
            fingerprint: 'warn:web@boot:a',
            severity: 'warning',
            domain: 'system',
            type: 'degraded-component',
            sourceRef: CLUSTER_HREF,
        });
        expect(alerts[0].actions[0]).toMatchObject({ kind: 'investigate', href: CLUSTER_HREF });
    });

    it('a sustained critical container is critical, with a critical fingerprint', () => {
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD], [WEB_CRIT, OLD]), NOW);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            severity: 'critical',
            fingerprint: 'critical:web@boot:a',
        });
        expect(alerts[0].detail).toContain('97 %');
    });

    it('a critical level that is not yet sustained leaves the warning in place', () => {
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD], [WEB_CRIT, FRESH]), NOW);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ severity: 'warning', fingerprint: 'warn:web@boot:a' });
    });

    it('minutes come from the warn clock even when the worst is critical', () => {
        const alerts = adaptResourcePressure(
            clocks([WEB_WARN, NOW - 30 * 60_000], [WEB_CRIT, NOW - 11 * 60_000]),
            NOW,
        );
        expect(alerts[0].severity).toBe('critical');
        expect(alerts[0].detail).toContain('for 30 minutes');
    });

    it('a sustained container and a sustained machine give two alerts', () => {
        const hostWarn = condition({
            key: 'host:boot:a',
            subject: 'boot:a',
            kind: 'host',
            level: 'warn',
            ratio: 0.93,
            where: 'box-a',
            availableBytes: 2 * GiB,
            totalBytes: 32 * GiB,
        });
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD], [hostWarn, OLD]), NOW);
        expect(alerts.map((a) => a.id).sort()).toEqual([
            'resource-pressure:container',
            'resource-pressure:host',
        ]);
    });

    it('names the worst container, counts the rest, and lists every subject in the fingerprint', () => {
        const webLoad = condition({
            key: 'container:web@boot:a',
            subject: 'web@boot:a',
            kind: 'container',
            level: 'warn',
            ratio: 0.88,
            role: 'web',
            where: 'box-a',
        });
        const workerLoad = condition({
            key: 'container:worker@boot:b',
            subject: 'worker@boot:b',
            kind: 'container',
            level: 'warn',
            ratio: 0.92,
            role: 'worker',
            where: 'box-b',
        });
        const [alert] = adaptResourcePressure(clocks([webLoad, OLD], [workerLoad, OLD]), NOW);
        expect(alert.title).toContain('Worker');
        expect(alert.detail).toContain('box-b');
        expect(alert.detail).toContain('92 %');
        expect(alert.detail).toContain('Also above the threshold: 1 more.');
        expect(alert.fingerprint).toBe('warn:web@boot:a,worker@boot:b');
    });

    it('a single subject carries no "more" note', () => {
        const [alert] = adaptResourcePressure(clocks([WEB_WARN, OLD]), NOW);
        expect(alert.detail).not.toContain('more are above');
    });

    it('a second subject joining changes the fingerprint, so a previous ack no longer holds', () => {
        const [one] = adaptResourcePressure(clocks([WEB_WARN, OLD]), NOW);
        const worker = condition({
            key: 'container:worker@boot:b',
            subject: 'worker@boot:b',
            kind: 'container',
            level: 'warn',
            ratio: 0.9,
            role: 'worker',
            where: 'box-b',
        });
        const [two] = adaptResourcePressure(clocks([WEB_WARN, OLD], [worker, OLD]), NOW);
        expect(two.fingerprint).not.toBe(one.fingerprint);
    });

    it('a restart with a new instance id keeps the clock and the same fingerprint', () => {
        const [before] = adaptResourcePressure(
            clocks([resourcePressureConditions([web('old-1', 0.9)])[0], OLD]),
            NOW,
        );
        const afterCondition = resourcePressureConditions([web('new-2', 0.9)])[0];
        const [after] = adaptResourcePressure(clocks([afterCondition, OLD]), NOW);
        expect(after.id).toBe(before.id);
        expect(after.fingerprint).toBe(before.fingerprint);
    });

    it('a clock held over a short gap (no condition this cycle) still counts as sustained', () => {
        const gapped = new Map([
            [WEB_WARN.key, { first: OLD, last: NOW - 2 * 60_000, value: WEB_WARN }],
        ]);
        expect(adaptResourcePressure(gapped, NOW)).toHaveLength(1);
    });
});

function urow(
    over: Partial<UncleanExitRow> & Pick<UncleanExitRow, 'instanceId' | 'cnt'>,
): UncleanExitRow {
    return { role: 'worker', hostname: 'media-1', ...over };
}

describe('adaptUncleanExits', () => {
    it('drops an instance below the threshold', () => {
        expect(
            adaptUncleanExits([urow({ instanceId: 'inst-1', cnt: UNCLEAN_EXIT_THRESHOLD - 1 })]),
        ).toEqual([]);
    });

    it('keeps an instance at the threshold', () => {
        expect(
            adaptUncleanExits([urow({ instanceId: 'inst-1', cnt: UNCLEAN_EXIT_THRESHOLD })]),
        ).toHaveLength(1);
    });

    it('three unclean exits is a warning, keyed on the instance, naming the host', () => {
        const [alert] = adaptUncleanExits([urow({ instanceId: 'inst-1', cnt: 3 })]);
        expect(alert).toMatchObject({
            id: 'unclean-exits:inst-1',
            severity: 'warning',
            count: 3,
            type: 'degraded-component',
            domain: 'system',
            sourceRef: CLUSTER_HREF,
        });
        expect(alert.title).toContain('Worker');
        expect(alert.title).toContain('3 times');
        expect(alert.detail).toContain('media-1');
    });

    it('falls back to the instance id when the hostname is unknown', () => {
        const [alert] = adaptUncleanExits([urow({ instanceId: 'inst-9', cnt: 2, hostname: null })]);
        expect(alert.detail).toContain('inst-9');
        expect(alert.detail).not.toContain('null');
    });
});

describe('attention id prefixes', () => {
    it('both producers emit ids under a prefix registered in ATTENTION_SOURCE_PREFIXES', () => {
        expect(ATTENTION_SOURCE_PREFIXES).toContain('resource-pressure:');
        expect(ATTENTION_SOURCE_PREFIXES).toContain('unclean-exits:');

        const hostCritical = condition({
            key: 'host:boot:a:critical',
            subject: 'boot:a',
            kind: 'host',
            level: 'critical',
            ratio: 0.97,
            where: 'box-a',
        });
        const ids = [
            ...adaptResourcePressure(
                clocks([WEB_WARN, OLD], [WEB_CRIT, OLD], [hostCritical, OLD]),
                NOW,
            ),
            ...adaptUncleanExits([urow({ instanceId: 'inst-1', cnt: 2 })]),
        ].map((a) => a.id);

        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            expect(id.startsWith('resource-pressure:') || id.startsWith('unclean-exits:')).toBe(
                true,
            );
            expect(ATTENTION_SOURCE_PREFIXES.some((p) => id.startsWith(p))).toBe(true);
        }
    });
});

describe('container peak (24 h working set)', () => {
    /** A container at `used` GiB now, with a 24 h `peak` GiB (or none), on a 1 GiB limit. */
    function peakNode(
        instanceId: string,
        used: number,
        peak: number | undefined,
        role = 'web',
        host = BOX_A,
    ): PressureNode {
        return pnode({
            instanceId,
            role,
            host,
            resources: {
                memoryUsedBytes: used * GiB,
                memoryLimitBytes: GiB,
                memoryPressurePeakBytes: peak === undefined ? undefined : peak * GiB,
            },
        });
    }

    const webPeak = resourcePressureConditions([peakNode('web-1', 0.4, 0.96)])[0];

    it('a 96 % peak on a calm container gives one container-peak warn condition', () => {
        const conditions = resourcePressureConditions([peakNode('web-1', 0.4, 0.96)]);
        expect(conditions.map((c) => c.key)).toEqual(['container-peak:web@boot:a']);
        expect(conditions[0]).toMatchObject({
            kind: 'containerPeak',
            subject: 'web@boot:a',
            level: 'warn',
        });
        expect(conditions[0].ratio).toBeCloseTo(0.96);
        expect(conditions[0].peakBytes).toBeCloseTo(0.96 * GiB);
    });

    it('a 95 % peak is a condition and a 94.9 % peak is not', () => {
        expect(
            resourcePressureConditions([peakNode('web-1', 0.4, 0.95)]).map((c) => c.key),
        ).toEqual(['container-peak:web@boot:a']);
        expect(resourcePressureConditions([peakNode('web-1', 0.4, 0.949)])).toEqual([]);
    });

    it('a current 90 % with a 96 % peak gives both the container and the container-peak keys', () => {
        const keys = resourcePressureConditions([peakNode('web-1', 0.9, 0.96)])
            .map((c) => c.key)
            .sort();
        expect(keys).toEqual(['container-peak:web@boot:a', 'container:web@boot:a']);
    });

    it('no peak figure gives no peak condition', () => {
        const keys = resourcePressureConditions([peakNode('web-1', 0.96, undefined)])
            .map((c) => c.key)
            .sort();
        expect(keys).toEqual(['container:web@boot:a', 'container:web@boot:a:critical']);
    });

    it('a sustained peak alone is a warning, under its own id, naming the service and the peak', () => {
        const alerts = adaptResourcePressure(clocks([webPeak, OLD]), NOW);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            id: 'resource-pressure:container-peak',
            severity: 'warning',
            fingerprint: 'warn:web@boot:a',
            domain: 'system',
            sourceRef: CLUSTER_HREF,
        });
        expect(alerts[0].title).toContain('came close to its memory limit');
        expect(alerts[0].detail).toContain('in the last 24 hours');
        expect(alerts[0].detail).toContain('983 MiB');
        expect(alerts[0].detail).toContain('1.0 GiB');
        expect(alerts[0].detail).toContain('410 MiB');
    });

    it('a peak that has not been sustained yet raises nothing', () => {
        expect(adaptResourcePressure(clocks([webPeak, FRESH]), NOW)).toEqual([]);
    });

    it('a sustained container for the same subject suppresses its peak alert', () => {
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD], [webPeak, OLD]), NOW);
        expect(alerts.map((a) => a.id)).toEqual(['resource-pressure:container']);
    });

    it('suppression is per subject: another container still gets its own peak alert', () => {
        const workerPeak = resourcePressureConditions([
            peakNode('worker-1', 0.4, 0.96, 'worker', BOX_B),
        ])[0];
        const alerts = adaptResourcePressure(clocks([WEB_WARN, OLD], [workerPeak, OLD]), NOW);
        expect(alerts.map((a) => a.id).sort()).toEqual([
            'resource-pressure:container',
            'resource-pressure:container-peak',
        ]);
        const peakAlert = alerts.find((a) => a.id === 'resource-pressure:container-peak');
        expect(peakAlert?.fingerprint).toBe('warn:worker@boot:b');
        expect(peakAlert?.title).toContain('Worker');
    });

    it('a container pressed for 5 minutes suppresses its sustained 24 h peak', () => {
        const alerts = adaptResourcePressure(clocks([WEB_WARN, FRESH], [webPeak, OLD]), NOW);
        expect(alerts).toEqual([]);
    });
});
