// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    findPlaybackDurationMs: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('track'),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: {
        reportPlayEnd: vi
            .fn()
            .mockRejectedValue(
                Object.assign(new Error('foreign key violation'), { code: '23503' }),
            ),
    },
}));
import { processReplayBatch } from '$lib/server/services/music/play-end-batch.service.js';
describe('replay missing tracks', () => {
    it('turns a missing-track FK violation into a permanent not_found outcome', async () => {
        const { results } = await processReplayBatch(
            {} as postgres.Sql,
            { userId: 'u' } as UserContext,
            [
                {
                    eventId: '11111111-2222-4333-a444-555555555555',
                    kind: 'music',
                    mediaId: '21111111-2222-4333-a444-555555555555',
                    startedAt: new Date().toISOString(),
                    positionMs: 1000,
                    listenedMs: 1000,
                    endReason: 'user',
                },
            ],
        );
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'not_found',
            retryable: false,
        });
    });
});
