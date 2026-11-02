// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The SQL half of the scan-outcome honesty fix, against a real Postgres.
 *
 * The unit tests next door pin how `processArtwork` / `processExternalSubtitle`
 * TRANSLATE an upsert outcome into a scan outcome. They cannot pin the outcome
 * itself: both come out of a statement whose behaviour lives in the database —
 * `xmax = 0`, a row-wise `IS DISTINCT FROM` guard on `ON CONFLICT DO UPDATE`,
 * and a pre-read of the conflicting row. Mocking that away and asserting the
 * mapping would leave code and test sharing one belief with nothing checking it.
 *
 * The claim under test, in one sentence: replaying the SAME registration a
 * second time must report 'unchanged', and must not touch the row.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { upsertMediaFile } from '../../../../../../database/queries/media-files.queries.js';
import {
    upsertLocalArtwork,
    upsertLocalArtworkWithOutcome,
} from '../../../../../../database/queries/media-artwork.queries.js';
import { upsertExternalSubtitle } from '../../../../../../database/queries/external-subtitles.queries.js';

const LIB = '/library/idempotence';

describe('scan upserts report what they actually did', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_artwork',
            'external_subtitle_files',
        ]);
    });

    async function customPosterUrl(mediaItemId: string): Promise<string | null> {
        const [row] = await sql<[{ custom_poster_url: string | null }]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${mediaItemId}::uuid
        `;
        return row.custom_poster_url;
    }

    async function newMovie(title: string): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES (${title}, 'movie', 'active', true)
            RETURNING id
        `;
        return row.id;
    }

    describe('upsertLocalArtworkWithOutcome', () => {
        it('inserts once, then reports the identical re-registration as unchanged', async () => {
            const movieId = await newMovie('Idempotent Movie');
            const filePath = `${LIB}/Idempotent Movie/poster.jpg`;

            const first = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });
            const second = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });
            const third = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });

            expect(first).toBe('inserted');
            // The scan-cycle steady state. Reporting 'inserted' here is the
            // production bug: /data/movies claimed +8866 added every hour.
            expect(second).toBe('unchanged');
            expect(third).toBe('unchanged');
        });

        /**
         * The amplification finding itself, asserted mechanically rather than
         * inferred from the outcome string.
         *
         * `media_artwork` has no `updated_at` to watch, so this watches `ctid`:
         * Postgres writes a NEW tuple version at a new ctid for every heap
         * update, HOT or not. A stable ctid across the call is proof that no row
         * version was written — which is the whole claim. The second half proves
         * the assertion has teeth by showing a real update DOES move it.
         */
        it('does not rewrite the row on an unchanged re-registration', async () => {
            const movieId = await newMovie('Untouched Movie');
            const filePath = `${LIB}/Untouched Movie/poster.jpg`;
            const ctid = async (): Promise<string> => {
                const [row] = await sql<[{ ctid: string }]>`
                    SELECT ctid::text FROM media_artwork
                    WHERE media_item_id = ${movieId}::uuid AND artwork_type = 'poster'
                `;
                return row.ctid;
            };

            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });
            const afterInsert = await ctid();

            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });
            expect(await ctid()).toBe(afterInsert);

            // Teeth: a genuine re-point must still move the tuple.
            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath: `${LIB}/Untouched Movie/movie-poster.jpg`,
            });
            expect(await ctid()).not.toBe(afterInsert);
        });

        it('retains a new file as an alternative and counts only its first registration', async () => {
            const movieId = await newMovie('Repointed Movie');
            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath: `${LIB}/Repointed Movie/poster.jpg`,
            });

            const outcome = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath: `${LIB}/Repointed Movie/movie-poster.jpg`,
            });

            expect(outcome).toBe('inserted');
            const candidates = await sql<{ file_path: string; selected: boolean }[]>`
                SELECT file_path, selected FROM image_candidates WHERE media_item_id = ${movieId}`;
            expect(candidates).toHaveLength(2);
            expect(candidates.find((row) => row.selected)?.file_path).toBe(
                `${LIB}/Repointed Movie/movie-poster.jpg`,
            );
            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    mediaItemId: movieId,
                    artworkType: 'poster',
                    filePath: `${LIB}/Repointed Movie/movie-poster.jpg`,
                }),
            ).toBe('unchanged');
        });

        /**
         * The second disjunct of the DO UPDATE guard, on its own.
         *
         * Same file, but provenance arriving where there was none: the write
         * MUST still happen. `isManagedArtworkFile` reads that tag to decide
         * whether admin "Remove" may unlink the file from the user's media
         * folder, so a guard that declined here would leave a materialized
         * image permanently indistinguishable from the user's own sidecar.
         */
        it('writes when only the provenance tag differs on the same file', async () => {
            const movieId = await newMovie('Tagged Movie');
            const filePath = `${LIB}/Tagged Movie/poster.jpg`;
            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });

            const outcome = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
                sourceTag: 'provider:tmdb',
            });

            expect(outcome).toBe('updated');
            const [row] = await sql<[{ remote_url: string | null }]>`
                SELECT remote_url FROM media_artwork
                WHERE media_item_id = ${movieId}::uuid AND artwork_type = 'poster'
            `;
            expect(row.remote_url).toBe('provider:tmdb');

            // ...and re-supplying the SAME tag is back to a no-op.
            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    mediaItemId: movieId,
                    artworkType: 'poster',
                    filePath,
                    sourceTag: 'provider:tmdb',
                }),
            ).toBe('unchanged');
        });

        /**
         * The first branch of the CASE, which the guard must not strand: a
         * tagless scanner re-registration of the SAME file keeps the stored
         * provenance rather than NULLing it.
         */
        it('preserves provenance through a tagless re-registration', async () => {
            const movieId = await newMovie('Provenance Movie');
            const filePath = `${LIB}/Provenance Movie/poster.jpg`;
            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
                sourceTag: 'provider:tmdb',
            });

            // This is the scanner's once-per-scan call: no tag.
            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    mediaItemId: movieId,
                    artworkType: 'poster',
                    filePath,
                }),
            ).toBe('unchanged');

            const [row] = await sql<[{ remote_url: string | null }]>`
                SELECT remote_url FROM media_artwork
                WHERE media_item_id = ${movieId}::uuid AND artwork_type = 'poster'
            `;
            expect(row.remote_url).toBe('provider:tmdb');
        });

        it('keeps the tombstone verdict distinguishable from unchanged', async () => {
            const movieId = await newMovie('Tombstoned Movie');
            const filePath = `${LIB}/Tombstoned Movie/poster.jpg`;
            await sql`
                INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
                VALUES (${movieId}::uuid, 'poster', ${filePath})
            `;

            const outcome = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });

            // 'suppressed', never 'unchanged': no row exists, and the boolean
            // wrapper's ten callers still need this to read as a refused write.
            expect(outcome).toBe('suppressed');
        });

        /**
         * The one that must not break.
         *
         * A tombstone must win over "the row already looks right". The obvious
         * way to stop the write amplification is an early return the moment the
         * prior row matches what we are about to write — and that branch never
         * reaches the suppression guard, so it answers 'unchanged' (boolean
         * wrapper: TRUE) for artwork an admin deliberately removed. Silent, and
         * on every scan cycle.
         *
         * This state is CONSTRUCTED, not observed: `deleteMediaImage` drops the
         * media_artwork row in the same transaction that writes the tombstone,
         * so the shipped Remove path does not leave a row behind. That is
         * deliberately not what this test rests on. The guard here is the sole
         * enforcement point for a durable Remove, and it must not be correct
         * only for as long as a DIFFERENT module keeps an invariant it cannot
         * see. Note also that the tombstone is keyed on `normalize(file_path)`
         * while the row stores the RAW path, so raw-equality and tombstone-match
         * are not even the same question.
         */
        it('refuses a tombstoned sidecar even when an identical row still exists', async () => {
            const movieId = await newMovie('Resurrection Movie');
            const filePath = `${LIB}/Resurrection Movie/poster.jpg`;

            expect(
                await upsertLocalArtworkWithOutcome(sql, {
                    mediaItemId: movieId,
                    artworkType: 'poster',
                    filePath,
                }),
            ).toBe('inserted');

            // Tombstone the exact file, leaving the row in place, and clear the
            // paired column the way deleteMediaImage would.
            await sql`
                INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
                VALUES (${movieId}::uuid, 'poster', ${filePath})
            `;
            await sql`
                UPDATE media_items SET custom_poster_url = NULL WHERE id = ${movieId}::uuid
            `;

            const outcome = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });

            expect(outcome).toBe('suppressed');
            // The ten call sites read the boolean. 'unchanged' would make this
            // true and re-publish the removed image.
            expect(
                await upsertLocalArtwork(sql, {
                    mediaItemId: movieId,
                    artworkType: 'poster',
                    filePath,
                }),
            ).toBe(false);
            // A refused write must not claim the serve URL either.
            expect(await customPosterUrl(movieId)).toBeNull();
        });

        /**
         * The self-heal that is easiest to lose to a short circuit: the paired
         * `custom_*_url` claim runs past the no-op write, not instead of it.
         * It is a `WHERE ... IS NULL` update, so it costs nothing in the steady
         * state and re-publishes the serve URL if anything ever cleared it.
         */
        it('still claims custom_poster_url on an unchanged re-registration', async () => {
            const movieId = await newMovie('Reclaimed Movie');
            const filePath = `${LIB}/Reclaimed Movie/poster.jpg`;
            await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });
            expect(await customPosterUrl(movieId)).not.toBeNull();

            // Drift: something else cleared the column while the row stands.
            await sql`
                UPDATE media_items SET custom_poster_url = NULL WHERE id = ${movieId}::uuid
            `;

            const outcome = await upsertLocalArtworkWithOutcome(sql, {
                mediaItemId: movieId,
                artworkType: 'poster',
                filePath,
            });

            expect(outcome).toBe('unchanged');
            expect(await customPosterUrl(movieId)).toBe(`/api/image/custom/${movieId}/poster`);
        });
    });

    describe('upsertExternalSubtitle', () => {
        async function newFile(path: string): Promise<string> {
            const { id } = await upsertMediaFile(sql, { filePath: path });
            return id;
        }

        const params = (fileId: string, subtitlePath: string) => ({
            fileId,
            subtitlePath,
            language: 'en',
            format: 'srt' as const,
            isForced: false,
            isSDH: false,
        });

        it('inserts once, then reports the identical re-registration as unchanged', async () => {
            const fileId = await newFile(`${LIB}/Show/S01E01.mkv`);
            const subtitlePath = `${LIB}/Show/S01E01.en.srt`;

            expect(await upsertExternalSubtitle(sql, params(fileId, subtitlePath))).toBe(
                'inserted',
            );
            expect(await upsertExternalSubtitle(sql, params(fileId, subtitlePath))).toBe(
                'unchanged',
            );
        });

        it('does not rewrite the row on an unchanged re-registration', async () => {
            const fileId = await newFile(`${LIB}/Show/S01E02.mkv`);
            const subtitlePath = `${LIB}/Show/S01E02.en.srt`;
            await upsertExternalSubtitle(sql, params(fileId, subtitlePath));

            const [before] = await sql<[{ updated_at: Date }]>`
                SELECT updated_at FROM external_subtitle_files
                WHERE subtitle_path = ${subtitlePath}
            `;
            await upsertExternalSubtitle(sql, params(fileId, subtitlePath));
            const [after] = await sql<[{ updated_at: Date }]>`
                SELECT updated_at FROM external_subtitle_files
                WHERE subtitle_path = ${subtitlePath}
            `;

            // The whole write-amplification finding in one assertion: on
            // production 8,571 of 8,595 rows carried an updated_at from the last
            // scan hour while the newest genuine insert was three weeks old.
            expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
        });

        it('reports a genuinely changed sidecar as updated and rewrites it', async () => {
            const fileId = await newFile(`${LIB}/Show/S01E03.mkv`);
            const subtitlePath = `${LIB}/Show/S01E03.en.srt`;
            await upsertExternalSubtitle(sql, params(fileId, subtitlePath));

            const outcome = await upsertExternalSubtitle(sql, {
                ...params(fileId, subtitlePath),
                isForced: true,
            });

            expect(outcome).toBe('updated');
            const [row] = await sql<[{ is_forced: boolean }]>`
                SELECT is_forced FROM external_subtitle_files
                WHERE subtitle_path = ${subtitlePath}
            `;
            expect(row.is_forced).toBe(true);
        });

        it('treats a NULL language on both sides as unchanged, not as a difference', async () => {
            // Row-wise IS DISTINCT FROM, not `<>`: a plain inequality goes
            // UNKNOWN on NULL = NULL, which would suppress the update for a row
            // that DID change and report every und-language sidecar as changed.
            const fileId = await newFile(`${LIB}/Show/S01E04.mkv`);
            const subtitlePath = `${LIB}/Show/S01E04.srt`;
            const undated = { ...params(fileId, subtitlePath), language: null };

            expect(await upsertExternalSubtitle(sql, undated)).toBe('inserted');
            expect(await upsertExternalSubtitle(sql, undated)).toBe('unchanged');
            expect(await upsertExternalSubtitle(sql, { ...undated, language: 'de' })).toBe(
                'updated',
            );
        });
    });
});
