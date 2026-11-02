// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
}));
vi.mock('$lib/shared/api-urls.js', () => ({
    apiUrl: (_surface: string, path: string) => `/api${path}`,
}));
import { apiPost, apiPut, apiDelete } from './client.js';
import {
    startMusicPlaySession,
    reportMusicPlayback,
    reportMusicPlaybackBeacon,
    setTrackFeedback,
    clearTrackFeedback,
    replayMusicPlays,
    type MusicPlaybackReport,
} from './music.js';

beforeEach(() => {
    vi.clearAllMocks();
});

const report: MusicPlaybackReport = {
    positionMs: 45_000,
    status: 'COMPLETED',
    eventSeq: 3,
    sessionElapsedMs: 12_000,
    listenedTotalMs: 12_000,
    endReason: 'skip',
};

describe('unified music reporting', () => {
    it('starts through the existing shared contract without preallocating an id', () => {
        startMusicPlaySession({ trackId: 'track', deviceId: 'device' });
        expect(apiPost).toHaveBeenCalledWith(
            '/api/play-sessions',
            expect.anything(),
            expect.objectContaining({
                mediaId: 'track',
                deviceId: 'device',
                capabilities: expect.objectContaining({
                    audioCodecs: expect.arrayContaining(['aac']),
                }),
            }),
        );
    });

    it('reports sequence, heard time, and the terminal reason in one request', () => {
        reportMusicPlayback('session', report);
        expect(apiPut).toHaveBeenCalledWith(
            '/api/play-sessions/session',
            expect.anything(),
            report,
        );
        const schema = vi.mocked(apiPut).mock.calls[0][1];
        expect(schema.safeParse(null).success).toBe(true);
        expect(schema.safeParse({ resumeAnchorAt: null, progressSaved: false }).success).toBe(true);
    });

    it('preserves omitted, cleared, and set crossfade fields', () => {
        const fade = {
            otherTrackId: 'other',
            role: 'incoming' as const,
            durationMs: 2000,
            remainingMs: 1000,
        };
        reportMusicPlayback('session', report);
        reportMusicPlayback('session', { ...report, crossfade: null });
        reportMusicPlayback('session', { ...report, crossfade: fade, nextMediaId: 'next' });
        const bodies = vi.mocked(apiPut).mock.calls.map((call) => call[2]);
        expect(bodies[0]).not.toHaveProperty('crossfade');
        expect(bodies[1]).toHaveProperty('crossfade', null);
        expect(bodies[2]).toMatchObject({ crossfade: fade, nextMediaId: 'next' });
    });

    it('uses the same report for unload', async () => {
        const sendBeacon = vi.fn((_url: string, _body: Blob) => true);
        vi.stubGlobal('navigator', { sendBeacon });
        try {
            expect(reportMusicPlaybackBeacon('session', report)).toBe(true);
            expect(sendBeacon).toHaveBeenCalledWith(
                '/api/play-sessions/session/beacon',
                expect.any(Blob),
            );
            expect(JSON.parse(await sendBeacon.mock.calls[0][1].text())).toEqual(report);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('writes and clears explicit feedback on the user resource', () => {
        setTrackFeedback('track', 'liked');
        setTrackFeedback('track', 'disliked');
        clearTrackFeedback('track');
        expect(apiPut).toHaveBeenNthCalledWith(
            1,
            '/api/me/music/tracks/track/feedback',
            expect.anything(),
            { feedback: 'liked' },
        );
        expect(apiPut).toHaveBeenNthCalledWith(
            2,
            '/api/me/music/tracks/track/feedback',
            expect.anything(),
            { feedback: 'disliked' },
        );
        expect(apiDelete).toHaveBeenCalledWith(
            '/api/me/music/tracks/track/feedback',
            expect.anything(),
        );
    });

    it('replays completed offline listens as items, allowing an omitted startReported', () => {
        const item = {
            eventId: crypto.randomUUID(),
            kind: 'music' as const,
            mediaId: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            positionMs: 45_000,
            listenedMs: 12_000,
            endReason: 'user' as const,
        };
        replayMusicPlays([item]);
        expect(apiPost).toHaveBeenCalledWith('/api/play-sessions/replay', expect.anything(), {
            items: [item],
        });
    });
});

describe('getRecommendations seed conversion', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';

    async function body(args: Parameters<typeof import('./music.js').getRecommendations>[0]) {
        const { getRecommendations } = await import('./music.js');
        getRecommendations(args);
        return vi.mocked(apiPost).mock.calls[0][2] as Record<string, unknown>;
    }

    it('converts artist and album autoplay seeds to wire shape', async () => {
        expect(
            (
                await body({
                    currentTrackId: A,
                    seed: { type: 'artist', artistId: B, artistName: 'X' },
                })
            ).seed,
        ).toEqual({ type: 'artist', id: B });
        vi.clearAllMocks();
        expect(
            (await body({ currentTrackId: A, seed: { type: 'album', albumId: B, albumName: 'Y' } }))
                .seed,
        ).toEqual({ type: 'album', id: B });
    });

    it('converts mood and genre autoplay seeds', async () => {
        expect(
            (await body({ seed: { type: 'mood', mood: 'chill', label: 'Chill', emoji: 'x' } }))
                .seed,
        ).toEqual({ type: 'mood', mood: 'chill' });
        vi.clearAllMocks();
        expect(
            (
                await body({
                    currentTrackId: A,
                    seed: { type: 'genre', genre: 'Trance', label: 'Trance' },
                })
            ).seed,
        ).toEqual({ type: 'genre', genre: 'Trance' });
    });

    it('passes wire seeds through unchanged', async () => {
        expect((await body({ seed: { type: 'artist', id: B } })).seed).toEqual({
            type: 'artist',
            id: B,
        });
    });

    it('filters non-GUID ids, caps lists at 200 and omits empty fields', async () => {
        const many = Array.from(
            { length: 250 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        );
        const b = (await body({
            currentTrackId: A,
            history: ['not-a-guid', ...many],
            skipped: ['nope'],
            exclude: [],
            upcoming: [B],
            crossfade: false,
        })) as { context: Record<string, unknown> };
        expect((b.context.history as string[]).length).toBe(200);
        expect((b.context.history as string[]).includes('not-a-guid')).toBe(false);
        expect('skipped' in b.context).toBe(false);
        expect('exclude' in b.context).toBe(false);
        expect(b.context.upcoming).toEqual([B]);
        expect(b.context.crossfade).toBe(false);
    });

    it('omits context when nothing is set', async () => {
        const b = await body({ seed: { type: 'genre', genre: 'Trance' } });
        expect('context' in b).toBe(false);
    });
});

it('discards an unheard music preload through the session DELETE', async () => {
    const { cancelMusicPlayback } = await import('./music.js');
    cancelMusicPlayback('unused/session');
    expect(apiDelete).toHaveBeenCalledWith(
        '/api/play-sessions/unused%2Fsession',
        expect.anything(),
    );
});
