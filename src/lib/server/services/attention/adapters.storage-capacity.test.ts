// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage capacity producer (design §4.4's first missing producer).
 *
 * The measurement already existed — `checkArtworkDiskHeadroom` statfs's every
 * target volume — but only gated artwork writes, so a filling disk surfaced as
 * artwork quietly stopping with no alert. The two properties that matter are
 * that it fires on a genuinely low volume, and that it does NOT fire on a
 * volume it could not measure: statfs fails on an NFS flap or an unmounted
 * path, and manufacturing a critical "disk full" from a read error would train
 * operators to ignore the one alert that means their server is about to stop.
 */

import { describe, it, expect } from 'vitest';
import { adaptStorageCapacity } from './adapters.js';
import type { VolumeHeadroom } from '$lib/server/utils/artwork-volume-headroom.js';

const GIB = 1024 ** 3;

function vol(over: Partial<VolumeHeadroom> = {}): VolumeHeadroom {
    return {
        label: 'central',
        path: '/config/metadata',
        freeBytes: 50 * GIB,
        totalBytes: 500 * GIB,
        belowMargin: false,
        ...over,
    };
}

describe('adaptStorageCapacity', () => {
    it('stays silent when every volume has room', () => {
        expect(adaptStorageCapacity([vol(), vol({ label: 'library' })])).toEqual([]);
    });

    it('raises a critical alert for a volume under its margin', () => {
        const [alert] = adaptStorageCapacity([
            vol({ label: 'library', path: '/data/movies', freeBytes: 2 * GIB, belowMargin: true }),
        ]);
        expect(alert.severity).toBe('critical');
        expect(alert.title).toContain('library');
        expect(alert.detail).toContain('/data/movies');
    });

    it('states its own domain instead of borrowing an enum member', () => {
        // `type` must stay a known member — AttentionType is closed on the wire
        // and an unknown value breaks decode in an older Swift client.
        const [alert] = adaptStorageCapacity([vol({ freeBytes: 1 * GIB, belowMargin: true })]);
        expect(alert.domain).toBe('storage');
        expect(alert.type).toBe('degraded-component');
    });

    it('FAILS OPEN — an unmeasurable volume is not reported as full', () => {
        // statfs threw (unmounted / NFS flap / permission): freeBytes is null.
        // belowMargin is false in that case, and this asserts the adapter does
        // not second-guess it.
        expect(
            adaptStorageCapacity([vol({ freeBytes: null, totalBytes: null, belowMargin: false })]),
        ).toEqual([]);
    });

    it('ignores a null-free volume even if something marked it below margin', () => {
        // Defence in depth: freeBytes null can never be evidence of fullness,
        // whatever the flag says.
        expect(
            adaptStorageCapacity([vol({ freeBytes: null, totalBytes: null, belowMargin: true })]),
        ).toEqual([]);
    });

    it('names the WORST volume, because the fix is per-path', () => {
        // An aggregate "2 volumes low" is the wrong summary when the operator
        // has to go and free space on one specific mount.
        const [alert] = adaptStorageCapacity([
            vol({ label: 'central', path: '/config', freeBytes: 4 * GIB, belowMargin: true }),
            vol({ label: 'library', path: '/data', freeBytes: 1 * GIB, belowMargin: true }),
        ]);
        expect(alert.detail).toContain('/data');
        expect(alert.title).toContain('media library');
    });

    it('keeps ONE stable id even when the worst volume changes', () => {
        // Keying the id on the worst volume meant that with two volumes low,
        // whichever was worse owned the id — and when they swapped, the old id
        // vanished from the derivation, reconcile resolved it, a new id
        // appeared, `first_seen` reset and the operator's ack was lost, all
        // while the underlying problem never changed.
        const [a] = adaptStorageCapacity([
            vol({ label: 'central', path: '/config', freeBytes: 1 * GIB, belowMargin: true }),
            vol({ label: 'library', path: '/data', freeBytes: 4 * GIB, belowMargin: true }),
        ]);
        const [b] = adaptStorageCapacity([
            vol({ label: 'central', path: '/config', freeBytes: 4 * GIB, belowMargin: true }),
            vol({ label: 'library', path: '/data', freeBytes: 1 * GIB, belowMargin: true }),
        ]);
        expect(a.id).toBe(b.id);
        expect(a.id).toBe('storage:capacity');
    });

    it('never puts a raw internal volume token on screen', () => {
        // `label` is the literal 'central' / 'library' from the headroom
        // module; interpolating it produced "Der Datenträger central ist fast
        // voll" — an untranslated internal token in an alert title.
        const [alert] = adaptStorageCapacity([
            vol({ label: 'central', freeBytes: 1 * GIB, belowMargin: true }),
        ]);
        expect(alert.title).not.toContain('central');
        expect(alert.title).toContain('Lumastra data');
    });

    it('buckets the fingerprint by whole GB so it does not re-fire on drift', () => {
        const a = adaptStorageCapacity([
            vol({ freeBytes: Math.round(2.1 * GIB), belowMargin: true }),
        ]);
        const b = adaptStorageCapacity([
            vol({ freeBytes: Math.round(2.9 * GIB), belowMargin: true }),
        ]);
        expect(a[0].fingerprint).toBe(b[0].fingerprint);

        const c = adaptStorageCapacity([
            vol({ freeBytes: Math.round(3.4 * GIB), belowMargin: true }),
        ]);
        expect(c[0].fingerprint).not.toBe(a[0].fingerprint);
    });
});
