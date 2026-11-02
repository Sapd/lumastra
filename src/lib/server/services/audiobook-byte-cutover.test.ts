// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    session: vi.fn(),
    auth: vi.fn(),
    proxy: vi.fn(),
    remux: vi.fn(),
}));
vi.mock('../database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('../database/queries/play-sessions.queries.js', () => ({ getSessionById: mocks.session }));
vi.mock('./audiobook-stream-auth.js', () => ({
    authenticateAudiobookStream: mocks.auth,
    extractStreamToken: () => 'grant',
}));
vi.mock('./audiobook-byte-proxy.service.js', async (original) => ({
    ...(await original<typeof import('./audiobook-byte-proxy.service.js')>()),
    proxyAudiobookBytes: mocks.proxy,
}));
vi.mock('./audiobook-remux.service.js', () => ({
    acquireAudiobookRemuxSlot: () => () => {},
    startAudiobookRemux: mocks.remux,
    AUDIOBOOK_REMUX_CONTENT_TYPE: 'audio/aac',
}));
vi.mock('../config.js', () => ({ config: { AUDIOURL: 'http://abs.test' } }));
import {
    handleAudiobookFile,
    handleAudiobookRemux,
    handleAudiobookHls,
} from './audiobook-stream-routes.js';
const book = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
function event(
    kind: string,
    query = `PlaySessionId=${session}`,
    method = 'GET',
    trackIndex = '1',
): RequestEvent {
    const path =
        kind === 'hls'
            ? `audiobook/${book}/hls/playback/${session}/output-0.ts`
            : `audiobooks/${book}/${kind}/${trackIndex}`;
    const url = new URL(`http://localhost/api/v1/${path}?${query}`);
    return {
        url,
        params: {
            mediaId: book,
            trackIndex,
            token: 'playback',
            sessionId: session,
            file: 'output-0.ts',
        },
        request: new Request(url, { method }),
        getClientAddress: () => '192.0.2.1',
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({
        user_id: 'owner',
        media_id: book,
        source: 'audiobookshelf',
        source_session_id: 'server-abs-session',
        status: 'ACTIVE',
        device_capabilities: { audiobookTracks: [{ index: 1, ino: 'server-inode' }] },
    });
    mocks.auth.mockResolvedValue({
        ok: true,
        userId: 'owner',
        absApiKey: 'key',
        absItemId: 'server-book',
    });
    mocks.proxy.mockImplementation(
        async () =>
            new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/mp4' } }),
    );
});
const routes = [
    ['files', handleAudiobookFile],
    ['remux', handleAudiobookRemux],
    ['hls', handleAudiobookHls],
] as const;
describe.each(routes)('%s session-only byte addressing', (kind, handler) => {
    it('HEAD resolves only server-owned addresses and has no body or encoder', async () => {
        const response = await handler(event(kind, undefined, 'HEAD'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
        expect(mocks.remux).not.toHaveBeenCalled();
        if (kind !== 'remux')
            expect(mocks.proxy.mock.calls[0][0].upstreamPath).toBe(
                kind === 'files'
                    ? '/api/items/server-book/file/server-inode'
                    : '/hls/server-abs-session/output-0.ts',
            );
    });
    it.each([
        '',
        'session=client-abs-session',
        `PlaySessionId=${session}&trackIndex=1`,
        `PlaySessionId=${session}&session=client-abs-session`,
    ])('rejects absent/retired query %s before reaching ABS', async (query) => {
        const response = await handler(event(kind, query));
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(mocks.proxy).not.toHaveBeenCalled();
        expect(mocks.remux).not.toHaveBeenCalled();
    });
    it.each(['COMPLETED', 'CRASHED', 'KILLED'])('rejects %s sessions', async (status) => {
        const row = await mocks.session();
        mocks.session.mockResolvedValue({ ...row, status });
        expect((await handler(event(kind))).status).toBe(404);
        expect(mocks.proxy).not.toHaveBeenCalled();
        expect(mocks.remux).not.toHaveBeenCalled();
    });
    it('refuses a foreign listener even with an admin credential', async () => {
        mocks.auth.mockResolvedValue({
            ok: true,
            userId: 'admin',
            absApiKey: 'key',
            absItemId: 'server-book',
        });
        expect((await handler(event(kind))).status).toBe(404);
        expect(mocks.proxy).not.toHaveBeenCalled();
        expect(mocks.remux).not.toHaveBeenCalled();
    });
    if (kind !== 'hls')
        it('never forwards a client inode as a track index', async () => {
            expect((await handler(event(kind, undefined, 'GET', 'server-inode'))).status).toBe(404);
            expect(mocks.proxy).not.toHaveBeenCalled();
            expect(mocks.remux).not.toHaveBeenCalled();
        });
});

it('rejects a raw ABS HLS session even alongside a valid public session pin', async () => {
    const request = event('hls');
    request.params.token = 'raw-token';
    request.params.sessionId = 'client-abs-session';
    expect((await handleAudiobookHls(request)).status).toBe(404);
    expect(mocks.proxy).not.toHaveBeenCalled();
});

describe('validators across reissued URLs', () => {
    it('two issued URLs for the same track (two play sessions) return identical ETag and Last-Modified (API.md: "ETag and Last-Modified are passed through unchanged … including across renewed URLs and fresh sessions")', async () => {
        // The real byte proxy runs here; only the upstream fetch is stubbed. Both sessions
        // map to the same ABS file, so the upstream representation (and its validators) is the same.
        const real = await vi.importActual<typeof import('./audiobook-byte-proxy.service.js')>(
            './audiobook-byte-proxy.service.js',
        );
        mocks.proxy.mockImplementation(real.proxyAudiobookBytes);
        const validators = {
            ETag: '"ino-server-inode-v1"',
            'Last-Modified': 'Tue, 01 Sep 2026 10:00:00 GMT',
        };
        const upstream = vi.fn(
            async (_url: string, _init?: RequestInit) =>
                new Response(new Uint8Array([1, 2, 3]), {
                    status: 200,
                    headers: { 'Content-Type': 'audio/mp4', ...validators },
                }),
        );
        vi.stubGlobal('fetch', upstream);
        const sessionB = '33333333-3333-4333-8333-333333333333';
        const rowA = {
            user_id: 'owner',
            media_id: book,
            source: 'audiobookshelf',
            source_session_id: 'server-abs-session',
            status: 'ACTIVE',
            device_capabilities: { audiobookTracks: [{ index: 1, ino: 'server-inode' }] },
        };
        mocks.session.mockImplementation(async (_db: unknown, id: string) =>
            id === sessionB ? { ...rowA, source_session_id: 'other-abs-session' } : rowA,
        );
        try {
            const first = await handleAudiobookFile(event('files'));
            const second = await handleAudiobookFile(event('files', `PlaySessionId=${sessionB}`));
            const head = await handleAudiobookFile(
                event('files', `PlaySessionId=${sessionB}`, 'HEAD'),
            );

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
            expect(second.headers.get('last-modified')).toBe(first.headers.get('last-modified'));
            expect(first.headers.get('etag')).toBe(validators.ETag);
            expect(first.headers.get('last-modified')).toBe(validators['Last-Modified']);
            expect(head.headers.get('etag')).toBe(validators.ETag);
            expect(head.headers.get('last-modified')).toBe(validators['Last-Modified']);
            const urls = upstream.mock.calls.map((call) => String(call[0]));
            expect(urls).toHaveLength(3);
            expect(new Set(urls)).toEqual(
                new Set(['http://abs.test/api/items/server-book/file/server-inode']),
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
