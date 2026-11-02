// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Album Enrichment Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum as insertAlbumRow,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getUnenrichedAlbums,
    countUnenrichedAlbums,
    getAlbumEnrichmentBacklog,
    findCoverageTableBacklog,
    markAlbumProcessed,
    updateAlbumPosterUrls,
    getAlbumEnrichmentWipeBatch,
    atomicallyWipeAlbumEnrichment,
    deferAlbumAfterSourceOutage,
    reEnrollGapAlbumsForRepoll,
} from './album-enrichment.queries.js';

import { recomputeHasFiles, markFileMissing } from './media-files.queries.js';

async function insertTestAlbum(
    sql: postgres.Sql,
    album: Parameters<typeof insertAlbumRow>[1],
): Promise<string> {
    const id = await insertAlbumRow(sql, album);
    const track = createTestTrack(id, 1);
    await insertTestTrack(sql, track);
    await recomputeHasFiles(sql, track.id);
    return id;
}

describe('Album Enrichment Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    describe('getUnenrichedAlbums', () => {
        it('returns albums without poster artwork', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const rows = await getUnenrichedAlbums(sql, 1, 10);
            const match = rows.find((r) => r.id === album.id);
            expect(match).toBeDefined();
            expect(match?.parent_id).toBe(artist.id);
        });

        it('returns parent_title for albums with artist', async () => {
            const artist = createTestArtist({ title: 'Neon Pulse' });
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const rows = await getUnenrichedAlbums(sql, 1, 10);
            const match = rows.find((r) => r.id === album.id);
            expect(match?.parent_title).toBe('Neon Pulse');
        });
    });

    it('excludes missing music from legacy and coverage enrichment backlogs', async () => {
        const artist = createTestArtist();
        const album = createTestAlbum(artist.id);
        await insertTestArtist(sql, artist);
        await insertTestAlbum(sql, album);
        await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
            VALUES (${album.id}, 'album-enrichment', 1, 'pending')`;
        expect((await getUnenrichedAlbums(sql, 1, 10)).map((r) => r.id)).toContain(album.id);
        expect(
            (await findCoverageTableBacklog(sql, 'album-enrichment', 10)).map((r) => r.id),
        ).toContain(album.id);
        const [file] =
            await sql`SELECT f.file_id FROM media_file_items f JOIN media_items t ON t.id = f.media_item_id WHERE t.parent_id = ${album.id}`;
        await markFileMissing(sql, file.file_id);
        expect((await getUnenrichedAlbums(sql, 1, 10)).map((r) => r.id)).not.toContain(album.id);
        expect(
            (await findCoverageTableBacklog(sql, 'album-enrichment', 10)).map((r) => r.id),
        ).not.toContain(album.id);
        expect(await countUnenrichedAlbums(sql, 1)).toBe(0);
        expect((await getAlbumEnrichmentBacklog(sql, 1)).remaining).toBe(0);
    });

    describe('countUnenrichedAlbums', () => {
        it('counts albums needing enrichment', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const count = await countUnenrichedAlbums(sql, 1);
            expect(count).toBeGreaterThanOrEqual(1);
        });
    });

    describe('getAlbumEnrichmentBacklog', () => {
        it('returns backlog breakdown', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const backlog = await getAlbumEnrichmentBacklog(sql, 1);
            expect(backlog.remaining).toBeGreaterThanOrEqual(1);
        });
    });

    describe('findCoverageTableBacklog', () => {
        it('returns empty array when no coverage rows exist', async () => {
            const rows = await findCoverageTableBacklog(sql, 'album-enrichment', 10);
            expect(rows).toHaveLength(0);
        });
    });

    describe('markAlbumProcessed', () => {
        it('marks album with success status', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const result = await markAlbumProcessed(sql, album.id, 1, 'success');
            expect(result).toBe(true);
        });

        it('marks album with failed status and reason', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const result = await markAlbumProcessed(sql, album.id, 1, 'failed', 'network_error');
            expect(result).toBe(true);

            const rows = await sql`
                SELECT processing_state FROM media_items WHERE id = ${album.id}::uuid
            `;
            expect(rows[0].processing_state['album-enrichment'].status).toBe('failed');
        });
    });

    describe('updateAlbumPosterUrls', () => {
        it('updates poster and backdrop URLs', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            await updateAlbumPosterUrls(sql, album.id, {
                posterUrl: 'http://example.com/poster.jpg',
                backdropUrl: 'http://example.com/backdrop.jpg',
            });

            const rows = await sql`
                SELECT custom_poster_url, custom_backdrop_url FROM media_items WHERE id = ${album.id}::uuid
            `;
            expect(rows[0].custom_poster_url).toBe('http://example.com/poster.jpg');
            expect(rows[0].custom_backdrop_url).toBe('http://example.com/backdrop.jpg');
        });
    });

    describe('getAlbumEnrichmentWipeBatch', () => {
        it('returns empty when no plugin artwork exists', async () => {
            const rows = await getAlbumEnrichmentWipeBatch(sql, 10);
            expect(rows.length).toBe(0);
        });
    });

    describe('atomicallyWipeAlbumEnrichment', () => {
        it('runs without error for missing album IDs', async () => {
            await expect(
                atomicallyWipeAlbumEnrichment(sql, ['00000000-0000-0000-0000-000000000000']),
            ).resolves.toBeUndefined();
        });
    });

    describe('deferAlbumAfterSourceOutage', () => {
        async function seedAlbum(title: string, status: string): Promise<string> {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id, { title });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
                VALUES (${album.id}::uuid, 'album-enrichment', 2, ${status})
            `;
            return album.id;
        }

        it('parks a pending row so the drain skips it until the retry time, then returns it', async () => {
            const id = await seedAlbum('Deferred Album', 'pending');

            const deferred = await deferAlbumAfterSourceOutage(sql as never, {
                albumId: id,
                stageId: 'album-enrichment',
                retryAfterMs: 12 * 60 * 60 * 1000,
                maxRetryAfterMs: 7 * 24 * 60 * 60 * 1000,
                detail: 'Enrichment source unavailable: theaudiodb',
            });

            expect(deferred).toBe(true);
            const [row] = await sql<
                {
                    status: string;
                    skipped_reason: string;
                    hours: number;
                    last_error: { code: string; message: string; deferrals: number };
                }[]
            >`
                SELECT status, skipped_reason, last_error,
                       EXTRACT(EPOCH FROM (next_eligible_at - now())) / 3600 AS hours
                FROM media_item_stage_state
                WHERE media_item_id = ${id}::uuid AND stage_id = 'album-enrichment'
            `;
            expect(row.status).toBe('skipped_transient');
            expect(row.skipped_reason).toBe('source-unavailable');
            expect(row.last_error).toMatchObject({
                code: 'source_unavailable',
                message: 'Enrichment source unavailable: theaudiodb',
                deferrals: 1,
            });
            // 12 h plus up to 10 % jitter.
            expect(Number(row.hours)).toBeGreaterThan(11.9);
            expect(Number(row.hours)).toBeLessThanOrEqual(13.2);

            expect(await findCoverageTableBacklog(sql as never, 'album-enrichment', 10)).toEqual(
                [],
            );
            await sql`
                UPDATE media_item_stage_state SET next_eligible_at = now() - interval '1 second'
                WHERE media_item_id = ${id}::uuid
            `;
            const due = await findCoverageTableBacklog(sql as never, 'album-enrichment', 10);
            expect(due.map((r) => r.id)).toEqual([id]);
        });

        it('doubles the wait on each consecutive deferral, up to the cap', async () => {
            const id = await seedAlbum('Long Outage', 'pending');
            const hour = 60 * 60 * 1000;
            const waits: number[] = [];
            for (let i = 0; i < 4; i++) {
                await deferAlbumAfterSourceOutage(sql as never, {
                    albumId: id,
                    stageId: 'album-enrichment',
                    retryAfterMs: hour,
                    maxRetryAfterMs: 4 * hour,
                    detail: 'theaudiodb unavailable: HTTP 404',
                });
                const [row] = await sql<{ hours: number; deferrals: number }[]>`
                    SELECT EXTRACT(EPOCH FROM (next_eligible_at - now())) / 3600 AS hours,
                           (last_error->>'deferrals')::int AS deferrals
                    FROM media_item_stage_state WHERE media_item_id = ${id}::uuid
                `;
                expect(row.deferrals).toBe(i + 1);
                waits.push(Number(row.hours));
            }
            // 1 h, 2 h, 4 h, then capped at 4 h — each with up to 10 % jitter.
            for (const [i, base] of [1, 2, 4, 4].entries()) {
                expect(waits[i]).toBeGreaterThan(base - 0.05);
                expect(waits[i]).toBeLessThanOrEqual(base * 1.1 + 0.01);
            }
        });

        it('drops a stale status marker so the legacy-no-match sweep cannot tombstone the row', async () => {
            const id = await seedAlbum('Stale Marker', 'failed_transient');
            await sql`
                UPDATE media_items
                   SET processing_state = '{"album-enrichment": {"status": "no-match", "version": 2}, "other-stage": {"version": 1}}'::jsonb
                 WHERE id = ${id}::uuid
            `;

            await deferAlbumAfterSourceOutage(sql as never, {
                albumId: id,
                stageId: 'album-enrichment',
                retryAfterMs: 60_000,
                maxRetryAfterMs: 60_000,
                detail: 'discogs unavailable: HTTP 503',
            });

            const [item] = await sql<{ ps: Record<string, unknown> }[]>`
                SELECT processing_state AS ps FROM media_items WHERE id = ${id}::uuid
            `;
            expect(item.ps).toEqual({ 'other-stage': { version: 1 } });
        });

        it('keeps a failed marker, so the admin failures list keeps the reason', async () => {
            const id = await seedAlbum('Failed Before', 'failed_transient');
            await sql`
                UPDATE media_items
                   SET processing_state = '{"album-enrichment": {"status": "failed", "version": 2, "reason": "HTTP 500"}}'::jsonb
                 WHERE id = ${id}::uuid
            `;

            expect(
                await deferAlbumAfterSourceOutage(sql as never, {
                    albumId: id,
                    stageId: 'album-enrichment',
                    retryAfterMs: 60_000,
                    maxRetryAfterMs: 60_000,
                    detail: 'x',
                }),
            ).toBe(true);
            const [item] = await sql<{ reason: string | null }[]>`
                SELECT processing_state->'album-enrichment'->>'reason' AS reason
                FROM media_items WHERE id = ${id}::uuid
            `;
            expect(item.reason).toBe('HTTP 500');
        });

        it('leaves terminal rows alone and reports that nothing was deferred', async () => {
            const id = await seedAlbum('Already Done', 'skipped_permanent');

            const deferred = await deferAlbumAfterSourceOutage(sql as never, {
                albumId: id,
                stageId: 'album-enrichment',
                retryAfterMs: 60_000,
                maxRetryAfterMs: 60_000,
                detail: 'x',
            });

            expect(deferred).toBe(false);
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_item_stage_state WHERE media_item_id = ${id}::uuid
            `;
            expect(row.status).toBe('skipped_permanent');
        });
    });

    describe('reEnrollGapAlbumsForRepoll', () => {
        it('re-opens tombstoned poster-less albums, drops their marker, and skips the rest', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const gap = createTestAlbum(artist.id, { title: 'Tombstoned Gap' });
            const withPoster = createTestAlbum(artist.id, { title: 'Has Poster' });
            const orphan = createTestAlbum(artist.id, { title: 'No Parent' });
            const failed = createTestAlbum(artist.id, { title: 'Failed For Good' });
            const parked = createTestAlbum(artist.id, { title: 'Parked Outage' });
            for (const a of [gap, withPoster, orphan, failed, parked])
                await insertTestAlbum(sql, a);
            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${withPoster.id}::uuid, 'poster', 'local', '/covers/poster.jpg')
            `;
            const seed: Array<[string, string, string | null]> = [
                [gap.id, 'skipped_permanent', 'no-match-upstream'],
                // Parked with backoff up to 90 days: a re-poll must not wait it out.
                [parked.id, 'skipped_transient', 'source-unavailable'],
                [withPoster.id, 'skipped_permanent', 'album-already-has-poster'],
                [orphan.id, 'skipped_permanent', 'no-parent-artist'],
                [failed.id, 'failed_permanent', null],
            ];
            for (const [id, status, reason] of seed) {
                await sql`
                    INSERT INTO media_item_stage_state
                        (media_item_id, stage_id, processing_version, status, skipped_reason)
                    VALUES (${id}::uuid, 'album-enrichment', 2, ${status}, ${reason})
                `;
                await sql`
                    UPDATE media_items
                       SET processing_state = '{"album-enrichment": {"status": "no-match", "version": 2}}'::jsonb
                     WHERE id = ${id}::uuid
                `;
            }

            await sql`
                UPDATE media_item_stage_state SET next_eligible_at = now() + interval '60 days'
                 WHERE media_item_id = ${parked.id}::uuid
            `;

            expect(await reEnrollGapAlbumsForRepoll(sql as never, 'album-enrichment')).toBe(2);

            const due = await findCoverageTableBacklog(sql as never, 'album-enrichment', 10);
            expect(due.map((r) => r.id).sort()).toEqual([gap.id, parked.id].sort());
            // Without this the legacy-no-match disposition re-tombstones the
            // re-opened row before the drain reaches it.
            const markers = await sql<{ id: string; has_marker: boolean }[]>`
                SELECT id, processing_state ? 'album-enrichment' AS has_marker
                FROM media_items
                WHERE id IN (${gap.id}::uuid, ${withPoster.id}::uuid, ${orphan.id}::uuid, ${failed.id}::uuid)
            `;
            const byId = new Map(markers.map((m) => [m.id, m.has_marker]));
            expect(byId.get(gap.id)).toBe(false);
            expect(byId.get(withPoster.id)).toBe(true);
            expect(byId.get(orphan.id)).toBe(true);
            expect(byId.get(failed.id)).toBe(true);
        });
    });
});
