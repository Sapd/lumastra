// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => async () => [{ id: '00000000-0000-4000-a000-000000000001' }],
}));
vi.mock('$lib/server/database/queries/media-segments.queries.js', () => ({
    getMediaTypeById: async () => 'movie',
    getSegmentsByMediaId: h.rows,
}));
vi.mock('$lib/server/database/queries/media-segment-candidates.queries.js', () => ({
    getCandidatesForMedia: async () => [],
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: {} }));
vi.mock('$lib/server/services/media-segment-override.service.js', () => ({
    applyManualSegmentOverride: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-segment-input.queries.js', () => ({
    getAnalyzerReadinessBatch: async () => [],
}));
import { def, SegmentsGetResponseSchema } from './segments.js';

it('returns optional file identity for admin segment entries, omitting NULL', async () => {
    const fileId = '00000000-0000-4000-a000-000000000002';
    h.rows.mockResolvedValue(
        [null, fileId].map((file_id, i) => ({
            id: String(i),
            media_id: 'item',
            file_id,
            type: i ? 'Outro' : 'Intro',
            start_time: i * 100,
            end_time: i * 100 + 10,
            source: 'plugin',
            fetched_at: new Date(0),
        })),
    );
    const response = await def.handlers.GET!(
        { params: { id: '00000000-0000-4000-a000-000000000001' } } as never,
        {} as never,
    );
    const body = SegmentsGetResponseSchema.parse(await response.json());
    expect(body.providers.plugin[0]).not.toHaveProperty('fileId');
    expect(body.providers.plugin[1].fileId).toBe(fileId);
    expect(
        SegmentsGetResponseSchema.safeParse({
            ...body,
            providers: { plugin: [{ ...body.providers.plugin[0], fileId: null }] },
        }).success,
    ).toBe(false);
});
