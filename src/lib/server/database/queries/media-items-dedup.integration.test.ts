// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Duplicate Series Detection and Merge
 *
 * Tests explicit mergeDuplicateSeries and findOrCreateSeries
 * advisory lock behavior.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'crypto';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';
import { upsertWatchlistItem } from './watchlist.queries.js';

import {
    mergeDuplicateSeries,
    findOrCreateSeries,
    MergeGuardError,
} from './media-items.queries.js';

const TABLES_TO_CLEAN = [
    'media_file_items',
    'media_files',
    'playlist_items',
    'playlists',
    'user_ratings',
    'watchlist_activities',
    'user_media_state',
    'user_media_events',
    'user_media_flags',
    'user_suggestions',
    'cached_list_items',
    'cached_lists',
    'external_ids',
    'media_items',
    'user_profiles',
    'users',
];

describe('Duplicate Series Detection and Merge', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES_TO_CLEAN);
    });

    describe('mergeDuplicateSeries', () => {
        describe("guard: 'adminPair' (operator merge endpoint)", () => {
            async function pair(keepHasFiles: boolean): Promise<{ keep: string; merge: string }> {
                const [keep] = await sql<[{ id: string }]>`
                    INSERT INTO media_items (title, media_type) VALUES ('Keep', 'movie') RETURNING id`;
                const [merge] = await sql<[{ id: string }]>`
                    INSERT INTO media_items (title, media_type) VALUES ('Merge', 'movie') RETURNING id`;
                await sql`UPDATE media_items SET has_files = ${keepHasFiles} WHERE id = ${keep.id}`;
                return { keep: keep.id, merge: merge.id };
            }

            it('refuses, and deletes nothing, when the kept row has no files at lock time', async () => {
                // The endpoint's pre-check passed earlier; by the time the rows
                // are locked the keeper has lost its files.
                const { keep, merge } = await pair(false);

                await expect(
                    mergeDuplicateSeries(sql, keep, merge, { guard: 'adminPair' }),
                ).rejects.toBeInstanceOf(MergeGuardError);

                const rows = await sql`SELECT id FROM media_items WHERE id IN (${keep}, ${merge})`;
                expect(rows).toHaveLength(2);
            });

            it('refuses when the merged row was dismissed meanwhile', async () => {
                const { keep, merge } = await pair(true);
                await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${merge}`;

                await expect(
                    mergeDuplicateSeries(sql, keep, merge, { guard: 'adminPair' }),
                ).rejects.toMatchObject({ reason: 'inactive' });
            });

            it('merges a valid pair', async () => {
                const { keep, merge } = await pair(true);

                await mergeDuplicateSeries(sql, keep, merge, { guard: 'adminPair' });

                const rows = await sql`SELECT id FROM media_items WHERE id = ${merge}`;
                expect(rows).toHaveLength(0);
            });

            it('is not applied without the option (reconciliation merges ghost rows)', async () => {
                const { keep, merge } = await pair(false);

                await mergeDuplicateSeries(sql, keep, merge);

                const rows = await sql`SELECT id FROM media_items WHERE id = ${merge}`;
                expect(rows).toHaveLength(0);
            });
        });

        it('merging an artist row leaves no dangling id on locked tracks', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep Artist', 'artist') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge Artist', 'artist') RETURNING id`;
            const track = async (locked: boolean): Promise<string> => {
                const [row] = await sql<[{ id: string }]>`
                    INSERT INTO media_items (title, media_type, metadata_locked, custom_metadata)
                    VALUES (${'T'}, 'track', ${locked},
                            ${sql.json({ additional_artist_ids: [merge.id, keep.id] })})
                    RETURNING id`;
                return row.id;
            };
            const locked = await track(true);
            const open = await track(false);

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            for (const id of [locked, open]) {
                const [row] = await sql<{ ids: string[] }[]>`
                    SELECT ARRAY(SELECT jsonb_array_elements_text(custom_metadata->'additional_artist_ids')) AS ids
                    FROM media_items WHERE id = ${id}`;
                expect(row.ids).toEqual([keep.id]);
            }
        });

        it('re-parents non-conflicting seasons', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;
            await sql`INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('S1', 'season', ${merge.id}, 1)`;

            const result = await mergeDuplicateSeries(sql, keep.id, merge.id);
            expect(result.seasonsReparented).toBe(1);

            // Season should now be under keepId
            const seasons = await sql`
                SELECT * FROM media_items WHERE parent_id = ${keep.id} AND media_type = 'season'`;
            expect(seasons).toHaveLength(1);

            // Merge source should be deleted
            const deleted = await sql`SELECT * FROM media_items WHERE id = ${merge.id}`;
            expect(deleted).toHaveLength(0);
        });

        it('merges conflicting seasons by moving episodes', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            // Both have season 1
            const [keepS1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('S1 Keep', 'season', ${keep.id}, 1) RETURNING id`;
            const [mergeS1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('S1 Merge', 'season', ${merge.id}, 1) RETURNING id`;

            // Keep has ep1, merge has ep2 (non-conflicting)
            await sql`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES ('Ep1', 'episode', ${keepS1.id}, 1, 1)`;
            await sql`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES ('Ep2', 'episode', ${mergeS1.id}, 1, 2)`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // Both episodes should be under keepS1
            const episodes = await sql`
                SELECT * FROM media_items WHERE parent_id = ${keepS1.id} AND media_type = 'episode'
                ORDER BY episode_number`;
            expect(episodes).toHaveLength(2);

            // Merge source season should be deleted
            const mergeSeasons = await sql`
                SELECT * FROM media_items WHERE id = ${mergeS1.id}`;
            expect(mergeSeasons).toHaveLength(0);
        });

        it('preserves media_file_items for conflicting episodes', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            const [keepS1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('S1 Keep', 'season', ${keep.id}, 1) RETURNING id`;
            const [mergeS1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('S1 Merge', 'season', ${merge.id}, 1) RETURNING id`;

            // Both have ep1 (conflicting)
            const [keepEp1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES ('Ep1 Keep', 'episode', ${keepS1.id}, 1, 1) RETURNING id`;
            const [mergeEp1] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES ('Ep1 Merge', 'episode', ${mergeS1.id}, 1, 1) RETURNING id`;

            // File linked to the merge episode
            const [file] = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path) VALUES ('/test/ep1.mkv') RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${file.id}, ${mergeEp1.id})`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // File should now be linked to the kept episode
            const fileLinks = await sql`
                SELECT media_item_id FROM media_file_items WHERE file_id = ${file.id}`;
            expect(fileLinks).toHaveLength(1);
            expect(fileLinks[0].media_item_id).toBe(keepEp1.id);
        });

        // Artist credits live in two places: album parentage (covered by the
        // generic child re-parent) and `custom_metadata.additional_artist_ids`,
        // a plain jsonb array with no FK. Merging an artist without remapping
        // the array leaves reference-only tracks pointing at the deleted row;
        // `trackArtistsSql` inner-joins those ids, so the credit does not error,
        // it silently vanishes from the track line and the artist's page.
        it('remaps additional_artist_ids when merging artists', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('DJ Maralon', 'artist') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Maralon', 'artist') RETURNING id`;
            const [track] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, custom_metadata)
                VALUES ('Ravers Fantasy', 'track',
                        ${sql.json({ additional_artist_ids: [merge.id] })})
                RETURNING id`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const [row] = await sql<[{ ids: string[] }]>`
                SELECT ARRAY(SELECT jsonb_array_elements_text(
                    custom_metadata->'additional_artist_ids')) AS ids
                FROM media_items WHERE id = ${track.id}`;
            expect(row.ids).toEqual([keep.id]);
        });

        // A track that already credited BOTH rows must not end up listing the
        // survivor twice — the remap collapses onto an id already present.
        it('dedupes a track that credited both merged artists', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('DJ Maralon', 'artist') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Maralon', 'artist') RETURNING id`;
            const [other] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Nicco', 'artist') RETURNING id`;
            const [track] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, custom_metadata)
                VALUES ('Welcome To The Club', 'track',
                        ${sql.json({ additional_artist_ids: [keep.id, other.id, merge.id] })})
                RETURNING id`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const [row] = await sql<[{ ids: string[] }]>`
                SELECT ARRAY(SELECT jsonb_array_elements_text(
                    custom_metadata->'additional_artist_ids')) AS ids
                FROM media_items WHERE id = ${track.id}`;
            // First occurrence wins, original order preserved.
            expect(row.ids).toEqual([keep.id, other.id]);
        });

        // The remap is artist-only: a tv merge must not pay for two extra
        // statements, and non-artist rows never appear in the array anyway.
        it('leaves additional_artist_ids untouched when merging non-artists', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;
            const [track] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, custom_metadata)
                VALUES ('Unrelated', 'track',
                        ${sql.json({ additional_artist_ids: [merge.id] })})
                RETURNING id`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const [row] = await sql<[{ ids: string[] }]>`
                SELECT ARRAY(SELECT jsonb_array_elements_text(
                    custom_metadata->'additional_artist_ids')) AS ids
                FROM media_items WHERE id = ${track.id}`;
            expect(row.ids).toEqual([merge.id]);
        });

        it('moves external_ids to kept item', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${merge.id}, 'imdb', 'tt1234567', 'tv')`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const extIds = await sql`
                SELECT * FROM external_ids WHERE media_id = ${keep.id}`;
            expect(extIds).toHaveLength(1);
            expect(extIds[0].provider).toBe('imdb');
        });

        // IDENT-C4 regression: the move guard must be composite-key aware
        // (provider, external_id, media_type) — NOT provider alone. The same
        // provider id is reused across media types (TMDB 1429 = a movie AND a
        // series). A provider-only guard would treat the mergeId's cross-type id
        // as a "conflict" and silently delete it; the composite-key guard moves
        // it because it is a genuinely distinct external id.
        it('moves a cross-type external_id sharing a provider+id with keepId (IDENT-C4)', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            // keepId already holds tmdb:1429:movie; mergeId holds tmdb:1429:tv.
            // Same provider + external_id, different media_type → distinct row.
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${keep.id}, 'tmdb', '1429', 'movie')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${merge.id}, 'tmdb', '1429', 'tv')`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const extIds = await sql<{ media_type: string }[]>`
                SELECT media_type FROM external_ids WHERE media_id = ${keep.id}
                  AND provider = 'tmdb' AND external_id = '1429'
                ORDER BY media_type`;
            // Both the pre-existing movie row and the moved tv row survive.
            expect(extIds.map((r) => r.media_type)).toEqual(['movie', 'tv']);

            // Nothing left on the merged-away item.
            const orphan = await sql`
                SELECT 1 FROM external_ids WHERE media_id = ${merge.id}`;
            expect(orphan).toHaveLength(0);
        });

        // Same (provider, media_type) is a genuine collision under
        // idx_external_ids_one_per_provider (one id per provider+type per item).
        // keepId keeps its existing row; mergeId's conflicting row is dropped —
        // and crucially the move must NOT throw on the unique index.
        it('drops a conflicting same provider+type external_id and keeps keepIds (IDENT-C4)', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${keep.id}, 'tvdb', '100', 'tv')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${merge.id}, 'tvdb', '200', 'tv')`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            const extIds = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${keep.id}
                  AND provider = 'tvdb' ORDER BY external_id`;
            // keepId's pre-existing id survives; merge's same-type id is dropped.
            expect(extIds.map((r) => r.external_id)).toEqual(['100']);
            const orphan = await sql`
                SELECT 1 FROM external_ids WHERE media_id = ${merge.id}`;
            expect(orphan).toHaveLength(0);
        });

        // DATA-LOSS regression (finding #61): every table whose FK to
        // media_items is ON DELETE CASCADE must be re-pointed BEFORE the final
        // DELETE, or its rows for the merged id are silently destroyed. This
        // test seeds all six user-data CASCADE tables on the merged row and
        // asserts (a) zero rows still reference mergeId after the merge and
        // (b) the data was re-pointed onto keepId (not just deleted).
        it('re-points all CASCADE user-data tables and leaves zero rows on mergeId', async () => {
            const userId = randomUUID();
            await ensureTestUser(sql, userId);
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            // user_media_state — resume position only on the merged row.
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, watch_count)
                VALUES (${userId}::uuid, ${merge.id}, true, 42000, 3)`;
            // user_media_events — a watch event with a unique source_event_id.
            await sql`
                INSERT INTO user_media_events (user_id, media_id, event_type, source, source_event_id, occurred_at)
                VALUES (${userId}::uuid, ${merge.id}, 'progress', 'lumastra-player', 'evt-1', now())`;
            // user_media_flags — a dismissed flag (target_id column).
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}::uuid, ${merge.id}, 'media', 'dismissed_cw')`;
            // watchlist entry — now an ordinary playlist_items row on the
            // user's system watchlist playlist (playlist_type = 'watchlist'),
            // re-pointed by the generic playlist_items fold below, not a
            // separate user_watchlist step.
            await upsertWatchlistItem(sql, toUserId(userId), merge.id);
            // user_suggestions — an AI suggestion row.
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, cache_context, combined_score)
                VALUES (${userId}::uuid, ${merge.id}, 'general', 0.9)`;
            // cached_list_items — list membership (needs a parent cached_lists row).
            await sql`
                INSERT INTO cached_lists (list_id, name, list_path)
                VALUES ('list-1', 'Test List', 'user/list-1')`;
            await sql`
                INSERT INTO cached_list_items (list_id, media_id, rank)
                VALUES ('list-1', ${merge.id}, 1)`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // (a) Zero rows reference the merged-away id across every CASCADE table.
            const stillReferencing = await sql<{ tbl: string; n: number }[]>`
                SELECT 'user_media_state' AS tbl, COUNT(*)::int AS n FROM user_media_state WHERE media_id = ${merge.id}
                UNION ALL SELECT 'user_media_events', COUNT(*)::int FROM user_media_events WHERE media_id = ${merge.id}
                UNION ALL SELECT 'user_media_flags', COUNT(*)::int FROM user_media_flags WHERE target_id = ${merge.id}
                UNION ALL SELECT 'watchlist_playlist_items', COUNT(*)::int FROM playlist_items wpi
                    JOIN playlists wp ON wp.id = wpi.playlist_id
                    WHERE wpi.media_id = ${merge.id} AND wp.playlist_type = 'watchlist'
                UNION ALL SELECT 'user_suggestions', COUNT(*)::int FROM user_suggestions WHERE media_id = ${merge.id}
                UNION ALL SELECT 'cached_list_items', COUNT(*)::int FROM cached_list_items WHERE media_id = ${merge.id}
            `;
            for (const row of stillReferencing) {
                expect(row.n, `${row.tbl} still references mergeId`).toBe(0);
            }

            // (b) The data was re-pointed onto keepId, not destroyed.
            const onKeep = await sql<{ tbl: string; n: number }[]>`
                SELECT 'user_media_state' AS tbl, COUNT(*)::int AS n FROM user_media_state WHERE media_id = ${keep.id}
                UNION ALL SELECT 'user_media_events', COUNT(*)::int FROM user_media_events WHERE media_id = ${keep.id}
                UNION ALL SELECT 'user_media_flags', COUNT(*)::int FROM user_media_flags WHERE target_id = ${keep.id}
                UNION ALL SELECT 'watchlist_playlist_items', COUNT(*)::int FROM playlist_items wpi
                    JOIN playlists wp ON wp.id = wpi.playlist_id
                    WHERE wpi.media_id = ${keep.id} AND wp.playlist_type = 'watchlist'
                UNION ALL SELECT 'user_suggestions', COUNT(*)::int FROM user_suggestions WHERE media_id = ${keep.id}
                UNION ALL SELECT 'cached_list_items', COUNT(*)::int FROM cached_list_items WHERE media_id = ${keep.id}
            `;
            for (const row of onKeep) {
                expect(row.n, `${row.tbl} was not re-pointed to keepId`).toBe(1);
            }
        });

        // When keepId ALREADY has a unique-conflicting row, the source row is
        // de-duplicated away (skipped on UPDATE, then deleted) — keepId's
        // existing data wins, and no unique-violation is thrown.
        it('de-dupes CASCADE rows that would collide on keepIds unique key', async () => {
            const userId = randomUUID();
            await ensureTestUser(sql, userId);
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            // Same (user's watchlist playlist, media_id) watchlist + state on
            // BOTH rows → collision. Both upserts land in the SAME watchlist
            // playlist (one per user), so the fold's playlist_id+media_id
            // NOT EXISTS check applies exactly as it would for any other
            // playlist_items collision.
            await upsertWatchlistItem(sql, toUserId(userId), keep.id);
            await upsertWatchlistItem(sql, toUserId(userId), merge.id);
            await sql`
                INSERT INTO user_media_state (user_id, media_id, watch_count)
                VALUES (${userId}::uuid, ${keep.id}, 5)`;
            await sql`
                INSERT INTO user_media_state (user_id, media_id, watch_count)
                VALUES (${userId}::uuid, ${merge.id}, 1)`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // Exactly one row survives on keepId; keepId's existing value wins.
            const wl = await sql`
                SELECT wpi.* FROM playlist_items wpi
                JOIN playlists wp ON wp.id = wpi.playlist_id
                WHERE wpi.media_id = ${keep.id} AND wp.playlist_type = 'watchlist'
            `;
            expect(wl).toHaveLength(1);
            const state = await sql<{ watch_count: number }[]>`
                SELECT watch_count FROM user_media_state WHERE media_id = ${keep.id}`;
            expect(state).toHaveLength(1);
            expect(state[0].watch_count).toBe(5);

            // Nothing left on the merged id.
            const orphanWl = await sql`
                SELECT 1 FROM playlist_items wpi
                JOIN playlists wp ON wp.id = wpi.playlist_id
                WHERE wpi.media_id = ${merge.id} AND wp.playlist_type = 'watchlist'
            `;
            expect(orphanWl).toHaveLength(0);
        });

        it('handles NULL season_number correctly', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Keep', 'tv') RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Merge', 'tv') RETURNING id`;

            // Both have NULL season_number (specials)
            const [keepSpecials] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id)
                VALUES ('Specials Keep', 'season', ${keep.id}) RETURNING id`;
            await sql`INSERT INTO media_items (title, media_type, parent_id)
                VALUES ('Specials Merge', 'season', ${merge.id})`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // Only one specials season should remain under keep
            const seasons = await sql`
                SELECT * FROM media_items WHERE parent_id = ${keep.id} AND media_type = 'season'`;
            expect(seasons).toHaveLength(1);
            expect(seasons[0].id).toBe(keepSpecials.id);
        });

        // The merge re-points media_file_items onto the keeper's EXISTING episode
        // rows, but those rows were created file-less and stay has_files=false
        // unless something recomputes them. Availability is has_files alone
        // (availability.queries.ts), so a "successful" merge still reported the
        // episodes as not-on-disk — the prod repair on 2026-08-21 needed a
        // separate recompute pass to actually fix the symptom.
        it('recomputes has_files on the keeper rows that gained the file links', async () => {
            const [keep] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year) VALUES ('Rollup Show', 'tv', 2023) RETURNING id`;
            const [merge] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year) VALUES ('Rollup Show', 'tv', 2023) RETURNING id`;

            const [keepSeason] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('Season 1', 'season', ${keep.id}, 1) RETURNING id`;
            const [keepEp] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                VALUES ('Ep 1', 'episode', ${keepSeason.id}, 1, 1) RETURNING id`;

            const [mergeSeason] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES ('Season 1', 'season', ${merge.id}, 1) RETURNING id`;
            const [mergeEp] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, has_files)
                VALUES ('Ep 1', 'episode', ${mergeSeason.id}, 1, 1, true) RETURNING id`;

            const [file] = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path) VALUES ('/data/rollup-show/s01e01.mkv') RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}, ${mergeEp.id})`;

            await mergeDuplicateSeries(sql, keep.id, merge.id);

            // The link moved onto the keeper's episode...
            const links = await sql`
                SELECT media_item_id FROM media_file_items WHERE file_id = ${file.id}`;
            expect(links).toHaveLength(1);
            expect(links[0].media_item_id).toBe(keepEp.id);

            // ...and has_files is true all the way up the kept hierarchy.
            const rows = await sql<{ id: string; has_files: boolean }[]>`
                SELECT id, has_files FROM media_items
                WHERE id IN (${keepEp.id}, ${keepSeason.id}, ${keep.id})`;
            const byId = new Map(rows.map((r) => [r.id, r.has_files]));
            expect(byId.get(keepEp.id)).toBe(true);
            expect(byId.get(keepSeason.id)).toBe(true);
            expect(byId.get(keep.id)).toBe(true);
        });
    });

    // ==========================================================================
    // findOrCreateSeries (advisory lock dedup)
    // ==========================================================================

    describe('findOrCreateSeries', () => {
        it('creates a new series when none exists', async () => {
            const id = await findOrCreateSeries(sql, {
                title: 'New Show',
                mediaType: 'tv',
            });
            expect(id).toBeDefined();

            const rows = await sql`SELECT * FROM media_items WHERE id = ${id}`;
            expect(rows).toHaveLength(1);
            expect(rows[0].title).toBe('New Show');
        });

        it('returns existing series by external ID', async () => {
            const [existing] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('Existing', 'tv') RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${existing.id}, 'tmdb', '99999', 'tv')`;

            const id = await findOrCreateSeries(sql, {
                title: 'Different Title',
                mediaType: 'tv',
                externalId: { provider: 'tmdb', id: '99999', mediaType: 'tv' },
            });
            expect(id).toBe(existing.id);
        });

        it('returns existing series by normalized title match', async () => {
            const [existing] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type) VALUES ('The Outpost!', 'tv') RETURNING id`;

            const id = await findOrCreateSeries(sql, {
                title: 'the outpost',
                mediaType: 'tv',
            });
            expect(id).toBe(existing.id);
        });

        /**
         * Regression: split-brain series creation (prod, 2026-08-20/21).
         *
         * Three prod shows ended up as two media_items rows each, with their
         * episode files split across both — "My Unique Skill Makes Me OP Even
         * at Level 1" stranded 4 of 12 episodes on a second, identity-less row
         * so the UI reported them as not-on-disk.
         *
         * Mechanism: step 1 (external-ID resolve) runs OUTSIDE the advisory
         * lock, so a scan worker that reads before the winner attaches its
         * TMDB id gets a stale MISS. By the time that worker acquires the lock,
         * the winner also carries the scanner's `imdb` id — and the
         * cross-provider conflict guard rejects ANY row holding an external_id
         * that isn't exactly the incoming triple, including the show's own row.
         * Title fallback therefore also misses, and the worker inserts a
         * duplicate.
         *
         * This test reproduces that interleaving deterministically by holding
         * the series advisory lock while the winner row is enriched.
         */
        it('re-resolves the external ID under the lock instead of creating a split-brain duplicate', async () => {
            const title = 'Split Brain Show';
            const lockKey = 'series:split brain show:tv';

            // Hold the same transaction-scoped advisory lock findOrCreateSeries
            // takes, on a reserved (pinned) connection.
            const holder = await sql.reserve();
            await holder`BEGIN`;
            await holder`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

            // Worker B starts now: its step-1 external-ID resolve MISSES
            // (nothing carries tmdb=771010 yet), then it parks on the lock.
            const workerB = findOrCreateSeries(sql, {
                title,
                year: 2023,
                mediaType: 'tv',
                externalId: { provider: 'tmdb', id: '771010', mediaType: 'tv' },
            });

            // Give worker B time to miss step 1 and block on the lock.
            await new Promise((r) => setTimeout(r, 250));

            // Meanwhile worker A finishes: row created, then the scanner attaches
            // BOTH the primary tmdb id and the secondary imdb id.
            const [winner] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year)
                VALUES (${title}, 'tv', 2023) RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${winner.id}, 'tmdb', '771010', 'tv', true)`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${winner.id}, 'imdb', 'tt7710100', 'tv', false)`;

            // Release the lock -> worker B proceeds.
            await holder`COMMIT`;
            await holder.release();

            const workerBId = await workerB;

            // Worker B must land on the existing row, not mint a second one.
            expect(workerBId).toBe(winner.id);

            const rows = await sql`
                SELECT id FROM media_items
                WHERE media_type = 'tv' AND parent_id IS NULL AND title = ${title}`;
            expect(rows).toHaveLength(1);
        });

        it('does not create duplicates under concurrent calls', async () => {
            // Run multiple findOrCreate concurrently for the same title
            const results = await Promise.all([
                findOrCreateSeries(sql, {
                    title: 'Concurrent Show',
                    mediaType: 'tv',
                }),
                findOrCreateSeries(sql, {
                    title: 'Concurrent Show',
                    mediaType: 'tv',
                }),
                findOrCreateSeries(sql, {
                    title: 'Concurrent Show',
                    mediaType: 'tv',
                }),
            ]);

            // All should return the same ID
            expect(new Set(results).size).toBe(1);

            // Only one row should exist
            const rows = await sql`
                SELECT * FROM media_items WHERE title = 'Concurrent Show' AND media_type = 'tv'`;
            expect(rows).toHaveLength(1);
        });
    });
});
