// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Users Query Module
 *
 * Tests upsertUser, getUserByUsername, listUsers, and setIsAdmin
 * against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { generateTestUserId } from '../../../../../tests/integration/fixtures/index.js';

import {
    upsertUser,
    insertFederatedUser,
    adminCreateUser,
    adminSetUserEmail,
    getActiveUsersByEmail,
    getUserLiveTvAllowed,
    setUserLiveTvAllowed,
    getUserByUsername,
    getUserById,
    getUsernamesByIds,
    listUsers,
    setIsAdmin,
    resolveJellyfinNamesToUserIds,
    searchUsersForDirectory,
    searchUsersForInvite,
    getUserAvatar,
    getUserAvatarVersion,
    setUserAvatar,
    deleteUserAvatar,
    setUserIdpAvatar,
} from './users.queries.js';
import { createPlaySession } from './play-sessions.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { config } from '$lib/server/config.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cleanupTestUsers(sql: postgres.Sql, usernames: string[]): Promise<void> {
    if (usernames.length === 0) return;
    await sql`DELETE FROM users WHERE username = ANY(${usernames})`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Users Queries', () => {
    let sql: postgres.Sql;
    const createdUsernames: string[] = [];

    function newUsername(prefix = 'test_user'): string {
        const name = generateTestUserId(prefix);
        createdUsernames.push(name);
        return name;
    }

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanupTestUsers(sql, createdUsernames);
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clean up any rows from previous test in this suite
        await cleanupTestUsers(sql, createdUsernames);
        createdUsernames.length = 0;
    });

    it('stores a normalized admin email for immediate verified-email SSO matching', async () => {
        const username = newUsername();
        const id = await adminCreateUser(sql, {
            username,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
            email: ' Anna@Example.Test ',
        });
        const row = await getUserByUsername(sql, username);
        expect(row?.email).toBe('anna@example.test');
        expect((await getActiveUsersByEmail(sql, 'ANNA@example.test')).map((u) => u.id)).toEqual([
            id,
        ]);
        expect(row?.is_admin).toBe(false);
    });
    it('edits, repeats and clears matching email without changing restrictions', async () => {
        const username = newUsername();
        const id = (await adminCreateUser(sql, {
            username,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
        }))!;
        await sql`UPDATE users SET max_age_rating = 12, age_rating_pinned = true WHERE id = ${id}`;
        for (let i = 0; i < 2; i++)
            expect(await adminSetUserEmail(sql, id, ' Anna@Example.Test ')).toBe(true);
        expect(await getActiveUsersByEmail(sql, 'anna@example.test')).toEqual([{ id, username }]);
        expect(await getUserById(sql, id)).toMatchObject({
            is_admin: false,
            max_age_rating: 12,
            age_rating_pinned: true,
        });
        expect(await adminSetUserEmail(sql, id, '')).toBe(true);
        expect(await getActiveUsersByEmail(sql, 'anna@example.test')).toEqual([]);
    });
    it('rejects an edit to another account’s email and preserves the previous value', async () => {
        const first = newUsername();
        const second = newUsername();
        await adminCreateUser(sql, {
            username: first,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
            email: 'anna@example.test',
        });
        const id = (await adminCreateUser(sql, {
            username: second,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
            email: 'other@example.test',
        }))!;
        await expect(adminSetUserEmail(sql, id, 'ANNA@example.test')).rejects.toThrow('email');
        expect((await getUserById(sql, id))?.email).toBe('other@example.test');
    });

    it('serializes competing email claims from separate database connections', async () => {
        const connections = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        const names = [newUsername(), newUsername()];
        try {
            const results = await Promise.allSettled(
                connections.map((connection, index) =>
                    adminCreateUser(connection, {
                        username: names[index],
                        passwordHash: 'test-hash',
                        isAdmin: false,
                        groups: [],
                        email: 'race@example.test',
                    }),
                ),
            );
            expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
            expect(await getActiveUsersByEmail(sql, 'race@example.test')).toHaveLength(1);
        } finally {
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });

    it('refuses a duplicate admin email case-insensitively without creating another account', async () => {
        const first = newUsername();
        const second = newUsername();
        await adminCreateUser(sql, {
            username: first,
            passwordHash: 'test-hash',
            isAdmin: false,
            groups: [],
            email: 'anna@example.test',
        });
        await expect(
            adminCreateUser(sql, {
                username: second,
                passwordHash: 'test-hash',
                isAdmin: false,
                groups: [],
                email: 'ANNA@example.test',
            }),
        ).rejects.toThrow('email');
        expect(await getUserByUsername(sql, second)).toBeNull();
    });

    // ========================================================================
    // upsertUser
    // ========================================================================

    describe('Live TV permission defaults and writes', () => {
        it.each([insertFederatedUser, adminCreateUser])(
            'protects a newly provisioned age-limited account',
            async (create) => {
                const username = newUsername();
                await create(sql, {
                    username,
                    isAdmin: false,
                    groups: [`${config.AGE_RATING_GROUP_PREFIX}12`],
                    passwordHash: 'test-hash',
                });
                expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
            },
        );
        it.each([insertFederatedUser, adminCreateUser])(
            'allows a new unrestricted account',
            async (create) => {
                const username = newUsername();
                await create(sql, {
                    username,
                    isAdmin: false,
                    groups: [],
                    passwordHash: 'test-hash',
                });
                expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
            },
        );
        it('reads admin changes immediately and preserves explicit choices on repeated login', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
            await setUserLiveTvAllowed(sql, username, false);
            expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
            await setUserLiveTvAllowed(sql, username, false);
            await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
            expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
            await setUserLiveTvAllowed(sql, username, true);
            expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
            await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
            expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
        });
    });

    describe('upsertUser', () => {
        it.each([null, 0, 12])(
            'sets Live TV default for a new user with age %s',
            async (maxAgeRating) => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false, maxAgeRating });
                const row = await getUserByUsername(sql, username);
                expect((row as unknown as { allow_live_tv: boolean | null }).allow_live_tv).toBe(
                    maxAgeRating === null ? null : false,
                );
            },
        );

        it('preserves the existing Live TV default when an age limit is added on re-run', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
            const row = await getUserByUsername(sql, username);
            expect((row as unknown as { allow_live_tv: boolean | null }).allow_live_tv).toBeNull();
        });

        it('inserts a new user row', async () => {
            const username = newUsername();

            await upsertUser(sql, { username, isAdmin: false });

            const row = await getUserByUsername(sql, username);
            expect(row).not.toBeNull();
            expect(row!.username).toBe(username);
            expect(row!.is_admin).toBe(false);
        });

        it('sets is_admin from isAdmin param on first insert', async () => {
            const username = newUsername('admin_user');

            await upsertUser(sql, { username, isAdmin: true });

            const row = await getUserByUsername(sql, username);
            expect(row!.is_admin).toBe(true);
        });

        it('stores displayName but never persists an unverified forward-auth email', async () => {
            const username = newUsername();

            await upsertUser(sql, {
                username,
                isAdmin: false,
                displayName: 'Test User',
                email: 'test@example.com',
            });

            const row = await getUserByUsername(sql, username);
            expect(row!.display_name).toBe('Test User');
            expect(row!.email).toBeNull();
        });

        it('sets last_seen_at on insert', async () => {
            const username = newUsername();

            await upsertUser(sql, { username, isAdmin: false });

            const row = await getUserByUsername(sql, username);
            expect(row!.last_seen_at).not.toBeNull();
        });

        it('updates last_seen_at on conflict but does NOT change is_admin', async () => {
            const username = newUsername();

            // First insert — not admin
            await upsertUser(sql, { username, isAdmin: false });

            // Manually promote to admin
            await setIsAdmin(sql, username, true);

            // Second upsert — groups say false, but is_admin must remain true (sticky)
            await upsertUser(sql, { username, isAdmin: false });

            const row = await getUserByUsername(sql, username);
            expect(row!.is_admin).toBe(true); // sticky — not overwritten
        });

        // display_name backfill — the NAMEHEADER contract.
        //
        // Forward auth upserts on (almost) every request, and only some callers
        // carry a display name. So the ON CONFLICT clause has to be asymmetric:
        // a name that arrives must land even on a row created years earlier, and
        // a request without one must leave the stored name alone.
        it('backfills display_name on an existing row that has none', async () => {
            const username = newUsername();

            // Pre-NAMEHEADER row: created by a proxy that sent no name header.
            await upsertUser(sql, { username, isAdmin: false });
            expect((await getUserByUsername(sql, username))!.display_name).toBeNull();

            // Operator adds the header; the very next request fills it in — the
            // user does not have to be re-created.
            await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice Example' });

            expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice Example');
        });

        it('does NOT null out an existing display_name when none is supplied', async () => {
            const username = newUsername();

            await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice Example' });

            // A caller that never has a name (OIDC provisioning, native auth) or a
            // proxy that momentarily stops sending the header must not erase it.
            await upsertUser(sql, { username, isAdmin: false });

            expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice Example');
        });

        it('updates display_name when the IdP sends a new one', async () => {
            const username = newUsername();

            await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice Example' });
            await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice Newname' });

            expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice Newname');
        });

        it('upsert with same username twice does not throw', async () => {
            const username = newUsername();

            // upsertUser() now returns {id, isAdmin, demoted, promoted} (fix
            // round 1 review, security review 2026-09-16, Important 3) so
            // forward-auth.ts can narrow/restore admin-scoped credentials in
            // lockstep with an IdP-group-driven admin transition. Neither
            // call here changes is_admin, so both come back with demoted:
            // false, promoted: false.
            await expect(upsertUser(sql, { username, isAdmin: false })).resolves.toMatchObject({
                isAdmin: false,
                demoted: false,
                promoted: false,
            });
            await expect(upsertUser(sql, { username, isAdmin: false })).resolves.toMatchObject({
                isAdmin: false,
                demoted: false,
                promoted: false,
            });
        });

        it('reports demoted:true when an unpinned admin loses admin, and promoted:true on the way back', async () => {
            const username = newUsername();

            const created = await upsertUser(sql, { username, isAdmin: true });
            expect(created.demoted).toBe(false);
            expect(created.promoted).toBe(false); // brand-new row, nothing to promote FROM

            const demoted = await upsertUser(sql, { username, isAdmin: false });
            expect(demoted.isAdmin).toBe(false);
            expect(demoted.demoted).toBe(true);
            expect(demoted.promoted).toBe(false);

            const promoted = await upsertUser(sql, { username, isAdmin: true });
            expect(promoted.isAdmin).toBe(true);
            expect(promoted.demoted).toBe(false);
            expect(promoted.promoted).toBe(true);
        });

        it('never reports demoted/promoted for a PINNED user (the CASE never changes is_admin)', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: true });
            await setIsAdmin(sql, username, true); // pins it

            const result = await upsertUser(sql, { username, isAdmin: false });
            expect(result.isAdmin).toBe(true); // pin wins — CASE keeps users.is_admin
            expect(result.demoted).toBe(false);
            expect(result.promoted).toBe(false);
        });

        // Forward auth upserts on nearly every request. When the row already equals
        // what the ON CONFLICT branch would write and last_seen_at is fresh, the
        // statement must not touch the row at all (no new tuple version, so no row
        // lock queue behind slow commits) while returning the same result shape.
        describe('skips the write when nothing changed', () => {
            async function stamp(username: string): Promise<{ xmin: string; seen: string }> {
                const [r] = await sql<{ xmin: string; seen: string }[]>`
                    SELECT xmin::text AS xmin, last_seen_at::text AS seen
                    FROM users WHERE username = ${username}`;
                return r;
            }
            async function makeStale(username: string): Promise<void> {
                await sql`UPDATE users SET last_seen_at = NOW() - INTERVAL '5 minutes',
                                           updated_at = NOW() - INTERVAL '5 minutes'
                          WHERE username = ${username}`;
            }

            it('concurrent first logins of a new user create exactly one row without errors', async () => {
                const username = newUsername();
                const results = await Promise.all(
                    Array.from({ length: 5 }, () =>
                        upsertUser(sql, { username, isAdmin: false, displayName: 'Racer' }),
                    ),
                );
                const ids = new Set(results.map((r) => r.id));
                expect(ids.size).toBe(1);
                const [{ n }] = await sql<{ n: number }[]>`
                    SELECT COUNT(*)::int AS n FROM users WHERE username = ${username}`;
                expect(n).toBe(1);
                expect(results.every((r) => !r.promoted && !r.demoted)).toBe(true);
            });

            it('leaves the row untouched on an identical repeat and reports an unchanged result', async () => {
                const username = newUsername();
                const first = await upsertUser(sql, {
                    username,
                    isAdmin: true,
                    maxAgeRating: 12,
                    displayName: 'Alice',
                });
                expect(first.created).toBe(true);
                const before = await stamp(username);

                const again = await upsertUser(sql, {
                    username,
                    isAdmin: true,
                    maxAgeRating: 12,
                    displayName: 'Alice',
                });

                expect(await stamp(username)).toEqual(before);
                expect(again).toEqual({
                    id: first.id,
                    isAdmin: true,
                    demoted: false,
                    promoted: false,
                    created: false,
                });
            });

            it('a request without a display name does not count as a change', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice' });
                const before = await stamp(username);

                await upsertUser(sql, { username, isAdmin: false });

                expect(await stamp(username)).toEqual(before);
                expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice');
            });

            it('writes again once last_seen_at is older than the refresh window', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false });
                await makeStale(username);
                const before = await stamp(username);

                await upsertUser(sql, { username, isAdmin: false });

                const after = await stamp(username);
                expect(after.xmin).not.toBe(before.xmin);
                expect(new Date(after.seen).getTime()).toBeGreaterThan(
                    new Date(before.seen).getTime() + 4 * 60_000,
                );
            });

            it('writes when last_seen_at is NULL', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false });
                await sql`UPDATE users SET last_seen_at = NULL WHERE username = ${username}`;

                await upsertUser(sql, { username, isAdmin: false });

                expect((await getUserByUsername(sql, username))!.last_seen_at).not.toBeNull();
            });

            it('still demotes and promotes an unpinned admin on a fresh row', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: true });

                const demoted = await upsertUser(sql, { username, isAdmin: false });
                expect(demoted).toMatchObject({ isAdmin: false, demoted: true, promoted: false });
                expect((await getUserByUsername(sql, username))!.is_admin).toBe(false);

                const promoted = await upsertUser(sql, { username, isAdmin: true });
                expect(promoted).toMatchObject({ isAdmin: true, demoted: false, promoted: true });
                expect((await getUserByUsername(sql, username))!.is_admin).toBe(true);
            });

            it('a pinned admin on a fresh row keeps its stored value without a write', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: true });
                await setIsAdmin(sql, username, true); // pins it
                await sql`UPDATE users SET last_seen_at = NOW() WHERE username = ${username}`;
                const before = await stamp(username);

                const result = await upsertUser(sql, { username, isAdmin: false });

                expect(await stamp(username)).toEqual(before);
                expect(result).toMatchObject({ isAdmin: true, demoted: false, promoted: false });
            });

            it('writes a changed max_age_rating on an unpinned row, ignores it on a pinned one', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });

                await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 16 });
                expect((await getUserByUsername(sql, username))!.max_age_rating).toBe(16);

                await upsertUser(sql, { username, isAdmin: false, maxAgeRating: null });
                expect((await getUserByUsername(sql, username))!.max_age_rating).toBeNull();

                await sql`UPDATE users SET age_rating_pinned = true, max_age_rating = 6,
                                           last_seen_at = NOW()
                          WHERE username = ${username}`;
                const before = await stamp(username);
                await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 18 });
                expect(await stamp(username)).toEqual(before);
                expect((await getUserByUsername(sql, username))!.max_age_rating).toBe(6);
            });

            it('writes a new or first display name on a fresh row', async () => {
                const username = newUsername();
                await upsertUser(sql, { username, isAdmin: false });
                await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice' });
                expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice');

                await upsertUser(sql, { username, isAdmin: false, displayName: 'Alice B' });
                expect((await getUserByUsername(sql, username))!.display_name).toBe('Alice B');
            });
        });
    });

    // ========================================================================
    // getUserByUsername
    // ========================================================================

    describe('getUserByUsername', () => {
        it('returns the user row when found', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });

            const row = await getUserByUsername(sql, username);
            expect(row).not.toBeNull();
            expect(row!.username).toBe(username);
            expect(row!.id).toBeTruthy();
            expect(row!.created_at).toBeInstanceOf(Date);
        });

        it('returns null for unknown username', async () => {
            const row = await getUserByUsername(sql, 'no_such_user_xyz_999');
            expect(row).toBeNull();
        });
    });

    describe('getUserById', () => {
        it('returns the user row for its UUID', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            const byName = await getUserByUsername(sql, username);

            const row = await getUserById(sql, byName!.id);
            expect(row!.username).toBe(username);
        });

        // An admin may target any user id, so a username in the path reached the
        // UUID column and Postgres threw (a 500 on PUT /users/{name}/images/avatar).
        it('returns null for an id that is not a UUID', async () => {
            await expect(getUserById(sql, 'rpadmin')).resolves.toBeNull();
        });
    });

    // ========================================================================
    // getUsernamesByIds
    // ========================================================================

    describe('getUsernamesByIds', () => {
        it('resolves a set of user ids to their usernames', async () => {
            const a = newUsername('a_user');
            const b = newUsername('b_user');
            await upsertUser(sql, { username: a, isAdmin: false });
            await upsertUser(sql, { username: b, isAdmin: false });
            const rowA = await getUserByUsername(sql, a);
            const rowB = await getUserByUsername(sql, b);

            const map = await getUsernamesByIds(sql, [rowA!.id, rowB!.id]);

            expect(map.get(rowA!.id.toLowerCase())).toBe(a);
            expect(map.get(rowB!.id.toLowerCase())).toBe(b);
        });

        it('returns an empty map for an empty id list (no query)', async () => {
            const map = await getUsernamesByIds(sql, []);
            expect(map.size).toBe(0);
        });

        it('omits ids that do not exist', async () => {
            const a = newUsername('a_user');
            await upsertUser(sql, { username: a, isAdmin: false });
            const rowA = await getUserByUsername(sql, a);
            const unknownId = randomUUID();

            const map = await getUsernamesByIds(sql, [rowA!.id, unknownId]);

            expect(map.get(rowA!.id.toLowerCase())).toBe(a);
            expect(map.has(unknownId.toLowerCase())).toBe(false);
            expect(map.size).toBe(1);
        });
    });

    // ========================================================================
    // listUsers
    // ========================================================================

    describe('listUsers', () => {
        it('returns all users ordered by last_seen_at DESC NULLS LAST then username ASC', async () => {
            const a = newUsername('a_user');
            const b = newUsername('b_user');
            const c = newUsername('c_user');

            await upsertUser(sql, { username: a, isAdmin: false });
            // Slight delay to get distinct timestamps
            await new Promise((r) => setTimeout(r, 10));
            await upsertUser(sql, { username: b, isAdmin: false });
            await new Promise((r) => setTimeout(r, 10));
            await upsertUser(sql, { username: c, isAdmin: false });

            const rows = await listUsers(sql);
            const names = rows.filter((r) => [a, b, c].includes(r.username)).map((r) => r.username);

            // c was last seen most recently → first
            expect(names[0]).toBe(c);
            expect(names[1]).toBe(b);
            expect(names[2]).toBe(a);
        });

        it('returns an empty array when no users exist', async () => {
            // No users created in this beforeEach cycle — createdUsernames is empty.
            // Filter by the tracked set to avoid interference from other test suites
            // that leave rows in the shared users table.
            const rows = await listUsers(sql);
            const testRows = rows.filter((r) => createdUsernames.includes(r.username));
            expect(testRows).toHaveLength(0);
        });

        it('reports currently_streaming = false and null activity for a user with no play_sessions', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });

            const rows = await listUsers(sql);
            const row = rows.find((r) => r.username === username);

            expect(row?.currently_streaming).toBe(false);
            expect(row?.last_activity_at).toBeNull();
            expect(row?.last_watched_title).toBeNull();
        });

        it('aggregates currently_streaming, last_activity_at, and last_watched_title from play_sessions', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            const user = await getUserByUsername(sql, username);
            expect(user).not.toBeNull();
            const userId = toUserId(user!.id);

            const mediaId = randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, 'Test Movie For Activity', 'movie', 'active')
            `;

            try {
                await createPlaySession(sql, {
                    surface: 'web',
                    media_id: mediaId,
                    user_id: userId,
                    device_id: 'test-device',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });

                const rows = await listUsers(sql);
                const row = rows.find((r) => r.username === username);

                expect(row?.currently_streaming).toBe(true);
                expect(row?.last_activity_at).toBeInstanceOf(Date);
                expect(row?.last_watched_title).toBe('Test Movie For Activity');
            } finally {
                await sql`DELETE FROM media_items WHERE id = ${mediaId}::uuid`;
            }
        });

        it('prefixes the series title for episode play sessions (episode → season → series)', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            const user = await getUserByUsername(sql, username);
            expect(user).not.toBeNull();
            const userId = toUserId(user!.id);

            const seriesId = randomUUID();
            const seasonId = randomUUID();
            const episodeId = randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id) VALUES
                (${seriesId}::uuid, 'Test Series For Activity', 'tv', 'active', NULL),
                (${seasonId}::uuid, 'Season 1', 'season', 'active', ${seriesId}::uuid),
                (${episodeId}::uuid, 'Episode 1', 'episode', 'active', ${seasonId}::uuid)
            `;

            try {
                await createPlaySession(sql, {
                    surface: 'web',
                    media_id: episodeId,
                    user_id: userId,
                    device_id: 'test-device',
                    ip_address: '127.0.0.1',
                    play_method: 'direct',
                    position_ms: 0,
                });

                const rows = await listUsers(sql);
                const row = rows.find((r) => r.username === username);

                expect(row?.last_watched_title).toBe('Test Series For Activity – Episode 1');
            } finally {
                await sql`DELETE FROM media_items WHERE id IN (${episodeId}::uuid, ${seasonId}::uuid, ${seriesId}::uuid)`;
            }
        });
    });

    // ========================================================================
    // setIsAdmin
    // ========================================================================

    describe('setIsAdmin', () => {
        it('promotes a regular user to admin and returns updated row', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });

            const updated = await setIsAdmin(sql, username, true);
            expect(updated).not.toBeNull();
            expect(updated!.is_admin).toBe(true);
            expect(updated!.username).toBe(username);
        });

        it('demotes an admin to regular user', async () => {
            const username = newUsername('admin_user');
            await upsertUser(sql, { username, isAdmin: true });

            const updated = await setIsAdmin(sql, username, false);
            expect(updated!.is_admin).toBe(false);
        });

        it('returns null when user does not exist', async () => {
            const result = await setIsAdmin(sql, 'no_such_user_xyz_999', true);
            expect(result).toBeNull();
        });

        it('persists the change (visible via getUserByUsername)', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            await setIsAdmin(sql, username, true);

            const row = await getUserByUsername(sql, username);
            expect(row!.is_admin).toBe(true);
        });
    });

    // ========================================================================
    // resolveJellyfinNamesToUserIds — collision-safe attribution (H1)
    // ========================================================================

    describe('resolveJellyfinNamesToUserIds (collision-safe)', () => {
        async function insertUser(username: string, jellyfinUsername?: string): Promise<string> {
            const id = randomUUID();
            createdUsernames.push(username);
            await sql`
                INSERT INTO users (id, username, jellyfin_username)
                VALUES (${id}::uuid, ${username}, ${jellyfinUsername ?? null})
            `;
            return id;
        }

        it('maps a unique provider name to its user id', async () => {
            const name = newUsername('solo');
            const id = await insertUser(name);
            const map = await resolveJellyfinNamesToUserIds(sql, [name.toLowerCase()]);
            expect(map.get(name.toLowerCase())).toBe(id);
        });

        it('EXCLUDES a name claimed by two users (case-insensitive) — no cross-attribution', async () => {
            // Two distinct users colliding on LOWER(username): e.g. 'X' and 'x'.
            const lower = newUsername('coll'); // a UUID string (lowercase hex)
            const variant = lower.toUpperCase(); // collides on LOWER()
            await insertUser(lower);
            await insertUser(variant);

            const map = await resolveJellyfinNamesToUserIds(sql, [lower.toLowerCase()]);
            // Ambiguous → neither user resolves; the key is absent entirely.
            expect(map.has(lower.toLowerCase())).toBe(false);
        });

        it('honors a jellyfin_username override and still excludes overrides that collide', async () => {
            // A unique override resolves.
            const overrideName = `jf_${randomUUID().slice(0, 8)}`;
            const id = await insertUser(newUsername('ovr'), overrideName);
            const map = await resolveJellyfinNamesToUserIds(sql, [overrideName.toLowerCase()]);
            expect(map.get(overrideName.toLowerCase())).toBe(id);

            // A second user whose USERNAME equals another's jellyfin_username (case-
            // insensitive) collides on the COALESCE key → both excluded.
            const shared = `shared_${randomUUID().slice(0, 8)}`;
            await insertUser(newUsername('a'), shared); // jellyfin_username = shared
            await insertUser(shared); // username = shared
            const map2 = await resolveJellyfinNamesToUserIds(sql, [shared.toLowerCase()]);
            expect(map2.has(shared.toLowerCase())).toBe(false);
        });
    });

    // ========================================================================
    // searchUsersForDirectory / searchUsersForInvite
    //
    // The peer variant is the one carrying privacy semantics, so most of these
    // assert what it must NOT return. See defs/users/search.ts for why the two
    // exist and docs/architecture/social-sharing.md for the accepted risk.
    // ========================================================================

    describe('user search (directory vs invite)', () => {
        /** Distinct prefix per test run so ILIKE cannot collide with real rows. */
        function searchPrefix(): string {
            return `srch${randomUUID().slice(0, 8)}`;
        }

        async function insertSearchUser(
            username: string,
            opts: { hideStreams?: boolean; disabled?: boolean; deleted?: boolean } = {},
        ): Promise<string> {
            const id = randomUUID();
            createdUsernames.push(username);
            await sql`
                INSERT INTO users (id, username, hide_streams, disabled_at, deleted_at)
                VALUES (
                    ${id}::uuid,
                    ${username},
                    ${opts.hideStreams ?? false},
                    ${opts.disabled ? sql`now()` : null},
                    ${opts.deleted ? sql`now()` : null}
                )
            `;
            return id;
        }

        it('invite: prefix match returns a visible user', async () => {
            const p = searchPrefix();
            await insertSearchUser(`${p}_visible`);
            const rows = await searchUsersForInvite(sql, p, 'nobody');
            expect(rows.map((r) => r.username)).toEqual([`${p}_visible`]);
        });

        it('invite: hide_streams user is ABSENT from a prefix match', async () => {
            const p = searchPrefix();
            await insertSearchUser(`${p}_hidden`, { hideStreams: true });
            const rows = await searchUsersForInvite(sql, p, 'nobody');
            expect(rows).toEqual([]);
        });

        it('invite: hide_streams user IS returned on an exact username match', async () => {
            // The whole point of the exact-match arm: hiding must not make an
            // account permanently un-invitable to someone who knows its name.
            const p = searchPrefix();
            const name = `${p}_hidden`;
            await insertSearchUser(name, { hideStreams: true });
            const rows = await searchUsersForInvite(sql, name, 'nobody');
            expect(rows.map((r) => r.username)).toEqual([name]);
        });

        it('invite: exact match is case-insensitive', async () => {
            const p = searchPrefix();
            const name = `${p}_Hidden`;
            await insertSearchUser(name, { hideStreams: true });
            const rows = await searchUsersForInvite(sql, name.toUpperCase(), 'nobody');
            expect(rows.map((r) => r.username)).toEqual([name]);
        });

        it('invite: does NOT substring-match — only prefix', async () => {
            const p = searchPrefix();
            await insertSearchUser(`zz_${p}_inner`);
            const rows = await searchUsersForInvite(sql, p, 'nobody');
            expect(rows).toEqual([]);
        });

        it('invite: disabled and deleted accounts are absent from both arms', async () => {
            const p = searchPrefix();
            const disabled = `${p}_disabled`;
            const deleted = `${p}_deleted`;
            await insertSearchUser(disabled, { disabled: true });
            await insertSearchUser(deleted, { deleted: true });

            expect(await searchUsersForInvite(sql, p, 'nobody')).toEqual([]);
            // Exact match must not resurrect them either.
            expect(await searchUsersForInvite(sql, disabled, 'nobody')).toEqual([]);
            expect(await searchUsersForInvite(sql, deleted, 'nobody')).toEqual([]);
        });

        it('invite: excludes the caller', async () => {
            const p = searchPrefix();
            const self = `${p}_self`;
            await insertSearchUser(self);
            const rows = await searchUsersForInvite(sql, p, self);
            expect(rows).toEqual([]);
        });

        it('directory: substring-matches and includes hidden + disabled users', async () => {
            const p = searchPrefix();
            await insertSearchUser(`zz_${p}_inner`);
            await insertSearchUser(`${p}_hidden`, { hideStreams: true });
            await insertSearchUser(`${p}_disabled`, { disabled: true });

            const rows = await searchUsersForDirectory(sql, p, 'nobody');
            expect(rows.map((r) => r.username).sort()).toEqual(
                [`${p}_disabled`, `${p}_hidden`, `zz_${p}_inner`].sort(),
            );
        });

        it('directory: still excludes soft-deleted accounts', async () => {
            const p = searchPrefix();
            await insertSearchUser(`${p}_deleted`, { deleted: true });
            const rows = await searchUsersForDirectory(sql, p, 'nobody');
            expect(rows).toEqual([]);
        });

        it('both: ILIKE metacharacters in the query are matched literally', async () => {
            const p = searchPrefix();
            await insertSearchUser(`${p}_plain`);
            // '%' must not act as a wildcard that matches the row above.
            expect(await searchUsersForInvite(sql, `${p}%`, 'nobody')).toEqual([]);
            expect(await searchUsersForDirectory(sql, `${p}%`, 'nobody')).toEqual([]);
        });
    });

    // ========================================================================
    // Avatar versions (the image proxy's disk-cache key)
    // ========================================================================

    describe('avatar versions', () => {
        it('an upload gets a version that every new upload and the delete move', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });

            await setUserAvatar(sql, username, Buffer.from('one'), 'image/webp');
            const first = await getUserAvatarVersion(sql, username);
            expect(first).toEqual({ source: 'upload', version: expect.stringMatching(/^\d+$/) });
            // The bytes read reports the same version as the version-only read.
            expect((await getUserAvatar(sql, username))?.version).toBe(first!.version);

            await sql`UPDATE users SET avatar_updated_at = avatar_updated_at - interval '1 second'
                      WHERE username = ${username}`;
            const backdated = (await getUserAvatarVersion(sql, username))!.version;
            await setUserAvatar(sql, username, Buffer.from('two'), 'image/webp');
            const second = (await getUserAvatarVersion(sql, username))!.version;
            expect(Number(second)).toBeGreaterThan(Number(backdated));

            await deleteUserAvatar(sql, username);
            expect(await getUserAvatarVersion(sql, username)).toBeNull();
            expect(await getUserAvatar(sql, username)).toBeNull();
        });

        it('an upload made before the column existed has a null version', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            await setUserAvatar(sql, username, Buffer.from('old'), 'image/webp');
            await sql`UPDATE users SET avatar_updated_at = NULL WHERE username = ${username}`;

            expect(await getUserAvatarVersion(sql, username)).toEqual({
                source: 'upload',
                version: null,
            });
        });

        it('the IdP copy reports its own version, and only when includeIdp', async () => {
            const username = newUsername();
            await upsertUser(sql, { username, isAdmin: false });
            const user = (await getUserByUsername(sql, username))!;
            await setUserIdpAvatar(sql, user.id, null, {
                data: Buffer.from('idp'),
                contentType: 'image/webp',
                source: 'claim-hash',
            });

            expect(await getUserAvatarVersion(sql, username)).toBeNull();
            const idp = await getUserAvatarVersion(sql, username, { includeIdp: true });
            expect(idp).toEqual({ source: 'idp', version: expect.stringMatching(/^\d+$/) });
            expect((await getUserAvatar(sql, username, { includeIdp: true }))?.version).toBe(
                idp!.version,
            );

            // An upload wins over the IdP copy, version included.
            await setUserAvatar(sql, username, Buffer.from('mine'), 'image/webp');
            const upload = await getUserAvatarVersion(sql, username, { includeIdp: true });
            expect(upload?.source).toBe('upload');
        });
    });
});

it('rating fallback initializes a child safely before its first auth upsert and preserves explicit choices', async () => {
    const sql = getTestDb();
    const username = `tv-fallback-${randomUUID()}`;
    const { ensureUserExists } = await import('./user-ratings.queries.js');
    try {
        await ensureUserExists(sql, username, { maxAgeRating: 12 });
        expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
        await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
        expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
        await setUserLiveTvAllowed(sql, username, true);
        await ensureUserExists(sql, username, { maxAgeRating: 0 });
        expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
    } finally {
        await cleanupTestUsers(sql, [username]);
    }
});

it('first auth applies the child default to a bare fallback row without changing a returning account', async () => {
    const sql = getTestDb();
    const username = `tv-bare-${randomUUID()}`;
    const { ensureUserExists } = await import('./user-ratings.queries.js');
    try {
        await ensureUserExists(sql, username);
        // Auth may resolve this stub before its background upsert has finished.
        expect(await getUserLiveTvAllowed(sql, username, { ageLimited: true })).toBe(false);
        await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
        expect(await getUserLiveTvAllowed(sql, username)).toBe(false);
        await setUserLiveTvAllowed(sql, username, true);
        await upsertUser(sql, { username, isAdmin: false, maxAgeRating: 12 });
        expect(await getUserLiveTvAllowed(sql, username)).toBe(true);
    } finally {
        await cleanupTestUsers(sql, [username]);
    }
});
