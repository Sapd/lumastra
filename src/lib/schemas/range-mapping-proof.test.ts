// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { MediaFilesResponseSchema } from './api-media-responses.js';
import { FileHealthRecheckResultSchema } from './file-health-recheck.js';
import { RangeMappingProofSchema } from './range-mapping-proof.js';

it('public file projections and generic run results strip private mapping observations', () => {
    const proof = { version: 1, participants: [{ path: '/private/covering-proof.mkv' }] };
    const files = MediaFilesResponseSchema.parse({
        files: [
            {
                id: 'file',
                file_path: '/fixture.mkv',
                edition: null,
                part_number: null,
                library_group_id: null,
                created_at: '',
                media_item_id: 'item',
                file_size_bytes: null,
                duration_seconds: null,
                container_format: null,
                file_mtime: null,
                file_hash_head: null,
                probed_at: null,
                health_issues: [],
                is_default: true,
                file_sort_order: 0,
                file_label: null,
                rangeMapping: proof,
            },
        ],
    });
    expect(JSON.stringify(files)).not.toContain('covering-proof');
    const result = FileHealthRecheckResultSchema.parse({
        fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        outcome: 'warning',
        issues: [{ type: 'range_superseded' }],
        reason: 'warnings_remain',
        rangeMapping: proof,
    });
    expect(JSON.stringify(result)).not.toContain('covering-proof');
});
it('an empty, oversized or unsupported proof cannot become typed admin evidence', () => {
    expect(
        RangeMappingProofSchema.safeParse({
            version: 1,
            observedAt: new Date().toISOString(),
            participants: [],
        }).success,
    ).toBe(false);
    expect(RangeMappingProofSchema.safeParse({ version: 2, participants: [] }).success).toBe(false);
    expect(
        RangeMappingProofSchema.safeParse({
            version: 1,
            observedAt: 'bad',
            participants: Array(500).fill({}),
        }).success,
    ).toBe(false);
});
