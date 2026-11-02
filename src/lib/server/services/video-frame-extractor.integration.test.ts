// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/video-frame-extractor.integration.test.ts
//
// Integration tests for resolveMultiEpisodeTimestamp against a real PostgreSQL
// database. Combined files (one physical file holding two episode segments)
// must extract a DISTINCT, segment-correct frame per episode: the first
// segment at 25% of the file, the second at 75%. A unit test can't verify the
// media_file_items sibling lookup that drives this, so it lives here.
//
// Run locally:
//   npm run test:integration src/lib/server/services/video-frame-extractor.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    resolveMultiEpisodeTimestamp,
    buildEpisodeTimestampMap,
    resolveExtractionSpan,
} from './video-frame-extractor.service.js';

const SERIES_ID = '00000000-0000-4000-b000-0000000000a0';
const SEASON_ID = '00000000-0000-4000-b000-0000000000a1';
const EP1_ID = '00000000-0000-4000-b000-0000000000a2';
const EP2_ID = '00000000-0000-4000-b000-0000000000a3';
const EP_SOLO_ID = '00000000-0000-4000-b000-0000000000a4';
const COMBINED_FILE_ID = '00000000-0000-4000-b000-0000000000b0';
const SOLO_FILE_ID = '00000000-0000-4000-b000-0000000000b1';

describe('resolveMultiEpisodeTimestamp', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_file_items', 'media_files', 'media_items']);

        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${SERIES_ID}, 'Combined Test Show', 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${SEASON_ID}, 'Season 1', 'season', ${SERIES_ID}, 1, 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
            VALUES
                (${EP1_ID}, 'Segment A', 'episode', ${SEASON_ID}, 1, 1, 'active'),
                (${EP2_ID}, 'Segment B', 'episode', ${SEASON_ID}, 1, 2, 'active'),
                (${EP_SOLO_ID}, 'Standalone', 'episode', ${SEASON_ID}, 1, 3, 'active')
        `;

        // One physical file holds episodes 1 and 2 (both default links).
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${COMBINED_FILE_ID}, '/test/S01E01E02.mkv', NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES
                (${COMBINED_FILE_ID}, ${EP1_ID}, true),
                (${COMBINED_FILE_ID}, ${EP2_ID}, true)
        `;

        // Episode 3 has its own single-episode file.
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${SOLO_FILE_ID}, '/test/S01E03.mkv', NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${SOLO_FILE_ID}, ${EP_SOLO_ID}, true)
        `;
    });

    it('honors stored segment offsets, including unequal combined episodes', async () => {
        await sql`UPDATE media_file_items SET start_offset_ms=400000,end_offset_ms=1200000
            WHERE media_item_id=${EP2_ID}`;
        expect(await resolveExtractionSpan(sql, EP2_ID, '/test/S01E01E02.mkv', 1200)).toEqual({
            base: 400,
            duration: 800,
        });
    });
    it('derives the second segment bounds when offsets are not stored', async () => {
        expect(await resolveExtractionSpan(sql, EP2_ID, '/test/S01E01E02.mkv', 1200)).toEqual({
            base: 600,
            duration: 600,
        });
    });

    it('places the first segment of a combined file at 25%', async () => {
        const ts = await resolveMultiEpisodeTimestamp(sql, EP1_ID);
        expect(ts).toBeCloseTo(25);
    });

    it('places the second segment of a combined file at 75%', async () => {
        const ts = await resolveMultiEpisodeTimestamp(sql, EP2_ID);
        expect(ts).toBeCloseTo(75);
    });

    it('returns undefined for a single-episode file so the caller uses the config default', async () => {
        const ts = await resolveMultiEpisodeTimestamp(sql, EP_SOLO_ID);
        expect(ts).toBeUndefined();
    });

    it('returns undefined for an episode with no file link', async () => {
        const orphan = '00000000-0000-4000-b000-0000000000a9';
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
            VALUES (${orphan}, 'No File', 'episode', ${SEASON_ID}, 1, 4, 'active')
        `;
        const ts = await resolveMultiEpisodeTimestamp(sql, orphan);
        expect(ts).toBeUndefined();
    });

    // The batch extractor distributes timestamps via buildEpisodeTimestampMap.
    // When only ONE episode of a combined file is in scope (episode-scope
    // regenerate), it must still resolve the off-scope sibling so the in-scope
    // episode lands on its own segment — not the default timestamp.
    describe('buildEpisodeTimestampMap', () => {
        it('distributes correctly when only the second segment is in scope', async () => {
            const map = await buildEpisodeTimestampMap(sql, [EP2_ID]);
            expect(map.get(EP2_ID)).toBeCloseTo(75);
        });

        it('distributes correctly when only the first segment is in scope', async () => {
            const map = await buildEpisodeTimestampMap(sql, [EP1_ID]);
            expect(map.get(EP1_ID)).toBeCloseTo(25);
        });

        it('omits single-episode files so the caller uses the config default', async () => {
            const map = await buildEpisodeTimestampMap(sql, [EP_SOLO_ID]);
            expect(map.has(EP_SOLO_ID)).toBe(false);
        });
    });
});
