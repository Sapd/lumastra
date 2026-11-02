// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * M14 — unit tests for `checkMediaAccess()` in media-access.ts.
 *
 * Characterizes the inline access-check helper used by routes that cannot use
 * middleware composition (Jellyfin compat, watch-together). It combines a
 * library-group check (`isMediaAccessible`, mocked here) with the in-module
 * age-rating gate (exercised for real via a stubbed `sql` tagged-template).
 *
 * `checkMediaAccess` is fail-OPEN on `!user` (returns true) — callers MUST
 * have already run their own auth gate (`requireAuth`/`withIdResolution`/etc.)
 * before calling this helper; it does not authenticate on its own, it only
 * authorizes an already-identified user against library/age restrictions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockConfig = vi.hoisted(() => ({ UNRATED_CONTENT_VISIBLE: false, FEATURE_LIVETV: true }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: vi.fn(() => undefined),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

const mockIsMediaAccessible = vi.fn();
vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/cache/library-group-permissions-cache.js')
        >();
    return {
        ...actual,
        isMediaAccessible: (...args: unknown[]) => mockIsMediaAccessible(...args),
    };
});

// ── Import after mocks ────────────────────────────────────────────────────────

import { checkMediaAccess, userNeedsMediaAccessCheck, withAgeGate } from './media-access.js';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        username: 'alice',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: true,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

/** Tagged-template-callable stub standing in for a postgres.Sql connection. */
function makeSql(ageRating: number | null): Sql {
    const fn = vi.fn(async () => [{ age_rating: ageRating }]);
    return fn as unknown as Sql;
}

let idCounter = 0;
/** Fresh UUID per test so media-access.ts's module-level age-rating L1 cache
 * (keyed by mediaId) never leaks a cached value between test cases. */
function freshMediaId(): string {
    idCounter += 1;
    return `aaaaaaaa-aaaa-aaaa-aaaa-${idCounter.toString().padStart(12, '0')}`;
}

beforeEach(() => {
    mockIsMediaAccessible.mockReset();
    mockConfig.UNRATED_CONTENT_VISIBLE = false;
    mockConfig.FEATURE_LIVETV = true;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('checkMediaAccess — !user fails open (returns true)', () => {
    it('returns true for an unauthenticated caller without touching the DB or library gate', async () => {
        const sql = makeSql(null);
        const result = await checkMediaAccess(sql, freshMediaId(), undefined);
        expect(result).toBe(true);
        expect(mockIsMediaAccessible).not.toHaveBeenCalled();
    });
});

describe('checkMediaAccess — streaming compatibility', () => {
    it('preserves the unrestricted raw non-UUID fallback without a content query', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const sql = vi.fn(async () => {
            throw new Error('invalid input syntax for uuid');
        });
        expect(await checkMediaAccess(sql as unknown as Sql, 'abs-raw-item-id', makeUser())).toBe(
            true,
        );
        expect(sql).not.toHaveBeenCalled();
    });

    it('adds no retirement query for file-backed HLS/audio callers', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const sql = vi.fn(async () => []);
        expect(
            await checkMediaAccess(sql as unknown as Sql, freshMediaId(), makeUser(), {
                fileBacked: true,
            }),
        ).toBe(true);
        expect(sql).not.toHaveBeenCalled();
    });
});

describe('checkMediaAccess — admin bypass', () => {
    it('returns true for an admin user (library gate reports accessible, no age restriction)', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const admin = makeUser({ ownerIsAdmin: true, isAgeRestricted: false, maxAgeRating: null });
        const sql = makeSql(null);
        const result = await checkMediaAccess(sql, freshMediaId(), admin);
        expect(result).toBe(true);
        expect(mockIsMediaAccessible).toHaveBeenCalledWith(
            sql,
            expect.any(String),
            expect.objectContaining({ isAdmin: true }),
        );
    });
});

describe('checkMediaAccess — library-group denial', () => {
    it('returns false when isMediaAccessible reports the item is not accessible', async () => {
        mockIsMediaAccessible.mockResolvedValue(false);
        const user = makeUser({ ownerIsAdmin: false, isAgeRestricted: false });
        const sql = makeSql(null);
        const result = await checkMediaAccess(sql, freshMediaId(), user);
        expect(result).toBe(false);
    });

    it('fails closed (false) for a non-admin when the library check throws', async () => {
        mockIsMediaAccessible.mockRejectedValue(new Error('db error'));
        const user = makeUser({ ownerIsAdmin: false });
        const sql = makeSql(null);
        const result = await checkMediaAccess(sql, freshMediaId(), user);
        expect(result).toBe(false);
    });
});

describe('checkMediaAccess — age-rating denial', () => {
    it('returns false when the item age rating exceeds the user maxAgeRating', async () => {
        mockIsMediaAccessible.mockResolvedValue(true); // library gate passes
        const user = makeUser({ ownerIsAdmin: false, isAgeRestricted: true, maxAgeRating: 8 });
        const sql = makeSql(16); // item is rated above the user's ceiling
        const result = await checkMediaAccess(sql, freshMediaId(), user);
        expect(result).toBe(false);
    });

    it('returns true when the item age rating is within the user maxAgeRating', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const user = makeUser({ ownerIsAdmin: false, isAgeRestricted: true, maxAgeRating: 18 });
        const sql = makeSql(8);
        const result = await checkMediaAccess(sql, freshMediaId(), user);
        expect(result).toBe(true);
    });

    it('does not cache an episode that has no parent yet (ingest links it later)', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const user = makeUser({ ownerIsAdmin: false, isAgeRestricted: true, maxAgeRating: 8 });
        const rows = [
            { owner_id: null, age_rating: null, media_type: 'episode' }, // not linked yet
            { owner_id: 'series-1', age_rating: 6, media_type: 'episode' }, // linked
        ];
        const reads = vi.fn(async () => [rows.shift()]);
        // SQL builders also call sql(alias) and compose fragments. Only the
        // outer SELECT consumes a database response.
        const fn = vi.fn((strings: TemplateStringsArray | string) =>
            Array.isArray(strings) && strings.join(' ').includes('SELECT owner.id') ? reads() : [],
        );
        const sql = fn as unknown as Sql;
        const id = freshMediaId();

        expect(await checkMediaAccess(sql, id, user)).toBe(false); // unrated hidden
        expect(await checkMediaAccess(sql, id, user)).toBe(true); // re-queried, series rated 6
        expect(reads).toHaveBeenCalledTimes(2);
        expect(await checkMediaAccess(sql, id, user)).toBe(true); // now cached
        expect(reads).toHaveBeenCalledTimes(2);
    });

    it('folds audiobook availability into the library gate for a non-age-restricted user', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const user = makeUser({ ownerIsAdmin: false, isAgeRestricted: false });
        const read = vi.fn(async (_parts: TemplateStringsArray) => []);
        const result = await checkMediaAccess(read as unknown as Sql, freshMediaId(), user);
        expect(result).toBe(true);
        expect(read).not.toHaveBeenCalled();
        expect(mockIsMediaAccessible).toHaveBeenCalledWith(
            read,
            expect.any(String),
            expect.anything(),
            { checkAudiobookAvailability: true },
        );
    });
});

describe('credential admin capability controls media bypass', () => {
    it('does not fail open on library errors for a scoped admin owner', async () => {
        const user = { ...makeUser({ ownerIsAdmin: true }), mediaAccessIsAdmin: false };
        mockIsMediaAccessible.mockRejectedValue(new Error('db unavailable'));
        expect(await checkMediaAccess(makeSql(null), freshMediaId(), user)).toBe(false);
    });

    it('does not fail open on age errors for a scoped admin owner', async () => {
        const user = {
            ...makeUser({ ownerIsAdmin: true, isAgeRestricted: true, maxAgeRating: 8 }),
            mediaAccessIsAdmin: false,
        };
        mockIsMediaAccessible.mockResolvedValue(true);
        const sql = vi.fn(async () => {
            throw new Error('db unavailable');
        }) as unknown as Sql;
        expect(await checkMediaAccess(sql, freshMediaId(), user)).toBe(false);
        expect(await userNeedsMediaAccessCheck(sql, user)).toBe(true);
    });

    it('keeps admin-session library bypass', async () => {
        const user = { ...makeUser({ ownerIsAdmin: true }), mediaAccessIsAdmin: true };
        mockIsMediaAccessible.mockImplementation(
            async (_sql, _id, accessUser) => accessUser.isAdmin,
        );
        expect(await checkMediaAccess(makeSql(null), freshMediaId(), user)).toBe(true);
    });
});

describe('withAgeGate database unavailability', () => {
    it.each([false, true])(
        'uses credential admin capability (%s) instead of owner status',
        async (mediaAccessIsAdmin) => {
            const inner = vi.fn<RequestHandler>(async () => new Response('media'));
            const event = {
                locals: {
                    user: makeUser({
                        ownerIsAdmin: true,
                        mediaAccessIsAdmin,
                        isAgeRestricted: true,
                        maxAgeRating: 8,
                    }),
                    resolvedIds: { internalId: freshMediaId() },
                },
            } as unknown as RequestEvent;
            expect((await withAgeGate(inner)(event)).status).toBe(mediaAccessIsAdmin ? 200 : 500);
            expect(inner).toHaveBeenCalledTimes(mediaAccessIsAdmin ? 1 : 0);
        },
    );
});

describe('Live TV metadata on generic media surfaces', () => {
    describe.each([false, true])('age-restricted=%s, no Live TV permission', (isAgeRestricted) => {
        it.each([
            { result: 'no row', rows: [] },
            { result: 'null identity', rows: [{ is_live_tv: null, age_rating: 6 }] },
            { result: 'undefined identity', rows: [{ is_live_tv: undefined, age_rating: 6 }] },
        ])('denies when the combined read returns $result', async ({ rows }) => {
            mockIsMediaAccessible.mockResolvedValue(true);
            // A missing rating must pass the age gate so denial proves the
            // identity check fails closed, including when there is no row.
            mockConfig.UNRATED_CONTENT_VISIBLE = true;
            const sql = vi.fn().mockResolvedValue(rows);
            const user = makeUser({
                hasLiveTvPermission: false,
                isAgeRestricted,
                maxAgeRating: isAgeRestricted ? 12 : null,
            });
            expect(await checkMediaAccess(sql as unknown as Sql, freshMediaId(), user)).toBe(false);
            expect(sql).toHaveBeenCalled();
        });
    });

    it.each([false, true])(
        'hides channel IDs even with admin=%s and no age restriction',
        async (admin) => {
            mockIsMediaAccessible.mockResolvedValue(true);
            const sql = vi.fn().mockResolvedValue([{ is_live_tv: true }]) as unknown as Sql;
            const user = makeUser({
                hasLiveTvPermission: false,
                ownerIsAdmin: admin,
                mediaAccessIsAdmin: admin,
                isAgeRestricted: false,
            });
            expect(await checkMediaAccess(sql, '00000000-0000-0000-0000-000000000123', user)).toBe(
                false,
            );
        },
    );
    it.each([false, true])(
        'fails closed on the combined read even with admin=%s',
        async (admin) => {
            mockIsMediaAccessible.mockResolvedValue(true);
            const sql = vi.fn(async () => {
                throw new Error('identity read failed');
            }) as unknown as Sql;
            for (const isAgeRestricted of [false, true]) {
                expect(
                    await checkMediaAccess(
                        sql,
                        freshMediaId(),
                        makeUser({
                            hasLiveTvPermission: false,
                            ownerIsAdmin: admin,
                            mediaAccessIsAdmin: admin,
                            isAgeRestricted,
                        }),
                    ),
                ).toBe(false);
            }
        },
    );
    it('denies a channel identity even when the media row is missing', async () => {
        mockIsMediaAccessible.mockResolvedValue(true);
        const sql = vi.fn().mockResolvedValue([
            {
                owner_id: null,
                media_type: null,
                age_rating: null,
                is_live_tv: true,
            },
        ]) as unknown as Sql;
        expect(
            await checkMediaAccess(sql, freshMediaId(), makeUser({ hasLiveTvPermission: false })),
        ).toBe(false);
    });
    it('does not skip the media check when Live TV is disabled', async () => {
        expect(
            await userNeedsMediaAccessCheck(
                {} as Sql,
                makeUser({
                    hasLiveTvPermission: false,
                    ownerIsAdmin: true,
                    mediaAccessIsAdmin: true,
                }),
            ),
        ).toBe(true);
    });
});

it('C-3 follow-up: default install adds no content read for a file-backed VOD route', async () => {
    mockConfig.FEATURE_LIVETV = false;
    const library = await import('$lib/server/cache/library-group-permissions-cache.js');
    const denied = vi.spyOn(library, 'getDeniedLibraryGroups').mockResolvedValue(null);
    try {
        mockIsMediaAccessible.mockResolvedValue(true);
        const user = makeUser({ hasLiveTvPermission: false });
        const sql = vi.fn(async () => [{ is_live_tv: false, age_rating: null }]) as unknown as Sql;
        expect(await userNeedsMediaAccessCheck(sql, user)).toBe(false);
        expect(await checkMediaAccess(sql, freshMediaId(), user, { fileBacked: true })).toBe(true);
        expect(sql).not.toHaveBeenCalled();
    } finally {
        denied.mockRestore();
    }
});
it('C-3 follow-up: feature-off still checks channel metadata on a generic item route', async () => {
    mockConfig.FEATURE_LIVETV = false;
    mockIsMediaAccessible.mockResolvedValue(true);
    const sql = vi.fn(async () => [{ is_live_tv: true }]) as unknown as Sql;
    expect(
        await checkMediaAccess(sql, freshMediaId(), makeUser({ hasLiveTvPermission: false })),
    ).toBe(false);
    expect(sql).toHaveBeenCalled();
});
