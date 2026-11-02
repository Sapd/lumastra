// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.fn();
const mockHistogram = vi.fn();
const mockSummary = vi.fn();
const mockCohorts = vi.fn();
const mockBacklogCount = vi.fn();
const mockBacklogLengths = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/media-segment-stats.queries.js', () => ({
    DEFAULT_SEGMENT_HISTOGRAM_BUCKET_SECONDS: 15,
    getSegmentDurationHistogramByMethod: (...args: unknown[]) => mockHistogram(...args),
    getSegmentDurationSummaryByMethod: (...args: unknown[]) => mockSummary(...args),
    getCandidateConfigCohorts: (...args: unknown[]) => mockCohorts(...args),
}));

vi.mock('$lib/server/database/queries/media-segment-repair.queries.js', () => ({
    countSuspectOutros: (...args: unknown[]) => mockBacklogCount(...args),
    getSuspectLengthHistogram: (...args: unknown[]) => mockBacklogLengths(...args),
}));

const { def } = await import('./stats.js');

function makeCtx(type: 'Outro' | 'Intro' = 'Outro'): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: {
            body: undefined,
            params: undefined,
            query: { type, bucketSeconds: 15, minLength: 90 },
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockHistogram.mockResolvedValue([]);
    mockSummary.mockResolvedValue([]);
    mockCohorts.mockResolvedValue([]);
    mockBacklogCount.mockResolvedValue(2);
    mockBacklogLengths.mockResolvedValue([{ lengthSeconds: 90, items: 2 }]);
});

describe('GET /api/admin/media-segments/stats', () => {
    it('maps repair-query lengthSeconds to the published bucketStart shape', async () => {
        const response = await def.handlers.GET!(null as never, makeCtx());
        const body = await response.json();

        expect(body.repairBacklog).toEqual({
            minLengthSeconds: 90,
            items: 2,
            lengths: [{ bucketStart: 90, items: 2 }],
        });
    });

    it('does not query the Outro-only repair backlog for another segment type', async () => {
        const response = await def.handlers.GET!(null as never, makeCtx('Intro'));
        const body = await response.json();

        expect(body.repairBacklog).toBeNull();
        expect(mockBacklogCount).not.toHaveBeenCalled();
        expect(mockBacklogLengths).not.toHaveBeenCalled();
    });
});
