// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `AdminChaptersResponseSchema` gates GET /api/admin/media/{id}/chapters on the
 * CLIENT (getMediaChapters in $lib/api/admin). The SERVER handler `.parse()`s
 * the same body through `MediaChaptersResponseSchema`, so that schema is the
 * wire shape and there is exactly one correct client schema: that same object.
 *
 * It used to be a hand-written second copy, and it had drifted in three places
 * at once — `start_ticks`/`end_ticks` declared `z.string()` (they are bigint
 * columns, which connection.ts parses to a JS NUMBER) and `media_item_id`
 * declared non-nullable (the no-owner branch of getChaptersForFile LEFT JOINs
 * for it). Because apiFetch is fail-open, none of that broke a screen — it just
 * logged schema-drift forever and gave the Files tab a lying type.
 *
 * The row-level guarantee — that the shared schema accepts what the queries
 * ACTUALLY return, numeric ticks included — is asserted against a real database
 * in episode-chapters.queries.integration.test.ts. This file guards the other
 * half: that the client keeps pointing at the shared schema instead of growing
 * a fresh copy to drift again.
 */

import { describe, it, expect } from 'vitest';
import { AdminChaptersResponseSchema } from './api-admin-responses';
import { SegmentsResponseSchema, SegmentsSetResponseSchema } from './api-admin-responses';
import { MediaChaptersResponseSchema } from './api-media-responses';

describe('AdminChaptersResponseSchema', () => {
    it('IS the server-side schema, not a second copy of it', () => {
        expect(AdminChaptersResponseSchema).toBe(MediaChaptersResponseSchema);
    });
});


describe('admin milliseconds', () => {
    it('chapter rows expose millisecond boundaries', () => {
        const result = MediaChaptersResponseSchema.parse({ chapters: [{ id: 1, file_id: 'file', media_item_id: null, chapter_index: 0, chapter_name: 'Intro', startMs: 1250, endMs: null, source: 'probe', fetched_at: new Date() }], episodesWithChapters: 1 });
        expect(result.chapters[0].startMs).toBe(1250);
        expect(result.chapters[0]).not.toHaveProperty('start_ticks');
    });
    it('segment entries and manual responses expose millisecond boundaries', () => {
        const result = SegmentsResponseSchema.parse({ totalSegments: 1, providers: { detector: [{ type: 'Intro', startMs: 1250, endMs: 9500, fetchedAt: 'now' }] } });
        expect(result.providers.detector[0]).not.toHaveProperty('startTime');
        expect(SegmentsSetResponseSchema.parse({ type: 'Intro', startMs: 1250, endMs: 9500, durationMs: 10000, materialized: true, segmentsResolved: 1, message: 'saved' }).durationMs).toBe(10000);
    });
});
