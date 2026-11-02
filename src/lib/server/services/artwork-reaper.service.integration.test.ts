// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the artwork reaper sweep.
 *
 * Uses a real Postgres (lumastra_tests) and a real temp directory so the
 * `assessFilePresence` classification is exercised against actual inodes —
 * mocking the filesystem here would defeat the entire point of the mount-flap
 * safety guarantee this suite exists to prove.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import * as filePresence from '../utils/file-presence.js';
import { lockArtworkOwners } from '../database/queries/media-artwork.queries.js';
import { selectImageCandidate } from '../database/queries/image-candidates.queries.js';
import { createLibraryPath } from '../database/queries/library-paths.queries.js';
import {
    reapMissingArtwork,
    artworkMissKey,
    type ArtworkMissRecord,
    type ArtworkMissStore,
} from './artwork-reaper.service.js';

interface MemoryMissStore extends ArtworkMissStore {
    raw: Map<string, ArtworkMissRecord>;
}

function memoryMissStore(): MemoryMissStore {
    const raw = new Map<string, ArtworkMissRecord>();
    return {
        raw,
        get: async (key) => raw.get(key) ?? null,
        set: async (key, value) => {
            raw.set(key, value);
        },
        del: async (key) => {
            raw.delete(key);
        },
    };
}

/** Insert one movie + one local poster row pointing at `filePath`. */
async function seedPoster(
    sql: postgres.Sql,
    filePath: string,
): Promise<{ itemId: string; artworkId: string }> {
    const item = createTestMediaItem({ media_type: 'movie' });
    await insertTestMediaItem(sql, item);
    await sql`
        INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
        VALUES (${item.id}::uuid, 'poster', 'local', ${filePath})
    `;
    // Mirror the custom_<type>_url invariant upsertLocalArtwork maintains, so
    // we can assert the reaper clears it on delete.
    await sql`
        UPDATE media_items
        SET custom_poster_url = ${`/api/image/custom/${item.id}/poster`}
        WHERE id = ${item.id}::uuid
    `;
    const [row] = await sql<{ id: string }[]>`SELECT id FROM image_candidates
        WHERE media_item_id = ${item.id} AND artwork_type = 'poster' AND selected`;
    return { itemId: item.id, artworkId: row.id };
}

describe('reapMissingArtwork', () => {
    let sql: postgres.Sql;
    let tmp: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_artwork',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name = 'Reaper Test'`;
        tmp = await mkdtemp(join(tmpdir(), 'artwork-reaper-'));
    });

    // Every case gets its OWN mkdtemp directory, so cleanup must be per-case.
    // A single "cleanup" test at the bottom would only remove the last one and
    // leak one tree per case into the OS temp dir.
    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tmp, { recursive: true, force: true });
    });

    it('leaves a row alone when its file is present', async () => {
        const dir = join(tmp, 'Haze (1995)');
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, 'poster.jpg');
        await writeFile(filePath, 'jpegbytes');
        const { artworkId } = await seedPoster(sql, filePath);

        const store = memoryMissStore();
        const result = await reapMissingArtwork(sql, {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 1,
            cursor: null,
            misses: store,
        });

        expect(result.inspected).toBe(1);
        expect(result.present).toBe(1);
        expect(result.deleted).toBe(0);
        expect(store.raw.size).toBe(0);
        const rows = await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`;
        expect(rows).toHaveLength(1);
    });

    it('deletes the row and clears custom_poster_url after N consecutive misses', async () => {
        const dir = join(tmp, 'Haze (1995)');
        await mkdir(dir, { recursive: true });
        // The directory exists; only the file is gone => a real deletion.
        const filePath = join(dir, 'poster.jpg');
        const { itemId, artworkId } = await seedPoster(sql, filePath);

        const store = memoryMissStore();
        const opts = {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 2,
            cursor: null,
            misses: store,
        };

        const run1 = await reapMissingArtwork(sql, opts);
        expect(run1.missing).toBe(1);
        expect(run1.deleted).toBe(0);
        expect(store.raw.get(artworkMissKey(artworkId))).toEqual({ filePath, misses: 1 });
        expect(
            await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`,
        ).toHaveLength(1);

        const run2 = await reapMissingArtwork(sql, opts);
        expect(run2.deleted).toBe(1);
        expect(store.raw.size).toBe(0);
        expect(
            await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`,
        ).toHaveLength(0);

        const [item] = await sql<{ custom_poster_url: string | null }[]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${itemId}::uuid
        `;
        expect(item.custom_poster_url).toBeNull();
        expect(
            await sql`SELECT id FROM media_artwork WHERE media_item_id = ${itemId}`,
        ).toHaveLength(0);
    });

    it('MOUNT-FLAP SAFETY: deletes nothing when the parent directory is also absent', async () => {
        // No library_paths row covers this path, so assessFilePresence falls
        // back to the immediate-parent probe. Parent absent => 'transient'.
        const filePath = join(tmp, 'never-created', 'poster.jpg');
        const { artworkId } = await seedPoster(sql, filePath);

        const store = memoryMissStore();
        const opts = {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 1,
            cursor: null,
            misses: store,
        };

        const run1 = await reapMissingArtwork(sql, opts);
        const run2 = await reapMissingArtwork(sql, opts);

        expect(run1.transient).toBe(1);
        expect(run2.transient).toBe(1);
        expect(run1.deleted + run2.deleted).toBe(0);
        expect(run1.missing + run2.missing).toBe(0);
        // Nothing was even counted — a flap must not accumulate evidence.
        expect(store.raw.size).toBe(0);
        expect(
            await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`,
        ).toHaveLength(1);
    });

    it.each(['lock', 'repoint'] as const)(
        'rejects stale deletion after an admin %s during the filesystem await',
        async (action) => {
            const missingPath = join(tmp, 'missing.jpg');
            const replacementPath = join(tmp, 'replacement.jpg');
            await writeFile(replacementPath, 'replacement bytes');
            const { itemId, artworkId } = await seedPoster(sql, missingPath);
            let observed!: () => void;
            let resume!: () => void;
            const observedPromise = new Promise<void>((resolve) => {
                observed = resolve;
            });
            const resumePromise = new Promise<void>((resolve) => {
                resume = resolve;
            });
            const assess = filePresence.assessFilePresence;
            const probe = vi
                .spyOn(filePresence, 'assessFilePresence')
                .mockImplementationOnce(async (...args) => {
                    const presence = await assess(...args);
                    expect(presence).toBe('missing');
                    observed();
                    await resumePromise;
                    return presence;
                });
            const reaping = reapMissingArtwork(sql, {
                inspectLimit: 100,
                deleteLimit: 100,
                missThreshold: 1,
                cursor: null,
                misses: memoryMissStore(),
            });
            try {
                await observedPromise;
                await sql.begin(async (raw) => {
                    const tx = raw as unknown as postgres.Sql;
                    await lockArtworkOwners(tx, [itemId]);
                    if (action === 'lock')
                        await selectImageCandidate(tx, itemId, artworkId, true, true);
                    else
                        await tx`UPDATE image_candidates SET file_path = ${replacementPath} WHERE id = ${artworkId}`;
                });
            } finally {
                resume();
            }
            expect((await reaping).deleted).toBe(0);
            expect(probe).toHaveBeenCalledTimes(2);
            expect(
                await sql`SELECT id, file_path, locked FROM image_candidates WHERE id = ${artworkId}`,
            ).toEqual([
                {
                    id: artworkId,
                    file_path: action === 'lock' ? missingPath : replacementPath,
                    locked: action === 'lock',
                },
            ]);
            expect(
                await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${itemId}`,
            ).toEqual([
                {
                    file_path: action === 'lock' ? missingPath : replacementPath,
                },
            ]);
            expect(
                await sql`SELECT custom_poster_url FROM media_items WHERE id = ${itemId}`,
            ).toEqual([
                {
                    custom_poster_url: `/api/image/custom/${itemId}/poster`,
                },
            ]);
        },
    );

    it.each(['restore', 'upgrade'] as const)(
        'preserves same-path artwork after an automatic %s during the missing probe',
        async (action) => {
            const filePath = join(tmp, 'restored.jpg');
            const { itemId, artworkId } = await seedPoster(sql, filePath);
            const assess = filePresence.assessFilePresence;
            vi.spyOn(filePresence, 'assessFilePresence').mockImplementationOnce(async (...args) => {
                const presence = await assess(...args);
                expect(presence).toBe('missing');
                if (action === 'restore') await writeFile(filePath, 'restored bytes');
                const { upsertLocalArtworkWithOutcome } =
                    await import('../database/queries/media-artwork.queries.js');
                await upsertLocalArtworkWithOutcome(sql, {
                    mediaItemId: itemId,
                    artworkType: 'poster',
                    filePath,
                    ...(action === 'upgrade' ? { sourceTag: 'provider:tmdb' } : {}),
                });
                return presence;
            });
            const result = await reapMissingArtwork(sql, {
                inspectLimit: 100,
                deleteLimit: 100,
                missThreshold: 1,
                cursor: null,
                misses: memoryMissStore(),
            });
            expect(result.deleted).toBe(0);
            expect(await sql`SELECT id FROM image_candidates WHERE id=${artworkId}`).toHaveLength(
                1,
            );
        },
    );

    it('rejects a timestamp-only concurrent refresh while the file remains missing', async () => {
        const filePath = join(tmp, 'still-missing.jpg');
        const { itemId, artworkId } = await seedPoster(sql, filePath);
        const before =
            await sql`SELECT id,file_path,provider,provider_ref,remote_url,locked,chosen_by FROM image_candidates WHERE id=${artworkId}`;
        const mirror =
            await sql`SELECT id,file_path,remote_url FROM media_artwork WHERE media_item_id=${itemId}`;
        const assess = filePresence.assessFilePresence;
        const probe = vi
            .spyOn(filePresence, 'assessFilePresence')
            .mockImplementationOnce(async (...args) => {
                const presence = await assess(...args);
                expect(presence).toBe('missing');
                await sql.begin(async (raw) => {
                    const tx = raw as unknown as postgres.Sql;
                    await lockArtworkOwners(tx, [itemId]);
                    await tx`UPDATE image_candidates SET updated_at=updated_at + interval '1 second' WHERE id=${artworkId}`;
                });
                return presence;
            });
        const result = await reapMissingArtwork(sql, {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 1,
            cursor: null,
            misses: memoryMissStore(),
        });
        expect(result.deleted).toBe(0);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(await filePresence.assessFilePresence(filePath)).toBe('missing');
        expect(
            await sql`SELECT id,file_path,provider,provider_ref,remote_url,locked,chosen_by FROM image_candidates WHERE id=${artworkId}`,
        ).toEqual(before);
        expect(
            await sql`SELECT id,file_path,remote_url FROM media_artwork WHERE media_item_id=${itemId}`,
        ).toEqual(mirror);
        expect(await sql`SELECT custom_poster_url FROM media_items WHERE id=${itemId}`).toEqual([
            { custom_poster_url: `/api/image/custom/${itemId}/poster` },
        ]);
    });

    it('never probes a legacy HTTP reference as a local file', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await sql`INSERT INTO media_artwork (media_item_id,artwork_type,source,file_path)
            VALUES (${item.id},'poster','tmdb','https://image.tmdb.org/t/p/original/remote.jpg')`;
        const probe = vi.spyOn(filePresence, 'assessFilePresence');
        const result = await reapMissingArtwork(sql, {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 1,
            cursor: null,
            misses: memoryMissStore(),
        });
        expect(result.inspected).toBe(0);
        expect(probe).not.toHaveBeenCalled();
        expect(
            await sql`SELECT source,file_path,provider,provider_ref,remote_url FROM image_candidates WHERE media_item_id = ${item.id}`,
        ).toEqual([
            {
                source: 'remote',
                file_path: null,
                provider: 'tmdb',
                provider_ref: 'https://image.tmdb.org/t/p/original/remote.jpg',
                remote_url: 'https://image.tmdb.org/t/p/original/remote.jpg',
            },
        ]);
    });

    it('honours deleteLimit and returns a resumable cursor', async () => {
        const dir = join(tmp, 'gone');
        await mkdir(dir, { recursive: true });
        await seedPoster(sql, join(dir, 'a.jpg'));
        await seedPoster(sql, join(dir, 'b.jpg'));
        await seedPoster(sql, join(dir, 'c.jpg'));

        const store = memoryMissStore();
        const result = await reapMissingArtwork(sql, {
            inspectLimit: 100,
            deleteLimit: 1,
            missThreshold: 1,
            cursor: null,
            misses: store,
        });

        expect(result.deleted).toBe(1);
        expect(await sql`SELECT id FROM media_artwork`).toHaveLength(2);
        // The run stopped on its delete budget, not at the end of the table,
        // so it hands back a real cursor (the last media_item_id of the page
        // it was working) rather than the null "wrapped" sentinel.
        expect(result.nextCursor).not.toBeNull();
    });

    it('returns a null cursor once the sweep wraps past the last item', async () => {
        const dir = join(tmp, 'Haze (1995)');
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, 'poster.jpg');
        await writeFile(filePath, 'jpegbytes');
        await seedPoster(sql, filePath);

        const result = await reapMissingArtwork(sql, {
            inspectLimit: 100,
            deleteLimit: 100,
            missThreshold: 3,
            cursor: null,
            misses: memoryMissStore(),
        });

        expect(result.nextCursor).toBeNull();
    });

    describe('mount awareness', () => {
        const GROUP_ID = '00000000-0000-0000-0000-0000000000a6';

        it('classifies a deleted FOLDER on a live library root as missing, not transient', async () => {
            // Season-foldered layout: Show/Season 01/poster.jpg. The whole "Show"
            // directory is removed. The file AND its parent are gone, so the
            // immediate-parent heuristic alone would say "mount offline" and the
            // row would never be reaped. The library root still exists, so with
            // mountRoot wired the verdict is a real deletion.
            const seasonDir = join(tmp, 'Show', 'Season 01');
            await mkdir(seasonDir, { recursive: true });
            const filePath = join(seasonDir, 'poster.jpg');
            await writeFile(filePath, 'jpegbytes');
            const { artworkId } = await seedPoster(sql, filePath);
            await rm(join(tmp, 'Show'), { recursive: true, force: true });

            await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP_ID}::uuid, 'Reaper Test') ON CONFLICT DO NOTHING`;
            await createLibraryPath(sql, {
                path: tmp,
                // 'tv', NOT 'series'. This is the DB side of the seam:
                // LibraryPathMediaType / library_paths_media_type_check accept
                // 'tv'. 'series' is the SDK appliesTo spelling and is rejected by
                // both the type and the CHECK constraint.
                media_type: 'tv',
                library_group_id: GROUP_ID,
            });

            const result = await reapMissingArtwork(sql, {
                inspectLimit: 100,
                deleteLimit: 100,
                missThreshold: 1,
                cursor: null,
                misses: memoryMissStore(),
            });

            expect(result.missing).toBe(1);
            expect(result.transient).toBe(0);
            expect(result.deleted).toBe(1);
            expect(
                await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`,
            ).toHaveLength(0);
        });

        it('MOUNT-FLAP SAFETY: deletes nothing when the library root itself is gone', async () => {
            const offlineRoot = join(tmp, 'offline-mount');
            // Registered as a library path but never created on disk => the whole
            // share is offline.
            const filePath = join(offlineRoot, 'Show', 'Season 01', 'poster.jpg');
            const { artworkId } = await seedPoster(sql, filePath);

            await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP_ID}::uuid, 'Reaper Test') ON CONFLICT DO NOTHING`;
            await createLibraryPath(sql, {
                path: offlineRoot,
                // 'tv', NOT 'series' — see the note above.
                media_type: 'tv',
                library_group_id: GROUP_ID,
            });

            const store = memoryMissStore();
            const result = await reapMissingArtwork(sql, {
                inspectLimit: 100,
                deleteLimit: 100,
                missThreshold: 1,
                cursor: null,
                misses: store,
            });

            expect(result.transient).toBe(1);
            expect(result.missing).toBe(0);
            expect(result.deleted).toBe(0);
            expect(store.raw.size).toBe(0);
            expect(
                await sql`SELECT id FROM image_candidates WHERE id = ${artworkId}::uuid`,
            ).toHaveLength(1);
        });
    });
});
