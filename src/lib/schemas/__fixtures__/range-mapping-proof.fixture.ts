// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { RangeMappingProofSchema, type RangeMappingProof } from '../range-mapping-proof.js';

/** Invented, schema-validated observation shared by endpoint and mounted UI tests. */
export function rangeMappingProofFixture(): RangeMappingProof {
    const files = [
        {
            fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            path: '/test-media/Lantern Station S01E01E02.mkv',
        },
        {
            fileId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            path: '/test-media/Lantern Station S01E01.mkv',
        },
        {
            fileId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            path: '/test-media/Lantern Station S01E02.mkv',
        },
    ];
    return RangeMappingProofSchema.parse({
        version: 1,
        observedAt: '2026-10-25T12:34:56.000Z',
        participants: files.map(({ fileId, path }, index) => ({
            fileId,
            path,
            generation: 'a'.repeat(32),
            root: '/test-media',
            realRoot: '/test-media',
            realPath: path,
            regularFile: true,
            dev: '7',
            ino: String(index + 1),
            size: '100',
            mtimeMs: '1000',
            mtimeNs: '1000000000',
            ctimeNs: '1000000000',
        })),
    });
}
