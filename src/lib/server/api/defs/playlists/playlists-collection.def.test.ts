// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/playlists/index.ts — playlist collection endpoint.
 *
 * Key invariant:
 *   POST with visibility=public and insufficient permission → 403 (not a silent
 *   private downgrade). Returns 403 so clients know their intent was not honoured.
 *
 * All external I/O is mocked — no DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('$lib/server/services/image-descriptor/avatars.js', async () => {
    const { userAvatarSet } = await import('$lib/server/services/image-descriptor/resolver.js');
    return {
        userImageSets: async (_sql: unknown, surface: 'internal' | 'v1', ids: string[]) =>
            new Map(
                ids.map((userId) => [userId, userAvatarSet(surface, { userId, version: '0' })]),
            ),
    };
});

import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// Mocked user-lookup: always resolves to a fixed userId. Must be a real UUID
// — GET now passes it through toUserId() (N1, ensureWatchlistPlaylist call),
// which throws on a non-UUID string.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('00000000-0000-0000-0000-0000000001c3'),
}));

// Mocked playlist queries — we won't exercise the happy path through DB
const mockGetOwnedPlaylists = vi.fn().mockResolvedValue([]);
const mockGetSharedPlaylists = vi.fn().mockResolvedValue([]);
const mockGetPublicPlaylists = vi.fn().mockResolvedValue([]);
const mockCreatePlaylist = vi.fn();

vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getOwnedPlaylists: (...args: unknown[]) => mockGetOwnedPlaylists(...args),
    getSharedPlaylists: (...args: unknown[]) => mockGetSharedPlaylists(...args),
    getPublicPlaylists: (...args: unknown[]) => mockGetPublicPlaylists(...args),
    createPlaylist: (...args: unknown[]) => mockCreatePlaylist(...args),
}));

vi.mock('$lib/server/utils/playlist-transforms.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/playlist-transforms.js')>()),
    transformPlaylistRow: vi.fn((row) => row),
    // Collection tests use minimal rows and isolate transformation/database I/O.
    playlistWithImages: vi.fn(async (_sql, row) => row),
    playlistsWithImages: vi.fn(async (_sql: unknown, entries: PlaylistImageEntry[]) =>
        entries.map(({ row, role }) => ({ ...row, role })),
    ),
}));

// N1 (2026-09-22 edge-case pass): GET now ensures the caller's watchlist
// playlist exists (scope!=='public') before listing. Mocked here — this file
// tests the collection endpoint's own listing/pagination behaviour, not
// ensureWatchlistPlaylist itself (see watchlist-playlist.queries.ts for that).
const mockEnsureWatchlistPlaylist = vi.fn().mockResolvedValue(1);
vi.mock('$lib/server/database/queries/watchlist-playlist.queries.js', () => ({
    ensureWatchlistPlaylist: (...args: unknown[]) => mockEnsureWatchlistPlaylist(...args),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        username: 'tester',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: true,
        showUnavailableMedia: true,
    }),
    unauthenticatedSearchAccessContext: vi.fn(() => ({
        username: null,
        deniedGroupIds: null,
        ageRating: { maxAgeRating: -1, allowUnrated: false },
        liveTvAllowed: false,
        showUnavailableMedia: false,
    })),
    // The def now projects the context onto a MediaAccessBoundary via this
    // adapter instead of hand-building a { deniedGroupIds, ageRating } literal.
    // Mocking the module wholesale means this must be stubbed too, or the def
    // calls undefined at runtime. The stub mirrors the real mapping rather than
    // returning a constant, so the fallback test below still observes which
    // boundary the unauthenticated context actually projects to.
    searchAccessBoundary: vi.fn(
        (ctx: {
            deniedGroupIds: string[] | null;
            ageRating: { maxAgeRating: number | null; allowUnrated: boolean } | null;
        }) => ({
            library:
                ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0
                    ? { kind: 'denyGroups', ids: ctx.deniedGroupIds }
                    : { kind: 'all' },
            age:
                ctx.ageRating && ctx.ageRating.maxAgeRating !== null
                    ? {
                          kind: 'limit',
                          maxAgeRating: ctx.ageRating.maxAgeRating,
                          allowUnrated: ctx.ageRating.allowUnrated,
                      }
                    : { kind: 'any' },
        }),
    ),
}));

// canCreatePublicPlaylist is the key toggle for the no-silent-downgrade test
const mockCanCreatePublicPlaylist = vi.fn();
vi.mock('$lib/server/config.js', () => ({
    canCreatePublicPlaylist: (...args: unknown[]) => mockCanCreatePublicPlaylist(...args),
}));

// ── Import def AFTER mocks are set up ────────────────────────────────────────

const { def } = await import('./index.js');

const ctx: ApiContext = {
    surface: 'v1',
};

import {
    playlistsWithImages,
    type PlaylistImageEntry,
} from '$lib/server/utils/playlist-transforms.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal RequestEvent stub for POST /playlists */
function makePostEvent(
    body: unknown,
    {
        username = 'alice',
        userGroups = [] as string[],
    }: { username?: string; userGroups?: string[] } = {},
): Partial<RequestEvent> {
    return {
        request: new Request('http://localhost/api/v1/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL('http://localhost/api/v1/playlists'),
        params: {},
        locals: {
            principal: { username, userGroups },
        } as RequestEvent['locals'],
    };
}

/** Minimal RequestEvent stub for GET /playlists */
function makeGetEvent({
    username = 'alice',
    search = '',
}: { username?: string; search?: string } = {}): Partial<RequestEvent> {
    return {
        request: new Request(`http://localhost/api/v1/playlists${search}`),
        url: new URL(`http://localhost/api/v1/playlists${search}`),
        params: {},
        locals: {
            principal: { username },
        } as RequestEvent['locals'],
    };
}

// ── Tests: auth invariants ────────────────────────────────────────────────────

describe('defs/playlists/index (playlist collection)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetOwnedPlaylists.mockResolvedValue([]);
        mockGetSharedPlaylists.mockResolvedValue([]);
    });

    describe('def.auth shape', () => {
        it('requires user auth for GET', () => {
            const authSpec = (def.auth as Record<string, unknown>).GET;
            expect(authSpec).toMatchObject({
                kind: 'feature',
                flag: 'playlists',
                then: { kind: 'user' },
            });
        });

        it('requires user auth for POST', () => {
            const authSpec = (def.auth as Record<string, unknown>).POST;
            expect(authSpec).toMatchObject({
                kind: 'feature',
                flag: 'playlists',
                then: { kind: 'user' },
            });
        });
    });

    describe('GET /playlists', () => {
        it('returns an {items, page} envelope', async () => {
            const event = makeGetEvent();
            const res = await def.handlers.GET!(event as RequestEvent, ctx);
            const body = (await (res as Response).json()) as {
                items: unknown[];
                page: Record<string, unknown>;
            };
            expect(Array.isArray(body.items)).toBe(true);
            expect(typeof body.page).toBe('object');
        });

        it('returns 401 when no authenticated user', async () => {
            const event = {
                ...makeGetEvent(),
                locals: {} as RequestEvent['locals'],
            };
            const res = await def.handlers.GET!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(401);
        });

        it('enriches only the requested page across the owned/shared boundary', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([{ id: 1 }, { id: 2 }]);
            mockGetSharedPlaylists.mockResolvedValue([{ id: 3, role: 'editor' }, { id: 4 }]);
            const response = await def.handlers.GET!(
                makeGetEvent({ search: '?offset=1&limit=2' }) as RequestEvent,
                ctx,
            );
            expect(await (response as Response).json()).toEqual({
                items: [
                    { id: 2, role: 'owner' },
                    { id: 3, role: 'editor' },
                ],
                page: { limit: 2, offset: 1, hasMore: true },
            });
            expect(vi.mocked(playlistsWithImages).mock.calls[0][1]).toEqual([
                { row: { id: 2 }, role: 'owner' },
                { row: { id: 3, role: 'editor' }, role: 'editor' },
            ]);
        });

        it('does not enrich off-page summaries for an empty final page', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([{ id: 1 }, { id: 2 }]);
            const response = await def.handlers.GET!(
                makeGetEvent({ search: '?offset=20&limit=1' }) as RequestEvent,
                ctx,
            );
            expect(await (response as Response).json()).toEqual({
                items: [],
                page: { limit: 1, offset: 20, hasMore: false },
            });
            expect(vi.mocked(playlistsWithImages).mock.calls[0][1]).toEqual([]);
        });

        it('merges owned and shared playlists into a single items array', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([{ id: 1, name: 'My List' }]);
            mockGetSharedPlaylists.mockResolvedValue([
                { id: 2, name: 'Shared List', role: 'editor' },
            ]);

            const event = makeGetEvent();
            const res = await def.handlers.GET!(event as RequestEvent, ctx);
            const body = (await (res as Response).json()) as { items: unknown[] };
            expect(body.items).toHaveLength(2);
        });
    });

    describe('GET /playlists — scope', () => {
        beforeEach(() => {
            mockGetOwnedPlaylists.mockClear().mockResolvedValue([]);
            mockGetSharedPlaylists.mockClear().mockResolvedValue([]);
            mockGetPublicPlaylists.mockClear().mockResolvedValue([]);
        });

        it('defaults to owned when scope is absent', async () => {
            await def.handlers.GET!(makeGetEvent() as RequestEvent, ctx);

            expect(mockGetOwnedPlaylists).toHaveBeenCalled();
            expect(mockGetSharedPlaylists).toHaveBeenCalled();
            expect(mockGetPublicPlaylists).not.toHaveBeenCalled();
        });

        it('scope=owned behaves identically to no scope', async () => {
            await def.handlers.GET!(makeGetEvent({ search: '?scope=owned' }) as RequestEvent, ctx);

            expect(mockGetOwnedPlaylists).toHaveBeenCalled();
            expect(mockGetSharedPlaylists).toHaveBeenCalled();
            expect(mockGetPublicPlaylists).not.toHaveBeenCalled();
        });

        it('scope=public queries only the public feed', async () => {
            await def.handlers.GET!(makeGetEvent({ search: '?scope=public' }) as RequestEvent, ctx);

            expect(mockGetPublicPlaylists).toHaveBeenCalled();
            expect(mockGetOwnedPlaylists).not.toHaveBeenCalled();
            expect(mockGetSharedPlaylists).not.toHaveBeenCalled();
        });

        it('passes limit and offset-mode pagination through to the public query for SQL paging', async () => {
            await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=20&offset=40' }) as RequestEvent,
                ctx,
            );

            const args = mockGetPublicPlaylists.mock.calls[0];
            expect(args[3]).toBe(20); // limit
            expect(args[4]).toEqual({ mode: 'offset', offset: 40 }); // pagination
        });

        it('passes the type filter through to the public query', async () => {
            await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&type=video' }) as RequestEvent,
                ctx,
            );

            expect(mockGetPublicPlaylists.mock.calls[0][2]).toBe('video');
        });

        it('passes the viewer access context through to the public query', async () => {
            await def.handlers.GET!(makeGetEvent({ search: '?scope=public' }) as RequestEvent, ctx);

            const access = mockGetPublicPlaylists.mock.calls[0][5] as Record<string, unknown>;
            expect(access).toBeDefined();
            // Required-by-shape MediaAccessBoundary: both axes always present.
            expect(access).toHaveProperty('library');
            expect(access).toHaveProperty('age');
        });

        it('passes the viewer access context through to the owned and shared queries', async () => {
            await def.handlers.GET!(makeGetEvent() as RequestEvent, ctx);

            const ownedAccess = mockGetOwnedPlaylists.mock.calls[0][3] as Record<string, unknown>;
            const sharedAccess = mockGetSharedPlaylists.mock.calls[0][3] as Record<string, unknown>;
            expect(ownedAccess).toHaveProperty('library');
            expect(ownedAccess).toHaveProperty('age');
            expect(sharedAccess).toHaveProperty('library');
            expect(sharedAccess).toHaveProperty('age');
        });

        it('falls back to unauthenticatedSearchAccessContext when locals.user is unset', async () => {
            // makeGetEvent only sets locals.principal, never locals.user — so every
            // existing test in this file already exercises the fail-closed branch
            // in index.ts (`user ? buildSearchAccessContext(...) :
            // unauthenticatedSearchAccessContext()`). Prove the fallback context —
            // not a permissive one — is what actually reaches the query.
            await def.handlers.GET!(makeGetEvent({ search: '?scope=public' }) as RequestEvent, ctx);

            const access = mockGetPublicPlaylists.mock.calls[0][5] as {
                library: { kind: string; ids?: string[] };
                age: { kind: string; maxAgeRating?: number; allowUnrated?: boolean };
            };
            // The unauthenticated context's maxAgeRating: -1 sentinel projects to
            // an age LIMIT, and its deniedGroupIds: null leaves the LIBRARY axis
            // fully open. That asymmetry is the sentinel the access-boundary spec
            // exists to remove; pinned here so replacing it with a real
            // library.denyAll is a visible, deliberate change rather than a
            // silent one.
            expect(access.library.kind).toBe('all');
            expect(access.age).toEqual({ kind: 'limit', maxAgeRating: -1, allowUnrated: false });
        });

        it('reports hasMore when the public query returns limit + 1 rows', async () => {
            const row = (id: number) => ({ id, role: 'readonly' });
            mockGetPublicPlaylists.mockResolvedValue([row(1), row(2), row(3)]);

            const res = await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=2&offset=0' }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as {
                items: unknown[];
                page: { hasMore: boolean };
            };

            expect(body.items).toHaveLength(2); // the extra row is sliced off
            expect(body.page.hasMore).toBe(true);
        });

        it('reports hasMore false when exactly limit rows come back', async () => {
            const row = (id: number) => ({ id, role: 'readonly' });
            mockGetPublicPlaylists.mockResolvedValue([row(1), row(2)]);

            const res = await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=2&offset=0' }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as {
                items: unknown[];
                page: { hasMore: boolean };
            };

            expect(body.items).toHaveLength(2);
            expect(body.page.hasMore).toBe(false);
        });

        it('keeps owner-role rows ahead of shared rows in scope=owned', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([
                { id: 2, updated_at: '2026-07-01T00:00:00.000Z' },
            ]);
            mockGetSharedPlaylists.mockResolvedValue([
                { id: 1, updated_at: '2026-07-20T00:00:00.000Z', role: 'editor' },
            ]);

            const res = await def.handlers.GET!(makeGetEvent() as RequestEvent, ctx);
            const body = (await (res as Response).json()) as { items: Array<{ id: number }> };

            // The shared row is NEWER, but owner rows must still come first —
            // this is the pre-existing concatenation contract.
            expect(body.items[0].id).toBe(2);
        });
    });

    describe('GET /playlists — cursor pagination (scope=public)', () => {
        beforeEach(() => {
            mockGetPublicPlaylists.mockClear().mockResolvedValue([]);
        });

        // The def now emits cursors via the shared keyset-cursor builder, which
        // uses base64url. Match that here so page.nextCursor assertions compare like
        // for like.
        function encodeCursor(updatedAt: string, id: string): string {
            return Buffer.from(`${updatedAt}:${id}`, 'utf-8').toString('base64url');
        }

        it('decodes a legacy plain-base64 cursor (in-flight cursor compatibility)', async () => {
            // Cursors minted by the OLD local encoder used plain base64 (not
            // base64url). They must still decode after the migration onto the
            // shared builder — base64 and base64url round-trip byte-identically
            // through Buffer.from(x, 'base64url').
            const legacy = Buffer.from('2026-07-20T00:00:00.000Z:42', 'utf-8').toString('base64');
            await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=public&cursor=${encodeURIComponent(legacy)}`,
                }) as RequestEvent,
                ctx,
            );

            const pagination = mockGetPublicPlaylists.mock.calls[0][4];
            expect(pagination).toEqual({
                mode: 'cursor',
                cursor: { updatedAt: '2026-07-20T00:00:00.000Z', id: '42' },
            });
        });

        it('no cursor param → query receives offset mode (backward compat)', async () => {
            await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=10&offset=5' }) as RequestEvent,
                ctx,
            );

            const pagination = mockGetPublicPlaylists.mock.calls[0][4];
            expect(pagination).toEqual({ mode: 'offset', offset: 5 });
        });

        it('cursor param present → query receives cursor mode, offset ignored', async () => {
            const cursor = encodeCursor('2026-07-20T00:00:00.000Z', '42');
            await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=public&limit=10&offset=999&cursor=${encodeURIComponent(cursor)}`,
                }) as RequestEvent,
                ctx,
            );

            const pagination = mockGetPublicPlaylists.mock.calls[0][4];
            expect(pagination).toEqual({
                mode: 'cursor',
                cursor: { updatedAt: '2026-07-20T00:00:00.000Z', id: '42' },
            });
        });

        it('malformed/undecodable cursor → validation error, query never called', async () => {
            const res = await def.handlers.GET!(
                makeGetEvent({
                    search: '?scope=public&cursor=not-valid-base64!!!',
                }) as RequestEvent,
                ctx,
            );

            // ApiProblem.validationFailed() — this repo's convention for a bad
            // request is 422, not 400 (see the sibling POST-body test below).
            expect((res as Response).status).toBe(422);
            expect(mockGetPublicPlaylists).not.toHaveBeenCalled();
        });

        it('well-formed base64 decoding to garbage (no valid timestamp/id) → validation error, query never called', async () => {
            // `not-valid-base64!!!` only passes by luck — it decodes to bytes with
            // no colon, hitting the idx<=0 branch. This cursor decodes cleanly
            // (Buffer.from(..., 'base64') never throws) into { updatedAt: 'foo',
            // id: 'bar' }, which without component validation would reach
            // Postgres as 'foo'::timestamptz and 500 (SQLSTATE 22007).
            const cursor = Buffer.from('foo:bar', 'utf-8').toString('base64');
            const res = await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=public&cursor=${encodeURIComponent(cursor)}`,
                }) as RequestEvent,
                ctx,
            );

            expect((res as Response).status).toBe(422);
            expect(mockGetPublicPlaylists).not.toHaveBeenCalled();
        });

        it('emits page.nextCursor encoding the last returned row when hasMore is true', async () => {
            const row = (id: number, updatedAt: string) => ({
                id,
                role: 'readonly',
                updated_at: updatedAt,
                updated_at_cursor: updatedAt,
            });
            mockGetPublicPlaylists.mockResolvedValue([
                row(1, '2026-07-20T00:00:00.000Z'),
                row(2, '2026-07-19T00:00:00.000Z'),
                row(3, '2026-07-18T00:00:00.000Z'), // the +1 lookahead row
            ]);
            const cursor = encodeCursor('2026-07-21T00:00:00.000Z', '99');

            const res = await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=public&limit=2&cursor=${encodeURIComponent(cursor)}`,
                }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as {
                page: { hasMore: boolean; nextCursor?: string };
            };

            expect(body.page.hasMore).toBe(true);
            expect(body.page.nextCursor).toBe(encodeCursor('2026-07-19T00:00:00.000Z', '2'));
        });

        it('omits page.nextCursor in cursor mode when hasMore is false', async () => {
            const row = (id: number, updatedAt: string) => ({
                id,
                role: 'readonly',
                updated_at: updatedAt,
            });
            mockGetPublicPlaylists.mockResolvedValue([
                row(1, '2026-07-20T00:00:00.000Z'),
                row(2, '2026-07-19T00:00:00.000Z'),
            ]);
            const cursor = encodeCursor('2026-07-21T00:00:00.000Z', '99');

            const res = await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=public&limit=2&cursor=${encodeURIComponent(cursor)}`,
                }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as { page: { nextCursor?: string } };

            expect(body.page.nextCursor).toBeUndefined();
        });

        it('Gate J1: emits page.nextCursor alongside offset on a cursor-eligible offset-mode response when hasMore', async () => {
            const row = (id: number, updatedAt: string) => ({
                id,
                role: 'readonly',
                updated_at: updatedAt,
                updated_at_cursor: updatedAt,
            });
            mockGetPublicPlaylists.mockResolvedValue([
                row(1, '2026-07-20T00:00:00.000Z'),
                row(2, '2026-07-19T00:00:00.000Z'),
                row(3, '2026-07-18T00:00:00.000Z'), // +1 lookahead row
            ]);

            const res = await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=2&offset=0' }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as {
                page: { offset?: number; nextCursor?: string; hasMore: boolean };
            };

            // scope=public is cursor-eligible: an offset response carries BOTH
            // offset (the mechanism that produced this page) and cursor (the
            // bootstrap handoff for the next request).
            expect(body.page.hasMore).toBe(true);
            expect(body.page.offset).toBe(0);
            expect(body.page.nextCursor).toBe(encodeCursor('2026-07-19T00:00:00.000Z', '2'));
        });

        it('does not emit page.nextCursor on an offset-mode response when hasMore is false', async () => {
            const row = (id: number, updatedAt: string) => ({
                id,
                role: 'readonly',
                updated_at: updatedAt,
                updated_at_cursor: updatedAt,
            });
            mockGetPublicPlaylists.mockResolvedValue([
                row(1, '2026-07-20T00:00:00.000Z'),
                row(2, '2026-07-19T00:00:00.000Z'),
            ]);

            const res = await def.handlers.GET!(
                makeGetEvent({ search: '?scope=public&limit=2&offset=0' }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as { page: { nextCursor?: string } };

            expect(body.page.nextCursor).toBeUndefined();
        });

        it('never emits page.nextCursor for the non-cursor-eligible scope=owned path', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([
                {
                    id: 1,
                    updated_at: '2026-07-20T00:00:00.000Z',
                    updated_at_cursor: '2026-07-20T00:00:00.000Z',
                },
                {
                    id: 2,
                    updated_at: '2026-07-19T00:00:00.000Z',
                    updated_at_cursor: '2026-07-19T00:00:00.000Z',
                },
                {
                    id: 3,
                    updated_at: '2026-07-18T00:00:00.000Z',
                    updated_at_cursor: '2026-07-18T00:00:00.000Z',
                },
            ]);
            mockGetSharedPlaylists.mockResolvedValue([]);

            const res = await def.handlers.GET!(
                makeGetEvent({ search: '?limit=2&offset=0' }) as RequestEvent,
                ctx,
            );
            const body = (await (res as Response).json()) as { page: { nextCursor?: string } };

            expect(body.page.nextCursor).toBeUndefined();
        });

        it('ignores a cursor sent with scope=owned — owned path unchanged', async () => {
            mockGetOwnedPlaylists.mockResolvedValue([
                { id: 1, updated_at: '2026-07-01T00:00:00.000Z' },
            ]);
            mockGetSharedPlaylists.mockResolvedValue([]);
            const cursor = encodeCursor('2026-07-20T00:00:00.000Z', '42');

            const res = await def.handlers.GET!(
                makeGetEvent({
                    search: `?scope=owned&cursor=${encodeURIComponent(cursor)}`,
                }) as RequestEvent,
                ctx,
            );

            expect((res as Response).status).toBe(200);
            expect(mockGetPublicPlaylists).not.toHaveBeenCalled();
            expect(mockGetOwnedPlaylists).toHaveBeenCalled();
            const body = (await (res as Response).json()) as { items: unknown[] };
            expect(body.items).toHaveLength(1);
        });
    });

    describe('POST /playlists — no-silent-downgrade', () => {
        it('returns 403 when requesting public visibility without permission', async () => {
            // Core invariant: no silent downgrade to private
            mockCanCreatePublicPlaylist.mockReturnValue(false);

            const event = makePostEvent(
                { name: 'My Public List', visibility: 'public' },
                { userGroups: [] },
            );
            const res = await def.handlers.POST!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(403);
            expect((res as Response).headers.get('content-type')).toMatch(
                'application/problem+json',
            );
        });

        it('does NOT call createPlaylist when public is forbidden', async () => {
            mockCanCreatePublicPlaylist.mockReturnValue(false);

            const event = makePostEvent({ name: 'My Public List', visibility: 'public' });
            await def.handlers.POST!(event as RequestEvent, ctx);
            expect(mockCreatePlaylist).not.toHaveBeenCalled();
        });

        it('creates playlist and returns 201 when user has public permission', async () => {
            mockCanCreatePublicPlaylist.mockReturnValue(true);
            mockCreatePlaylist.mockResolvedValue({
                id: 99,
                name: 'My Public List',
                visibility: 'public',
                playlist_type: 'general',
                description: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });

            const event = makePostEvent({ name: 'My Public List', visibility: 'public' });
            const res = await def.handlers.POST!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(201);
            expect((res as Response).headers.get('Location')).toContain('/playlists/99');
        });

        it('creates private playlist without canCreatePublicPlaylist check', async () => {
            mockCanCreatePublicPlaylist.mockReturnValue(false); // irrelevant for private
            mockCreatePlaylist.mockResolvedValue({
                id: 100,
                name: 'Private List',
                visibility: 'private',
                playlist_type: 'general',
                description: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });

            const event = makePostEvent({ name: 'Private List', visibility: 'private' });
            const res = await def.handlers.POST!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(201);
        });

        it('returns 422 for invalid create body', async () => {
            const event = makePostEvent({ name: '' }); // name is required (min 1)
            const res = await def.handlers.POST!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(422);
            expect((res as Response).headers.get('content-type')).toMatch(
                'application/problem+json',
            );
        });

        it('returns 401 when no authenticated user', async () => {
            const event = {
                ...makePostEvent({ name: 'Test' }),
                locals: {} as RequestEvent['locals'],
            };
            const res = await def.handlers.POST!(event as RequestEvent, ctx);
            expect((res as Response).status).toBe(401);
        });
    });
});
