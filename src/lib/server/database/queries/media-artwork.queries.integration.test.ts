// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Artwork Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    upsertLocalArtwork,
    getArtworkForMediaItem,
    getLocalArtwork,
    getOwnLocalArtwork,
    addArtworkSuppression,
    clearArtworkSuppression,
    isArtworkSuppressed,
    hasArtworkSuppressionForType,
    findManagedArtworkClaimForPath,
    getLocalArtworkInheritedBatch,
    getOwnStillPresence,
    deleteLocalArtworkForItem,
    deleteArtworkById,
    getArtworkWithInheritance,
    findDuplicateThumbEpisodes,
    findEpisodeThumbnailWork,
    loadEpisodeThumbnailExclusions,
    remapEpisodeThumbnailPath,
} from './media-artwork.queries.js';

describe('Media Artwork Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_artwork',
            'media_artwork_suppressions',
        ]);
    });

    // ========================================================================
    // upsertLocalArtwork
    // ========================================================================

    describe('upsertLocalArtwork', () => {
        it('inserts a new local artwork row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/artwork/poster.jpg',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].artwork_type).toBe('poster');
            expect(rows[0].file_path).toBe('/artwork/poster.jpg');
            expect(rows[0].source).toBe('local');
        });

        it('retains a new file as an alternative candidate', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/old.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/new.jpg',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toHaveLength(2);
            expect(rows.map((row) => row.file_path)).toEqual(
                expect.arrayContaining(['/old.jpg', '/new.jpg']),
            );
            expect((await getOwnLocalArtwork(sql, item.id, 'poster'))?.file_path).toBe('/new.jpg');
        });

        it('sets custom_poster_url on media_items when null', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            const [row] = await sql`
                SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(row.custom_poster_url).toContain('/api/image/custom/');
        });

        it('does not overwrite existing custom_poster_url', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items SET custom_poster_url = 'http://existing.com/poster.jpg'
                WHERE id = ${item.id}::uuid
            `;

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            const [row] = await sql`
                SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(row.custom_poster_url).toBe('http://existing.com/poster.jpg');
        });

        it('preserves a managed remote_url when a tagless write re-registers the SAME file', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
                sourceTag: 'provider:tmdb:poster',
            });
            // The next library scan re-registers the exact same file with no tag.
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows[0].remote_url).toBe('provider:tmdb:poster');
        });

        it('preserves a generated: and an admin: tag the same way', async () => {
            for (const tag of ['generated:frame', 'admin:file']) {
                const item = createTestMediaItem({ media_type: 'episode' });
                await insertTestMediaItem(sql, item);
                await upsertLocalArtwork(sql, {
                    mediaItemId: item.id,
                    artworkType: 'thumb',
                    filePath: '/series/Show/S01E01-thumb.jpg',
                    sourceTag: tag,
                });
                await upsertLocalArtwork(sql, {
                    mediaItemId: item.id,
                    artworkType: 'thumb',
                    filePath: '/series/Show/S01E01-thumb.jpg',
                });

                const rows = await getArtworkForMediaItem(sql, item.id);
                expect(rows[0].remote_url).toBe(tag);
            }
        });

        it.each(['frame-extract', 'upload', 'embedded', 'tmdb'])(
            'preserves %s candidate identity and curation on tagless rescans',
            async (provider) => {
                const item = createTestMediaItem({ media_type: 'episode' });
                await insertTestMediaItem(sql, item);
                const filePath = `/series/Show/S01E01-${item.id.slice(0, 8)}-thumb.jpg`;
                for (const language of ['', 'de']) {
                    await sql`DELETE FROM image_candidates WHERE media_item_id = ${item.id}`;
                    await sql`INSERT INTO image_candidates
                        (media_item_id, artwork_type, source, provider, provider_ref, file_path, language)
                        VALUES (${item.id}, 'thumb', 'local', ${provider}, 'writer-reference', ${filePath}, ${language}),
                            (${item.id}, 'thumb', 'remote', 'tvdb', 'alternative-reference', NULL, '')`;
                    for (const selected of [true, false]) {
                        // Curation fires reselect; set the intended selection only afterwards.
                        await sql`UPDATE image_candidates SET chosen_by = 'user', locked = true
                            WHERE media_item_id = ${item.id} AND provider = ${provider}`;
                        await sql`UPDATE image_candidates SET selected = false WHERE media_item_id = ${item.id}`;
                        await sql`UPDATE image_candidates SET selected = true
                            WHERE media_item_id = ${item.id} AND provider = ${selected ? provider : 'tvdb'}`;
                        const before = await sql`SELECT * FROM image_candidates
                            WHERE media_item_id = ${item.id} ORDER BY id`;
                        expect(before.find((row) => row.provider === provider)?.selected).toBe(
                            selected,
                        );
                        expect(before.find((row) => row.provider === 'tvdb')?.selected).toBe(
                            !selected,
                        );
                        // Exercise the pooled fast path and the locked nested path,
                        // including the URL self-heal that forces real registration.
                        await upsertLocalArtwork(sql, {
                            mediaItemId: item.id,
                            artworkType: 'thumb',
                            filePath,
                        });
                        expect([
                            ...(await sql`SELECT * FROM image_candidates WHERE media_item_id = ${item.id} ORDER BY id`),
                        ]).toEqual([...before]);
                        await sql.begin(async (tx) => {
                            await tx`UPDATE media_items SET custom_thumb_url = NULL WHERE id = ${item.id}`;
                            // Clearing the serve URL also fires reselect. Restore
                            // the intended fixture before the nested rescan.
                            await tx`UPDATE image_candidates SET selected = false WHERE media_item_id = ${item.id}`;
                            await tx`UPDATE image_candidates SET selected = true
                                WHERE media_item_id = ${item.id} AND provider = ${selected ? provider : 'tvdb'}`;
                            const current = await tx`SELECT provider, selected FROM image_candidates
                                WHERE media_item_id = ${item.id}`;
                            expect(current.find((row) => row.provider === provider)?.selected).toBe(
                                selected,
                            );
                            expect(current.find((row) => row.provider === 'tvdb')?.selected).toBe(
                                !selected,
                            );
                            await upsertLocalArtwork(tx as unknown as postgres.Sql, {
                                mediaItemId: item.id,
                                artworkType: 'thumb',
                                filePath,
                            });
                        });
                        const after = await sql`SELECT * FROM image_candidates
                            WHERE media_item_id = ${item.id} ORDER BY id`;
                        expect([...after]).toEqual([...before]);
                    }
                }
            },
        );

        it('keeps a selected automatic alias when another curated candidate is unselected', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            const filePath = '/series/Show/shared-thumb.jpg';
            await sql`INSERT INTO image_candidates
                (media_item_id, artwork_type, source, provider, provider_ref, file_path)
                VALUES (${item.id}, 'thumb', 'local', 'local-folder', ${filePath}, ${filePath}),
                    (${item.id}, 'thumb', 'local', 'frame-extract', 'managed-reference', ${filePath}),
                    (${item.id}, 'thumb', 'remote', 'tvdb', 'curated-reference', NULL)`;
            await sql`UPDATE image_candidates SET chosen_by = 'user', locked = true
                WHERE media_item_id = ${item.id} AND provider = 'tvdb'`;
            await sql`UPDATE image_candidates SET selected = false WHERE media_item_id = ${item.id}`;
            await sql`UPDATE image_candidates SET selected = true
                WHERE media_item_id = ${item.id} AND provider = 'local-folder'`;
            const before =
                await sql`SELECT * FROM image_candidates WHERE media_item_id = ${item.id} ORDER BY id`;
            expect(before.find((row) => row.provider === 'tvdb')?.selected).toBe(false);
            expect(before.find((row) => row.provider === 'local-folder')?.selected).toBe(true);
            await sql.begin(async (tx) => {
                await upsertLocalArtwork(tx as unknown as postgres.Sql, {
                    mediaItemId: item.id,
                    artworkType: 'thumb',
                    filePath,
                });
            });
            expect([
                ...(await sql`SELECT * FROM image_candidates WHERE media_item_id = ${item.id} ORDER BY id`),
            ]).toEqual([...before]);
        });

        it('reuses a localized generated backdrop and its thumb on nested tagless rescans', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            const filePath = '/series/Show/localized-backdrop.jpg';
            await sql`INSERT INTO media_artwork
                (media_item_id, artwork_type, source, file_path, remote_url, language)
                VALUES (${item.id}, 'backdrop', 'local', ${filePath}, 'generated:ffmpeg', 'de')`;
            const before =
                await sql`SELECT * FROM image_candidates WHERE media_item_id = ${item.id} ORDER BY id`;
            expect(before).toHaveLength(2);
            expect(before.every((row) => row.language === 'de')).toBe(true);
            for (let scan = 0; scan < 2; scan++) {
                await sql.begin(async (tx) => {
                    await upsertLocalArtwork(tx as unknown as postgres.Sql, {
                        mediaItemId: item.id,
                        artworkType: 'backdrop',
                        filePath,
                    });
                });
                expect([
                    ...(await sql`SELECT * FROM image_candidates WHERE media_item_id = ${item.id} ORDER BY id`),
                ]).toEqual([...before]);
            }
        });

        it('keeps provenance on the original candidate when a tagless write registers a different file', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
                sourceTag: 'provider:tmdb:poster',
            });
            // The user's sidecar is a separate candidate; it must not inherit
            // the managed file's provenance or admin Remove could unlink it.
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/folder.jpg',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toHaveLength(2);
            expect(
                rows.find((row) => row.file_path === '/series/Show/folder.jpg')?.remote_url,
            ).toBeNull();
            expect(
                rows.find((row) => row.file_path === '/series/Show/poster.jpg')?.remote_url,
            ).toBe('provider:tmdb:poster');
        });

        it('an explicit new tag always wins', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
                sourceTag: 'provider:tmdb:poster',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
                sourceTag: 'admin:file',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toHaveLength(2);
            expect((await getOwnLocalArtwork(sql, item.id, 'poster'))?.remote_url).toBe(
                'admin:file',
            );
        });
    });

    // ========================================================================
    // getArtworkForMediaItem
    // ========================================================================

    describe('upsertLocalArtworkWithOutcome steady state', () => {
        const params = (id: string) => ({
            mediaItemId: id,
            artworkType: 'poster' as const,
            filePath: '/lib/poster.jpg',
        });

        // Holding FOR UPDATE on the owner row blocks any FOR NO KEY UPDATE. The
        // call under test either resolves while the row is held (it took no owner
        // lock) or shows up waiting on a lock in pg_stat_activity ('blocked').
        // No timing race: the verdict is whichever of the two is observed first,
        // and the pending call is always awaited after the row is released.
        async function whileOwnerRowHeld<T>(
            id: string,
            fn: () => Promise<T>,
        ): Promise<T | 'blocked'> {
            let release!: () => void;
            const held = new Promise<void>((r) => (release = r));
            let locked!: () => void;
            const lockedP = new Promise<void>((r) => (locked = r));
            const holder = sql.begin(async (t) => {
                await t`SELECT 1 FROM media_items WHERE id = ${id}::uuid FOR UPDATE`;
                locked();
                await held;
            });
            await lockedP;
            let settled = false;
            const call = fn().finally(() => {
                settled = true;
            });
            try {
                for (let i = 0; i < 500 && !settled; i++) {
                    const [{ waiting }] = await sql<[{ waiting: boolean }]>`
                        SELECT EXISTS (
                            SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database()
                              AND wait_event_type = 'Lock'
                        ) AS waiting`;
                    if (waiting) return 'blocked';
                    await new Promise((r) => setTimeout(r, 20));
                }
                return await call;
            } finally {
                release();
                await holder;
                await call.catch(() => undefined);
            }
        }

        it('an already-registered file reports unchanged WITHOUT locking the owner row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            expect(await upsertLocalArtworkWithOutcome(sql, params(item.id))).toBe('inserted');

            const out = await whileOwnerRowHeld(item.id, () =>
                upsertLocalArtworkWithOutcome(sql, params(item.id)),
            );
            expect(out).toBe('unchanged');
        });

        it('repeated localized tagless registrations avoid the owner lock', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`INSERT INTO media_artwork
                (media_item_id, artwork_type, source, file_path, remote_url, language)
                VALUES (${item.id}, 'poster', 'local', '/lib/poster.jpg', 'provider:tmdb:poster', 'de')`;
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            // Claim the serve URL before testing steady-state registration.
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            expect(
                (await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}`)[0]
                    .custom_poster_url,
            ).not.toBeNull();
            for (let scan = 0; scan < 2; scan++) {
                expect(
                    await whileOwnerRowHeld(item.id, () =>
                        upsertLocalArtworkWithOutcome(sql, params(item.id)),
                    ),
                ).toBe('unchanged');
            }
        });

        it('checks measurements on the same localized identity the locked path reuses', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`INSERT INTO image_candidates
                (media_item_id, artwork_type, source, provider, provider_ref, file_path, language, width)
                VALUES (${item.id}, 'poster', 'local', 'tmdb', 'localized', '/lib/poster.jpg', 'de', 100),
                    (${item.id}, 'poster', 'local', 'local-folder', '/lib/poster.jpg', '/lib/poster.jpg', '', 200)`;
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            // Claim the serve URL before testing steady-state registration.
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            expect(
                (await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}`)[0]
                    .custom_poster_url,
            ).not.toBeNull();
            expect(
                await whileOwnerRowHeld(item.id, () =>
                    upsertLocalArtworkWithOutcome(sql, { ...params(item.id), width: 200 }),
                ),
            ).toBe('blocked');
            const [localized] = await sql`SELECT width FROM image_candidates
                WHERE media_item_id = ${item.id} AND provider_ref = 'localized'`;
            expect(localized.width).toBe(200);
        });

        it('honors provider suppression on the reused localized identity', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`INSERT INTO media_artwork
                (media_item_id, artwork_type, source, file_path, remote_url, language)
                VALUES (${item.id}, 'poster', 'local', '/lib/poster.jpg', 'provider:tmdb:poster', 'de')`;
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            // Claim the serve URL before testing steady-state registration.
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            expect(
                (await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}`)[0]
                    .custom_poster_url,
            ).not.toBeNull();
            await sql`INSERT INTO image_provider_suppressions (owner, provider, role)
                VALUES (${item.id}, 'tmdb', 'poster')`;
            expect(await upsertLocalArtworkWithOutcome(sql, params(item.id))).toBe('suppressed');
        });

        it('a first registration still takes the owner lock', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            const out = await whileOwnerRowHeld(item.id, () =>
                upsertLocalArtworkWithOutcome(sql, params(item.id)),
            );
            expect(out).toBe('blocked');
        });

        it('inside a caller transaction an already-registered file still takes the owner lock', async () => {
            // Nested callers rely on this lock for their own lock order
            // (album first, then track), so the fast path must not apply there.
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            expect(await upsertLocalArtworkWithOutcome(sql, params(item.id))).toBe('inserted');

            const out = await whileOwnerRowHeld(item.id, () =>
                sql.begin((tx) =>
                    upsertLocalArtworkWithOutcome(tx as unknown as typeof sql, params(item.id)),
                ),
            );
            expect(out).toBe('blocked');
        });

        it('a cleared custom_poster_url is still self-healed (no fast path)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            await sql`UPDATE media_items SET custom_poster_url = NULL WHERE id = ${item.id}::uuid`;

            expect(await upsertLocalArtworkWithOutcome(sql, params(item.id))).toBe('unchanged');
            const [row] =
                await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid`;
            expect(row.custom_poster_url).toContain('/api/image/custom/');
        });

        it('a tombstone added after registration still yields suppressed', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');
            expect(await upsertLocalArtworkWithOutcome(sql, params(item.id))).toBe('suppressed');
        });

        it('a different incoming tag or path is not short-circuited', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const { upsertLocalArtworkWithOutcome } = await import('./media-artwork.queries.js');
            await upsertLocalArtworkWithOutcome(sql, params(item.id));
            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    ...params(item.id),
                    sourceTag: 'provider:x',
                }),
            ).toBe('inserted');
            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    ...params(item.id),
                    filePath: '/lib/other.jpg',
                }),
            ).toBe('inserted');
        });
    });

    describe('getArtworkForMediaItem', () => {
        it('returns artwork ordered by sort_order', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'backdrop',
                filePath: '/backdrop.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toHaveLength(2);
        });

        it('returns empty array when no artwork exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getLocalArtwork
    // ========================================================================

    describe('getLocalArtwork', () => {
        it('returns local artwork for the requested type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'logo',
                filePath: '/logo.png',
            });

            const row = await getLocalArtwork(sql, item.id, 'logo');
            expect(row).not.toBeNull();
            expect(row!.artwork_type).toBe('logo');
        });

        it('walks parent chain for inherited artwork', async () => {
            // Series parent
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            // Season child
            const season = createTestMediaItem({
                media_type: 'season',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, season);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;

            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'poster',
                filePath: '/series/poster.jpg',
            });

            const row = await getLocalArtwork(sql, season.id, 'poster');
            expect(row).not.toBeNull();
            expect(row!.media_item_id).toBe(series.id);
        });

        it('returns null when no artwork exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const row = await getLocalArtwork(sql, item.id, 'thumb');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getOwnLocalArtwork — own row only, NEVER inherits (delete-safety boundary)
    // ========================================================================

    describe('getOwnLocalArtwork', () => {
        it('returns the item’s own local artwork row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/own/poster.jpg',
            });

            const row = await getOwnLocalArtwork(sql, item.id, 'poster');
            expect(row).not.toBeNull();
            expect(row!.media_item_id).toBe(item.id);
        });

        it('does NOT inherit from a parent (unlike getLocalArtwork)', async () => {
            // Series with a poster; season with none of its own.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({
                media_type: 'season',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, season);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;

            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'poster',
                filePath: '/series/poster.jpg',
            });

            // getLocalArtwork inherits the series poster…
            const inherited = await getLocalArtwork(sql, season.id, 'poster');
            expect(inherited!.media_item_id).toBe(series.id);

            // …but getOwnLocalArtwork must NOT — the season owns nothing. This is
            // the guard that stops deleteMediaImage from removing the ancestor's row.
            const own = await getOwnLocalArtwork(sql, season.id, 'poster');
            expect(own).toBeNull();
        });
    });

    // ========================================================================
    // Artwork suppressions (durable Remove) — tombstone + upsert enforcement
    // ========================================================================

    describe('artwork suppressions', () => {
        it('add + isSuppressed are keyed by the exact (item, type, file_path)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');

            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/poster.jpg')).toBe(true);
            // Different path / different type are NOT suppressed.
            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/other.jpg')).toBe(false);
            expect(await isArtworkSuppressed(sql, item.id, 'backdrop', '/lib/poster.jpg')).toBe(
                false,
            );
            // Idempotent.
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');
            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/poster.jpg')).toBe(true);
        });

        it('a scanner upsert (no admin tag) SKIPS a suppressed file', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');

            // Scanner write — no sourceTag → must respect the tombstone.
            const registered = await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/lib/poster.jpg',
            });

            expect(registered).toBe(false);
            expect(await getOwnLocalArtwork(sql, item.id, 'poster')).toBeNull();
        });

        it('a scanner upsert of a DIFFERENT path is not suppressed', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');

            const registered = await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/lib/other.jpg',
            });

            expect(registered).toBe(true);
            const row = await getOwnLocalArtwork(sql, item.id, 'poster');
            expect(row?.file_path).toBe('/lib/other.jpg');
        });

        it('an admin upsert of the same path LIFTS the suppression and registers', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/poster.jpg');

            const registered = await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/lib/poster.jpg',
                sourceTag: 'admin:file',
            });

            expect(registered).toBe(true);
            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/poster.jpg')).toBe(
                false,
            );
            const row = await getOwnLocalArtwork(sql, item.id, 'poster');
            expect(row?.file_path).toBe('/lib/poster.jpg');
        });

        it('suppression key is path-normalized (spelling drift still matches)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            // Tombstone recorded with a messy path…
            await addArtworkSuppression(sql, item.id, 'poster', '/lib//sub/../poster.jpg');

            // …a re-scan computing the clean equivalent still matches → skipped.
            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/poster.jpg')).toBe(true);
            const registered = await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/lib/poster.jpg',
            });
            expect(registered).toBe(false);
            expect(await getOwnLocalArtwork(sql, item.id, 'poster')).toBeNull();
        });

        it('clearArtworkSuppression removes only the exact path', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/a.jpg');
            await addArtworkSuppression(sql, item.id, 'poster', '/lib/b.jpg');

            await clearArtworkSuppression(sql, item.id, 'poster', '/lib/a.jpg');

            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/a.jpg')).toBe(false);
            expect(await isArtworkSuppressed(sql, item.id, 'poster', '/lib/b.jpg')).toBe(true);
        });
    });

    // ========================================================================
    // deleteLocalArtworkForItem
    // ========================================================================

    describe('deleteLocalArtworkForItem', () => {
        it('deletes all local artwork for an item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            await deleteLocalArtworkForItem(sql, item.id);

            const rows = await getArtworkForMediaItem(sql, item.id);
            expect(rows).toEqual([]);
        });

        it('clears proxy custom_*_url columns', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            await deleteLocalArtworkForItem(sql, item.id);

            const [row] = await sql`
                SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(row.custom_poster_url).toBeNull();
        });
    });

    // ========================================================================
    // deleteArtworkById
    // ========================================================================

    describe('deleteArtworkById', () => {
        it('deletes by primary key and returns true', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });
            const [artwork] = await getArtworkForMediaItem(sql, item.id);

            const ok = await deleteArtworkById(sql, artwork.id);
            expect(ok).toBe(true);
            expect(await getArtworkForMediaItem(sql, item.id)).toEqual([]);
        });

        it('returns false for non-existent id', async () => {
            const ok = await deleteArtworkById(sql, crypto.randomUUID());
            expect(ok).toBe(false);
        });
    });

    // ========================================================================
    // getArtworkWithInheritance
    // ========================================================================

    describe('getArtworkWithInheritance', () => {
        it('returns self artwork when present', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'poster',
                filePath: '/poster.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, item.id);
            const poster = enriched.find((e) => e.artworkType === 'poster');
            expect(poster).toBeDefined();
            expect(poster!.source).toBe('self');
        });

        it('returns inherited artwork from parent', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({
                media_type: 'season',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, season);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;

            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'backdrop',
                filePath: '/series/backdrop.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, season.id);
            const backdrop = enriched.find((e) => e.artworkType === 'backdrop');
            expect(backdrop).toBeDefined();
            expect(backdrop!.source).toBe('series');
            expect(backdrop!.sourceId).toBe(series.id);
        });

        it('omits artwork types with no artwork at any level', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const enriched = await getArtworkWithInheritance(sql, item.id);
            expect(enriched).toEqual([]);
        });
    });

    // ========================================================================
    // findDuplicateThumbEpisodes
    // ========================================================================

    describe('duplicate-episode-thumbnail detection', () => {
        async function makeSeriesWithThumbs(thumbPaths: string[]): Promise<string> {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, season);
            for (const filePath of thumbPaths) {
                const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
                await insertTestMediaItem(sql, ep);
                await upsertLocalArtwork(sql, {
                    mediaItemId: ep.id,
                    artworkType: 'thumb',
                    filePath,
                });
            }
            return series.id;
        }

        it('findDuplicateThumbEpisodes returns only the duplicate episodes', async () => {
            const seriesId = await makeSeriesWithThumbs([
                '/m/Show/S01/SHARED-thumb.jpg',
                '/m/Show/S01/SHARED-thumb.jpg',
                '/m/Show/S01/E3-thumb.jpg',
            ]);

            const rows = await findDuplicateThumbEpisodes(sql, null, 10);
            const forSeries = rows.filter((r) => r.seriesId === seriesId);

            // The correctly-mapped third episode is not part of a duplicate group.
            expect(forSeries).toHaveLength(2);
            expect(new Set(forSeries.map((r) => r.artworkPath))).toEqual(
                new Set(['/m/Show/S01/SHARED-thumb.jpg']),
            );
            expect(new Set(forSeries.map((r) => r.episodeId)).size).toBe(2);
        });

        it('findDuplicateThumbEpisodes pages past a series via the cursor', async () => {
            // Keyset pagination is what stops unfixable series from starving the
            // fixable ones behind them under the deterministic series ordering.
            await makeSeriesWithThumbs(['/a/dup-thumb.jpg', '/a/dup-thumb.jpg']);
            await makeSeriesWithThumbs(['/b/dup-thumb.jpg', '/b/dup-thumb.jpg']);

            const first = await findDuplicateThumbEpisodes(sql, null, 1);
            const firstSeries = [...new Set(first.map((r) => r.seriesId))];
            expect(firstSeries).toHaveLength(1);

            const second = await findDuplicateThumbEpisodes(sql, firstSeries[0], 1);
            const secondSeries = [...new Set(second.map((r) => r.seriesId))];
            expect(secondSeries).toHaveLength(1);
            expect(secondSeries[0]).not.toBe(firstSeries[0]);
            expect(secondSeries[0] > firstSeries[0]).toBe(true);
        });

        it('findEpisodeThumbnailWork ignores episodes without a duration', async () => {
            // No duration => no window to sample. media-probe fills it in on
            // its own schedule; this task must never ffprobe to find out.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, season);
            const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
            await insertTestMediaItem(sql, ep);

            const rows = await findEpisodeThumbnailWork(sql, null, 50);
            expect(rows.some((r) => r.episodeId === ep.id)).toBe(false);
        });

        it('remapEpisodeThumbnailPath repoints a row and is idempotent', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            const id = item.id;
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'thumb',
                filePath: '/m/WRONG-thumb.jpg',
            });

            expect(await remapEpisodeThumbnailPath(sql, id, '/m/RIGHT-thumb.jpg')).toBe(1);
            const after = await getLocalArtwork(sql, id, 'thumb');
            expect(after?.file_path).toBe('/m/RIGHT-thumb.jpg');

            // Second call is a no-op — the guard stops a concurrent correct
            // write from being clobbered and keeps the counter honest.
            expect(await remapEpisodeThumbnailPath(sql, id, '/m/RIGHT-thumb.jpg')).toBe(0);
        });

        it('remapEpisodeThumbnailPath registers an own sidecar when the foreign candidate was removed', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            expect(await remapEpisodeThumbnailPath(sql, item.id, '/m/Own-thumb.jpg')).toBe(1);
            expect((await getOwnLocalArtwork(sql, item.id, 'thumb'))?.file_path).toBe(
                '/m/Own-thumb.jpg',
            );
        });

        it('findEpisodeThumbnailWork includes combined episodes so ownership is checked on disk', async () => {
            // Sharing a video is not proof that a thumbnail belongs to it.
            // Both missing and shared paths must reach the sidecar classifier.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, season);

            const [fileId] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/m/Show - S01E01E02.mkv', 2400) RETURNING id
            `;

            for (let i = 0; i < 2; i++) {
                const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
                await insertTestMediaItem(sql, ep);
                await sql`
                    INSERT INTO media_file_items (media_item_id, file_id, is_default)
                    VALUES (${ep.id}, ${fileId.id}, true)
                `;
                await upsertLocalArtwork(sql, {
                    mediaItemId: ep.id,
                    artworkType: 'thumb',
                    filePath: '/m/Show - S01E01E02-thumb.jpg',
                });
            }

            const rows = await findEpisodeThumbnailWork(sql, null, 50);
            expect(rows.filter((r) => r.fileId === fileId.id)).toHaveLength(2);
        });

        it('keeps immutable generated candidate identities when registering a new owned sidecar', async () => {
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/m/Published - S01E01E02.mkv', 1200) RETURNING id`;
            const ids: string[] = [];
            for (let i = 0; i < 2; i++) {
                const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
                await insertTestMediaItem(sql, ep);
                ids.push(ep.id);
                await sql`INSERT INTO media_file_items
                    (media_item_id, file_id, is_default, start_offset_ms, end_offset_ms)
                    VALUES (${ep.id}, ${file.id}, true, ${i * 600000}, ${(i + 1) * 600000})`;
                await upsertLocalArtwork(sql, {
                    mediaItemId: ep.id,
                    artworkType: 'thumb',
                    filePath: `/m/${ep.id}-a566562c-59e2-471b-bbee-1a8d1d97c485-thumb.jpg`,
                    sourceTag: 'generated:ffmpeg',
                });
            }
            for (const exclusions of [undefined, await loadEpisodeThumbnailExclusions(sql)]) {
                expect(
                    (await findEpisodeThumbnailWork(sql, null, 50, exclusions)).filter((r) =>
                        ids.includes(r.episodeId),
                    ),
                ).toHaveLength(0);
            }
            // Registration of another source preserves each existing candidate's
            // identity and bytes; ownership is checked by scanners before remap.
            const before = await sql`SELECT id,provider,provider_ref,file_path FROM image_candidates
                WHERE media_item_id=ANY(${ids}::uuid[]) ORDER BY id`;
            const path = `/m/${ids[1]}-e426709e-8092-44a8-89b4-72eddfc44af3-thumb.jpg`;
            await remapEpisodeThumbnailPath(sql, ids[1], path);
            for (const candidate of before) {
                expect(
                    await sql`SELECT id,provider,provider_ref,file_path FROM image_candidates WHERE id=${candidate.id}`,
                ).toEqual([candidate]);
            }
            expect(
                await sql`SELECT id FROM image_candidates WHERE media_item_id=${ids[1]} AND file_path=${path}`,
            ).toHaveLength(1);
        });

        it('findEpisodeThumbnailWork with precomputed exclusions matches the inline-CTE result', async () => {
            // episode-thumbnail-generate/-repair compute `loadEpisodeThumbnailExclusions`
            // ONCE per run and pass it to every page instead of letting each
            // page recompute the two whole-catalog aggregates (prod slow-query
            // log, 2026-09-26 — see the doc comment on both functions). The
            // two call shapes must return identical rows for the same cursor.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, season);

            // A combined release remains eligible for ownership classification.
            const [combinedFileId] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/m/Combined - S01E03E04.mkv', 2400) RETURNING id
            `;
            for (let i = 0; i < 2; i++) {
                const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
                await insertTestMediaItem(sql, ep);
                await sql`
                    INSERT INTO media_file_items (media_item_id, file_id, is_default)
                    VALUES (${ep.id}, ${combinedFileId.id}, true)
                `;
                await upsertLocalArtwork(sql, {
                    mediaItemId: ep.id,
                    artworkType: 'thumb',
                    filePath: '/m/Combined-thumb.jpg',
                });
            }

            // A legitimately shared thumbnail across two distinct files in the
            // same season (included by the shared-path fingerprint).
            for (let i = 0; i < 2; i++) {
                const ep = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
                await insertTestMediaItem(sql, ep);
                const [fileId] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, duration_seconds)
                    VALUES (${`/m/Shared-${i}.mkv`}, 1800) RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (media_item_id, file_id, is_default)
                    VALUES (${ep.id}, ${fileId.id}, true)
                `;
                await upsertLocalArtwork(sql, {
                    mediaItemId: ep.id,
                    artworkType: 'thumb',
                    filePath: '/m/Shared-thumb.jpg',
                });
            }

            // A genuinely missing thumbnail — must survive both exclusions.
            const epMissing = createTestMediaItem({ media_type: 'episode', parent_id: season.id });
            await insertTestMediaItem(sql, epMissing);
            const [missingFileId] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/m/Missing.mkv', 1500) RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (media_item_id, file_id, is_default)
                VALUES (${epMissing.id}, ${missingFileId.id}, true)
            `;

            const inline = await findEpisodeThumbnailWork(sql, null, 50);
            const exclusions = await loadEpisodeThumbnailExclusions(sql);
            const precomputed = await findEpisodeThumbnailWork(sql, null, 50, exclusions);

            expect(precomputed).toEqual(inline);
            expect(precomputed.some((r) => r.episodeId === epMissing.id)).toBe(true);
        });

        it('remapEpisodeThumbnailPath refuses to resurrect a suppressed file', async () => {
            // Durable Remove: an operator tombstoned this exact path. The raw
            // UPDATE must honour that, or the one write path that bypasses
            // upsertLocalArtwork silently undoes an admin action.
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            await upsertLocalArtwork(sql, {
                mediaItemId: item.id,
                artworkType: 'thumb',
                filePath: '/m/WRONG-thumb.jpg',
            });
            await addArtworkSuppression(sql, item.id, 'thumb', '/m/REMOVED-thumb.jpg');

            expect(await remapEpisodeThumbnailPath(sql, item.id, '/m/REMOVED-thumb.jpg')).toBe(0);
            const after = await getLocalArtwork(sql, item.id, 'thumb');
            expect(after?.file_path).toBe('/m/WRONG-thumb.jpg');
        });

        it('findDuplicateThumbEpisodes returns nothing when no duplicates exist', async () => {
            await makeSeriesWithThumbs(['/m/Show/S01/E1-thumb.jpg', '/m/Show/S01/E2-thumb.jpg']);
            expect(await findDuplicateThumbEpisodes(sql, null, 10)).toEqual([]);
        });
    });

    // ========================================================================
    // getArtworkWithInheritance — music track → album → artist
    // ========================================================================

    describe('getArtworkWithInheritance — music track/album/artist inheritance', () => {
        it('track with no own artwork inherits poster from its album', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);

            // Give the album a poster; track has nothing.
            await upsertLocalArtwork(sql, {
                mediaItemId: album.id,
                artworkType: 'poster',
                filePath: '/music/album-cover.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, track.id);

            const poster = enriched.find((e) => e.artworkType === 'poster');
            expect(poster).toBeDefined();
            // Source must be the album row, not the track itself.
            expect(poster!.sourceId).toBe(album.id);
            // The serve URL points at the album's artwork.
            expect(poster!.url).toContain(album.id);
            expect(poster!.url).toContain('poster');
            // source label reflects the actual ancestor type — 'album', NOT the
            // mislabeled 'series' the TV-centric branch used to emit for music.
            expect(poster!.source).toBe('album');
        });

        it('track own artwork takes precedence over album artwork', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);

            await upsertLocalArtwork(sql, {
                mediaItemId: album.id,
                artworkType: 'poster',
                filePath: '/music/album-cover.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: track.id,
                artworkType: 'poster',
                filePath: '/music/track-cover.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, track.id);

            const poster = enriched.find((e) => e.artworkType === 'poster');
            expect(poster).toBeDefined();
            // Track's own artwork wins.
            expect(poster!.source).toBe('self');
            expect(poster!.sourceId).toBe(track.id);
            expect(poster!.url).toContain(track.id);
        });

        it('track with no album artwork never takes the artist photo as its poster', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);

            // Only the artist has art; album and track have nothing.
            await upsertLocalArtwork(sql, {
                mediaItemId: artist.id,
                artworkType: 'poster',
                filePath: '/music/artist-photo.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: artist.id,
                artworkType: 'backdrop',
                filePath: '/music/artist-backdrop.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, track.id);

            // An artist photo is not a cover: on a compilation it is the one
            // "Various Artists" image for every track. Must agree with the
            // serve-side getLocalArtwork, which declines it too.
            expect(enriched.find((e) => e.artworkType === 'poster')).toBeUndefined();
            expect(await getLocalArtwork(sql, track.id, 'poster')).toBeNull();
            expect(await getLocalArtwork(sql, album.id, 'poster')).toBeNull();

            // The backdrop still inherits from the artist, labelled as such.
            const backdrop = enriched.find((e) => e.artworkType === 'backdrop');
            expect(backdrop?.sourceId).toBe(artist.id);
            expect(backdrop?.source).toBe('artist');
            expect((await getLocalArtwork(sql, track.id, 'backdrop'))?.media_item_id).toBe(
                artist.id,
            );

            // The artist's own poster is still served for the artist.
            expect((await getLocalArtwork(sql, artist.id, 'poster'))?.media_item_id).toBe(
                artist.id,
            );
        });

        it('album artwork wins over artist artwork when both have a poster', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);

            // Album is nearer (depth 1) than artist (depth 2).
            await upsertLocalArtwork(sql, {
                mediaItemId: album.id,
                artworkType: 'poster',
                filePath: '/music/album-cover.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: artist.id,
                artworkType: 'poster',
                filePath: '/music/artist-photo.jpg',
            });

            const enriched = await getArtworkWithInheritance(sql, track.id);

            const poster = enriched.find((e) => e.artworkType === 'poster');
            expect(poster).toBeDefined();
            // Album is the nearest ancestor with the art — it must win.
            expect(poster!.sourceId).toBe(album.id);
        });

        it('returns empty array for a track with no artwork at any level', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);

            const enriched = await getArtworkWithInheritance(sql, track.id);

            expect(enriched).toEqual([]);
        });
    });

    // ========================================================================
    // Batched helpers for the episode-thumbnail path
    // ========================================================================

    describe('getLocalArtworkInheritedBatch + getOwnStillPresence', () => {
        async function seedSeriesChain(): Promise<{
            seriesId: string;
            episodeWithThumb: string;
            episodeBare: string;
        }> {
            const series = createTestMediaItem({ media_type: 'tv', title: 'Batch Series' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({
                media_type: 'season',
                title: 'Season 1',
                parent_id: series.id,
            });
            await insertTestMediaItem(sql, season);
            const ep1 = createTestMediaItem({
                media_type: 'episode',
                title: 'E1',
                parent_id: season.id,
            });
            const ep2 = createTestMediaItem({
                media_type: 'episode',
                title: 'E2',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);

            await upsertLocalArtwork(sql, {
                mediaItemId: ep1.id,
                artworkType: 'thumb',
                filePath: '/library/show/s01e01-thumb.jpg',
            });
            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'backdrop',
                filePath: '/library/show/backdrop.jpg',
            });

            return { seriesId: series.id, episodeWithThumb: ep1.id, episodeBare: ep2.id };
        }

        it('batch winners match per-item getLocalArtwork (nearest ancestor first)', async () => {
            const { episodeWithThumb, episodeBare } = await seedSeriesChain();
            const ids = [episodeWithThumb, episodeBare];

            const batch = await getLocalArtworkInheritedBatch(sql, ids, ['thumb', 'backdrop']);
            const firstByKey = new Map<string, string | null>();
            for (const row of batch) {
                const key = `${row.origin_id}:${row.artwork_type}`;
                if (!firstByKey.has(key)) firstByKey.set(key, row.file_path);
            }

            for (const id of ids) {
                for (const type of ['thumb', 'backdrop'] as const) {
                    const single = await getLocalArtwork(sql, id, type);
                    expect(firstByKey.get(`${id}:${type}`) ?? null).toBe(single?.file_path ?? null);
                }
            }

            expect(firstByKey.get(`${episodeWithThumb}:thumb`)).toBe(
                '/library/show/s01e01-thumb.jpg',
            );
            // ep2 has no thumb row anywhere but inherits the series backdrop
            expect(firstByKey.has(`${episodeBare}:thumb`)).toBe(false);
            expect(firstByKey.get(`${episodeBare}:backdrop`)).toBe('/library/show/backdrop.jpg');
        });

        it('returns empty for empty inputs without querying', async () => {
            expect(await getLocalArtworkInheritedBatch(sql, [], ['thumb'])).toEqual([]);
            const someId = crypto.randomUUID();
            expect(await getLocalArtworkInheritedBatch(sql, [someId], [])).toEqual([]);
        });

        it('getOwnStillPresence counts stored sources, not live-fetch external ids', async () => {
            const { episodeWithThumb, episodeBare } = await seedSeriesChain();
            const epWithProviderStill = createTestMediaItem({
                media_type: 'episode',
                title: 'E3',
            });
            await insertTestMediaItem(sql, epWithProviderStill);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${epWithProviderStill.id}::uuid, 'tmdb', jsonb_build_object('still_path', '/abc123.jpg'))
            `;

            // A bare tmdb id is NOT a stored still: the TMDB episode-still path
            // resolves via the SERIES id + local numbering (a live, possibly-
            // wrong guess), so counting it would defeat the skip. A jellyfin id
            // is watch-sync only and not in the image path. Both must be false
            // when no still is actually stored.
            const epWithTmdbId = createTestMediaItem({ media_type: 'episode', title: 'E4' });
            await insertTestMediaItem(sql, epWithTmdbId);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${epWithTmdbId.id}::uuid, 'tmdb', '77001', 'episode', true)
            `;
            const epWithJellyfinId = createTestMediaItem({ media_type: 'episode', title: 'E5' });
            await insertTestMediaItem(sql, epWithJellyfinId);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${epWithJellyfinId.id}::uuid, 'jellyfin', 'abcdef01234567890123456789012345', 'episode', false)
            `;

            const presence = await getOwnStillPresence(sql, [
                episodeWithThumb,
                episodeBare,
                epWithProviderStill.id,
                epWithTmdbId.id,
                epWithJellyfinId.id,
            ]);

            expect(presence.get(episodeWithThumb)).toBe(true);
            // Series backdrop is INHERITED (depth-2) art — must not count
            expect(presence.get(episodeBare)).toBe(false);
            // Persisted still_path IS a stored source
            expect(presence.get(epWithProviderStill.id)).toBe(true);
            // Bare external ids are NOT stored stills
            expect(presence.get(epWithTmdbId.id)).toBe(false);
            expect(presence.get(epWithJellyfinId.id)).toBe(false);
        });

        it('getOwnStillPresence counts SEASON-level artwork (inherits before the series backdrop)', async () => {
            const { episodeBare } = await seedSeriesChain();
            // Give the bare episode's SEASON its own local backdrop — the byte
            // route would serve it (depth 1) ahead of the series backdrop.
            const [row] = await sql<{ parent_id: string }[]>`
                SELECT parent_id FROM media_items WHERE id = ${episodeBare}::uuid
            `;
            await upsertLocalArtwork(sql, {
                mediaItemId: row.parent_id,
                artworkType: 'backdrop',
                filePath: '/library/show/season1-backdrop.jpg',
            });

            const presence = await getOwnStillPresence(sql, [episodeBare]);
            expect(presence.get(episodeBare)).toBe(true);
        });
    });
    // ========================================================================
    // hasArtworkSuppressionForType
    // ========================================================================

    describe('hasArtworkSuppressionForType', () => {
        it('returns false when the item has no tombstone for that type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            expect(await hasArtworkSuppressionForType(sql, item.id, 'poster')).toBe(false);
        });

        it('returns true regardless of WHICH file was tombstoned', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            // The operator removed folder.jpg. A fresh write to poster.jpg must
            // still be refused — isArtworkSuppressed cannot answer this.
            await addArtworkSuppression(sql, item.id, 'poster', '/movies/Film/folder.jpg');

            expect(
                await isArtworkSuppressed(sql, item.id, 'poster', '/movies/Film/poster.jpg'),
            ).toBe(false);
            expect(await hasArtworkSuppressionForType(sql, item.id, 'poster')).toBe(true);
        });

        it('is scoped to the artwork type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await addArtworkSuppression(sql, item.id, 'poster', '/movies/Film/folder.jpg');

            expect(await hasArtworkSuppressionForType(sql, item.id, 'backdrop')).toBe(false);
        });

        it('is scoped to the media item', async () => {
            const a = createTestMediaItem({ media_type: 'movie' });
            const b = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, a);
            await insertTestMediaItem(sql, b);
            await addArtworkSuppression(sql, a.id, 'poster', '/movies/Film/folder.jpg');

            expect(await hasArtworkSuppressionForType(sql, b.id, 'poster')).toBe(false);
        });
    });

    // ========================================================================
    // findManagedArtworkClaimForPath
    // ========================================================================

    describe('findManagedArtworkClaimForPath', () => {
        it('returns the claim when a managed row on ANOTHER item owns the file', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, series);
            await insertTestMediaItem(sql, season);
            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
                sourceTag: 'provider:tmdb:poster',
            });

            const claim = await findManagedArtworkClaimForPath(
                sql,
                '/series/Show/poster.jpg',
                season.id,
            );

            expect(claim).not.toBeNull();
            expect(claim?.media_item_id).toBe(series.id);
            expect(claim?.artwork_type).toBe('poster');
        });

        it('returns null for the item that already claims the file (legitimate re-registration)', async () => {
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            await upsertLocalArtwork(sql, {
                mediaItemId: season.id,
                artworkType: 'poster',
                filePath: '/series/Show/Season 01/poster.jpg',
                sourceTag: 'provider:tmdb:poster',
            });

            const claim = await findManagedArtworkClaimForPath(
                sql,
                '/series/Show/Season 01/poster.jpg',
                season.id,
            );

            expect(claim).toBeNull();
        });

        it('ignores an UNMANAGED row (a user sidecar has no provenance tag)', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            const season = createTestMediaItem({ media_type: 'season', parent_id: series.id });
            await insertTestMediaItem(sql, series);
            await insertTestMediaItem(sql, season);
            await upsertLocalArtwork(sql, {
                mediaItemId: series.id,
                artworkType: 'poster',
                filePath: '/series/Show/poster.jpg',
            });

            const claim = await findManagedArtworkClaimForPath(
                sql,
                '/series/Show/poster.jpg',
                season.id,
            );

            expect(claim).toBeNull();
        });

        it('recognises admin: and generated: tags as managed', async () => {
            for (const tag of ['admin:file', 'generated:frame']) {
                await truncateTables(sql, [
                    ...TEST_TABLES.media,
                    'media_artwork',
                    'media_artwork_suppressions',
                ]);
                const owner = createTestMediaItem({ media_type: 'tv' });
                const other = createTestMediaItem({ media_type: 'season' });
                await insertTestMediaItem(sql, owner);
                await insertTestMediaItem(sql, other);
                await upsertLocalArtwork(sql, {
                    mediaItemId: owner.id,
                    artworkType: 'poster',
                    filePath: '/series/Show/poster.jpg',
                    sourceTag: tag,
                });

                const claim = await findManagedArtworkClaimForPath(
                    sql,
                    '/series/Show/poster.jpg',
                    other.id,
                );

                expect(claim?.media_item_id).toBe(owner.id);
            }
        });

        it('returns null for a path nobody claims', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            expect(
                await findManagedArtworkClaimForPath(sql, '/series/Show/nothing.jpg', item.id),
            ).toBeNull();
        });
    });

    // ========================================================================
    // Index coverage for findManagedArtworkClaimForPath
    // ========================================================================

    describe('media_artwork index coverage', () => {
        it('has an index that can serve a file_path lookup', async () => {
            const rows = await sql<{ indexdef: string }[]>`
                SELECT indexdef
                FROM pg_indexes
                WHERE tablename = 'media_artwork'
            `;
            // The guard in processArtwork runs once per artwork file per scan;
            // without this index it is a sequential scan of the whole table.
            expect(rows.some((r) => /\(file_path\)/.test(r.indexdef))).toBe(true);
        });
    });
});
