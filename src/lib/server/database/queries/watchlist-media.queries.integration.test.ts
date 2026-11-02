// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Watchlist Media Query Module
 *
 * Tests fetching watchlist items with full metadata.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createTestMediaItem,
    insertTestMediaItem,
    generateTestUserId,
    ensureTestUser,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';

import { getUserWatchlistMedia, type WatchlistMediaCursor } from './watchlist-media.queries.js';
import { upsertWatchlistItem } from './watchlist.queries.js';
import type { UserId } from '$lib/shared/user-id';

describe('Watchlist Media Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Watchlist writes now land in playlist_items under a `playlists` row
        // (playlist_type = 'watchlist') — see watchlist.queries.ts. Truncating
        // `playlists` CASCADEs into `playlist_items` via its FK.
        await truncateTables(sql, [
            'playlists',
            'playlist_items',
            'provider_metadata',
            'external_ids',
            'media_items',
            'library_groups',
            'media_files',
            'media_file_items',
        ]);
    });

    // ========================================================================
    // getUserWatchlistMedia
    // ========================================================================

    describe('getUserWatchlistMedia', () => {
        it('returns watchlist items with metadata', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 900001,
            });

            // Seed provider metadata so v_media_metadata has something to join
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${mediaId}::uuid,
                    'aggregated',
                    ${sql.json({
                        overview: 'Test overview',
                        popularity: 7.5,
                        runtime_minutes: 120,
                        certification: 'PG-13',
                        genres: [28, 12],
                        actors: ['Actor A'],
                        directors: ['Director X'],
                    })},
                    NOW()
                )
            `;

            // Ensure primary external id is 'tmdb' (default)
            await sql`
                UPDATE external_ids SET provider = 'tmdb', is_primary = true
                WHERE media_id = ${mediaId}::uuid AND provider = 'tmdb'
            `;

            await upsertWatchlistItem(sql, userId, mediaId);

            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(result.length).toBe(1);
            expect(result[0].media_id).toBe(mediaId);
            expect(result[0].title).toBeTruthy();
        });

        it("returns an audiobook watchlist row (no tmdb external_ids row) with type 'audiobook'", async () => {
            // Regression guard: `primary_ext` used to be an INNER JOIN on
            // external_ids WHERE provider = the primary provider (tmdb).
            // Audiobooks are keyed by provider='audiobookshelf', never tmdb, so
            // that join silently dropped every audiobook watchlist row — the
            // add would report success but the item would vanish from GET.
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const mediaId = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    id: mediaId,
                    media_type: 'audiobook',
                    title: 'Test Audiobook',
                    has_files: true,
                }),
            );
            // Fixture's TestExternalId.provider type doesn't include
            // 'audiobookshelf' — raw insert, matching how every other audiobook
            // integration suite seeds this row (see MediaType's own doc comment
            // in tests/integration/fixtures/media.fixtures.ts).
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${mediaId}::uuid, 'audiobookshelf', 'abs-item-1', 'audiobook', true, 'api')
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({ overview: 'A book' })}, NOW())
            `;
            await upsertWatchlistItem(sql, userId, mediaId);

            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(result.length).toBe(1);
            expect(result[0].media_id).toBe(mediaId);
            expect(result[0].media_type).toBe('audiobook');
            expect(result[0].primary_ext_id).toBeNull();
        });

        it('returns BOTH audiobooks, not just one — DISTINCT ON must not collapse two NULL primary_ext_id rows', async () => {
            // The sharpest form of the regression above: DISTINCT ON (primary_ext.
            // external_id, media_type) treats NULL as a single group, so two
            // audiobooks (both NULL under the tmdb-keyed join) would silently
            // collapse into ONE output row — losing the second book entirely,
            // not just mislabeling it. The fix's COALESCE(external_id, media_id)
            // key must give each row its own unique group.
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const mediaIds = [crypto.randomUUID(), crypto.randomUUID()];
            for (const [i, mediaId] of mediaIds.entries()) {
                await insertTestMediaItem(
                    sql,
                    createTestMediaItem({
                        id: mediaId,
                        media_type: 'audiobook',
                        title: `Test Audiobook ${i}`,
                        has_files: true,
                    }),
                );
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                    VALUES (${mediaId}::uuid, 'audiobookshelf', ${'abs-item-' + i}, 'audiobook', true, 'api')
                `;
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                    VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({})}, NOW())
                `;
                await upsertWatchlistItem(sql, userId, mediaId);
            }

            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: null,
            });

            expect(result.length).toBe(2);
            expect(new Set(result.map((r) => r.media_id))).toEqual(new Set(mediaIds));
        });

        it('returns empty array when user has no watchlist items', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: null,
            });
            expect(result).toEqual([]);
        });

        it('excludes items denied by library access', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 900002,
            });

            // Create a media file with a library group
            const fileId = crypto.randomUUID();
            const groupId = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name, sort_order, created_at, updated_at)
                VALUES (${groupId}::uuid, 'Deny Group', 1, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/deny.mkv'}, ${groupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaId}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid
            `;

            // Seed minimal metadata
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({})}, NOW())
            `;

            await upsertWatchlistItem(sql, userId, mediaId);

            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: [groupId],
                ageRating: null,
            });

            expect(result.length).toBe(0);
        });

        it('excludes items above age rating limit', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId } = await createAndInsertTestMovie(sql, {
                tmdbId: 900003,
            });

            await sql`
                UPDATE media_items SET age_rating = 18 WHERE id = ${mediaId}::uuid
            `;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({})}, NOW())
            `;

            await upsertWatchlistItem(sql, userId, mediaId);

            const result = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: { maxAgeRating: 13, allowUnrated: true },
            });

            expect(result.length).toBe(0);
        });
    });

    // ========================================================================
    // Opt-in keyset cursor paging — keyset is over the DISTINCT ON output order
    // `(external_id, media_type)` (NOT added_at; that is only the DISTINCT ON
    // tiebreak). Both halves are `text NOT NULL`, so there is no NULL group.
    // ========================================================================

    describe('getUserWatchlistMedia — keyset cursor', () => {
        const NO_ACCESS = { deniedGroupIds: null, ageRating: null } as const;

        /** Seed `count` watchlisted movies with sequential tmdb ids from `baseTmdb`. */
        async function seedWatchlist(userId: UserId, baseTmdb: number, count: number) {
            for (let i = 0; i < count; i++) {
                const { id: mediaId } = await createAndInsertTestMovie(sql, {
                    tmdbId: baseTmdb + i,
                });
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                    VALUES (${mediaId}::uuid, 'aggregated', ${sql.json({ overview: 'o' })}, NOW())
                `;
                await upsertWatchlistItem(sql, userId, mediaId);
            }
        }

        it('cursor walk reproduces the offset ordering exactly (parity)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            // tmdb ids 900100..900104 — equal-length numeric strings, so the
            // external_id text ordering is deterministic and ascending.
            await seedWatchlist(userId, 900100, 5);

            const full = await getUserWatchlistMedia(sql, userId, NO_ACCESS);
            expect(full.length).toBe(5);
            const expectedOrder = full.map((r) => r.media_id);

            // Page size 2. The FIRST page is offset mode (offset 0) — a real client
            // gets its bootstrap cursor from that response (Gate J1); every later
            // page is keyset mode.
            const pageSize = 2;
            const walked: string[] = [];
            let cursor: WatchlistMediaCursor | null = null;
            for (let guard = 0; guard < 10; guard++) {
                const pagination = cursor
                    ? { limit: pageSize, cursor }
                    : { limit: pageSize, offset: 0 };
                const rows = await getUserWatchlistMedia(sql, userId, NO_ACCESS, pagination);
                if (rows.length === 0) break;
                for (const r of rows) walked.push(r.media_id);
                const last = rows[rows.length - 1];
                cursor = { externalId: String(last.primary_ext_id), mediaType: last.media_type };
                if (rows.length < pageSize) break;
            }

            expect(walked).toEqual(expectedOrder);
            // No duplicates across page boundaries.
            expect(new Set(walked).size).toBe(walked.length);
        });

        it('cursor page is a stable window when a new item is added mid-walk', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await seedWatchlist(userId, 900200, 4);

            // First page (offset mode) of size 2.
            const p1 = await getUserWatchlistMedia(sql, userId, NO_ACCESS, {
                limit: 2,
                offset: 0,
            });
            expect(p1.length).toBe(2);
            const cursor = {
                externalId: String(p1[1].primary_ext_id),
                mediaType: p1[1].media_type,
            };

            // A concurrent insert lands BEFORE the cursor boundary (lower tmdb id).
            // Under OFFSET this would shift the window and duplicate a row; the
            // keyset predicate `(external_id, media_type) > cursor` is immune.
            const { id: injected } = await createAndInsertTestMovie(sql, { tmdbId: 900199 });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${injected}::uuid, 'aggregated', ${sql.json({ overview: 'o' })}, NOW())
            `;
            await upsertWatchlistItem(sql, userId, injected);

            const p2 = await getUserWatchlistMedia(sql, userId, NO_ACCESS, { limit: 2, cursor });
            const p1Ids = new Set(p1.map((r) => r.media_id));
            for (const r of p2) {
                expect(p1Ids.has(r.media_id)).toBe(false); // no row re-appears
                // Every p2 row sorts strictly after the cursor boundary.
                expect(String(r.primary_ext_id) > cursor.externalId).toBe(true);
            }
            expect(p2.some((r) => r.media_id === injected)).toBe(false);
        });
    });

    // =========================================================================
    // Library axis on a CONTAINER row.
    //
    // POST /watchlist accepts mediaType movie|series|tv|audiobook, so a `tv`
    // row is a first-class watchlist entry. `tv` rows own no media_file_items
    // (0 of 6,570 on production, 2026-09-15), so the predicate's
    // `NOT EXISTS (own files)` arm was unconditionally true and the library
    // axis did nothing -- returning title, overview, ratings and IDs for a
    // series whose every episode is in a denied group, which is precisely what
    // the query's own comment says it must prevent.
    //
    // The file goes on the EPISODE via placeInLibraryGroup, where a real scan
    // puts it and where the container-aware predicate looks.
    // =========================================================================
    describe('getUserWatchlistMedia — library axis for container rows', () => {
        async function seedWatchlistSeries(
            userId: UserId,
            title: string,
            libraryGroupId: string | null,
        ): Promise<string> {
            const item = createTestMediaItem({ title, media_type: 'tv', has_files: true });
            await insertTestMediaItem(sql, item);
            if (libraryGroupId) {
                await placeInLibraryGroup(sql, {
                    mediaItemId: item.id,
                    mediaType: 'tv',
                    libraryGroupId,
                });
            }
            await upsertWatchlistItem(sql, userId, item.id);
            return item.id;
        }

        it('hides a watchlisted series whose episodes are all in a denied group', async () => {
            const userId = generateTestUserId('wl_container');
            await ensureTestUser(sql, userId);
            const groupA = crypto.randomUUID();
            const groupB = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupA}::uuid, 'WL A'), (${groupB}::uuid, 'WL B')
            `;

            const denied = await seedWatchlistSeries(userId, 'Obsidian Tideline', groupA);
            const allowed = await seedWatchlistSeries(userId, 'Marigold Transit', groupB);

            // POSITIVE CONTROL — both rows are reachable unrestricted.
            const open = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: null,
                ageRating: null,
            });
            const openIds = open.map((r) => r.media_id);
            expect(openIds).toContain(denied);
            expect(openIds).toContain(allowed);

            const narrowed = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: [groupA],
                ageRating: null,
            });
            const narrowedIds = narrowed.map((r) => r.media_id);
            for (const id of narrowedIds) expect(openIds).toContain(id);
            expect(narrowedIds.length).toBeLessThan(openIds.length);
            expect(narrowedIds).not.toContain(denied);
            expect(narrowedIds).toContain(allowed);
        });

        it('keeps a file-less watchlisted series visible (catalog-only fail-open)', async () => {
            const userId = generateTestUserId('wl_stub');
            await ensureTestUser(sql, userId);
            const groupA = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'WL Unrelated')`;

            const stub = await seedWatchlistSeries(userId, 'Paper Kestrel', null);

            const narrowed = await getUserWatchlistMedia(sql, userId, {
                deniedGroupIds: [groupA],
                ageRating: null,
            });
            expect(narrowed.map((r) => r.media_id)).toContain(stub);
        });
    });
});
