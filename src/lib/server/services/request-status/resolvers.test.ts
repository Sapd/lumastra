// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests: request status resolves from the Sonarr/Radarr queue.
 *
 * The queue is the only live-progress source (percentage, time left, size,
 * importing). These pin that a queued title reports progress without any
 * download-client integration behind it.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
    SonarrQueueResponse,
    RadarrQueueResponse,
    SonarrQueueRecord,
    RadarrQueueRecord,
} from '$lib/server/sonarr';

vi.mock('./database.js', () => ({
    checkLocalAvailability: vi.fn().mockResolvedValue(null),
    checkSeasonAvailability: vi.fn().mockResolvedValue(null),
    checkIfWatched: vi.fn().mockResolvedValue(false),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/server/sonarr.js', () => ({
    radarrClient: { getMovieByTmdbId: vi.fn().mockResolvedValue(null) },
    sonarrClient: { getSeriesByTvdbId: vi.fn().mockResolvedValue(null) },
}));

const { determineMovieStatus, determineSeasonStatus, determineTvAggregateStatus } =
    await import('./resolvers.js');

function queue<T>(records: Partial<T>[]): {
    page: number;
    pageSize: number;
    sortKey: string;
    sortDirection: 'ascending';
    totalRecords: number;
    records: T[];
} {
    return {
        page: 1,
        pageSize: 100,
        sortKey: 'progress',
        sortDirection: 'ascending',
        totalRecords: records.length,
        records: records as T[],
    };
}

const access = { deniedGroupIds: null, ageRating: null };

describe('request status from the Sonarr/Radarr queue', () => {
    it('movie in the Radarr queue resolves to downloading with progress', async () => {
        const radarrQueue = queue<RadarrQueueRecord>([
            {
                movie: { tmdbId: 550 } as RadarrQueueRecord['movie'],
                size: 1000,
                sizeleft: 250,
                status: 'downloading',
                timeleft: '00:10:00',
            },
        ]) as RadarrQueueResponse;

        const result = await determineMovieStatus(
            { tmdb: '550' },
            radarrQueue,
            0,
            undefined,
            access,
        );

        expect(result.status).toBe('downloading');
        expect(result.download?.percentage).toBe(75);
        expect(result.download?.timeLeft).toBe('00:10:00');
        expect(result.download).not.toHaveProperty('speed');
    });

    it('season in the Sonarr queue resolves to downloading', async () => {
        const sonarrQueue = queue<SonarrQueueRecord>([
            {
                series: { tvdbId: 42 } as SonarrQueueRecord['series'],
                episode: { seasonNumber: 1 } as SonarrQueueRecord['episode'],
                size: 1000,
                sizeleft: 500,
                status: 'downloading',
            },
        ]) as SonarrQueueResponse;

        const result = await determineSeasonStatus({ tmdb: '1' }, 1, 42, sonarrQueue, null, 0);

        expect(result.status).toBe('downloading');
        expect(result.seasonNumber).toBe(1);
        expect(result.download?.percentage).toBe(50);
    });

    it('series aggregate in the Sonarr queue resolves to queued', () => {
        const sonarrQueue = queue<SonarrQueueRecord>([
            {
                series: { tvdbId: 42 } as SonarrQueueRecord['series'],
                episode: { seasonNumber: 2 } as SonarrQueueRecord['episode'],
                size: 1000,
                sizeleft: 1000,
                status: 'queued',
            },
        ]) as SonarrQueueResponse;

        const result = determineTvAggregateStatus(undefined, sonarrQueue, 42, 0);

        expect(result.status).toBe('queued');
        expect(result.download?.percentage).toBe(0);
    });

    it('nothing queued and no Seerr state falls back without a queue entry', () => {
        const result = determineTvAggregateStatus(undefined, queue<SonarrQueueRecord>([]), 42, 0);
        expect(result.status).toBe('pending');
        expect(result.download).toBeUndefined();
    });
});

describe('season completion', () => {
    it('reports a season as available when every aired episode is present', async () => {
        const { checkSeasonAvailability } = await import('./database.js');
        vi.mocked(checkSeasonAvailability).mockResolvedValueOnce({
            isAvailable: false,
            isCaughtUp: true,
        });
        const result = await determineSeasonStatus(
            { tmdb: '1' },
            1,
            42,
            queue<SonarrQueueRecord>([]),
            null,
        );
        expect(result.status).toBe('available');
        vi.mocked(checkSeasonAvailability).mockReset();
    });

    it('keeps downloading when an earlier episode is already available locally', async () => {
        const { checkSeasonAvailability } = await import('./database.js');
        vi.mocked(checkSeasonAvailability).mockResolvedValueOnce({
            isAvailable: true,
            isCaughtUp: false,
        });
        const result = await determineSeasonStatus(
            { tmdb: '1' },
            1,
            42,
            queue<SonarrQueueRecord>([
                {
                    series: { tvdbId: 42 } as SonarrQueueRecord['series'],
                    episode: { seasonNumber: 1 } as SonarrQueueRecord['episode'],
                    size: 1000,
                    sizeleft: 500,
                    status: 'downloading',
                },
            ]),
            null,
        );
        expect(result.status).toBe('downloading');
        expect(result.download?.percentage).toBe(50);
        vi.mocked(checkSeasonAvailability).mockReset();
    });

    it('does not label a partial season complete or importing when its queue is empty', async () => {
        const { checkSeasonAvailability } = await import('./database.js');
        vi.mocked(checkSeasonAvailability).mockResolvedValueOnce({
            isAvailable: true,
            isCaughtUp: false,
        });
        const result = await determineSeasonStatus(
            { tmdb: '1' },
            1,
            42,
            queue<SonarrQueueRecord>([]),
            [
                {
                    seasonNumber: 1,
                    status: 4,
                    isAvailable: false,
                    isRequested: true,
                    requestStatus: 'processing',
                },
            ],
        );
        expect(result.status).toBe('monitored');
    });
});
