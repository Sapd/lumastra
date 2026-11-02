// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for download progress extraction from Sonarr/Radarr queues
 */

import { describe, it, expect } from 'vitest';
import { getSeasonProgressFromSonarr, getMovieProgressFromRadarr } from './progress';
import type {
    SonarrQueueResponse,
    RadarrQueueResponse,
    SonarrQueueRecord,
    RadarrQueueRecord,
} from '$lib/server/sonarr';

// Helper to create partial SonarrQueueRecord for testing
// Only the fields actually used by getSeasonProgressFromSonarr are required
type TestSonarrRecord = Pick<SonarrQueueRecord, 'size' | 'sizeleft' | 'status'> & {
    series?: { tvdbId?: number };
    episode?: { seasonNumber: number };
    trackedDownloadState?: string;
    timeleft?: string;
};

// Helper to create partial RadarrQueueRecord for testing
type TestRadarrRecord = Pick<RadarrQueueRecord, 'size' | 'sizeleft' | 'status'> & {
    movie?: { tmdbId?: number };
    timeleft?: string;
};

describe('getSeasonProgressFromSonarr', () => {
    const createSonarrQueue = (records: TestSonarrRecord[]): SonarrQueueResponse => ({
        page: 1,
        pageSize: 100,
        sortKey: 'progress',
        sortDirection: 'ascending',
        totalRecords: records.length,
        records: records as SonarrQueueRecord[],
    });

    it('keeps downloading while another episode imports', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1000,
                sizeleft: 0,
                status: 'completed',
                trackedDownloadState: 'importPending',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1000,
                sizeleft: 500,
                status: 'downloading',
            },
        ]);
        expect(getSeasonProgressFromSonarr(123, 1, queue)).toMatchObject({
            state: 'downloading',
            percentage: 75,
        });
        queue.records[1].sizeleft = 0;
        expect(getSeasonProgressFromSonarr(123, 1, queue)?.state).toBe('importing');
    });

    it('does not treat an unsized queued episode as imported', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1000,
                sizeleft: 0,
                status: 'completed',
                trackedDownloadState: 'importPending',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 0,
                sizeleft: 0,
                status: 'queued',
            },
        ]);
        expect(getSeasonProgressFromSonarr(123, 1, queue)?.state).not.toBe('importing');
    });

    it('returns null when no episodes match', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1000000000,
                sizeleft: 500000000,
                status: 'downloading',
            },
        ]);

        expect(getSeasonProgressFromSonarr(999, 1, queue)).toBeNull();
        expect(getSeasonProgressFromSonarr(123, 2, queue)).toBeNull();
    });

    it('calculates progress for single episode', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824, // 1 GB
                sizeleft: 536870912, // 0.5 GB
                status: 'downloading',
                timeleft: '00:30:00',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result).not.toBeNull();
        expect(result!.percentage).toBe(50);
        expect(result!.size).toBe('1.0 GB');
        // Unit scaling: 0.5 GB worth of bytes renders as MB, not "0.5 GB"
        expect(result!.sizeLeft).toBe('512 MB');
        expect(result!.timeLeft).toBe('00:30:00');
        expect(result!.state).toBe('downloading');
    });

    it('aggregates progress across multiple episodes', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824, // 1 GB
                sizeleft: 0, // Complete
                status: 'completed',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824, // 1 GB
                sizeleft: 1073741824, // Not started
                status: 'queued',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result).not.toBeNull();
        expect(result!.percentage).toBe(50); // 1 of 2 GB done
        expect(result!.size).toBe('2.0 GB');
        expect(result!.sizeLeft).toBe('1.0 GB');
    });

    it('detects paused state when any episode is paused', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 500000000,
                status: 'downloading',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 1073741824,
                status: 'paused',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result!.state).toBe('paused');
    });

    it('detects queued state when all episodes are queued', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 1073741824,
                status: 'queued',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 1073741824,
                status: 'queued',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result!.state).toBe('queued');
    });

    it('returns a zero-progress record (not null) for a freshly-grabbed, unsized item', () => {
        // size 0 means the download was grabbed but not yet sized — surface it
        // as 0% rather than hiding it (null is reserved for "no queue record").
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 0,
                sizeleft: 0,
                status: 'downloading',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result).not.toBeNull();
        expect(result!.percentage).toBe(0);
        // sizeleft === size (0 === 0) → treated as queued/waiting
        expect(result!.state).toBe('queued');
    });

    it('gets timeLeft from first downloading episode', () => {
        const queue = createSonarrQueue([
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 1073741824,
                status: 'queued',
                timeleft: '00:00:00',
            },
            {
                series: { tvdbId: 123 },
                episode: { seasonNumber: 1 },
                size: 1073741824,
                sizeleft: 500000000,
                status: 'downloading',
                timeleft: '00:15:00',
            },
        ]);

        const result = getSeasonProgressFromSonarr(123, 1, queue);
        expect(result!.timeLeft).toBe('00:15:00');
    });
});

describe('getMovieProgressFromRadarr', () => {
    const createRadarrQueue = (records: TestRadarrRecord[]): RadarrQueueResponse => ({
        page: 1,
        pageSize: 100,
        sortKey: 'progress',
        sortDirection: 'ascending',
        totalRecords: records.length,
        records: records as RadarrQueueRecord[],
    });

    it('returns null when movie not in queue', () => {
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 1073741824,
                sizeleft: 500000000,
                status: 'downloading',
            },
        ]);

        expect(getMovieProgressFromRadarr(999, queue)).toBeNull();
    });

    it('calculates progress correctly', () => {
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 4294967296, // 4 GB
                sizeleft: 1073741824, // 1 GB
                status: 'downloading',
                timeleft: '00:30:00',
            },
        ]);

        const result = getMovieProgressFromRadarr(123, queue);
        expect(result).not.toBeNull();
        expect(result!.percentage).toBe(75);
        expect(result!.size).toBe('4.0 GB');
        expect(result!.sizeLeft).toBe('1.0 GB');
        expect(result!.timeLeft).toBe('00:30:00');
        expect(result!.state).toBe('downloading');
    });

    it('detects paused state', () => {
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 4294967296,
                sizeleft: 2147483648,
                status: 'paused',
                timeleft: '01:00:00',
            },
        ]);

        const result = getMovieProgressFromRadarr(123, queue);
        expect(result!.state).toBe('paused');
    });

    it('detects queued state', () => {
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 4294967296,
                sizeleft: 4294967296, // Not started
                status: 'queued',
            },
        ]);

        const result = getMovieProgressFromRadarr(123, queue);
        expect(result!.state).toBe('queued');
    });

    it('returns a zero-progress record (not null) for a freshly-grabbed, unsized item', () => {
        // size 0 = grabbed but not yet sized — surface as 0% (null is reserved
        // for "movie not in queue").
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 0,
                sizeleft: 0,
                status: 'downloading',
            },
        ]);

        const result = getMovieProgressFromRadarr(123, queue);
        expect(result).not.toBeNull();
        expect(result!.percentage).toBe(0);
        // sizeleft === size (0 === 0) → treated as queued/waiting
        expect(result!.state).toBe('queued');
    });

    it('excludes timeLeft when 00:00:00', () => {
        const queue = createRadarrQueue([
            {
                movie: { tmdbId: 123 },
                size: 4294967296,
                sizeleft: 1073741824,
                status: 'downloading',
                timeleft: '00:00:00',
            },
        ]);

        const result = getMovieProgressFromRadarr(123, queue);
        expect(result!.timeLeft).toBeUndefined();
    });
});
