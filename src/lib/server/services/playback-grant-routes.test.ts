// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const getPlaybackSession = vi.hoisted(() => vi.fn());
vi.mock('./livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({ getPlaybackSession }),
}));
import { getLivetvPlaybackSession, resolvePlaybackGrantRoute } from './playback-grant-routes';

const session = {
    sessionId: 'session',
    feedId: 'feed',
    viewerKey: 'alice:pat:id',
    state: 'active',
};
beforeEach(() => getPlaybackSession.mockReset().mockResolvedValue(session));

describe('Live TV grant route resolver', () => {
    it('maps the real service session shape and preserves viewer identity', async () => {
        expect(await getLivetvPlaybackSession('session')).toEqual({
            playbackSessionId: 'session',
            feedId: 'feed',
            viewerKey: 'alice:pat:id',
            active: true,
        });
        expect(getPlaybackSession).toHaveBeenCalledWith('session');
    });
    it('maps ended and missing service sessions', async () => {
        getPlaybackSession
            .mockResolvedValueOnce({ ...session, state: 'ended' })
            .mockResolvedValueOnce(null);
        expect(await getLivetvPlaybackSession('session')).toMatchObject({ active: false });
        expect(await getLivetvPlaybackSession('missing')).toBeNull();
    });
    it.each(['', '/a', '/r/rung', '/v/fmp4'])(
        'resolves active live streams on both surfaces (%s)',
        async (variant) => {
            for (const prefix of ['/api', '/api/v1']) {
                expect(
                    await resolvePlaybackGrantRoute(
                        new URL(
                            `https://test${prefix}/livetv/channels/feed/stream${variant}/master.m3u8?PlaySessionId=session`,
                        ),
                    ),
                ).toMatchObject({
                    kind: 'live',
                    playbackSessionId: 'session',
                    liveTvViewerKey: session.viewerKey,
                });
            }
        },
    );
    it('marks an ended or unknown Live TV session so the grant answers session_ended', async () => {
        const url = new URL(
            'https://test/api/v1/livetv/channels/feed/stream/segment.ts?PlaySessionId=session',
        );
        for (const resolved of [
            null,
            { playbackSessionId: 'session', feedId: 'feed', active: false },
        ]) {
            expect(
                await resolvePlaybackGrantRoute(url, vi.fn().mockResolvedValue(resolved)),
            ).toEqual({ playbackSessionId: 'session', kind: 'live', sessionEnded: true });
        }
    });
    it('keeps the resolver injectable and rejects wrong-feed and mismatched sessions', async () => {
        const url = new URL(
            'https://test/api/v1/livetv/channels/feed/stream/segment.ts?PlaySessionId=session',
        );
        for (const resolved of [
            { playbackSessionId: 'session', feedId: 'other', active: true },
            { playbackSessionId: 'other', feedId: 'feed', active: true },
        ]) {
            expect(
                await resolvePlaybackGrantRoute(url, vi.fn().mockResolvedValue(resolved)),
            ).toBeNull();
        }
    });
    it('requires PlaySessionId on master URLs', async () => {
        expect(
            await resolvePlaybackGrantRoute(
                new URL('https://test/api/v1/livetv/channels/feed/stream/master.m3u8'),
            ),
        ).toBeNull();
        expect(getPlaybackSession).not.toHaveBeenCalled();
    });
});

describe('preview lifecycle route scope', () => {
    it.each(['/api', '/api/v1'])('binds lifecycle paths and methods on %s', async (prefix) => {
        for (const [suffix, method] of [
            ['', 'DELETE'],
            ['/keepalive', 'POST'],
        ]) {
            const url = new URL(`https://test${prefix}/playback/previews/preview-owned${suffix}`);
            expect(await resolvePlaybackGrantRoute(url)).toEqual({
                kind: 'preview',
                playbackSessionId: 'preview-owned',
                methods: [method],
            });
            url.searchParams.set('PlaySessionId', 'preview-foreign');
            expect(await resolvePlaybackGrantRoute(url)).toBeNull();
        }
    });
    it('does not classify /j as a playback grant surface', async () => {
        expect(
            await resolvePlaybackGrantRoute(
                new URL('https://test/j/Videos/item/stream?PlaySessionId=preview-owned'),
            ),
        ).toBeNull();
    });
});
