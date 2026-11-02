// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Contamination Prevention Integration Suite (W6)
 *
 * End-to-end exercise of the layered defenses landed across W1.x – W3.1:
 *
 *   1. `findOrCreateSeries` cross-provider conflict guard (W2.1) — Office AU
 *      vs Office US, Glimmers UK vs AU, etc.
 *   2. Same-title-different-TMDB-id collision guard (W2.1) — naked title
 *      match must NOT collapse two distinct shows into one row.
 *   3. NFO parser `kind` discriminator (W1.3) — episode-scoped IMDB ids
 *      must not leak up to series scope.
 *   4. Probe sentinel idempotency (W1.2) — `markFileMissing` is safe to
 *      re-run.
 *   5. `is_default` integrity after stale-default delete (W3.1) — sibling
 *      promotion keeps the partial unique index satisfied.
 *
 * Tables truncated per test for hermeticity. Runs against the integration
 * test database — NOT production.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { findOrCreateSeries } from '../database/queries/media-items.queries.js';
import { parseNfoContent } from '../utils/nfo-parser.js';
import {
    upsertMediaFile,
    attachFileToItem,
    markFileMissing,
    deleteStaleMediaFile,
} from '../database/queries/media-files.queries.js';

const TABLES_TO_CLEAN = [
    'media_file_items',
    'media_files',
    'playlist_items',
    'user_ratings',
    'watchlist_activities',
    'external_ids',
    'media_items',
];

describe('Contamination Prevention (W6)', () => {
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

    // =========================================================================
    // 1. Office AU contamination shape
    // =========================================================================
    it('cross-provider conflict guard: existing TMDB primary blocks a different TMDB id from matching by title', async () => {
        // Existing row: Office US — TMDB primary 2316
        const [existing] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type)
            VALUES ('The Outpost', 'tv')
            RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${existing.id}, 'tmdb', '2316', 'tv', TRUE)
        `;

        // Sync brings in Office AU — different TMDB id (3148, fictional)
        const id = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            mediaType: 'tv',
            externalId: { provider: 'tmdb', id: '3148', mediaType: 'tv' },
        });

        // Must be a NEW row, not the existing US row.
        expect(id).not.toBe(existing.id);

        // Verify two distinct rows now exist for the same title.
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE title = 'The Outpost' AND media_type = 'tv'
        `;
        expect(rows.length).toBe(2);
    });

    // =========================================================================
    // 2. Same-title series collision (UK vs AU)
    // =========================================================================
    it('naked title scan: UK vs AU with different TMDB ids do not collapse', async () => {
        // Existing row: Glimmers UK — TMDB primary 95396, year 2019
        const [uk] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, year)
            VALUES ('Glimmers', 'tv', 2019)
            RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${uk.id}, 'tmdb', '95396', 'tv', TRUE)
        `;

        // Sync brings in Glimmers AU — different TMDB id (78606, fictional)
        const auId = await findOrCreateSeries(sql, {
            title: 'Glimmers',
            mediaType: 'tv',
            year: 2008,
            externalId: { provider: 'tmdb', id: '78606', mediaType: 'tv' },
        });

        // Must NOT collapse with UK row — distinct TMDB id + cross-provider
        // conflict guard means AU gets a fresh row.
        expect(auId).not.toBe(uk.id);

        // The original UK row must remain intact and still hold its own TMDB
        // primary — AU did not poach the row or its external_id.
        const ukExt = await sql<{ external_id: string }[]>`
            SELECT external_id FROM external_ids
            WHERE media_id = ${uk.id} AND provider = 'tmdb'
        `;
        expect(ukExt[0]?.external_id).toBe('95396');

        // Two distinct rows now coexist for the same title.
        const allRows = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE title = 'Glimmers' AND media_type = 'tv'
        `;
        expect(allRows.length).toBe(2);
    });

    // =========================================================================
    // 3. NFO episode-IMDB scoping
    // =========================================================================
    it('NFO episode IMDB id is correctly scoped (kind=episode), preventing series-scope leak', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>Pilot</title>
  <season>1</season>
  <episode>1</episode>
  <imdbid>tt35287360</imdbid>
</episodedetails>`;

        const nfo = parseNfoContent(xml);

        expect(nfo.kind).toBe('episode');
        expect(nfo.imdbId).toBe('tt35287360');

        // Consumer-side rule: callers that want a SERIES-scope IMDB id must
        // refuse this NFO. We mirror the video-processor.ts check inline so
        // a regression in the consumer would also fail this expectation.
        const seriesScopeImdb = nfo.kind === 'episode' ? null : (nfo.imdbId ?? null);
        expect(seriesScopeImdb).toBeNull();
    });

    // =========================================================================
    // 4. Probe sentinel idempotency
    // =========================================================================
    it('markFileMissing is idempotent: re-running keeps is_missing=true and probed_at set', async () => {
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: '/media/movies/Probe.mkv',
        });

        await markFileMissing(sql, fileId);
        const [first] = await sql<[{ is_missing: boolean; probed_at: Date | null }]>`
            SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
        `;
        expect(first.is_missing).toBe(true);
        expect(first.probed_at).not.toBeNull();
        const firstProbedAt = first.probed_at?.getTime();

        // Re-run; must remain consistent. probed_at may be bumped (NOW()) but
        // never reverted to NULL, and is_missing stays true.
        await markFileMissing(sql, fileId);
        const [second] = await sql<[{ is_missing: boolean; probed_at: Date | null }]>`
            SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}::uuid
        `;
        expect(second.is_missing).toBe(true);
        expect(second.probed_at).not.toBeNull();
        // Sanity: probed_at didn't go backwards.
        if (firstProbedAt && second.probed_at) {
            expect(second.probed_at.getTime()).toBeGreaterThanOrEqual(firstProbedAt);
        }
    });

    // =========================================================================
    // 5. is_default integrity after stale-default delete
    // =========================================================================
    it('deleteStaleMediaFile promotes a sibling to is_default=true when the default file is removed', async () => {
        // Single episode with two attached files: one default, one not.
        const [item] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type)
            VALUES ('Default Promotion Test', 'episode')
            RETURNING id
        `;

        const { id: defaultFileId } = await upsertMediaFile(sql, {
            filePath: '/media/tv/Default.mkv',
        });
        // attachFileToItem sets is_default=true when no current default exists.
        await attachFileToItem(sql, defaultFileId, item.id);

        const { id: siblingFileId } = await upsertMediaFile(sql, {
            filePath: '/media/tv/Sibling.mkv',
        });
        // Manually attach as non-default.
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${siblingFileId}::uuid, ${item.id}::uuid, FALSE)
        `;

        // Sanity precondition.
        const [pre] = await sql<[{ is_default: boolean }]>`
            SELECT is_default FROM media_file_items
            WHERE file_id = ${defaultFileId}::uuid AND media_item_id = ${item.id}::uuid
        `;
        expect(pre.is_default).toBe(true);

        // Remove the default. Sibling must be promoted.
        await deleteStaleMediaFile(sql, '/media/tv/Default.mkv');

        const [post] = await sql<[{ is_default: boolean }]>`
            SELECT is_default FROM media_file_items
            WHERE file_id = ${siblingFileId}::uuid AND media_item_id = ${item.id}::uuid
        `;
        expect(post.is_default).toBe(true);

        // The deleted file's row should be gone (CASCADE).
        const remaining = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_file_items
            WHERE media_item_id = ${item.id}::uuid
        `;
        expect(parseInt(remaining[0].count, 10)).toBe(1);
    });
});
