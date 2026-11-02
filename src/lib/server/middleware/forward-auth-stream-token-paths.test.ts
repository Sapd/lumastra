// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    resolvePlaybackGrantRoute,
    registerPlaybackGrantRoute,
} from '../services/playback-grant-routes.js';

const classify = (path: string) => resolvePlaybackGrantRoute(new URL(path, 'http://localhost'));

describe('grant delivery route registry', () => {
    it.each(['/api', '/api/v1'])('classifies item-scoped delivery on %s', async (base) => {
        expect(await classify(`${base}/music/tracks/track-1/stream`)).toMatchObject({
            mediaId: 'track-1',
            kind: 'music',
        });
        expect(await classify(`${base}/music/radio/stations/st-1/stream`)).toMatchObject({
            mediaId: 'st-1',
            kind: 'music',
        });
        expect(await classify(`${base}/music/radio/st-1/stream`)).toMatchObject({
            mediaId: 'st-1',
            kind: 'music',
        });
        expect(
            await classify(`${base}/playback/movie-1/hls/stream_0/init.mp4?PlaySessionId=ps-1`),
        ).toEqual({
            mediaId: 'movie-1',
            kind: 'video',
            playbackSessionId: 'ps-1',
            previewDelivery: true,
        });
    });
    it.each([
        '/api/v1/media/movie/playability',
        '/api/v1/playback/movie/probe-status',
        '/api/v1/playback/grants/id',
        '/api/v1/playback/movie/chapters',
        '/api/v1/music/radio/stations/st/now-playing',
        '/api/v1/music/quick-picks',
        '/api/v1/audiobook/book/bookmarks',
        '/j/Videos/movie/hls',
    ])('rejects non-delivery path %s', async (path) => {
        expect(await classify(path)).toBeNull();
    });
    it.each(['%2f', '%2F', '%5c', '%5C', '%2e%2e', '%2E%2E', '..'])(
        'rejects ambiguous delivery path containing %s before extension classifiers',
        async (part) => {
            const unregister = registerPlaybackGrantRoute(() => ({ mediaId: 'm', kind: 'video' }));
            try {
                expect(
                    await classify(`/api/v1/playback/movie/hls/segment${part}file.ts`),
                ).toBeNull();
            } finally {
                unregister();
            }
        },
    );
    it('normalizes UUIDs in grant routes', async () => {
        expect(
            await classify('/api/music/tracks/ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF/stream'),
        ).toMatchObject({ mediaId: 'abcdefab-abcd-4abc-8abc-abcdefabcdef' });
    });
    it('marks an unknown Live TV session as ended (the grant then answers session_ended)', async () => {
        expect(
            await resolvePlaybackGrantRoute(
                new URL('http://x/api/v1/livetv/channels/feed/stream/master.m3u8?PlaySessionId=ps'),
                async () => null,
            ),
        ).toEqual({ playbackSessionId: 'ps', kind: 'live', sessionEnded: true });
    });
    it('checks Live TV active session and feed via the injected resolver', async () => {
        const url = new URL(
            'http://x/api/v1/livetv/channels/feed/stream/v/fmp4/init.mp4?PlaySessionId=ps',
        );
        expect(
            await resolvePlaybackGrantRoute(url, async () => ({
                playbackSessionId: 'ps',
                feedId: 'feed',
                active: true,
            })),
        ).toEqual({ playbackSessionId: 'ps', kind: 'live' });
        expect(
            await resolvePlaybackGrantRoute(url, async () => ({
                playbackSessionId: 'ps',
                feedId: 'other',
                active: true,
            })),
        ).toBeNull();
        expect(
            await resolvePlaybackGrantRoute(url, async () => ({
                playbackSessionId: 'ps',
                feedId: 'feed',
                active: false,
            })),
        ).toEqual({ playbackSessionId: 'ps', kind: 'live', sessionEnded: true });
    });
    it('supports explicitly registered future delivery routes', async () => {
        const unregister = registerPlaybackGrantRoute((url) =>
            url.pathname === '/api/v1/timeline/frame' ? { mediaId: 'm', kind: 'video' } : null,
        );
        expect(await classify('/api/v1/timeline/frame')).toEqual({ mediaId: 'm', kind: 'video' });
        unregister();
        expect(await classify('/api/v1/timeline/frame')).toBeNull();
    });
});

it.each(['files', 'remux'])(
    'classifies only versioned session-mapped audiobook %s URLs',
    async (kind) => {
        expect(await classify(`/api/v1/audiobooks/book/${kind}/1?PlaySessionId=session`)).toEqual({
            mediaId: 'book',
            kind: 'audiobook',
            playbackSessionId: 'session',
        });
        expect(await classify(`/api/audiobooks/book/${kind}/1?PlaySessionId=session`)).toBeNull();
        expect(await classify(`/api/v1/audiobook/book/${kind}/inode`)).toBeNull();
        expect(await classify(`/api/v1/audiobooks/book/${kind}/1`)).toBeNull();
    },
);
