// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { ActiveSessionView } from './session-read-model.service.js';
import type { UserId } from '$lib/shared/user-id.js';
import { toUserId } from '$lib/shared/user-id.js';

const {
    getActiveSessionsForUser,
    getNextUpForSeries,
    findNextSequentialEpisode,
    findEpisodeForNextUp,
} = vi.hoisted(() => ({
    getActiveSessionsForUser: vi.fn(),
    getNextUpForSeries: vi.fn(),
    findNextSequentialEpisode: vi.fn(),
    findEpisodeForNextUp: vi.fn(),
}));

vi.mock('$lib/server/services/session-read-model.service.js', () => ({
    getSessionReadModel: () => ({ getActiveSessionsForUser }),
}));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: { getNextUpForSeries },
}));
vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    findNextSequentialEpisode,
    findEpisodeForNextUp,
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/services/effective-series-marker.service.js', () => ({
    isCallerSession: () => false,
}));

const { effectiveNextUpForSeries } = await import('./effective-next-up.service.js');

const USER_ID = toUserId('11111111-1111-4111-8111-111111111111');
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const SQL = {} as postgres.Sql;

function session(hasFiles: boolean): ActiveSessionView {
    const now = new Date();
    return {
        sessionId: 'live-e2',
        source: 'lumastra',
        sourceSessionId: null,
        userId: USER_ID as UserId,
        username: 'alice',
        displayName: null,
        mediaId: 'episode-e2',
        hasFiles,
        seriesId: SERIES_ID,
        mediaType: 'episode',
        positionMs: 2_400_000,
        runtimeMs: 2_600_000,
        status: 'ACTIVE',
        isPlaying: true,
        startedAt: now,
        lastHeartbeatAt: now,
        lastSeenAt: now,
        heartbeatAgeMs: 1_000,
        isFresh: true,
        isBuffering: false,
    };
}

const durableE3 = {
    media_id: 'episode-e3',
    title: 'Playable E3',
    season_number: 1,
    episode_number: 3,
    overview: null,
    runtime_seconds: 2_600,
    premiere_date: null,
};

describe('effectiveNextUpForSeries availability', () => {
    beforeEach(() => {
        getActiveSessionsForUser.mockReset();
        getNextUpForSeries.mockReset().mockResolvedValue(durableE3);
        findNextSequentialEpisode.mockReset();
        findEpisodeForNextUp.mockReset();
    });

    it('does not let a file-less live session replace durable playable E3', async () => {
        getActiveSessionsForUser.mockResolvedValue([session(false)]);

        const result = await effectiveNextUpForSeries({
            userId: USER_ID,
            seriesId: SERIES_ID,
            sql: SQL,
        });

        expect(result.source).toBe('durable');
        expect(result.episode?.media_id).toBe('episode-e3');
        expect(findNextSequentialEpisode).not.toHaveBeenCalled();
    });

    it('rejects a metadata-only sequential E2 and keeps durable playable E3', async () => {
        getActiveSessionsForUser.mockResolvedValue([session(true)]);
        findNextSequentialEpisode.mockResolvedValue({
            id: 'metadata-only-e2',
            title: 'Metadata E2',
            season_number: 1,
            episode_number: 2,
            is_new_season: false,
            has_primary_image: false,
            overview: null,
            has_files: false,
        });

        const result = await effectiveNextUpForSeries({
            userId: USER_ID,
            seriesId: SERIES_ID,
            sql: SQL,
        });

        expect(findNextSequentialEpisode).toHaveBeenCalledWith(SQL, SERIES_ID, 'episode-e2', {
            playableOnly: true,
        });
        expect(result.source).toBe('durable');
        expect(result.episode?.media_id).toBe('episode-e3');
    });
});
