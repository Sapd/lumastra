// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
    placeInLibraryGroup,
} from '../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id';
import type { UserContext } from '$lib/server/types';
import { SYNC_STATE_FIELD, type SyncChange, type SyncChangesResponse } from '$lib/schemas/api-sync';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache';
import {
    compareSyncPositions,
    decodeSyncCursor,
    encodeSyncCursor,
    type SyncCursor,
} from '$lib/server/sync/cursor';
import { readSyncChanges, readSyncLibrary, readSyncUserState } from './sync-changes.service';

describe('library delta sync read side', () => {
    let sql: Sql;
    const allowed = randomUUID(),
        denied = randomUUID();
    const media: string[] = [],
        files: string[] = [],
        playlists: number[] = [];
    const makeUser = (maxAgeRating: number): UserContext => {
        const id = toUserId(randomUUID());
        return {
            userId: id,
            username: derivedUsername(id),
            groups: 'sync-viewers',
            userGroups: ['sync-viewers'],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            ownerIsAdmin: false,
            mediaAccessIsAdmin: false,
            maxAgeRating,
            isAgeRestricted: true,
            isModerator: false,
            liveTvPriority: 'low',
        };
    };
    const viewer = makeUser(18),
        restricted = makeUser(12);
    const users = [viewer.userId, restricted.userId];

    beforeAll(async () => {
        sql = getTestDb();
        for (const user of users) await ensureTestUser(sql, user);
        await sql`INSERT INTO library_groups (id, name) VALUES
            (${allowed}::uuid, 'Sync allowed'), (${denied}::uuid, 'Sync denied')`;
        await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups)
            VALUES (${denied}::uuid, ${['sync-other']})`;
        invalidateLibraryGroupPermissionsCache();
    });
    afterAll(async () => {
        await sql`DELETE FROM playlists WHERE id = ANY(${playlists}::int[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${media}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${denied}::uuid`;
        await sql`DELETE FROM library_groups WHERE id = ANY(${[allowed, denied]}::uuid[])`;
        await sql`DELETE FROM sync_changes WHERE user_id = ANY(${users}::uuid[])
            OR entity_id = ANY(${[...media, ...playlists.map(String)]}::text[])`;
        await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    async function item(
        age = 10,
        type = 'movie',
    ): Promise<{ id: string; fileId: string; descendants: string[] }> {
        const id = randomUUID();
        media.push(id);
        await sql`INSERT INTO media_items (id, title, media_type, status, age_rating)
            VALUES (${id}::uuid, ${`Sync ${id}`}, ${type}, 'active', ${age})`;
        const placement = await placeInLibraryGroup(sql, {
            mediaItemId: id,
            mediaType: type === 'tv' ? 'tv' : 'movie',
            libraryGroupId: allowed,
        });
        files.push(placement.fileId);
        media.push(...placement.createdDescendantIds);
        return { id, fileId: placement.fileId, descendants: placement.createdDescendantIds };
    }
    const start = async (user = viewer): Promise<string> => {
        const response = await readSyncChanges({ sql, user, limit: 500 });
        expect(response.items).toEqual([]);
        expect(response.page.hasMore).toBe(false);
        expect(response.initialLoad).toHaveLength(13);
        expect(response.initialLoad?.find((entry) => entry.kind === 'playlist')?.href).toContain(
            '/sync/user-state?kind=playlist&limit=500',
        );
        return response.page.nextCursor;
    };
    function decode(raw: string, user = viewer): SyncCursor {
        const result = decodeSyncCursor(raw, user.userId);
        if (result.status !== 'ok') throw new Error('Test expected a valid cursor');
        return result.cursor;
    }
    async function poll(
        cursor: string,
        user: UserContext,
        done: (changes: SyncChange[]) => boolean,
        limit = 500,
    ): Promise<{ changes: SyncChange[]; cursor: string; pages: SyncChangesResponse[] }> {
        const changes: SyncChange[] = [],
            pages: SyncChangesResponse[] = [];
        const deadline = Date.now() + 5000;
        do {
            const page = await readSyncChanges({ sql, user, cursor, limit });
            pages.push(page);
            changes.push(...page.items);
            cursor = page.page.nextCursor;
            if (done(changes)) return { changes, cursor, pages };
            await new Promise((resolve) => setTimeout(resolve, 40));
        } while (Date.now() < deadline);
        throw new Error('Own fixture changes did not pass the cluster horizon within 5 s');
    }
    async function throughViewerPosition(cursor: string, target: string): Promise<SyncChange[]> {
        const changes: SyncChange[] = [];
        const deadline = Date.now() + 5000;
        do {
            const page = await readSyncChanges({ sql, user: restricted, cursor, limit: 500 });
            changes.push(...page.items);
            cursor = page.page.nextCursor;
            if (compareSyncPositions(decode(cursor, restricted), decode(target)) >= 0)
                return changes;
            await new Promise((resolve) => setTimeout(resolve, 40));
        } while (Date.now() < deadline);
        throw new Error('Restricted reader did not reach the viewer position');
    }

    it('retains a durable checkpoint on an empty terminal page', async () => {
        const cursor = await start();
        const terminal = await readSyncChanges({ sql, user: viewer, cursor, limit: 1 });
        expect(terminal.items).toEqual([]);
        expect(terminal.page).toMatchObject({
            limit: 1,
            hasMore: false,
            nextCursor: expect.any(String),
        });
        expect(
            compareSyncPositions(decode(terminal.page.nextCursor), decode(cursor)),
        ).toBeGreaterThanOrEqual(0);
        const again = await readSyncChanges({
            sql,
            user: viewer,
            cursor: terminal.page.nextCursor,
            limit: 1,
        });
        expect(again.items).toEqual([]);
        expect(again.page.hasMore).toBe(false);
        expect(again.page.nextCursor).toEqual(expect.any(String));
    });

    it('starts, adds, updates in place, dismisses and deletes with recorded previous access', async () => {
        let cursor = await start();
        const fixture = await item();
        let response = await poll(cursor, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.op === 'upsert'),
        );
        cursor = response.cursor;
        await sql`UPDATE media_items SET title = 'Sync renamed' WHERE id = ${fixture.id}::uuid`;
        response = await poll(cursor, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.op === 'upsert'),
        );
        cursor = response.cursor;
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${fixture.id}::uuid`;
        response = await poll(cursor, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.op === 'delete'),
        );
        cursor = response.cursor;
        await sql`DELETE FROM media_items WHERE id = ${fixture.id}::uuid`;
        await poll(cursor, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.op === 'delete'),
        );
    });

    it('moves to a denied library: delete for the previous viewer, silence for a user who never had access', async () => {
        const fixture = await item(16);
        const a = await start(),
            b = await start(restricted);
        const initial = await readSyncUserState({
            sql,
            user: restricted,
            kind: 'watch_state',
            limit: 500,
        });
        expect(initial.items.some((row) => row.id === fixture.id)).toBe(false);
        await sql`UPDATE media_files SET library_group_id = ${denied}::uuid WHERE id = ${fixture.fileId}::uuid`;
        await sql`UPDATE media_items SET title = 'Moved and edited' WHERE id = ${fixture.id}::uuid`;
        const result = await poll(a, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.op === 'delete'),
        );
        expect(
            (await throughViewerPosition(b, result.cursor)).filter((r) => r.id === fixture.id),
        ).toEqual([]);
    });

    it('inherits series age for episodes and emits deletes after an age rise', async () => {
        const fixture = await item(10, 'tv');
        const episode = fixture.descendants[fixture.descendants.length - 1];
        const cursor = await start(restricted);
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${fixture.id}::uuid`;
        await poll(cursor, restricted, (rows) =>
            rows.some((r) => r.id === episode && r.op === 'delete'),
        );
    });

    it.each(['floor raised', 'moved group', 'own rating raised', 'floor raised twice'] as const)(
        'deletes a previously synced audiobook when its effective age rises: %s',
        async (change) => {
            const group = randomUUID(),
                higher = randomUUID(),
                id = randomUUID();
            media.push(id);
            await sql`INSERT INTO library_groups (id, name, max_age_rating) VALUES
                (${group}, 'Sync floor low', 12), (${higher}, 'Sync floor high', 18)`;
            try {
                await sql`INSERT INTO media_items (id, title, media_type, status, has_files, library_group_id)
                    VALUES (${id}, 'Sync floor book', 'audiobook', 'active', true, ${group})`;
                const initial = await readSyncLibrary({
                    sql,
                    user: restricted,
                    kind: 'audiobook',
                    limit: 500,
                });
                expect(initial.items.some((row) => row.id === id)).toBe(true);
                const neverAllowed = { ...restricted, maxAgeRating: 8 };
                expect(
                    (
                        await readSyncLibrary({
                            sql,
                            user: neverAllowed,
                            kind: 'audiobook',
                            limit: 500,
                        })
                    ).items.some((row) => row.id === id),
                ).toBe(false);
                const neverCursor = await start(neverAllowed);
                const cursor = await start(restricted);
                if (change === 'floor raised') {
                    await sql`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${group}`;
                } else if (change === 'floor raised twice') {
                    await sql.begin(async (tx) => {
                        await tx`UPDATE library_groups SET max_age_rating = 16 WHERE id = ${group}`;
                        await tx`UPDATE library_groups SET max_age_rating = 18 WHERE id = ${group}`;
                    });
                } else if (change === 'moved group') {
                    await sql`UPDATE media_items SET library_group_id = ${higher} WHERE id = ${id}`;
                } else {
                    await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${id}`;
                }
                const result = await poll(cursor, restricted, (rows) =>
                    rows.some((r) => r.id === id && r.op === 'delete'),
                );
                expect(result.changes.filter((r) => r.id === id)).toContainEqual(
                    expect.objectContaining({ kind: 'audiobook', op: 'delete' }),
                );
                const [row] =
                    await sql`SELECT prev_age_rating, prev_age_known, prev_libs_known FROM sync_changes
                    WHERE entity_id = ${id} AND prev_age_known ORDER BY xid DESC LIMIT 1`;
                expect(row).toMatchObject({ prev_age_rating: 12, prev_age_known: true });
                const [effective] = await sql`SELECT sync_effective_age(${id}::uuid) AS age`;
                expect(effective.age).toBe(18);
                const neverDelta = await readSyncChanges({
                    sql,
                    user: neverAllowed,
                    cursor: neverCursor,
                    limit: 500,
                });
                expect(
                    compareSyncPositions(
                        decode(neverDelta.page.nextCursor, neverAllowed),
                        decode(result.cursor, restricted),
                    ),
                ).toBeGreaterThanOrEqual(0);
                expect(neverDelta.items.some((row) => row.id === id)).toBe(false);
            } finally {
                await sql`DELETE FROM media_items WHERE id = ${id}`;
                await sql`DELETE FROM library_groups WHERE id = ANY(${[group, higher]}::uuid[])`;
            }
        },
    );

    it('never crosses per-user rows and shares inline data with initial-load lists', async () => {
        const fixture = await item();
        const a = await start(),
            b = await start(restricted);
        await sql`INSERT INTO user_media_state
            (user_id, media_id, resume_position_ms, runtime_ms, watch_count, is_favorite, last_event_at)
            VALUES (${viewer.userId}::uuid, ${fixture.id}::uuid, 60000, 120000, 2, true, now())`;
        await sql`INSERT INTO user_ratings (user_id, media_id, rating, skipped, rating_style, is_explicit)
            VALUES (${viewer.userId}::uuid, ${fixture.id}::uuid, 8, false, 'stars', true)`;
        const result = await poll(
            a,
            viewer,
            (rows) =>
                rows.some((r) => r.id === fixture.id && r.kind === 'rating') &&
                rows.some((r) => r.id === fixture.id && r.kind === 'watch_state'),
        );
        const watch = result.changes.find((r) => r.id === fixture.id && r.kind === 'watch_state');
        expect(watch?.watchState).toMatchObject({
            progress: { positionMs: 60000, durationMs: 120000, fraction: 0.5 },
            playCount: 2,
            favorite: true,
        });
        const list = await readSyncUserState({
            sql,
            user: viewer,
            kind: 'watch_state',
            limit: 500,
        });
        expect(list.items.find((r) => r.id === fixture.id)?.watchState).toEqual(watch?.watchState);
        expect(
            (await throughViewerPosition(b, result.cursor)).filter(
                (r) => r.id === fixture.id && ['rating', 'watch_state'].includes(r.kind),
            ),
        ).toEqual([]);
        expect(
            (
                await readSyncUserState({ sql, user: restricted, kind: 'watch_state', limit: 500 })
            ).items.some((r) => r.id === fixture.id),
        ).toBe(false);
        // A media-keyed state entry becomes a delete if its media fails the same boundary.
        const cursor = result.cursor;
        await sql`UPDATE media_files SET library_group_id = ${denied}::uuid WHERE id = ${fixture.fileId}::uuid`;
        await sql`UPDATE user_media_state SET watch_count = 3 WHERE user_id = ${viewer.userId}::uuid
            AND media_id = ${fixture.id}::uuid`;
        await poll(cursor, viewer, (rows) =>
            rows.some((r) => r.id === fixture.id && r.kind === 'watch_state' && r.op === 'delete'),
        );
        expect(
            (
                await readSyncUserState({ sql, user: viewer, kind: 'watch_state', limit: 500 })
            ).items.some((r) => r.id === fixture.id),
        ).toBe(false);
    });

    it('drops removed playlist members and excludes pending invites and public nonmembers', async () => {
        const [playlist] = await sql<
            { id: number }[]
        >`INSERT INTO playlists (user_id, name, visibility)
            VALUES (${viewer.userId}::uuid, 'Sync membership', 'public') RETURNING id`;
        playlists.push(playlist.id);
        const id = String(playlist.id);
        expect(
            (
                await readSyncUserState({ sql, user: restricted, kind: 'playlist', limit: 500 })
            ).items.some((r) => r.id === id),
        ).toBe(false);
        await sql`INSERT INTO playlist_members (playlist_id, user_id, role, status)
            VALUES (${playlist.id}, ${restricted.userId}::uuid, 'readonly', 'pending')`;
        expect(
            (
                await readSyncUserState({ sql, user: restricted, kind: 'playlist', limit: 500 })
            ).items.some((r) => r.id === id),
        ).toBe(false);
        await sql`UPDATE playlist_members SET status = 'accepted' WHERE playlist_id = ${playlist.id}`;
        expect(
            (
                await readSyncUserState({ sql, user: restricted, kind: 'playlist', limit: 500 })
            ).items.find((r) => r.id === id)?.playlist,
        ).toEqual({ revision: 0 });
        const cursor = await start(restricted);
        await sql`DELETE FROM playlist_members WHERE playlist_id = ${playlist.id}`;
        await poll(cursor, restricted, (rows) =>
            rows.some((r) => r.id === id && r.kind === 'playlist' && r.op === 'delete'),
        );
        expect(
            (
                await readSyncUserState({ sql, user: restricted, kind: 'playlist', limit: 500 })
            ).items.some((r) => r.id === id),
        ).toBe(false);
    });

    it('projects listen counters, explicit ratings, and grouped watchlist entries identically in both surfaces', async () => {
        const fixture = await item();
        // A track is the canonical owner of listen state.
        await sql`UPDATE media_items SET media_type = 'track' WHERE id = ${fixture.id}::uuid`;
        const [watchlist] = await sql<{ id: number }[]>`INSERT INTO playlists
            (user_id, name, playlist_type, is_system)
            VALUES (${viewer.userId}::uuid, 'Watchlist', 'watchlist', true) RETURNING id`;
        playlists.push(watchlist.id);
        const cursor = await start();
        await sql`INSERT INTO user_music_state (user_id, track_id, play_count, skip_count,
            complete_count, first_played_at, last_played_at)
            VALUES (${viewer.userId}::uuid, ${fixture.id}::uuid, 7, 2, 5, now(), now())`;
        await sql`INSERT INTO user_ratings (user_id, media_id, rating, skipped, rating_style, is_explicit)
            VALUES (${viewer.userId}::uuid, ${fixture.id}::uuid, 9, false, 'quick', true)`;
        await sql`INSERT INTO playlist_items
            (playlist_id, media_id, title, position, season_number, episode_number, added_at)
            VALUES (${watchlist.id}, ${fixture.id}::uuid, 'Sync watchlist', 0, 1, 2, '2026-01-01T00:00:00Z'),
                   (${watchlist.id}, ${fixture.id}::uuid, 'Sync watchlist', 1, 1, 3, '2026-01-02T00:00:00Z')`;
        const kinds = ['listen_state', 'rating', 'watchlist'] as const;
        const result = await poll(cursor, viewer, (rows) =>
            kinds.every((kind) =>
                rows.some(
                    (row) => row.id === fixture.id && row.kind === kind && row.op === 'upsert',
                ),
            ),
        );
        for (const kind of kinds) {
            const list = await readSyncUserState({ sql, user: viewer, kind, limit: 500 });
            const field = SYNC_STATE_FIELD[kind];
            expect(list.items.find((row) => row.id === fixture.id)?.[field]).toEqual(
                result.changes.find((row) => row.id === fixture.id && row.kind === kind)?.[field],
            );
        }
        expect(
            result.changes.find((row) => row.id === fixture.id && row.kind === 'listen_state')
                ?.listenState,
        ).toMatchObject({ playCount: 7, skipCount: 2, completeCount: 5 });
        expect(
            result.changes.find((row) => row.id === fixture.id && row.kind === 'watchlist')
                ?.watchlist,
        ).toMatchObject({
            entries: [
                { seasonNumber: 1, episodeNumber: 2 },
                { seasonNumber: 1, episodeNumber: 3 },
            ],
        });
        const after = result.cursor;
        await sql`UPDATE user_ratings SET skipped = true WHERE user_id = ${viewer.userId}::uuid
            AND media_id = ${fixture.id}::uuid`;
        await sql`DELETE FROM user_music_state WHERE user_id = ${viewer.userId}::uuid AND track_id = ${fixture.id}::uuid`;
        await sql`DELETE FROM playlist_items WHERE playlist_id = ${watchlist.id}`;
        await poll(after, viewer, (rows) =>
            kinds.every((kind) =>
                rows.some(
                    (row) => row.id === fixture.id && row.kind === kind && row.op === 'delete',
                ),
            ),
        );
    });

    it('keysets initial user state without duplicates and omits age-hidden media', async () => {
        const ids: string[] = [];
        for (const age of [10, 10, 18]) {
            const fixture = await item(age);
            ids.push(fixture.id);
            await sql`INSERT INTO user_media_state (user_id, media_id, watch_count)
                VALUES (${restricted.userId}::uuid, ${fixture.id}::uuid, 1)`;
        }
        const seen: string[] = [];
        let after: string | undefined;
        do {
            const page = await readSyncUserState({
                sql,
                user: restricted,
                kind: 'watch_state',
                cursor: after,
                limit: 1,
            });
            seen.push(...page.items.map((row) => row.id));
            after = page.page.nextCursor ?? undefined;
        } while (after !== undefined);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toContain(ids[0]);
        expect(seen).toContain(ids[1]);
        expect(seen).not.toContain(ids[2]);
        expect(seen).toEqual([...seen].sort());
    });

    it('rejects tampered/foreign/malformed cursors and effective scope changes', async () => {
        const cursor = await start();
        const bytes = Buffer.from(cursor, 'base64url');
        bytes[bytes.length - 1] ^= 1;
        await expect(
            readSyncChanges({ sql, user: viewer, cursor: bytes.toString('base64url'), limit: 5 }),
        ).rejects.toMatchObject({ reason: 'invalid_cursor' });
        await expect(
            readSyncChanges({ sql, user: restricted, cursor, limit: 5 }),
        ).rejects.toMatchObject({ reason: 'invalid_cursor' });
        await expect(
            readSyncChanges({ sql, user: viewer, cursor: '%%%', limit: 5 }),
        ).rejects.toMatchObject({ reason: 'invalid_param' });
        await expect(
            readSyncChanges({ sql, user: { ...viewer, maxAgeRating: 12 }, cursor, limit: 5 }),
        ).rejects.toMatchObject({ reason: 'access_changed' });
        await expect(
            readSyncChanges({
                sql,
                user: { ...viewer, userGroups: ['sync-other'] },
                cursor,
                limit: 5,
            }),
        ).rejects.toMatchObject({ reason: 'access_changed' });
        const future = encodeSyncCursor({ ...decode(cursor), xid: '18446744073709551615' });
        await expect(
            readSyncChanges({ sql, user: viewer, cursor: future, limit: 5 }),
        ).rejects.toMatchObject({ reason: 'log_reset' });
    });

    it('expires below the prune watermark, permits equality, and detects capture TRUNCATE epochs', async () => {
        const cursor = await start();
        const position = decode(cursor);
        const [old] = await sql<{ xid: string | null; seq: string }[]>`
            SELECT pruned_xid::text AS xid, pruned_seq::text AS seq FROM sync_state WHERE id = 1`;
        try {
            await sql`UPDATE sync_state SET pruned_xid = ${position.xid}::xid8,
                pruned_seq = ${(BigInt(position.seq) + 1n).toString()}::bigint WHERE id = 1`;
            await expect(
                readSyncChanges({ sql, user: viewer, cursor, limit: 5 }),
            ).rejects.toMatchObject({ reason: 'cursor_expired' });
            await sql`UPDATE sync_state SET pruned_seq = ${position.seq}::bigint WHERE id = 1`;
            await expect(
                readSyncChanges({ sql, user: viewer, cursor, limit: 5 }),
            ).resolves.toHaveProperty('page.nextCursor');
        } finally {
            await sql`UPDATE sync_state SET pruned_xid = ${old.xid}::xid8, pruned_seq = ${old.seq}::bigint WHERE id = 1`;
        }
        await sql`TRUNCATE user_music_state`;
        await expect(
            readSyncChanges({ sql, user: viewer, cursor, limit: 5 }),
        ).rejects.toMatchObject({ reason: 'log_reset' });
    });

    it('advances over the scan cap, stops at the entry limit, and skips no own entities', async () => {
        const cursor = await start(restricted);
        const hidden = Array.from({ length: 25 }, () => randomUUID());
        const visible = Array.from({ length: 4 }, () => randomUUID());
        media.push(...hidden, ...visible);
        await sql.begin(async (tx) => {
            for (const id of hidden)
                await tx`INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
                VALUES (${id}::uuid, 'Sync hidden cap', 'movie', 'active', false, 18)`;
            for (const id of visible) {
                await tx`INSERT INTO media_items (id, title, media_type, status, age_rating)
                    VALUES (${id}::uuid, 'Sync visible cap', 'movie', 'active', 10)`;
                const placed = await placeInLibraryGroup(tx as unknown as Sql, {
                    mediaItemId: id,
                    mediaType: 'movie',
                    libraryGroupId: allowed,
                });
                files.push(placed.fileId);
                await tx`INSERT INTO user_media_state (user_id, media_id, watch_count)
                    VALUES (${restricted.userId}::uuid, ${id}::uuid, 1)`;
            }
        });
        const result = await poll(
            cursor,
            restricted,
            (rows) =>
                visible.every((id) =>
                    ['movie', 'watch_state'].every((kind) =>
                        rows.some((r) => r.id === id && r.kind === kind && r.op === 'upsert'),
                    ),
                ),
            1,
        );
        expect(result.pages.some((page) => page.page.hasMore && page.items.length === 0)).toBe(
            true,
        );
        expect(result.pages.every((page) => page.items.length <= 1)).toBe(true);
        expect(result.changes.filter((r) => (hidden as string[]).includes(r.id))).toEqual([]);
        let previous = decode(cursor, restricted);
        for (const page of result.pages) {
            const next = decode(page.page.nextCursor, restricted);
            expect(compareSyncPositions(next, previous)).toBeGreaterThanOrEqual(0);
            if (page.page.hasMore) expect(compareSyncPositions(next, previous)).toBeGreaterThan(0);
            previous = next;
        }
    });

    it('holds an open writer below the cursor horizon and returns it after commit', async () => {
        const cursor = await start();
        const id = randomUUID();
        media.push(id);
        const reserved = await sql.reserve();
        let committed = false;
        try {
            await reserved`BEGIN`;
            await reserved`INSERT INTO media_items (id, title, media_type, status, has_files, age_rating)
                VALUES (${id}::uuid, 'Sync blocked writer', 'movie', 'active', false, 10)`;
            const placed = await placeInLibraryGroup(reserved as unknown as Sql, {
                mediaItemId: id,
                mediaType: 'movie',
                libraryGroupId: allowed,
            });
            files.push(placed.fileId);
            const [position] = await reserved<{ xid: string; seq: string }[]>`
                SELECT xid::text, seq::text FROM sync_changes WHERE entity_id = ${id}
                ORDER BY sync_changes.xid, sync_changes.seq LIMIT 1`;
            const response = await readSyncChanges({ sql, user: viewer, cursor, limit: 500 });
            expect(response.items.some((r) => r.id === id)).toBe(false);
            expect(compareSyncPositions(decode(response.page.nextCursor), position)).toBeLessThan(
                0,
            );
            await reserved`COMMIT`;
            committed = true;
            await poll(response.page.nextCursor, viewer, (rows) =>
                rows.some((r) => r.id === id && r.op === 'upsert'),
            );
        } finally {
            if (!committed) await reserved`ROLLBACK`;
            reserved.release();
        }
    });
    it('lists library ids with the feed predicates: boundary, keyset paging, same set as upserts', async () => {
        const open = await item(10);
        const adult = await item(16);
        const dismissed = await item(10);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${dismissed.id}::uuid`;
        const walk = async (user: UserContext, limit: number): Promise<string[]> => {
            const ids: string[] = [];
            let after: string | undefined;
            do {
                const page = await readSyncLibrary({
                    sql,
                    user,
                    kind: 'movie',
                    cursor: after,
                    limit,
                });
                expect(page.items.length).toBeLessThanOrEqual(limit);
                ids.push(...page.items.map((entry) => entry.id));
                after = page.page.nextCursor ?? undefined;
            } while (after);
            return ids;
        };
        const own = new Set([open.id, adult.id, dismissed.id]);
        const forViewer = await walk(viewer, 1);
        expect(forViewer.filter((id) => own.has(id)).sort()).toEqual([open.id, adult.id].sort());
        expect(new Set(forViewer).size).toBe(forViewer.length);
        expect(forViewer).toEqual(await walk(viewer, 1000));
        expect((await walk(restricted, 1000)).filter((id) => own.has(id))).toEqual([open.id]);
        await expect(
            readSyncLibrary({ sql, user: viewer, kind: 'nonsense', limit: 10 }),
        ).rejects.toMatchObject({ reason: 'invalid_param' });
        await expect(
            readSyncLibrary({ sql, user: viewer, kind: 'movie', cursor: 'not-a-uuid', limit: 10 }),
        ).rejects.toMatchObject({ reason: 'invalid_param' });

        // The delta feed reports exactly the same visibility for the same items.
        const fresh = await start(restricted);
        await sql`UPDATE media_items SET overview = 'touched' WHERE id = ANY(${[open.id, adult.id, dismissed.id]}::uuid[])`;
        const changes = await poll(fresh, restricted, (rows) =>
            rows.some((r) => r.id === open.id && r.op === 'upsert'),
        );
        const upserts = new Set(changes.changes.filter((r) => r.op === 'upsert').map((r) => r.id));
        expect(upserts.has(open.id)).toBe(true);
        expect(upserts.has(adult.id)).toBe(false);
        expect(upserts.has(dismissed.id)).toBe(false);
    });
    it('a client that follows the recipe ends up identical to a fresh full load', async () => {
        type Cache = { movies: Set<string>; watch: Map<string, string> };
        const loadAll = async (): Promise<Cache> => {
            const cache: Cache = { movies: new Set(), watch: new Map() };
            let after: string | undefined;
            do {
                const page = await readSyncLibrary({
                    sql,
                    user: viewer,
                    kind: 'movie',
                    cursor: after,
                    limit: 2,
                });
                for (const entry of page.items) cache.movies.add(entry.id);
                after = page.page.nextCursor ?? undefined;
            } while (after);
            const state = await readSyncUserState({
                sql,
                user: viewer,
                kind: 'watch_state',
                limit: 500,
            });
            for (const entry of state.items) {
                cache.watch.set(entry.id, JSON.stringify(entry.watchState));
            }
            return cache;
        };
        const own = (cache: Cache): { movies: string[]; watch: [string, string][] } => ({
            movies: [...cache.movies].filter((id) => media.includes(id)).sort(),
            watch: [...cache.watch].filter(([id]) => media.includes(id)).sort(),
        });

        // 1. cursor first, then the full load
        const first = await readSyncChanges({ sql, user: viewer, limit: 500 });
        let cursor = first.page.nextCursor;
        const a = await item(10),
            b = await item(10),
            c = await item(10);
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${viewer.userId}::uuid, ${a.id}::uuid, true, 1)`;
        const cache = await loadAll();

        // 2. add, rename, watch, delete, dismiss on the server
        const d = await item(10);
        await sql`UPDATE media_items SET title = 'Renamed' WHERE id = ${a.id}::uuid`;
        await sql`UPDATE user_media_state SET watch_count = 2 WHERE user_id = ${viewer.userId}::uuid
            AND media_id = ${a.id}::uuid`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${viewer.userId}::uuid, ${d.id}::uuid, true, 1)`;
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${b.id}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${c.id}::uuid`;

        // 3. apply the delta like the recipe says (the catalog hydrate is POST /media/batch;
        //    here an upsert only needs the id to be listed by the full load below)
        const deadline = Date.now() + 5000;
        const touched = new Set([a.id, b.id, c.id, d.id]);
        const seen = new Set<string>();
        do {
            let more = true;
            while (more) {
                const page = await readSyncChanges({ sql, user: viewer, cursor, limit: 500 });
                cursor = page.page.nextCursor;
                more = page.page.hasMore;
                for (const change of page.items) {
                    if (change.kind === 'movie') {
                        if (change.op === 'delete') cache.movies.delete(change.id);
                        else cache.movies.add(change.id);
                    } else if (change.kind === 'watch_state') {
                        if (change.op === 'delete') cache.watch.delete(change.id);
                        else cache.watch.set(change.id, JSON.stringify(change.watchState));
                    }
                    if (touched.has(change.id)) seen.add(change.id + change.kind + change.op);
                }
            }
            // wait until the cluster horizon has passed our last write
            if (seen.has(c.id + 'movie' + 'delete') && seen.has(d.id + 'watch_state' + 'upsert'))
                break;
            await new Promise((resolve) => setTimeout(resolve, 40));
        } while (Date.now() < deadline);

        // 4. same state as a client that loads everything again
        expect(own(cache)).toEqual(own(await loadAll()));
        expect(cache.movies.has(b.id)).toBe(false);
        expect(cache.movies.has(c.id)).toBe(false);
        expect(cache.movies.has(d.id)).toBe(true);
    });
    it('lists only explicit ratings: an inferred skip/complete rating is no rating', async () => {
        const fixture = await item(10);
        await sql`INSERT INTO user_ratings (user_id, media_id, rating, skipped, is_explicit)
            VALUES (${viewer.userId}::uuid, ${fixture.id}::uuid, 3, false, false)`;
        const list = await readSyncUserState({ sql, user: viewer, kind: 'rating', limit: 500 });
        expect(list.items.find((row) => row.id === fixture.id)).toBeUndefined();
        await sql`UPDATE user_ratings SET is_explicit = true WHERE user_id = ${viewer.userId}::uuid
            AND media_id = ${fixture.id}::uuid`;
        const after = await readSyncUserState({ sql, user: viewer, kind: 'rating', limit: 500 });
        expect(after.items.find((row) => row.id === fixture.id)?.rating).toMatchObject({
            rating: 3,
        });
    });
});
