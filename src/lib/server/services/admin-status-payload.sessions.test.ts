// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Home's sessions block: the glance fields (struggling / transcoding /
 * bandwidth / speed) and the idle "last watched" line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAllActive = vi.fn();
const getAllActiveSessionsWithMedia = vi.fn();
const getLastEndedSession = vi.fn();
const getAggregatedSessionBandwidthMap = vi.fn();
const getAllActiveJobsInfoMultiPod = vi.fn();

vi.mock('$lib/server/services/session-read-model.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getSessionReadModel: () => ({ getAllActive }),
}));
vi.mock('$lib/server/database/connection.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAdminDb: () => ({}) as never,
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAllActiveSessionsWithMedia,
    getLastEndedSession,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    bandwidthTracker: { getAggregatedSessionBandwidthMap },
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getFFmpegTranscodeService: () => ({ getAllActiveJobsInfoMultiPod }),
}));

const { getSessionsBlock } = await import('./admin-status-payload.service');

function live(id: string, o: Record<string, unknown> = {}) {
    return {
        sessionId: id,
        username: id,
        title: 'Title ' + id,
        mediaId: 'media-' + id,
        seriesId: null,
        isPlaying: true,
        positionMs: 85_000,
        runtimeMs: 1_000_000,
        playMethod: 'direct',
        source: 'lumastra',
        ...o,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    getAggregatedSessionBandwidthMap.mockResolvedValue(
        new Map([
            ['slow', 6.2],
            ['fine', 1.4],
        ]),
    );
    getAllActiveSessionsWithMedia.mockResolvedValue([
        { id: 'slow', plan_mode: 'full_transcode', buffer_health_sec: 20 },
        { id: 'fine', plan_mode: 'direct', buffer_health_sec: 60 },
    ]);
    getAllActiveJobsInfoMultiPod.mockResolvedValue([
        {
            playSessionId: 'slow',
            processRunning: true,
            startedAt: '2026-01-01T00:00:00Z',
            // 6 s segments: (10 + 5) x 6 = 90 s encoded, playhead at 85 s → 5 s ahead.
            segmentOffset: 10,
            segmentsReady: 5,
            elapsedSeconds: 60,
            progressPercent: 40,
            lastProgressSecondsAgo: 1,
            status: 'running',
        },
    ]);
});

describe('getSessionsBlock', () => {
    it('marks a transcode that is about to run out of output as struggling, with totals', async () => {
        getAllActive.mockResolvedValue([
            live('slow', { playMethod: 'transcode', seriesId: 'series-1' }),
            live('fine', { isPlaying: false }),
        ]);
        const block = await getSessionsBlock();
        const slow = block.preview.find((r) => r.sessionId === 'slow');
        const fine = block.preview.find((r) => r.sessionId === 'fine');
        expect(slow).toMatchObject({
            struggling: true,
            transcoding: true,
            bandwidthMbps: 6.2,
            posterMediaId: 'series-1',
        });
        expect(slow?.encodeSpeed).toBeCloseTo(0.5);
        expect(fine).toMatchObject({
            struggling: false,
            isPaused: true,
            posterMediaId: 'media-fine',
        });
        expect(block.load).toEqual({ transcoding: 1, struggling: 1, bandwidthMbps: 7.6 });
        expect(getLastEndedSession).not.toHaveBeenCalled();
    });

    it('counts an unmeasured direct play at its declared bitrate, a paused one at zero', async () => {
        // Jellyfin direct play: the app never proxies the bytes, so the tracker
        // has nothing — the tile said "0.0 Mbps out" beside an 11.2 Mbps row.
        getAggregatedSessionBandwidthMap.mockResolvedValue(new Map());
        getAllActiveSessionsWithMedia.mockResolvedValue([]);
        getAllActiveJobsInfoMultiPod.mockResolvedValue([]);
        getAllActive.mockResolvedValue([
            live('leon', { source: 'jellyfin', bitrateKbps: 11_200 }),
            live('paused', { isPlaying: false, bitrateKbps: 8_000 }),
        ]);
        const block = await getSessionsBlock();
        expect(block.preview.find((r) => r.sessionId === 'leon')?.bandwidthMbps).toBe(11.2);
        expect(block.preview.find((r) => r.sessionId === 'paused')?.bandwidthMbps).toBeUndefined();
        expect(block.load?.bandwidthMbps).toBe(11.2);
    });

    it('keeps the rows when the glance inputs fail, just without load fields', async () => {
        getAllActive.mockResolvedValue([live('fine')]);
        getAllActiveSessionsWithMedia.mockRejectedValue(new Error('db down'));
        const block = await getSessionsBlock();
        expect(block.count).toBe(1);
        expect(block.preview[0].struggling).toBeUndefined();
        expect(block.load).toBeUndefined();
    });

    it('says who watched last while nobody is watching', async () => {
        getAllActive.mockResolvedValue([]);
        getLastEndedSession.mockResolvedValue({
            username: 'leon',
            title: 'What We Do in the Harbor – Colin',
            stopped_at: new Date('2026-09-27T06:00:00Z'),
        });
        const block = await getSessionsBlock();
        expect(block).toEqual({
            count: 0,
            preview: [],
            lastEnded: {
                username: 'leon',
                title: 'What We Do in the Harbor – Colin',
                endedAt: '2026-09-27T06:00:00.000Z',
            },
        });
        expect(getAllActiveSessionsWithMedia).not.toHaveBeenCalled();
    });
});
