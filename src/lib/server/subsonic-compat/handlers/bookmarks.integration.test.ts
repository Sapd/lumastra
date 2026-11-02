// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// bookmarks.integration.test.ts
//
// Integration tests for the OpenSubsonic bookmark handlers
// (getBookmarks, createBookmark, deleteBookmark).
//
// Verifies:
//   - createBookmark upserts a bookmark and returns ping ok
//   - getBookmarks hydrates stored bookmarks with track details
//   - deleteBookmark removes the bookmark entry
//   - Validation errors for missing/invalid id and position (error 10)
//   - Inaccessible track returns error 70
//   - Empty bookmark list returns empty bookmarks object
//   - Comment is preserved and returned
//
// Run locally:
//   npm run test:integration src/lib/server/subsonic-compat/handlers/bookmarks.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const cacheStore = new Map<string, string>();

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: vi.fn((key: string) => Promise.resolve(cacheStore.get(key) ?? null)),
    cacheSet: vi.fn((key: string, value: string, _ttl?: number) => {
        cacheStore.set(key, value);
        return Promise.resolve();
    }),
    cacheDel: vi.fn((key: string) => {
        cacheStore.delete(key);
        return Promise.resolve();
    }),
    getValkeyClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(() => Promise.resolve()),
    publishMessage: vi.fn(() => Promise.resolve()),
    connectValkey: vi.fn(() => Promise.resolve()),
    disconnectValkey: vi.fn(() => Promise.resolve()),
    isValkeyReady: vi.fn(() => false),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
    handleGetBookmarks,
    handleCreateBookmark,
    handleDeleteBookmark,
} from '$lib/server/subsonic-compat/handlers/bookmarks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// users.id UUID for the test user (mig 16.46.0 — user_id columns are now uuid)
const TEST_USER: UserId = toUserId(randomUUID());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockEvent(params: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost/rest/bookmarks');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    return {
        url,
        request: new Request(url.toString()),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/bookmarks' as const },
        cookies: {} as RequestEvent['cookies'],
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

function buildAuth(options?: { isAgeRestricted?: boolean }): SubsonicAuthContext {
    return {
        // userId is the UUID (users.id); username is the human-readable handle.
        // Tests pass both as the same UUID so handlers that use auth.username for
        // DB writes (pre-full-migration) still resolve to the same users row.
        userId: TEST_USER,
        username: TEST_USER,
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'integration-test',
        format: 'json',
        userGroups: [],
        maxAgeRating: 0,
        isAgeRestricted: options?.isAgeRestricted ?? false,
    };
}

async function parseJson<T>(response: Response): Promise<T> {
    return response.json() as Promise<T>;
}

interface SubsonicEnvelope<T> {
    'subsonic-response': T;
}

interface BookmarksPayload {
    status: 'ok' | 'failed';
    bookmarks?: {
        bookmark?: unknown[];
    };
    error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OpenSubsonic bookmark handlers', () => {
    let sql: postgres.Sql;
    let trackId: string;
    let _allMediaIds: string[];

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        cacheStore.clear();

        await sql`
            DELETE FROM media_file_items
            WHERE media_item_id IN (
                SELECT id FROM media_items WHERE title LIKE 'Bookmark Test%'
            )
        `;
        await sql`
            DELETE FROM media_files WHERE file_path LIKE '/test/music/bookmark%'
        `;
        await sql`DELETE FROM media_items WHERE title LIKE 'Bookmark Test%'`;
        // TEST_USER is a UUID (users.id); clean up by id, not username.
        await sql`DELETE FROM users WHERE id = ${TEST_USER}::uuid`;

        await ensureTestUser(sql, TEST_USER);

        const hierarchy = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Bookmark Test Artist',
            albumTitle: 'Bookmark Test Album',
            trackCount: 1,
        });

        trackId = hierarchy.trackIds[0];
        _allMediaIds = [hierarchy.artistId, hierarchy.albumId, ...hierarchy.trackIds];
    });

    // -----------------------------------------------------------------------
    // 1. createBookmark — success
    // -----------------------------------------------------------------------

    it('handleCreateBookmark creates a bookmark for a track and returns ok', async () => {
        const event = buildMockEvent({ id: trackId, position: '42000' });
        const resp = await handleCreateBookmark(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('ok');
    });

    // -----------------------------------------------------------------------
    // 2. getBookmarks — returns created bookmark
    // -----------------------------------------------------------------------

    it('handleGetBookmarks returns the created bookmark with track details, position, username', async () => {
        const createEvent = buildMockEvent({ id: trackId, position: '42000' });
        await handleCreateBookmark(createEvent, buildAuth(), sql);

        const getEvent = buildMockEvent({});
        const resp = await handleGetBookmarks(getEvent, buildAuth(), sql);
        expect(resp.status).toBe(200);

        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('ok');

        const bookmarkList = body['subsonic-response'].bookmarks?.bookmark;
        expect(bookmarkList).toBeDefined();
        expect(bookmarkList).toHaveLength(1);

        const entry = bookmarkList![0] as Record<string, unknown>;
        expect(entry.position).toBe(42000);
        expect(entry.username).toBe(TEST_USER);
        expect(entry.entry).toBeDefined();
        expect((entry.entry as Record<string, unknown>).id).toBe(trackId);
    });

    // -----------------------------------------------------------------------
    // 3. deleteBookmark — removes bookmark, getBookmarks returns empty
    // -----------------------------------------------------------------------

    it('handleDeleteBookmark deletes the bookmark, then getBookmarks returns empty', async () => {
        const createEvent = buildMockEvent({ id: trackId, position: '42000' });
        await handleCreateBookmark(createEvent, buildAuth(), sql);

        const deleteEvent = buildMockEvent({ id: trackId });
        const delResp = await handleDeleteBookmark(deleteEvent, buildAuth(), sql);
        expect(delResp.status).toBe(200);

        const getEvent = buildMockEvent({});
        const getResp = await handleGetBookmarks(getEvent, buildAuth(), sql);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(getResp);
        const bookmarkList = body['subsonic-response'].bookmarks?.bookmark;
        expect(bookmarkList).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // 4. createBookmark on inaccessible track returns error 70
    // -----------------------------------------------------------------------

    it('handleCreateBookmark on inaccessible track returns error 70', async () => {
        const nonExistentId = '00000000-0000-4000-a000-00000000dead';
        const event = buildMockEvent({ id: nonExistentId, position: '1000' });
        const resp = await handleCreateBookmark(event, buildAuth({ isAgeRestricted: true }), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // 5. createBookmark without required id returns error 10
    // -----------------------------------------------------------------------

    it('handleCreateBookmark without required id param returns error 10', async () => {
        const event = buildMockEvent({ position: '42000' });
        const resp = await handleCreateBookmark(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 6. createBookmark without required position returns error 10
    // -----------------------------------------------------------------------

    it('handleCreateBookmark without required position param returns error 10', async () => {
        const event = buildMockEvent({ id: trackId });
        const resp = await handleCreateBookmark(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 7. createBookmark with negative position returns error 10
    // -----------------------------------------------------------------------

    it('handleCreateBookmark with negative position returns error 10', async () => {
        const event = buildMockEvent({ id: trackId, position: '-5' });
        const resp = await handleCreateBookmark(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 8. deleteBookmark without required id returns error 10
    // -----------------------------------------------------------------------

    it('handleDeleteBookmark without required id returns error 10', async () => {
        const event = buildMockEvent({});
        const resp = await handleDeleteBookmark(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('failed');
        expect(body['subsonic-response'].error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 9. getBookmarks returns empty when no bookmarks exist
    // -----------------------------------------------------------------------

    it('handleGetBookmarks returns empty when no bookmarks exist', async () => {
        const event = buildMockEvent({});
        const resp = await handleGetBookmarks(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        expect(body['subsonic-response'].status).toBe('ok');
        expect(body['subsonic-response'].bookmarks?.bookmark).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // 10. createBookmark with comment includes comment in get response
    // -----------------------------------------------------------------------

    it('handleCreateBookmark with comment includes comment in get response', async () => {
        const comment = 'Resume from chorus';
        const createEvent = buildMockEvent({
            id: trackId,
            position: '12345',
            comment,
        });
        await handleCreateBookmark(createEvent, buildAuth(), sql);

        const getEvent = buildMockEvent({});
        const resp = await handleGetBookmarks(getEvent, buildAuth(), sql);
        const body = await parseJson<SubsonicEnvelope<BookmarksPayload>>(resp);
        const bookmarkList = body['subsonic-response'].bookmarks?.bookmark;
        expect(bookmarkList).toHaveLength(1);

        const entry = bookmarkList![0] as Record<string, unknown>;
        expect(entry.comment).toBe(comment);
        expect(entry.position).toBe(12345);
    });
});
