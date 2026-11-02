// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The inspector-panel fields added to AdminPreviewResponseSchema must stay
 * `.optional()`. A bare `.nullable()` field rejects `undefined` at
 * `.parse()` time — exactly the bug class that caused 500s on the chapters
 * endpoint for every item that legitimately doesn't carry that field (no
 * lock, no health issues, no video stream, etc).
 */

import { describe, it, expect, vi } from 'vitest';
import { AdminPreviewResponseSchema } from './preview.js';
import { getMediaPreview } from '$lib/server/database/queries/admin-media.queries.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';

/** The shape `getMediaPreview` returns for an item with none of the new
 * optional data present — e.g. an unlocked, healthy, unprobed item. */
const BASE_RESPONSE = {
    id: 'item-1',
    title: 'Some Movie',
    overview: null,
    year: 2020,
    media_type: 'movie',
    runtime_seconds: null,
    premiere_date: null,
    externalIds: {},
    fileCount: 0,
    totalFileSize: null,
    filePaths: [],
};

describe('AdminPreviewResponseSchema — inspector-panel additions', () => {
    it('parses when every new field is omitted (undefined)', () => {
        // This is the exact call shape a real handler produces for an item
        // with no lock, no health issues, and no probed video/audio stream —
        // the new keys are simply absent from the object, not present as
        // `null`. If any of them were declared as bare `.nullable()` instead
        // of `.optional()`, this `.parse()` would throw.
        expect(() => AdminPreviewResponseSchema.parse(BASE_RESPONSE)).not.toThrow();
    });

    it('accepts every new field populated', () => {
        const populated = {
            ...BASE_RESPONSE,
            metadataLocked: true,
            lockedBy: 'admin',
            lockedAt: '2026-08-01T00:00:00.000Z',
            isLocalOnly: false,
            filesLostAt: '2026-08-02T00:00:00.000Z',
            lastProbedAt: '2026-08-03T00:00:00.000Z',
            lastUpdatedAt: '2026-08-04T00:00:00.000Z',
            healthStatus: 'warning',
            healthIssues: [
                {
                    type: 'truncated_video',
                    detail: 'moov atom missing',
                    filePath: '/data/movies/foo.mkv',
                    expectedDuration: 7200,
                    actualDuration: 5400,
                },
            ],
            videoCodec: 'hevc',
            videoWidth: 3840,
            videoHeight: 2160,
            videoRange: 'HDR10',
            audioCodec: 'eac3',
            audioChannels: 6,
        };
        const result = AdminPreviewResponseSchema.parse(populated);
        expect(result.healthIssues?.[0].type).toBe('truncated_video');
        expect(result.videoWidth).toBe(3840);
    });

    it('rejects a genuinely missing required field', () => {
        // Sanity check that the schema is not accidentally permissive overall
        // (e.g. everything silently optional) — `id` staying required is the
        // control for the two tests above actually exercising optionality.
        const { id: _id, ...withoutId } = BASE_RESPONSE;
        expect(() => AdminPreviewResponseSchema.parse(withoutId)).toThrow();
    });
});

/**
 * Fix-round finding #1: `getMediaPreview` selected several timestamp columns
 * raw and typed them `string | null`, but postgres.js parses
 * date/timestamp/timestamptz to a native `Date` by default (only `bigint` is
 * overridden in connection.ts) — so every one of those fields actually
 * arrived as a `Date`, and `AdminPreviewResponseSchema.parse()` (which
 * `preview.ts` calls on every request) threw `invalid_type` for it. Because
 * `media_items.updated_at` is `NOT NULL DEFAULT now()`, the `lastUpdatedAt`
 * field was populated on every single request, so this was a 500 on every
 * preview fetch — including the already-shipped `MediaPreviewRow` path,
 * which calls this same endpoint.
 *
 * The fix casts each of the four columns to `::text` in SQL. This suite
 * exercises the real seam: it drives the actual `getMediaPreview()` mapping
 * (not a hand-built fixture) through a mock `sql` that derives each
 * timestamp column's JS type from whether THAT call's own SQL text carries
 * the cast — i.e. it simulates postgres.js's real behavior for the query as
 * written, rather than assuming the fix is in place.
 */
describe('getMediaPreview → AdminPreviewResponseSchema (real seam)', () => {
    /**
     * A single `sql` mock playing back canned rows in the exact call order
     * `getMediaPreview` issues them for a non-series item (`isSeries('movie')`
     * is false, so the `seasons` and `coverage` branches resolve without
     * calling `sql` at all): item, extIds,
     * fileInfo, parents, healthIssueRows, videoStream, audioStream — 7 calls.
     *
     * For the four fix-round columns, the row value is a `string` ONLY when
     * that call's own template text contains the column's `::text` cast;
     * otherwise it's a `Date`, mirroring postgres.js's real default parser.
     * This is what makes the test revert-sensitive: removing a cast from the
     * production query changes what this mock hands back, not just what a
     * fixture says it should be.
     */
    function driverShapedSql() {
        let call = 0;
        return vi.fn().mockImplementation((strings: TemplateStringsArray | string) => {
            // postgres.js identifiers are fragments, not query executions.
            if (typeof strings === 'string') return Promise.resolve([]);
            call++;
            const text = strings.join('');
            if (call === 1) {
                return Promise.resolve([
                    {
                        id: 'item-1',
                        title: 'Some Movie',
                        overview: null,
                        year: 2020,
                        media_type: 'movie',
                        runtime_seconds: null,
                        // `date` (oid 1082) is parsed to a Date by the same default
                        // handler as the timestamps. This one predates the inspector
                        // work and is live on stable for ~88k episodes / 4.4k seasons.
                        premiere_date: text.includes('premiere_date::text')
                            ? '2019-05-19'
                            : new Date('2019-05-19T00:00:00.000Z'),
                        custom_metadata: null,
                        metadata_locked: true,
                        metadata_locked_by: 'admin',
                        metadata_locked_at: text.includes('metadata_locked_at::text')
                            ? '2026-08-01T00:00:00.000Z'
                            : new Date('2026-08-01T00:00:00.000Z'),
                        is_local_only: false,
                        files_lost_at: text.includes('files_lost_at::text')
                            ? '2026-08-02T00:00:00.000Z'
                            : new Date('2026-08-02T00:00:00.000Z'),
                        updated_at: text.includes('updated_at::text')
                            ? '2026-08-03T00:00:00.000Z'
                            : new Date('2026-08-03T00:00:00.000Z'),
                    },
                ]);
            }
            if (call === 2) {
                return Promise.resolve([
                    { tmdb_id: null, imdb_id: null, jellyfin_id: null, tvdb_id: null },
                ]);
            }
            if (call === 3) {
                return Promise.resolve([
                    {
                        file_count: 1,
                        total_file_size: '1000',
                        file_paths: ['/data/movies/foo.mkv'],
                        last_probed_at: text.includes('probed_at)::text')
                            ? '2026-08-04T00:00:00.000Z'
                            : new Date('2026-08-04T00:00:00.000Z'),
                    },
                ]);
            }
            if (call === 4) {
                return Promise.resolve([{ parent_title: null, grandparent_title: null }]);
            }
            // healthIssueRows, videoStream, audioStream — empty for this item.
            return Promise.resolve([]);
        });
    }

    it('parses cleanly when getMediaPreview runs against the current (cast) SQL', async () => {
        const mockSql = driverShapedSql();

        const preview = await getMediaPreview(mockSql as never, 'item-1');
        expect(preview).toBeDefined();

        expect(() =>
            AdminPreviewResponseSchema.parse({
                ...preview,
                media_type: toPublicMediaType(preview!.media_type) ?? preview!.media_type,
            }),
        ).not.toThrow();
    });

    it('documents the failure mode a missing cast reproduces', () => {
        // Directly demonstrates why the cast matters, independent of the SQL
        // text detection above: a `Date` reaching `.parse()` for any of the
        // four fields throws, because the schema declares them `z.string()`.
        const dateValued = {
            id: 'item-1',
            title: 'Some Movie',
            overview: null,
            year: 2020,
            media_type: 'movie',
            runtime_seconds: null,
            premiere_date: null,
            externalIds: {},
            fileCount: 0,
            totalFileSize: null,
            filePaths: [],
            metadataLocked: true,
            lastUpdatedAt: new Date('2026-08-03T00:00:00.000Z') as unknown as string,
        };
        expect(() => AdminPreviewResponseSchema.parse(dateValued)).toThrow();
    });
});
