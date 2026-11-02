// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from '../api/principal.js';
import { invalidatePlaybackGrantCache, mintPlaybackGrant } from './playback-grant.js';
vi.mock('../database/connection.js', async (original) => ({
    ...(await original<typeof import('../database/connection.js')>()),
    getDb: () => getTestDb(),
}));
vi.mock('../middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));
vi.mock('./audiobookshelf-credentials.service.js', () => ({
    resolveUserApiKey: async () => 'listener-key',
}));
vi.mock('../audiobookshelf.js', () => ({ audiobookshelfClient: {} }));
const mocks = vi.hoisted(() => ({ proxy: vi.fn(), remux: vi.fn() }));
vi.mock('./audiobook-byte-proxy.service.js', async (original) => ({
    ...(await original<typeof import('./audiobook-byte-proxy.service.js')>()),
    proxyAudiobookBytes: mocks.proxy,
}));
vi.mock('./audiobook-remux.service.js', () => ({
    acquireAudiobookRemuxSlot: () => () => {},
    startAudiobookRemux: mocks.remux,
    AUDIOBOOK_REMUX_CONTENT_TYPE: 'audio/aac',
}));
import {
    handleAudiobookFile,
    handleAudiobookHls,
    handleAudiobookRemux,
} from './audiobook-stream-routes.js';

const routes = [
    ['files', handleAudiobookFile],
    ['remux', handleAudiobookRemux],
    ['hls', handleAudiobookHls],
] as const;
describe('audiobook bytes: real session/track/book ownership', () => {
    const sql = getTestDb();
    const owner = randomUUID();
    const other = randomUUID();
    const book = randomUUID();
    const foreignBook = randomUUID();
    const session = randomUUID();
    let grant: string;
    beforeAll(async () => {
        await sql`INSERT INTO users (id, username) VALUES (${owner}, ${'p9-' + owner}), (${other}, ${'p9-' + other})`;
        await sql`INSERT INTO media_items (id, title, media_type, status, has_files) VALUES
            (${book}, 'P9 book', 'audiobook', 'active', true), (${foreignBook}, 'P9 foreign', 'audiobook', 'active', true)`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES
            (${book}, 'audiobookshelf', ${'abs-' + book}, 'audiobook'), (${foreignBook}, 'audiobookshelf', ${'abs-' + foreignBook}, 'audiobook')`;
        await sql`INSERT INTO play_sessions (id, user_id, media_id, device_id, ip_address, play_method, source, source_session_id, status, device_capabilities)
            VALUES (${session}, ${owner}, ${book}, 'p9-device', '192.0.2.1'::inet, 'direct', 'audiobookshelf', 'p9-server-session', 'ACTIVE',
                ${sql.json({ audiobookTracks: [{ index: 1, ino: 'private-inode' }] })})`;
        grant = (
            await mintPlaybackGrant({
                userId: owner,
                mediaId: book,
                playbackSessionId: session,
                kind: 'audiobook',
                clientIp: '192.0.2.1',
            })
        ).token;
    });
    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id IN (${book}, ${foreignBook})`;
        await sql`DELETE FROM users WHERE id IN (${owner}, ${other})`;
        await closeTestDb();
    });
    function event(
        kind: string,
        who: string,
        admin: boolean,
        svc: boolean,
        mediaId = book,
        trackIndex = '1',
    ): RequestEvent {
        const user = {
            userId: toUserId(who),
            username: 'p9-' + who,
            userGroups: [],
            isAdmin: admin,
        };
        const url = new URL(
            `http://localhost/api/v1/${kind === 'hls' ? `audiobook/${mediaId}/hls/playback/${session}/output-0.ts` : `audiobooks/${mediaId}/${kind}/${trackIndex}`}?PlaySessionId=${session}`,
        );
        return {
            url,
            request: new Request(url, { method: 'HEAD' }),
            params: {
                mediaId,
                trackIndex,
                token: 'playback',
                sessionId: session,
                file: 'output-0.ts',
            },
            locals: {
                user,
                authMethod: svc ? 'service_token' : 'bearer',
                principal: buildPrincipal({
                    userId: user.userId,
                    username: user.username,
                    kind: svc ? 'service_token' : 'bearer',
                    userGroups: [],
                    tokenScopes: admin ? ['media:read', 'admin'] : ['media:read'],
                    ownerIsAdmin: admin,
                }),
            },
            getClientAddress: () => '192.0.2.1',
        } as unknown as RequestEvent;
    }
    describe.each(routes)('%s', (kind, handler) => {
        it.each([
            ['owner', false, false, true],
            ['other user', false, false, false],
            ['admin owner', true, false, true],
            ['foreign admin', true, false, false],
            ['service act-as owner', false, true, true],
            ['foreign service', false, true, false],
        ] as const)('%s', async (_name, admin, svc, own) => {
            mocks.proxy
                .mockClear()
                .mockResolvedValue(
                    new Response(null, { headers: { 'Content-Type': 'audio/mp4' } }),
                );
            const response = await handler(event(kind, own ? owner : other, admin, svc));
            expect(response.status).toBe(own ? 200 : 404);
            expect(await response.text()).toBe('');
            expect(mocks.remux).not.toHaveBeenCalled();
            expect(mocks.proxy).toHaveBeenCalledTimes(own && kind !== 'remux' ? 1 : 0);
        });
        it('refuses a foreign book and unknown track', async () => {
            expect((await handler(event(kind, owner, false, false, foreignBook))).status).toBe(404);
            if (kind !== 'hls')
                expect((await handler(event(kind, owner, false, false, book, '99'))).status).toBe(
                    404,
                );
        });
        it('refuses a reaped session and restores only a live session', async () => {
            await sql`UPDATE play_sessions SET status = 'CRASHED' WHERE id = ${session}`;
            try {
                expect((await handler(event(kind, owner, false, false))).status).toBe(404);
            } finally {
                await sql`UPDATE play_sessions SET status = 'ACTIVE' WHERE id = ${session}`;
            }
        });
        it('refuses an expired query grant', async () => {
            await sql`UPDATE hls_playback_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE play_session_id = ${session}`;
            invalidatePlaybackGrantCache();
            const request = event(kind, owner, false, false);
            request.locals = {} as RequestEvent['locals'];
            request.url.searchParams.set('grant', grant);
            try {
                expect((await handler(request)).status).toBe(401);
            } finally {
                await sql`UPDATE hls_playback_tokens SET expires_at = NOW() + INTERVAL '1 hour' WHERE play_session_id = ${session}`;
                invalidatePlaybackGrantCache();
            }
        });
    });
    it('admits a long download once, then requires a fresh grant for its next Range request', async () => {
        const fresh = await mintPlaybackGrant({
            userId: owner,
            mediaId: book,
            playbackSessionId: session,
            kind: 'audiobook',
            clientIp: '192.0.2.1',
        });
        expect(fresh.expiresAt.getTime() - fresh.createdAt.getTime()).toBeLessThanOrEqual(
            24 * 60 * 60 * 1000,
        );
        let finish: (() => void) | undefined;
        mocks.proxy.mockImplementationOnce(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            finish = () => {
                                controller.enqueue(new Uint8Array([1, 2, 3]));
                                controller.close();
                            };
                        },
                    }),
                    { headers: { 'Content-Type': 'audio/mp4', ETag: '"same-file"' } },
                ),
        );
        const request = event('files', owner, false, false);
        request.locals.authMethod = 'stream_token';
        request.url.searchParams.set('grant', fresh.token);
        request.request = new Request(request.url);
        const response = await handleAudiobookFile(request);
        expect(response.status).toBe(200);
        await sql`UPDATE hls_playback_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${fresh.id}`;
        invalidatePlaybackGrantCache();
        finish!();
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect((await handleAudiobookFile(request)).status).toBe(401);
    });
});
