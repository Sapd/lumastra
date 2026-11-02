// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    derivedUsername,
    ensureTestUser,
    insertTestExternalIds,
} from '../../../../tests/integration/fixtures/index.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import {
    createLibraryPath,
    deleteLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';
import * as rematch from '$lib/server/database/queries/file-rematch.queries.js';
import { readSyncState } from '$lib/server/database/queries/sync-read.queries.js';
import { readSyncChanges } from '$lib/server/services/sync-changes.service';
import { fileDeltaIngestTask } from '$lib/server/tasks/builtin/native/file-delta-ingest.js';
import type { UserContext } from '$lib/server/types';
import { hashFileHead } from '$lib/server/utils/file-hash.js';
import type { SyncChange } from '$lib/schemas/api-sync';
import { toUserId } from '$lib/shared/user-id';
import { compareSyncPositions, decodeSyncCursor, type SyncPosition } from './cursor';

// Same boundary as the scanner integration tests: real files, ffprobe, ingest,
// database queries and sync triggers; only remote matching/lifecycle enqueueing
// are stubbed. A clean provider miss creates a filename-only movie.
vi.mock('$lib/server/tasks/plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => false),
}));
vi.mock('$lib/server/services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async () => ({ matched: false })),
}));
vi.mock('$lib/server/services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: vi.fn(async () => undefined),
            afterReclaimed: vi.fn(async () => undefined),
        }),
    };
});

describe('scanner rename library delta sync', () => {
    let sql: Sql;
    let root: string | undefined;
    let libraryPathId: string | undefined;
    const groupId = randomUUID();
    const userId = toUserId(randomUUID());
    const titlePrefix = `Sync Rename ${randomUUID()}`;
    const mediaIds = new Set<string>();
    const user: UserContext = {
        userId,
        username: derivedUsername(userId),
        groups: 'admins',
        userGroups: ['admins'],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: true,
        mediaAccessIsAdmin: true,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };

    beforeAll(async () => {
        sql = getTestDb();
        await connectValkey();
        await ensureTestUser(sql, userId);
        await sql`INSERT INTO library_groups (id, name)
            VALUES (${groupId}::uuid, ${titlePrefix})`;
        root = await mkdtemp(join(tmpdir(), 'lumastra-sync-rename-'));
        const library = await createLibraryPath(sql, {
            path: root,
            media_type: 'movie',
            library_group_id: groupId,
        });
        libraryPathId = library.id;
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        try {
            // Include unexpected duplicate items when an identity assertion fails.
            const rows = await sql<{ id: string }[]>`SELECT id FROM media_items
                WHERE title LIKE ${titlePrefix + '%'}
                   OR id IN (SELECT mfi.media_item_id FROM media_file_items mfi
                       JOIN media_files mf ON mf.id = mfi.file_id
                       WHERE mf.library_group_id = ${groupId}::uuid)`;
            for (const row of rows) mediaIds.add(row.id);
            await sql`DELETE FROM media_items WHERE id = ANY(${[...mediaIds]}::uuid[])`;
            await sql`DELETE FROM media_files WHERE library_group_id = ${groupId}::uuid`;
            if (libraryPathId) await deleteLibraryPath(sql, libraryPathId);
            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
            await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
            await sql`DELETE FROM sync_changes WHERE entity_id = ANY(${[...mediaIds]}::text[])
                OR user_id = ${userId}::uuid`;
        } finally {
            if (root) await rm(root, { recursive: true, force: true });
            await closeTestDb();
            await disconnectValkey();
        }
    });

    async function ingest(
        upsert: string[],
        remove: string[],
        targetLibraryPathId = libraryPathId,
    ): Promise<void> {
        if (!targetLibraryPathId) throw new Error('Library path was not initialized');
        const response = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: targetLibraryPathId, upsert, remove },
            { sql },
        );
        expect(response.success).toBe(true);
        if (!response.result) throw new Error('Delta ingest returned no result');
        expect(response.result.softErrors).toBe(0);
        expect(response.result.succeeded).toBe(upsert.length + remove.length);
        expect(response.result.results.map((row) => row.outcome)).toEqual([
            ...remove.map(() => 'removed'),
            ...upsert.map(() => 'upserted'),
        ]);
    }

    async function linkedMovies(): Promise<{ id: string; file_path: string }[]> {
        return await sql<{ id: string; file_path: string }[]>`SELECT mi.id, mf.file_path
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mf.library_group_id = ${groupId}::uuid AND mi.media_type = 'movie'`;
    }

    async function latestChange(id: string): Promise<SyncPosition> {
        const [position] = await sql<SyncPosition[]>`SELECT xid::text, seq::text
            FROM sync_changes WHERE entity_id = ${id} AND user_id IS NULL
            ORDER BY sync_changes.xid DESC, sync_changes.seq DESC LIMIT 1`;
        if (!position) throw new Error('Scanner fixture produced no catalog sync change');
        return position;
    }

    async function through(
        cursor: string,
        target: SyncPosition,
    ): Promise<{ cursor: string; changes: SyncChange[] }> {
        const deadline = Date.now() + 5000;
        // xmin is cluster-wide. Wait until the WHOLE completed ingest is eligible
        // before reading: an empty page at an older horizon proves nothing, and
        // reading midway through a rename could split its coalesced upsert over
        // two polls. No transaction is held open while waiting for other writers.
        while (BigInt((await readSyncState(sql)).horizon) <= BigInt(target.xid)) {
            if (Date.now() >= deadline) {
                throw new Error('Scanner changes did not pass the cluster horizon within 5 s');
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        const changes: SyncChange[] = [];
        do {
            const page = await readSyncChanges({ sql, user, cursor, limit: 500 });
            changes.push(...page.items);
            cursor = page.page.nextCursor;
            const decoded = decodeSyncCursor(cursor, userId);
            if (decoded.status !== 'ok') throw new Error('Expected a valid sync cursor');
            if (compareSyncPositions(decoded.cursor, target) >= 0) return { cursor, changes };
            await new Promise((resolve) => setTimeout(resolve, 40));
        } while (Date.now() < deadline);
        throw new Error('Sync reader did not reach the completed scanner changes within 5 s');
    }

    it.each([
        { season: 1, episode: 18, numbering: 'S02E10-E11', reclaims: false },
        { season: 1, episode: 10, numbering: 'S02E10-E11', reclaims: false },
        { season: 2, episode: 18, numbering: 'S02E10-E11', reclaims: false },
        { season: 2, episode: 10, numbering: 'S02E10-E11', reclaims: true },
        { season: 2, episode: 11, numbering: 'S02E10-E11', reclaims: true },
        { season: 1, episode: 18, numbering: 'S02E10', reclaims: false },
        { season: 1, episode: 18, numbering: '', reclaims: true },
        // Air-date names carry no SxxEyy correction; a same-content rename keeps its UUID.
        { season: 1, episode: 18, numbering: '2026-10-21', reclaims: true },
    ])(
        'episode reclaim: S$season E$episode / $numbering -> $reclaims',
        async ({ season, episode, numbering, reclaims }) => {
            if (!root) throw new Error('Library root was not initialized');
            const id = randomUUID();
            mediaIds.add(id);
            const tvRoot = join(root, id);
            const rel = `Pinky and the Brain - ${numbering} - Die Mumie + Robin Brain.mp4`;
            const filePath = join(tvRoot, rel);
            await mkdir(tvRoot, { recursive: true });
            await copyFile(join(process.cwd(), 'tests/fixtures/test-video.mp4'), filePath);
            const marker = Buffer.from(randomUUID());
            const freeBox = Buffer.alloc(8 + marker.length);
            freeBox.writeUInt32BE(freeBox.length, 0);
            freeBox.write('free', 4, 'ascii');
            marker.copy(freeBox, 8);
            await appendFile(filePath, freeBox);
            const hash = await hashFileHead(filePath);
            await sql`INSERT INTO media_items
                (id, media_type, title, season_number, episode_number,
                 is_dismissed, dismissed_at, dismissed_content_hash)
                VALUES (${id}::uuid, 'episode', ${titlePrefix + ' dismissed ' + id},
                    ${season}, ${episode}, true, now(), ${hash})`;
            const library = await createLibraryPath(sql, {
                path: tvRoot,
                media_type: 'tv',
                library_group_id: groupId,
            });
            try {
                await ingest([rel], [], library.id);
                const linked = await sql<
                    {
                        id: string;
                        media_type: string;
                        season_number: number;
                        episode_number: number;
                    }[]
                >`SELECT mi.id, mi.media_type, mi.season_number, mi.episode_number
                    FROM media_items mi JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                    JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${filePath}
                    ORDER BY mi.episode_number`;
                for (const row of linked) mediaIds.add(row.id);
                const parents = await sql<{ id: string; parent_id: string | null }[]>`
                    SELECT p.id, p.parent_id FROM media_items ep
                    JOIN media_items p ON p.id = ep.parent_id
                    WHERE ep.id = ANY(${linked.map((row) => row.id)}::uuid[])`;
                for (const parent of parents) {
                    mediaIds.add(parent.id);
                    if (parent.parent_id) mediaIds.add(parent.parent_id);
                }
                expect(linked.length).toBeGreaterThan(0);
                expect(linked.every((row) => row.media_type === 'episode')).toBe(true);
                if (reclaims) {
                    expect(linked.map((row) => row.id)).toEqual([id]);
                } else {
                    expect(linked.map((row) => row.id)).not.toContain(id);
                    expect(linked.map((row) => [row.season_number, row.episode_number])).toEqual(
                        numbering === 'S02E10'
                            ? [[2, 10]]
                            : [
                                  [2, 10],
                                  [2, 11],
                              ],
                    );
                }
                const [candidate] = await sql<{ is_dismissed: boolean }[]>`SELECT is_dismissed
                    FROM media_items WHERE id = ${id}::uuid`;
                expect(candidate.is_dismissed).toBe(!reclaims);
            } finally {
                await rm(filePath);
                await ingest([], [rel], library.id);
                await deleteLibraryPath(sql, library.id);
            }
        },
        30000,
    );

    it.each([
        { kind: 'episode', provider: undefined, oldId: undefined, annotation: '', reclaims: false },
        { kind: 'movie', provider: undefined, oldId: undefined, annotation: '', reclaims: true },
        {
            kind: 'movie',
            provider: 'tmdb',
            oldId: '111',
            annotation: '[tmdbid-222]',
            reclaims: false,
        },
        {
            kind: 'movie',
            provider: 'imdb',
            oldId: 'tt1111111',
            annotation: '[imdbid-tt2222222]',
            reclaims: false,
        },
        {
            kind: 'movie',
            provider: 'tmdb',
            oldId: '333',
            annotation: '[tmdbid-333]',
            reclaims: true,
        },
        {
            kind: 'movie',
            provider: undefined,
            oldId: undefined,
            annotation: '[tmdbid-444]',
            reclaims: true,
        },
    ] as const)(
        'movies library reclaim: $kind / $annotation -> $reclaims',
        async ({ kind, provider, oldId, annotation, reclaims }) => {
            if (!root) throw new Error('Library root was not initialized');
            const id = randomUUID();
            mediaIds.add(id);
            const rel = `${titlePrefix} ${id} (2026) ${annotation}/film.mp4`;
            const filePath = join(root, rel);
            await mkdir(dirname(filePath), { recursive: true });
            await copyFile(join(process.cwd(), 'tests/fixtures/test-video.mp4'), filePath);
            // Give each scenario its own hash, even after a failed reclaim assertion.
            const marker = Buffer.from(randomUUID());
            const freeBox = Buffer.alloc(8 + marker.length);
            freeBox.writeUInt32BE(freeBox.length, 0);
            freeBox.write('free', 4, 'ascii');
            marker.copy(freeBox, 8);
            await appendFile(filePath, freeBox);
            const hash = await hashFileHead(filePath);
            await sql`INSERT INTO media_items
            (id, media_type, title, is_dismissed, dismissed_at, dismissed_content_hash)
            VALUES (${id}::uuid, ${kind}, ${titlePrefix + ' dismissed ' + id}, true, now(), ${hash})`;
            if (provider && oldId) {
                await insertTestExternalIds(sql, [
                    {
                        media_id: id,
                        provider,
                        external_id: oldId,
                        media_type: 'movie',
                        is_primary: true,
                    },
                ]);
            }

            await ingest([rel], []);
            const [linked] = await sql<
                { id: string; media_type: string }[]
            >`SELECT mi.id, mi.media_type
            FROM media_items mi JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${filePath}`;
            try {
                expect(linked).toBeDefined();
                mediaIds.add(linked.id);
                expect(linked.media_type).toBe('movie');
                if (reclaims) expect(linked.id).toBe(id);
                else expect(linked.id).not.toBe(id);
                const [candidate] = await sql<{ is_dismissed: boolean }[]>`SELECT is_dismissed
            FROM media_items WHERE id = ${id}::uuid`;
                expect(candidate.is_dismissed).toBe(!reclaims);
                // Retire the linked file so the existing single-movie sync test stays isolated.
            } finally {
                await rm(filePath);
                await ingest([], [rel]);
            }
        },
        30000,
    );

    it('keeps the movie UUID across hash reclaim and emits delete only after final removal', async () => {
        if (!root) throw new Error('Library root was not initialized');
        const oldRel = `${titlePrefix} Original (2026)/original.mp4`;
        const newRel = `${titlePrefix} Moved (2026)/renamed.mp4`;
        const oldPath = join(root, oldRel);
        const newPath = join(root, newRel);
        await mkdir(dirname(oldPath), { recursive: true });
        await copyFile(join(process.cwd(), 'tests/fixtures/test-video.mp4'), oldPath);
        // This fixture is smaller than 64 KiB. Append a valid MP4 free box so
        // another test's dismissed copy cannot be reclaimed by our first ingest.
        const marker = Buffer.from(randomUUID());
        const freeBox = Buffer.alloc(8 + marker.length);
        freeBox.writeUInt32BE(freeBox.length, 0);
        freeBox.write('free', 4, 'ascii');
        marker.copy(freeBox, 8);
        await appendFile(oldPath, freeBox);
        const headHash = await hashFileHead(oldPath);

        await ingest([oldRel], []);
        const initial = await linkedMovies();
        for (const row of initial) mediaIds.add(row.id);
        expect(initial).toHaveLength(1);
        const id = initial[0].id;
        const [{ created_at: createdAt }] = await sql<{ created_at: Date }[]>`SELECT created_at
            FROM media_items WHERE id = ${id}::uuid`;
        expect(initial[0].file_path).toBe(oldPath);
        const [stored] = await sql<{ file_hash_head: string | null }[]>`SELECT file_hash_head
            FROM media_files WHERE file_path = ${oldPath}`;
        expect(stored.file_hash_head).toBe(headHash);

        const start = await readSyncChanges({ sql, user, limit: 500 });
        expect(start.items).toEqual([]);
        expect(start.page.hasMore).toBe(false);
        // Initial-load cursors can precede our committed ingest while another
        // cluster writer is open. Drain those initial events before the rename.
        const baseline = await through(start.page.nextCursor, await latestChange(id));
        const reclaim = vi.spyOn(rematch, 'findReclaimableByHash');

        await mkdir(dirname(newPath), { recursive: true });
        await rename(oldPath, newPath);
        expect(await hashFileHead(newPath)).toBe(headHash);
        // Real watcher-style rename batch: remove snapshots/dismisses first,
        // then ingestSingleFile -> processVideoFile -> tryReclaimByHash.
        await ingest([newRel], [oldRel]);
        expect(reclaim).toHaveBeenCalledWith(sql, headHash);
        expect(reclaim).toHaveBeenCalledTimes(1);
        await expect(reclaim.mock.results[0].value).resolves.toMatchObject({ media_item_id: id });
        expect(await linkedMovies()).toEqual([{ id, file_path: newPath }]);
        const [movie] = await sql<{ is_dismissed: boolean; status: string }[]>`SELECT
            is_dismissed, status FROM media_items WHERE id = ${id}::uuid`;
        expect(movie).toMatchObject({ is_dismissed: false, status: 'active' });
        // The rename minted no second movie (the title comes from the filename parser, so
        // scope the creation-time check to this fixture rather than other test files' rows.
        const newMovies = await sql<{ id: string }[]>`SELECT id FROM media_items
            WHERE media_type = 'movie' AND id <> ${id}::uuid AND created_at >= ${createdAt}
              AND title LIKE ${titlePrefix + '%'}`;
        expect(newMovies).toEqual([]);

        const renamed = await through(baseline.cursor, await latestChange(id));
        expect(renamed.changes.filter((row) => row.id === id && row.op === 'delete')).toEqual([]);
        const movies = renamed.changes.filter((row) => row.kind === 'movie');
        expect(movies.every((row) => row.id === id && row.op === 'upsert')).toBe(true);
        expect(movies.length).toBeLessThanOrEqual(1);

        await rm(newPath);
        await ingest([], [newRel]);
        expect(await linkedMovies()).toEqual([]);
        const removed = await through(renamed.cursor, await latestChange(id));
        // Covers both physical deletion and soft dismissal/leaving the sync set.
        expect(removed.changes).toContainEqual(
            expect.objectContaining({ kind: 'movie', id, op: 'delete' }),
        );
    }, 30000);
});
