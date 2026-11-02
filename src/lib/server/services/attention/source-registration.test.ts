// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { ATTENTION_SOURCE_PREFIXES } from './attention-service.js';
import {
    adaptLiveTvProxyCompat,
    adaptMusicHygiene,
    adaptStorageCapacity,
    adaptStorageForecast,
} from './adapters.js';
import { MUSIC_HYGIENE_FINDINGS, MUSIC_ATTENTION_FINDINGS } from '$lib/shared/music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';
import type { VolumeHeadroom } from '$lib/server/utils/artwork-volume-headroom.js';
import type { LibraryVolumeGrowth } from '$lib/schemas/admin-library-storage-growth.js';

function everyFinding(n: number): MusicHygieneCounts {
    const out = {} as MusicHygieneCounts;
    for (const finding of MUSIC_HYGIENE_FINDINGS) out[finding] = n;
    return out;
}

/**
 * The two things that make a source EXIST, neither of which any other test in
 * the subsystem touches.
 *
 * Every music-hygiene test upstream of this file exercises a piece: the SQL
 * predicates, the counts, the adapter, the reconcile ack semantics,
 * the deep links, the section map. Each of them passes with the `music-hygiene:`
 * entry DELETED from `SOURCES` — the feature goes completely dark, no alert is
 * ever derived, and the suite stays green, because nothing asserts the fan-out
 * actually calls the adapter.
 *
 * Mistyping the prefix is worse than deleting it. The registered prefix is what
 * `deriveAttention` pushes into `failedPrefixes` when a source throws. A
 * prefix that does not match the ids the adapter emits protects the wrong
 * namespace: a failed count then resolves the persisted alerts and the next
 * successful count re-creates them — a flap arriving with no error.
 */
describe('music-hygiene source registration', () => {
    /**
     * Revert-check: delete the `music-hygiene:` entry from `SOURCES` in
     * `attention-service.ts` and this fails. Every other music-hygiene test in
     * the repo still passes.
     */
    it('is registered as a signal source', () => {
        expect(ATTENTION_SOURCE_PREFIXES).toContain('music-hygiene:');
    });

    /**
     * Revert-check (CROSS-WIRE, not delete): change the registered prefix to
     * `music-hygeine:` (or change the adapter's id template) and this fails,
     * naming the id that escaped the namespace. Deleting the entry fails the
     * test above instead, so the pair distinguishes "absent" from "mistyped".
     */
    it('emits only ids inside its own registered namespace', () => {
        const prefix = ATTENTION_SOURCE_PREFIXES.find((p) => p.startsWith('music-hygiene'));
        expect(prefix).toBe('music-hygiene:');

        const alerts = adaptMusicHygiene(everyFinding(7));
        // All four findings, so no branch of the adapter goes unexamined.
        expect(alerts).toHaveLength(MUSIC_ATTENTION_FINDINGS.length);

        for (const alert of alerts) {
            expect(alert.id.startsWith(prefix!), `${alert.id} escapes ${prefix}`).toBe(true);
        }
    });

    /**
     * A prefix that is a strict prefix of another source's would let one
     * source's failure protect — or one source's success false-resolve —
     * another's alerts. `degraded-component:` / `degraded-component:disk:` is
     * the one deliberate exception, documented in `SOURCES` itself: the disk
     * source narrows to its own sub-namespace ON PURPOSE.
     */
    it('keeps music-hygiene from overlapping any other source namespace', () => {
        for (const other of ATTENTION_SOURCE_PREFIXES) {
            if (other === 'music-hygiene:') continue;
            expect(other.startsWith('music-hygiene:'), other).toBe(false);
            expect('music-hygiene:'.startsWith(other), other).toBe(false);
        }
    });
});

describe('livetv-proxy-compat source registration', () => {
    it('is registered, and its alert id is inside the registered prefix', () => {
        const prefix = ATTENTION_SOURCE_PREFIXES.find((p) => p.startsWith('livetv-proxy'));
        expect(prefix).toBe('livetv-proxy-compat');
        const [alert] = adaptLiveTvProxyCompat(
            [{ role: 'proxy', version: 'v1' }],
            { protocol: 2, minProtocol: 2, build: undefined },
            'v2',
        );
        expect(alert.id.startsWith(prefix!)).toBe(true);
    });
});

/** Storage failure prefixes must protect the ids their adapters actually emit. */
describe('storage source registration', () => {
    it('registers exactly the capacity and forecast prefixes without trailing colons', () => {
        // `storage:` (the liveness bridge's domain namespace) is a separate producer.
        expect(
            ATTENTION_SOURCE_PREFIXES.filter(
                (prefix) => prefix.startsWith('storage:') && prefix !== 'storage:',
            ).sort(),
        ).toEqual(['storage:capacity', 'storage:forecast']);
    });

    it('emits capacity and forecast ids inside their respective registered namespaces', () => {
        const capacityPrefix = ATTENTION_SOURCE_PREFIXES.find((prefix) =>
            prefix.startsWith('storage:capacity'),
        );
        const forecastPrefix = ATTENTION_SOURCE_PREFIXES.find((prefix) =>
            prefix.startsWith('storage:forecast'),
        );
        expect(capacityPrefix).toBe('storage:capacity');
        expect(forecastPrefix).toBe('storage:forecast');

        const lowVolume: VolumeHeadroom = {
            label: 'library',
            path: '/media/movies',
            freeBytes: 1024 ** 3,
            totalBytes: 1024 ** 4,
            belowMargin: true,
        };
        const fillingVolume: LibraryVolumeGrowth = {
            id: '7',
            libraries: ['Movies'],
            freeBytes: 200 * 1024 ** 3,
            totalBytes: 1024 ** 4,
            measuredOn: '2026-10-21',
            estimate: {
                state: 'filling',
                daysUntilFull: 20,
                daysUntilFullLow: 18,
                daysUntilFullHigh: 22,
                bytesPerDay: 10 * 1024 ** 3,
                confidence: 'high',
            },
        };
        const capacity = adaptStorageCapacity([lowVolume]);
        const forecast = adaptStorageForecast([fillingVolume]);

        expect(capacity).toHaveLength(1);
        expect(forecast).toHaveLength(1);
        for (const alert of capacity) expect(alert.id.startsWith(capacityPrefix!)).toBe(true);
        for (const alert of forecast) expect(alert.id.startsWith(forecastPrefix!)).toBe(true);
    });
});
