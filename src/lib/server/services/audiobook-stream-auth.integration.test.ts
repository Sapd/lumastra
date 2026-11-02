// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The byte proxy's auth decision, exercised against real stream tokens.
 *
 * The design calls this "the one decision here that is expensive to reverse":
 * the proxy carries every audio byte, so retrofitting its auth later means
 * rewriting the route AND migrating whatever clients depend on it. These tests
 * pin the properties that made stream tokens the answer over a session cookie:
 *
 *  - the credential travels in the URL, so AirPlay / AVPlayer / tvOS / any
 *    `/api/v1` client can carry it (a cookie is same-origin-browser-only);
 *  - it is pinned to ONE `media_items.id`, so it cannot be replayed against
 *    another book;
 *  - the music WILDCARD token — which is deliberately unpinned — is refused, or
 *    any music session would double as a key to the whole audiobook library.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { WILDCARD_IP } from '../oauth/streaming-session.service.js';
import { mintPlaybackGrant } from './playback-grant.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
} from '../database/queries/audiobooks.queries.js';
import {
    authenticateAudiobookStream,
    extractStreamToken,
    invalidateAudiobookKeyCache,
} from './audiobook-stream-auth.js';
import type { AbsCredentialDeps } from './audiobookshelf-credentials.service.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

/**
 * Stand-in for the ABS server. `resolveUserApiKey` mints through this on first
 * use, so the credential path is exercised without creating real API keys on a
 * live AudiobookShelf every test run.
 */
function fakeAbs(absUsername: string): AbsCredentialDeps {
    return {
        listUsers: async () => [{ id: 'abs-user-1', username: absUsername, type: 'user' }],
        createApiKey: async () => ({
            id: 'abs-key-1',
            apiKey: 'abs-secret-key',
            isActive: true,
        }),
        deactivateApiKey: async () => {},
    };
}

describe.skipIf(SKIP)('audiobook stream auth', () => {
    let sql: postgres.Sql;
    let userId: string;
    let username: string;
    let mediaId: string;
    let otherMediaId: string;
    /** Unique per test — `external_ids` is UNIQUE on (provider, external_id, media_type). */
    let ABS_ITEM_ID: string;

    /** media_items ids inserted by this file, for exact teardown. */
    const seededBookIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanupSeededBooks();
        await closeTestDb();
    });

    /**
     * Remove the books this file inserted.
     *
     * Two per case, and without this they accumulate for the lifetime of the test
     * database — which is not harmless: `audiobook-browse.queries.integration.test.ts`
     * asserts an ABSOLUTE title list over the unscoped `media_items` table, so
     * leftovers from this file make that suite fail depending on file order, and
     * the failure looks like a broken visibility filter rather than residue.
     */
    async function cleanupSeededBooks(): Promise<void> {
        if (seededBookIds.length === 0) return;
        await sql`DELETE FROM media_items WHERE id = ANY(${seededBookIds}::uuid[])`;
        seededBookIds.length = 0;
    }

    afterEach(async () => {
        await cleanupSeededBooks();
    });

    beforeEach(async () => {
        invalidateAudiobookKeyCache();
        await sql`DELETE FROM play_sessions`;
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        [{ username }] = await sql<Array<{ username: string }>>`
            SELECT username FROM users WHERE id = ${userId}::uuid
        `;

        ABS_ITEM_ID = `abs-item-${randomUUID()}`;
        mediaId = await insertAudiobook(sql, ABS_ITEM_ID);
        otherMediaId = await insertAudiobook(sql, `abs-other-${randomUUID()}`);
    });

    async function insertAudiobook(db: postgres.Sql, absId: string): Promise<string> {
        const id = randomUUID();
        seededBookIds.push(id);
        await db`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}, ${'Book ' + absId}, ${AUDIOBOOK_MEDIA_TYPE}, 'active', true)
        `;
        await db`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${id}, ${AUDIOBOOKSHELF_PROVIDER}, ${absId}, ${AUDIOBOOK_MEDIA_TYPE})
        `;
        return id;
    }

    async function mint(
        forMediaId: string,
        kind: 'audiobook' | 'music' | 'video' = 'audiobook',
    ): Promise<string> {
        const result = await mintPlaybackGrant({
            userId,
            mediaId: forMediaId,
            kind,
            playbackSessionId: null,
            clientIp: WILDCARD_IP,
        });
        return result.token;
    }

    it('accepts a token minted for this book and resolves the ABS identity', async () => {
        const token = await mint(mediaId);

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            credentialDeps: fakeAbs(username),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.absItemId).toBe(ABS_ITEM_ID);
        expect(result.absApiKey).toBe('abs-secret-key');
        expect(result.userId).toBe(userId);
    });

    it('refuses a token minted for a DIFFERENT book', async () => {
        const token = await mint(otherMediaId);

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            credentialDeps: fakeAbs(username),
        });

        expect(result).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
    });

    it('refuses a music grant even when bound to the same item', async () => {
        const token = await mint(mediaId, 'music');

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            credentialDeps: fakeAbs(username),
        });

        // A wildcard token passes validate() for ANY item — that is what makes
        // it usable for the music player and unusable here.
        expect(result).toMatchObject({ ok: false, status: 401, reason: 'invalid_token' });
    });

    it('refuses a missing or malformed token without touching the database', async () => {
        for (const token of [null, '', 'pat_not_a_stream_token', 'stream_deadbeef']) {
            const result = await authenticateAudiobookStream({
                sql,
                token,
                mediaId,
                clientIp: '203.0.113.5',
                credentialDeps: fakeAbs(username),
            });
            expect(result.ok).toBe(false);
        }
    });

    it('404s a valid token whose media item is not an AudiobookShelf book', async () => {
        // A token minted through the ordinary playback flow for a MOVIE would
        // otherwise reach the proxy and have its media id interpolated into an
        // ABS path.
        const movieId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${movieId}, 'A Movie', 'movie', 'active', true)
        `;
        const token = await mint(movieId);

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId: movieId,
            clientIp: '203.0.113.5',
            credentialDeps: fakeAbs(username),
        });

        expect(result).toMatchObject({ ok: false, status: 404, reason: 'not_an_audiobook' });
    });

    describe('HLS session binding', () => {
        /**
         * The stream token pins the MEDIA id, not the ABS transcode session,
         * and ABS serves `/hls/:sid/*` with no auth of its own (measured). So
         * without a separate check, a listener holding a valid token for a book
         * they may read could name any other user's in-flight session id and
         * pull that book's audio — the library/age gate bypassed entirely.
         */
        async function insertPlaySession(
            absSessionId: string,
            forMediaId: string,
            forUserId: string,
            status = 'ACTIVE',
        ): Promise<void> {
            await sql`
                INSERT INTO play_sessions (
                    id, media_id, user_id, device_id, ip_address, play_method,
                    status, position_ms, source, source_session_id
                ) VALUES (
                    ${randomUUID()}::uuid, ${forMediaId}::uuid, ${forUserId}::uuid,
                    ${'dev-' + randomUUID()}, '127.0.0.1'::inet, 'direct',
                    ${status}, 0, 'audiobookshelf', ${absSessionId}
                )
            `;
        }

        const authWithSession = async (absSessionId: string, token: string) =>
            authenticateAudiobookStream({
                sql,
                token,
                mediaId,
                absSessionId,
                clientIp: '203.0.113.5',
                credentialDeps: fakeAbs(username),
            });

        it('accepts a session Lumastra opened for this user and this book', async () => {
            await insertPlaySession('abs-sess-mine', mediaId, userId);
            const result = await authWithSession('abs-sess-mine', await mint(mediaId));
            expect(result.ok).toBe(true);
        });

        it('accepts a PAUSED session — pausing must not kill playback auth', async () => {
            await insertPlaySession('abs-sess-paused', mediaId, userId, 'PAUSED');
            const result = await authWithSession('abs-sess-paused', await mint(mediaId));
            expect(result.ok).toBe(true);
        });

        it("refuses ANOTHER user's session for the same book", async () => {
            const strangerId = generateTestUserId();
            await ensureTestUser(sql, strangerId);
            await insertPlaySession('abs-sess-stranger', mediaId, strangerId);

            const result = await authWithSession('abs-sess-stranger', await mint(mediaId));
            expect(result).toMatchObject({ ok: false, status: 404, reason: 'unknown_session' });
        });

        it("refuses this user's session for a DIFFERENT book", async () => {
            // The escalation shape: a token for a book you may read, plus a
            // session id belonging to a book you may not.
            await insertPlaySession('abs-sess-other-book', otherMediaId, userId);

            const result = await authWithSession('abs-sess-other-book', await mint(mediaId));
            expect(result).toMatchObject({ ok: false, status: 404, reason: 'unknown_session' });
        });

        it('refuses a session id nobody opened', async () => {
            const result = await authWithSession('abs-sess-guessed', await mint(mediaId));
            expect(result).toMatchObject({ ok: false, status: 404, reason: 'unknown_session' });
        });

        it('refuses a session that has already ended', async () => {
            await insertPlaySession('abs-sess-done', mediaId, userId, 'COMPLETED');
            const result = await authWithSession('abs-sess-done', await mint(mediaId));
            expect(result).toMatchObject({ ok: false, status: 404, reason: 'unknown_session' });
        });

        it('returns the play session id and device of the row that proved ownership', async () => {
            // The remux route attaches its active_transcode_jobs row to this id.
            // It is returned from the ownership check rather than re-queried by
            // the caller so the ONLY play session id a handler can reach is one
            // that just passed the check — there is no second, unguarded lookup.
            await insertPlaySession('abs-sess-ids', mediaId, userId);
            const [row] = await sql<Array<{ id: string; device_id: string }>>`
                SELECT id, device_id FROM play_sessions
                WHERE source_session_id = 'abs-sess-ids'
            `;

            const result = await authWithSession('abs-sess-ids', await mint(mediaId));
            expect(result).toMatchObject({
                ok: true,
                playSessionId: row.id,
                playSessionDeviceId: row.device_id,
            });
        });

        it('carries NO play session id when no session was checked', async () => {
            // The direct-play file route passes no session (ABS authenticates
            // those bytes itself). Handing back an id there would let a caller
            // record a job against a session nothing verified.
            const result = await authenticateAudiobookStream({
                sql,
                token: await mint(mediaId),
                mediaId,
                clientIp: '203.0.113.5',
                credentialDeps: fakeAbs(username),
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.playSessionId).toBeUndefined();
            expect(result.playSessionDeviceId).toBeUndefined();
        });
    });

    it('stops serving a book that has been withdrawn since the token was minted', async () => {
        // Stream tokens live for hours; the media gate runs at mint. Without a
        // per-request recheck, a dismissed or deactivated book keeps streaming
        // until the token expires.
        const token = await mint(mediaId);
        await sql`UPDATE media_items SET is_dismissed = TRUE WHERE id = ${mediaId}::uuid`;

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            credentialDeps: fakeAbs(username),
        });

        expect(result).toMatchObject({ ok: false, status: 404, reason: 'not_an_audiobook' });
    });

    it('reports an ABS outage as retryable (503), not as a permanent 403', async () => {
        const token = await mint(mediaId);
        const brokenAbs: AbsCredentialDeps = {
            listUsers: async () => {
                throw new Error('ECONNREFUSED');
            },
            createApiKey: async () => {
                throw new Error('unreachable');
            },
            deactivateApiKey: async () => {},
        };

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            credentialDeps: brokenAbs,
        });

        // 403 tells a player to give up; 503 tells it to retry. A transient
        // outage must not read as "this account is not linked".
        expect(result).toMatchObject({ ok: false, status: 503, reason: 'abs_unavailable' });
    });

    it('refuses a listener with no AudiobookShelf counterpart', async () => {
        const token = await mint(mediaId);

        const result = await authenticateAudiobookStream({
            sql,
            token,
            mediaId,
            clientIp: '203.0.113.5',
            // ABS knows nobody by this Lumastra username.
            credentialDeps: fakeAbs('somebody-else-entirely'),
        });

        expect(result).toMatchObject({ ok: false, status: 403, reason: 'no_abs_link' });
    });
});

describe('extractStreamToken', () => {
    const url = new URL('https://lumastra.test/api/v1/audiobook/M/file/1');

    it('rejects path-carried credentials and stream Bearer credentials', () => {
        const req = new Request(url, { headers: { Authorization: 'Bearer stream_fromheader' } });
        expect(extractStreamToken(req, url, 'stream_frompath')).toBeNull();
    });

    it('reads ?grant= for clients that cannot set headers (AVPlayer)', () => {
        const withQuery = new URL(url);
        withQuery.searchParams.set('grant', 'stream_fromquery');
        expect(extractStreamToken(new Request(withQuery), withQuery)).toBe('stream_fromquery');
    });

    it('leaves account Bearer authentication to middleware', () => {
        const req = new Request(url, { headers: { Authorization: 'Bearer stream_fromheader' } });
        expect(extractStreamToken(req, url)).toBeNull();
    });

    it('ignores a non-stream credential in any position', () => {
        const withQuery = new URL(url);
        withQuery.searchParams.set('stream_token', 'pat_abc');
        const req = new Request(withQuery, { headers: { Authorization: 'Bearer pat_abc' } });
        expect(extractStreamToken(req, withQuery, 'pat_abc')).toBeNull();
    });
});
