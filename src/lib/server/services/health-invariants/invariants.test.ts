// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

vi.mock('./metadata-storage-writability.js', () => ({
    checkMetadataStorageWritability: vi.fn(),
}));

import {
    checkMetadataStorageWritability,
    type MetadataStorageWritabilityResult,
} from './metadata-storage-writability.js';
import { INVARIANTS } from './invariants.js';

const fakeSql = {} as postgres.Sql;

function findInvariant(id: string) {
    const invariant = INVARIANTS.find((i) => i.id === id);
    if (!invariant) throw new Error(`invariant not registered: ${id}`);
    return invariant;
}

/** Mirrors classifyStatus() in health-invariants.ts (not exported) so this
 * test verifies the invariant's threshold contract end-to-end. */
function classify(value: number, thresholdAmber: number, thresholdRed: number): string {
    if (value > thresholdRed) return 'red';
    if (value > thresholdAmber) return 'amber';
    return 'green';
}

describe("invariant 'metadata-storage-writability'", () => {
    const invariant = findInvariant('metadata-storage-writability');

    /** Defaults to a healthy central root so each case states only what it varies. */
    function probeResult(
        over: Partial<MetadataStorageWritabilityResult> & {
            mode: MetadataStorageWritabilityResult['mode'];
        },
    ): MetadataStorageWritabilityResult {
        return {
            readOnlyRoots: [],
            unknownRoots: [],
            centralDir: '/data',
            centralWritable: 'writable',
            ...over,
        };
    }

    const statusFor = async (
        over: Partial<MetadataStorageWritabilityResult> & {
            mode: MetadataStorageWritabilityResult['mode'];
        },
    ): Promise<string> => {
        vi.mocked(checkMetadataStorageWritability).mockResolvedValue(probeResult(over));
        const value = await invariant.query(fakeSql);
        return classify(value, invariant.thresholdAmber, invariant.thresholdRed);
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("is green when METADATA_STORAGE_LOCATION is 'central'", async () => {
        expect(await statusFor({ mode: 'central' })).toBe('green');
    });

    it("is green when 'alongside' has no read-only roots", async () => {
        expect(await statusFor({ mode: 'alongside' })).toBe('green');
    });

    it("is RED when 'alongside' has a read-only root", async () => {
        expect(await statusFor({ mode: 'alongside', readOnlyRoots: ['/mnt/movies'] })).toBe('red');
    });

    it("is AMBER (not red) when 'alongside-prefer' has read-only roots", async () => {
        expect(
            await statusFor({
                mode: 'alongside-prefer',
                readOnlyRoots: ['/mnt/movies', '/mnt/series', '/mnt/music'],
            }),
        ).toBe('amber');
    });

    it('is green when unknownRoots is non-empty but readOnlyRoots is empty (never counts unknown as a failure)', async () => {
        expect(await statusFor({ mode: 'alongside', unknownRoots: ['/mnt/hung-nfs'] })).toBe(
            'green',
        );
    });

    // Central-root coverage. Prod 2026-07-30 sat green here for two days with an
    // unwritable central root, because only library roots were ever probed.
    it("is RED when 'central' mode has an unwritable central root (nothing can be written at all)", async () => {
        expect(await statusFor({ mode: 'central', centralWritable: 'readonly' })).toBe('red');
    });

    it("is AMBER when 'alongside' has a healthy library root but an unwritable central root", async () => {
        expect(await statusFor({ mode: 'alongside', centralWritable: 'readonly' })).toBe('amber');
    });

    it("is AMBER when 'alongside-prefer' has an unwritable central root", async () => {
        expect(await statusFor({ mode: 'alongside-prefer', centralWritable: 'readonly' })).toBe(
            'amber',
        );
    });

    // 'alongside-prefer' survives a read-only library root ONLY because it falls back
    // to central. With central ALSO broken the fallback is gone and those writes fail
    // outright — the same failure as strict 'alongside', so the same severity.
    it("is RED when 'alongside-prefer' has a read-only root AND an unwritable central fallback", async () => {
        expect(
            await statusFor({
                mode: 'alongside-prefer',
                readOnlyRoots: ['/mnt/movies'],
                centralWritable: 'readonly',
            }),
        ).toBe('red');
    });

    it("stays RED for strict 'alongside' when both the root and central are broken", async () => {
        expect(
            await statusFor({
                mode: 'alongside',
                readOnlyRoots: ['/mnt/movies'],
                centralWritable: 'readonly',
            }),
        ).toBe('red');
    });

    it('never counts an unknown (hung) central root as a failure', async () => {
        expect(await statusFor({ mode: 'central', centralWritable: 'unknown' })).toBe('green');
    });

    it('has a stable id, non-empty label/description/remediation', () => {
        expect(invariant.id).toBe('metadata-storage-writability');
        expect(invariant.label.length).toBeGreaterThan(0);
        expect(invariant.description.length).toBeGreaterThan(0);
        expect(invariant.remediation.length).toBeGreaterThan(0);
    });
});

describe("invariant 'transcode-failures-24h'", () => {
    it('registers transcode-failures-24h with kebab-case id and sane thresholds', () => {
        const inv = INVARIANTS.find((i) => i.id === 'transcode-failures-24h');
        expect(inv).toBeDefined();
        expect(inv!.thresholdAmber).toBeLessThan(inv!.thresholdRed);
        expect(inv!.remediation).toContain('/admin/system/transcode-failures');
    });
});
