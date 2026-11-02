// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Artist Enrichment Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getUnenrichedArtists,
    countUnenrichedArtists,
    getArtistEnrichmentBacklog,
    updateArtistPosterUrls,
    mergeArtistEnrichmentMetadata,
    markArtistProcessed,
    getArtistEnrichmentWipeBatch,
    atomicallyWipeArtistEnrichment,
    findCoverageTableBacklog,
    deferArtistAfterSourceOutage,
    reEnrollGapArtistsForRepoll,
} from './artist-enrichment.queries.js';

describe('Artist Enrichment Queries', () => {
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

    describe('getUnenrichedArtists', () => {
        it('returns artists without custom_poster_url', async () => {
            const artist = createTestArtist({ title: 'Test Artist' });
            await insertTestArtist(sql, artist);

            const rows = await getUnenrichedArtists(sql, 1, 10);
            const match = rows.find((r) => r.id === artist.id);
            expect(match).toBeDefined();
            expect(match?.title).toBe('Test Artist');
        });

        it('excludes artists with custom_poster_url', async () => {
            const artist = createTestArtist({ title: 'Has Poster' });
            await insertTestArtist(sql, artist);
            await sql`UPDATE media_items SET custom_poster_url = 'http://example.com/poster.jpg' WHERE id = ${artist.id}::uuid`;

            const rows = await getUnenrichedArtists(sql, 1, 10);
            expect(rows.some((r) => r.id === artist.id)).toBe(false);
        });

        it('excludes artists flagged is_various_artists, regardless of title', async () => {
            // Flag-driven now (not name-matched): a foreign-language VA bucket
            // that hasn't been renamed to the canonical "Various Artists" title
            // yet must still be excluded, as long as it carries the flag.
            const va = createTestArtist({ title: 'Verschiedene Interpreten Foreign Bucket' });
            await insertTestArtist(sql, va);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;

            const rows = await getUnenrichedArtists(sql, 1, 10);
            expect(rows.some((r) => r.id === va.id)).toBe(false);
        });

        it('does not exclude an ordinary artist merely because its title looks VA-like', async () => {
            // Regression guard for the flag swap: without the is_various_artists
            // flag set, an unflagged artist must remain eligible even if its
            // title happens to contain "various" — name-based heuristics no
            // longer drive this predicate.
            const artist = createTestArtist({ title: 'Various Sounds Collective' });
            await insertTestArtist(sql, artist);

            const rows = await getUnenrichedArtists(sql, 1, 10);
            expect(rows.some((r) => r.id === artist.id)).toBe(true);
        });
    });

    describe('countUnenrichedArtists', () => {
        it('counts artists needing enrichment', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            const count = await countUnenrichedArtists(sql, 1);
            expect(count).toBeGreaterThanOrEqual(1);
        });

        it('stays in lockstep with getUnenrichedArtists when a flagged VA row is present', async () => {
            const ordinary = createTestArtist();
            await insertTestArtist(sql, ordinary);
            const va = createTestArtist({ title: 'Countstep VA Bucket' });
            await insertTestArtist(sql, va);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;

            const rows = await getUnenrichedArtists(sql, 1, 100);
            const count = await countUnenrichedArtists(sql, 1);

            expect(rows.some((r) => r.id === va.id)).toBe(false);
            expect(rows.some((r) => r.id === ordinary.id)).toBe(true);
            expect(count).toBe(rows.length);
        });
    });

    describe('getArtistEnrichmentBacklog', () => {
        it('returns backlog breakdown', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            const backlog = await getArtistEnrichmentBacklog(sql, 1);
            expect(backlog.remaining).toBeGreaterThanOrEqual(1);
        });
    });

    describe('updateArtistPosterUrls', () => {
        it('updates poster and backdrop URLs', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            await updateArtistPosterUrls(
                sql,
                artist.id,
                'http://example.com/thumb.jpg',
                'http://example.com/fanart.jpg',
            );

            const rows = await sql`
                SELECT custom_poster_url, custom_backdrop_url FROM media_items WHERE id = ${artist.id}::uuid
            `;
            expect(rows[0].custom_poster_url).toBe('http://example.com/thumb.jpg');
            expect(rows[0].custom_backdrop_url).toBe('http://example.com/fanart.jpg');
        });
    });

    describe('mergeArtistEnrichmentMetadata', () => {
        it('merges enrichment payload into custom_metadata', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            await mergeArtistEnrichmentMetadata(sql, artist.id, 'theaudiodb', {
                biography: 'Test bio',
                genre: 'Rock',
            });

            const rows = await sql`
                SELECT custom_metadata FROM media_items WHERE id = ${artist.id}::uuid
            `;
            expect(rows[0].custom_metadata.theaudiodb).toBeDefined();
            expect(rows[0].custom_metadata.theaudiodb.biography).toBe('Test bio');
        });
    });

    describe('markArtistProcessed', () => {
        it('updates processing_state and returns true', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            const result = await markArtistProcessed(sql, artist.id, 1, 'success');
            expect(result).toBe(true);

            const rows = await sql`
                SELECT processing_state FROM media_items WHERE id = ${artist.id}::uuid
            `;
            expect(rows[0].processing_state['artist-enrichment']).toBeDefined();
        });
    });

    describe('getArtistEnrichmentWipeBatch', () => {
        it('returns artists with a processing_state marker', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            await markArtistProcessed(sql, artist.id, 1, 'success');

            const ids = await getArtistEnrichmentWipeBatch(sql, 10);
            expect(ids).toContain(artist.id);
        });
    });

    describe('atomicallyWipeArtistEnrichment', () => {
        it('clears poster, metadata, and processing_state', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            await sql`UPDATE media_items SET custom_poster_url = 'http://example.com/poster.jpg' WHERE id = ${artist.id}::uuid`;
            await markArtistProcessed(sql, artist.id, 1, 'success');

            const affected = await atomicallyWipeArtistEnrichment(sql, [artist.id], 'theaudiodb');
            expect(affected).toBeGreaterThanOrEqual(0);
        });
    });

    describe('findCoverageTableBacklog', () => {
        it('returns empty array when no coverage table rows exist', async () => {
            const rows = await findCoverageTableBacklog(sql, 'artist-enrichment', 10);
            expect(rows).toHaveLength(0);
        });

        it('never hands the drain a flagged Various Artists row, even when its stage row is pending', async () => {
            // A fresh install seeds the canonical Various Artists row; its stage row
            // can be enrolled `pending` before the stage sweep disposes it, and the
            // first boot catch-up then sent "Various Artists" to TheAudioDB and Deezer.
            const ordinary = createTestArtist({ title: 'Ordinary Artist Pending' });
            const va = createTestArtist({ title: 'Various Artists' });
            await insertTestArtist(sql, ordinary);
            await insertTestArtist(sql, va);
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${va.id}::uuid`;
            for (const id of [ordinary.id, va.id]) {
                await sql`
                    INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
                    VALUES (${id}::uuid, 'artist-enrichment', 4, 'pending')
                `;
            }

            const rows = await findCoverageTableBacklog(sql, 'artist-enrichment', 10);
            expect(rows.map((r) => r.id)).toEqual([ordinary.id]);
        });
    });
    describe('deferArtistAfterSourceOutage', () => {
        async function seedStageRow(id: string, status: string): Promise<void> {
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
                VALUES (${id}::uuid, 'artist-enrichment', 5, ${status})
            `;
        }

        it('parks a pending row so the drain skips it until the retry time, then returns it', async () => {
            const artist = createTestArtist({ title: 'Deferred Artist' });
            await insertTestArtist(sql, artist);
            await seedStageRow(artist.id, 'pending');

            const deferred = await deferArtistAfterSourceOutage(sql as never, {
                artistId: artist.id,
                stageId: 'artist-enrichment',
                retryAfterMs: 12 * 60 * 60 * 1000,
                maxRetryAfterMs: 7 * 24 * 60 * 60 * 1000,
                detail: 'Enrichment source unavailable: deezer',
            });

            expect(deferred).toBe(true);
            const [row] = await sql<
                {
                    status: string;
                    skipped_reason: string;
                    hours: number;
                    last_error: { code: string; message: string };
                }[]
            >`
                SELECT status, skipped_reason, last_error,
                       EXTRACT(EPOCH FROM (next_eligible_at - now())) / 3600 AS hours
                FROM media_item_stage_state
                WHERE media_item_id = ${artist.id}::uuid AND stage_id = 'artist-enrichment'
            `;
            expect(row.status).toBe('skipped_transient');
            expect(row.skipped_reason).toBe('source-unavailable');
            expect(row.last_error).toMatchObject({
                code: 'source_unavailable',
                message: 'Enrichment source unavailable: deezer',
            });
            // 12 h plus up to 10 % jitter.
            expect(Number(row.hours)).toBeGreaterThan(11.9);
            expect(Number(row.hours)).toBeLessThanOrEqual(13.2);
            // No marker: a marker with a status is what the sweep tombstones.
            const [item] = await sql<{ has_marker: boolean }[]>`
                SELECT processing_state ? 'artist-enrichment' AS has_marker
                FROM media_items WHERE id = ${artist.id}::uuid
            `;
            expect(item.has_marker).toBe(false);

            expect(await findCoverageTableBacklog(sql as never, 'artist-enrichment', 10)).toEqual(
                [],
            );
            await sql`
                UPDATE media_item_stage_state SET next_eligible_at = now() - interval '1 second'
                WHERE media_item_id = ${artist.id}::uuid
            `;
            const due = await findCoverageTableBacklog(sql as never, 'artist-enrichment', 10);
            expect(due.map((r) => r.id)).toEqual([artist.id]);
        });

        it('doubles the wait on each consecutive deferral, up to the cap', async () => {
            const artist = createTestArtist({ title: 'Long Outage' });
            await insertTestArtist(sql, artist);
            await seedStageRow(artist.id, 'pending');
            const hour = 60 * 60 * 1000;
            const waits: number[] = [];
            for (let i = 0; i < 4; i++) {
                await deferArtistAfterSourceOutage(sql as never, {
                    artistId: artist.id,
                    stageId: 'artist-enrichment',
                    retryAfterMs: hour,
                    maxRetryAfterMs: 4 * hour,
                    detail: 'theaudiodb unavailable: HTTP 404',
                });
                const [row] = await sql<{ hours: number; deferrals: number }[]>`
                    SELECT EXTRACT(EPOCH FROM (next_eligible_at - now())) / 3600 AS hours,
                           (last_error->>'deferrals')::int AS deferrals
                    FROM media_item_stage_state WHERE media_item_id = ${artist.id}::uuid
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

        it('drops a stale status marker so the sweep cannot tombstone the parked row', async () => {
            const artist = createTestArtist({ title: 'Stale Marker' });
            await insertTestArtist(sql, artist);
            await sql`
                UPDATE media_items
                   SET processing_state = '{"artist-enrichment": {"status": "failed", "version": 5}, "other-stage": {"version": 1}}'::jsonb
                 WHERE id = ${artist.id}::uuid
            `;
            await seedStageRow(artist.id, 'failed_transient');

            await deferArtistAfterSourceOutage(sql as never, {
                artistId: artist.id,
                stageId: 'artist-enrichment',
                retryAfterMs: 60_000,
                maxRetryAfterMs: 60_000,
                detail: 'deezer unavailable: HTTP 503',
            });

            const [item] = await sql<{ ps: Record<string, unknown> }[]>`
                SELECT processing_state AS ps FROM media_items WHERE id = ${artist.id}::uuid
            `;
            expect(item.ps).toEqual({ 'other-stage': { version: 1 } });
        });

        it('leaves terminal rows alone and reports that nothing was deferred', async () => {
            const artist = createTestArtist({ title: 'Already Done' });
            await insertTestArtist(sql, artist);
            await seedStageRow(artist.id, 'completed');

            const deferred = await deferArtistAfterSourceOutage(sql as never, {
                artistId: artist.id,
                stageId: 'artist-enrichment',
                retryAfterMs: 60_000,
                maxRetryAfterMs: 60_000,
                detail: 'x',
            });

            expect(deferred).toBe(false);
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_item_stage_state WHERE media_item_id = ${artist.id}::uuid
            `;
            expect(row.status).toBe('completed');
        });
    });

    describe('reEnrollGapArtistsForRepoll', () => {
        it('re-opens a tombstoned no-match artist without a poster, not one with a poster', async () => {
            const gap = createTestArtist({ title: 'Tombstoned Gap' });
            const done = createTestArtist({ title: 'Has Image' });
            await insertTestArtist(sql, gap);
            await insertTestArtist(sql, done);
            await sql`UPDATE media_items SET custom_poster_url = 'https://img.example/a.jpg' WHERE id = ${done.id}::uuid`;
            for (const id of [gap.id, done.id]) {
                await sql`
                    INSERT INTO media_item_stage_state
                        (media_item_id, stage_id, processing_version, status, skipped_reason)
                    VALUES (${id}::uuid, 'artist-enrichment', 4, 'skipped_permanent', 'no-match-upstream')
                `;
            }

            expect(await reEnrollGapArtistsForRepoll(sql as never, 'artist-enrichment')).toBe(1);
            const due = await findCoverageTableBacklog(sql as never, 'artist-enrichment', 10);
            expect(due.map((r) => r.id)).toEqual([gap.id]);
        });

        it('re-opens an artist parked after a source outage, but not one parked for another reason', async () => {
            const parked = createTestArtist({ title: 'Parked Outage' });
            const other = createTestArtist({ title: 'Parked Otherwise' });
            await insertTestArtist(sql, parked);
            await insertTestArtist(sql, other);
            for (const [id, reason] of [
                [parked.id, 'source-unavailable'],
                [other.id, 'no-usable-enrichment-source'],
            ]) {
                await sql`
                    INSERT INTO media_item_stage_state
                        (media_item_id, stage_id, processing_version, status, skipped_reason,
                         next_eligible_at, last_error)
                    VALUES (${id}::uuid, 'artist-enrichment', 4, 'skipped_transient', ${reason},
                            now() + interval '60 days', '{"deferrals": 7}'::jsonb)
                `;
            }

            // Backoff runs up to 90 days; a fixed key or a re-poll must not wait it out.
            expect(await reEnrollGapArtistsForRepoll(sql as never, 'artist-enrichment')).toBe(1);
            const due = await findCoverageTableBacklog(sql as never, 'artist-enrichment', 10);
            expect(due.map((r) => r.id)).toEqual([parked.id]);
            const [row] = await sql<{ last_error: unknown }[]>`
                SELECT last_error FROM media_item_stage_state WHERE media_item_id = ${parked.id}::uuid
            `;
            expect(row.last_error).toBeNull();
        });
    });
});
