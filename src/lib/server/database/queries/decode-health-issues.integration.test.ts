// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the decode-time file-health path added 2026-08-20.
 *
 * The unit tests around trickplay generation mock these functions, so the SQL
 * itself — the advisory-lock transaction, the jsonb merge that must preserve
 * unrelated issue types, and the `health_issue_details` lateral that carries
 * the verbatim reason to the admin UI — was never executed against a real
 * Postgres. That is exactly the gap that lets a green suite ship a feature
 * that writes nothing, so it gets its own file here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    recordDecodeHealthIssue,
    clearDecodeHealthIssues,
    type FileHealthIssue,
} from './media-files.queries.js';
import { listAdminMediaItems } from './admin-media.queries.js';
import { ALL_BROWSABLE_TYPES } from '../../../../routes/admin/library/media/media-filters.js';

/** The exact demuxer complaint a broken MKV produces on prod. */
const EBML_REASON =
    '0x00 at pos 8193 (0x2001) invalid as first byte of an EBML number (Valerian … Bluray-1080p.mkv)';

describe('decode-time file health issues', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertFile(filePath: string, healthIssues?: FileHealthIssue[]): Promise<string> {
        // Two statements rather than a ternary inside the template: a
        // conditional interpolation widens to a union postgres.js cannot type
        // as a single parameter.
        if (!healthIssues) {
            const [bare] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES (${filePath}) RETURNING id
            `;
            return bare!.id;
        }
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, health_issues)
            VALUES (${filePath}, ${sql.json(healthIssues as unknown as postgres.JSONValue)})
            RETURNING id
        `;
        return row!.id;
    }

    async function readIssues(fileId: string): Promise<FileHealthIssue[]> {
        const [row] = await sql<{ health_issues: FileHealthIssue[] | null }[]>`
            SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid
        `;
        return row?.health_issues ?? [];
    }

    it('writes the issue with its verbatim reason', async () => {
        const fileId = await insertFile('/movies/valerian.mkv');

        await recordDecodeHealthIssue(sql, {
            fileId,
            type: 'container_unreadable',
            detail: EBML_REASON,
        });

        const issues = await readIssues(fileId);
        expect(issues).toHaveLength(1);
        expect(issues[0]!.type).toBe('container_unreadable');
        // The reason, and the byte offset within it, must survive the round
        // trip — "where" is half of what makes this actionable.
        expect(issues[0]!.detail).toBe(EBML_REASON);
        expect(issues[0]!.detail).toContain('pos 8193');
        expect(issues[0]!.attempt_count).toBe(1);
        expect(issues[0]!.detected_at).toBeTruthy();
    });

    it('carries the durations behind video_ends_early', async () => {
        const fileId = await insertFile('/anime/sugar-apple-s01e21.mkv');

        await recordDecodeHealthIssue(sql, {
            fileId,
            type: 'video_ends_early',
            detail: 'Video decodes to ~1360s but the container reports 13600s',
            expectedDuration: 13_600,
            actualDuration: 1360,
        });

        const [issue] = await readIssues(fileId);
        expect(issue!.expected_duration).toBe(13_600);
        expect(issue!.actual_duration).toBe(1360);
    });

    it('preserves unrelated scanner-written issues and bumps attempt_count on repeat', async () => {
        // A trickplay finding must not wipe a media-probe finding on the same
        // file, and vice versa — they have independent producers.
        const fileId = await insertFile('/movies/mixed.mkv', [
            { type: 'truncated_video', detected_at: '2026-01-01T00:00:00.000Z' },
        ]);

        await recordDecodeHealthIssue(sql, {
            fileId,
            type: 'container_unreadable',
            detail: 'first attempt',
        });
        await recordDecodeHealthIssue(sql, {
            fileId,
            type: 'container_unreadable',
            detail: 'second attempt',
        });

        const issues = await readIssues(fileId);
        const types = issues.map((i) => i.type).sort();
        expect(types).toEqual(['container_unreadable', 'truncated_video']);

        const decode = issues.find((i) => i.type === 'container_unreadable')!;
        expect(decode.attempt_count).toBe(2);
        // Re-recording replaces rather than appends — one row per type.
        expect(decode.detail).toBe('second attempt');
        expect(issues.filter((i) => i.type === 'container_unreadable')).toHaveLength(1);
    });

    it('clears only the named decode types, leaving scanner issues alone', async () => {
        const fileId = await insertFile('/movies/recovered.mkv', [
            { type: 'truncated_video', detected_at: '2026-01-01T00:00:00.000Z' },
            { type: 'container_unreadable', detected_at: '2026-01-01T00:00:00.000Z' },
            { type: 'video_ends_early', detected_at: '2026-01-01T00:00:00.000Z' },
        ]);

        await clearDecodeHealthIssues(sql, fileId, [
            'container_unreadable',
            'video_ends_early',
            'video_decode_gaps',
        ]);

        const issues = await readIssues(fileId);
        expect(issues.map((i) => i.type)).toEqual(['truncated_video']);
    });

    it('nulls the column out when clearing removes the last issue', async () => {
        // An empty array would keep the row matching the "has file issues"
        // filter's `jsonb_array_length > 0` guard only by luck; NULL is the
        // shape the orphan cleanup expects.
        const fileId = await insertFile('/movies/clean-again.mkv', [
            { type: 'container_unreadable', detected_at: '2026-01-01T00:00:00.000Z' },
        ]);

        await clearDecodeHealthIssues(sql, fileId, ['container_unreadable']);

        const [row] = await sql<{ health_issues: unknown }[]>`
            SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid
        `;
        expect(row?.health_issues).toBeNull();
    });

    it('does not create a row for a file that no longer exists', async () => {
        // Keyed by id rather than file_path precisely so a mid-run unlink
        // cannot fork the file's identity with a stub row.
        await recordDecodeHealthIssue(sql, {
            fileId: '00000000-0000-4000-8000-000000000000',
            type: 'container_unreadable',
            detail: 'gone',
        });

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM media_files
        `;
        expect(count).toBe('0');
    });

    /*
     * An `extra` — a trailer or featurette — is a real file that carries real
     * health issues, and it was unreachable in the admin browser under EVERY
     * filter: `ALL_BROWSABLE_TYPES` omitted the type, so `?type=all` (the widest
     * scope the browser offers) resolved to a set that could not contain it.
     * Observed on preprod as an attention badge reading 2 over a list of 0.
     *
     * Asserted directionally — "the list contains it" — deliberately NOT as
     * `countFilesWithHealthIssues === countAdminMediaItems(...)`. That equality
     * is FALSE in production for reasons unrelated to extras: an item-less file
     * is counted but unlistable, and a multi-episode file is one file across N
     * item rows. A seeded test would pass while encoding a claim that does not
     * hold, which is worse than no test.
     */
    it('lists an extra with a broken file, which no type filter could reach', async () => {
        const movie = createTestMediaItem({ media_type: 'movie', title: 'Cinderella' });
        await insertTestMediaItem(sql, movie);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

        const extra = createTestMediaItem({ media_type: 'extra', title: 'Cinderella trailer' });
        await insertTestMediaItem(sql, extra);
        await sql`
            UPDATE media_items SET has_files = true, parent_id = ${movie.id}::uuid
             WHERE id = ${extra.id}::uuid
        `;

        // Written directly rather than through `recordDecodeHealthIssue`:
        // `truncated_video` comes from the PROBE path, not the decode path, and
        // is deliberately outside `DecodeHealthIssueType`. This is the pair the
        // preprod badge was counting.
        const fileId = await insertFile('/movies/Cinderella (2015)/Cinderella-trailer.mkv', [
            {
                type: 'truncated_video',
                detected_at: '2026-08-26T10:00:00.000Z',
                detail: 'stops at 12s of a declared 41s',
                expected_duration: 41,
                actual_duration: 12,
            },
        ]);
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${extra.id}::uuid)`;

        const rows = await listAdminMediaItems(sql, {
            types: [...ALL_BROWSABLE_TYPES],
            fileIssues: true,
            limit: 50,
            offset: 0,
        });

        const row = rows.find((r) => r.id === extra.id);
        expect(row).toBeDefined();
        expect(row?.health_issue_types).toContain('truncated_video');
    });

    it('names the film an extra hangs off, so the row is attributable', async () => {
        // A movie parent matches none of the four closed ancestry CASEs
        // (artist/album/tv/season), so before the generic fallback the
        // Everything view rendered the trailer with an empty Parent AND an empty
        // Root — visible, but impossible to act on.
        const movie = createTestMediaItem({ media_type: 'movie', title: 'Cinderella' });
        await insertTestMediaItem(sql, movie);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

        const extra = createTestMediaItem({ media_type: 'extra', title: 'Cinderella trailer' });
        await insertTestMediaItem(sql, extra);
        await sql`
            UPDATE media_items SET has_files = true, parent_id = ${movie.id}::uuid
             WHERE id = ${extra.id}::uuid
        `;

        const rows = await listAdminMediaItems(sql, {
            types: [...ALL_BROWSABLE_TYPES],
            limit: 50,
            offset: 0,
        });

        const row = rows.find((r) => r.id === extra.id);
        expect(row?.generic_parent_title).toBe('Cinderella');
        // The named columns must stay null — putting a movie title in
        // `series_title` would reorder the TV grouping in `namedOrder()`.
        expect(row?.series_title).toBeNull();
        expect(row?.season_title).toBeNull();
    });

    it('surfaces the reason and the file through the admin media list', async () => {
        // The end of the chain the user actually looks at:
        // /admin/library/media?filter=file-issues
        const item = createTestMediaItem({ media_type: 'movie', title: 'Broken Movie' });
        await insertTestMediaItem(sql, item);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

        const fileId = await insertFile('/movies/Valerian (2017)/Valerian - Bluray-1080p.mkv');
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${item.id}::uuid)`;

        await recordDecodeHealthIssue(sql, {
            fileId,
            type: 'container_unreadable',
            detail: EBML_REASON,
        });

        const [row] = await listAdminMediaItems(sql, {
            types: ['movie'],
            fileIssues: true,
            limit: 10,
            offset: 0,
        });

        expect(row?.id).toBe(item.id);
        expect(row?.health_issue_types).toContain('container_unreadable');

        const detail = row?.health_issue_details.find((d) => d.type === 'container_unreadable');
        expect(detail).toBeDefined();
        expect(detail?.detail).toBe(EBML_REASON);
        // Which file it came from — an item can have several.
        expect(detail?.file_path).toContain('Valerian');
    });

    it('reports details per file for a multi-version item', async () => {
        const item = createTestMediaItem({ media_type: 'movie', title: 'Two Editions' });
        await insertTestMediaItem(sql, item);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

        const badId = await insertFile('/movies/Two Editions/edition-a.mkv');
        const shortId = await insertFile('/movies/Two Editions/edition-b.mkv');
        // Only one link per item may be the default (idx_media_file_items_one_default).
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${badId}::uuid, ${item.id}::uuid, true, 0)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${shortId}::uuid, ${item.id}::uuid, false, 1)`;

        await recordDecodeHealthIssue(sql, {
            fileId: badId,
            type: 'container_unreadable',
            detail: 'edition A is unreadable',
        });
        await recordDecodeHealthIssue(sql, {
            fileId: shortId,
            type: 'video_ends_early',
            detail: 'edition B stops early',
            expectedDuration: 7200,
            actualDuration: 3600,
        });

        const [row] = await listAdminMediaItems(sql, {
            types: ['movie'],
            fileIssues: true,
            limit: 10,
            offset: 0,
        });

        expect(row?.health_issue_types.sort()).toEqual([
            'container_unreadable',
            'video_ends_early',
        ]);
        expect(
            row?.health_issue_details.find((d) => d.type === 'container_unreadable')?.file_path,
        ).toContain('edition-a');
        expect(
            row?.health_issue_details.find((d) => d.type === 'video_ends_early')?.file_path,
        ).toContain('edition-b');
    });
});
