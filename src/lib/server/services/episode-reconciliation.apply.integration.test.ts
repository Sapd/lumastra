// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import type { TmdbCatalogEpisode } from './episode-reconciliation.service.js';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

// Mock ONLY the TMDB client so loadTmdbCatalog returns a fixed catalog (no network).
// Everything else (DB writes, CatalogService, the clear-then-set tx) runs for real.
//
// mockCatalogHolder is a mutable wrapper so individual tests can swap the active
// episode list without re-mocking the module (the closure always reads .episodes).
const mockCatalogHolder = {
    episodes: [
        {
            id: 78888,
            name: 'Das Experiment',
            overview: 'O3',
            seasonNumber: 1,
            episodeNumber: 3,
        },
        {
            id: 79000,
            name: 'Wo sind Spinellis Eltern?',
            overview: 'O25',
            seasonNumber: 1,
            episodeNumber: 25,
        },
        {
            id: 79002,
            name: 'Mikey ist verliebt',
            overview: 'O27',
            seasonNumber: 1,
            episodeNumber: 27,
        },
    ] as {
        id: number;
        name: string;
        overview: string;
        seasonNumber: number;
        episodeNumber: number;
        stillPath?: string | null;
    }[],
};

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/providers/implementations/tmdb/index.js')>();
    const mockClient = {
        isAvailable: () => true,
        getTVShowSeasons: async () => [
            {
                seasonNumber: 1,
                episodeCount: mockCatalogHolder.episodes.length,
            },
        ],
        getSeasonEpisodes: async () => mockCatalogHolder.episodes,
        getSeasonEpisodesInLanguage: async () => [],
    };
    return {
        ...actual,
        tmdbApi: mockClient,
        // The language-less fallbacks in episode-reconciliation now construct
        // a fresh client via createTMDBApi(config.TMDB_LANGUAGE) instead of
        // the frozen-language tmdbApi singleton (2026-07-08 language fix), so
        // the mock must intercept that path too.
        createTMDBApi: () => mockClient,
    };
});

// Used by exactly one test (the still_path lock-guard TOCTOU test below) to
// simulate a concurrent admin lock landing between applyReconciliation's
// match computation (previewReconciliation, which reads metadata_locked and
// would exclude an already-locked episode from ever reaching 'matched') and
// its write phase. getLockedHeldTmdbIds runs in between the two - after
// toApply is fixed, before the tx loop - so it is the natural injection
// point for a real (not simulated-away) race, without stubbing the write
// itself. One-shot: cleared immediately after firing so it cannot leak into
// any other test in this file.
let lockAfterMatchEpisodeId: string | null = null;

vi.mock('$lib/server/database/queries/episode-reconciliation.queries.js', async (importActual) => {
    const actual =
        await importActual<
            typeof import('$lib/server/database/queries/episode-reconciliation.queries.js')
        >();
    return {
        ...actual,
        getLockedHeldTmdbIds: async (
            sql: postgres.Sql,
            seriesMediaId: string,
            targetIds: string[],
        ) => {
            if (lockAfterMatchEpisodeId) {
                const epId = lockAfterMatchEpisodeId;
                lockAfterMatchEpisodeId = null;
                await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${epId}`;
            }
            return actual.getLockedHeldTmdbIds(sql, seriesMediaId, targetIds);
        },
    };
});

const URL = getTestDatabaseUrl();

describe('applyReconciliation permutation (integration)', () => {
    let sql: postgres.Sql;
    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        // Self-isolate: start from a clean slate so the hardcoded tmdb-id
        // external_ids inserted below can't collide with rows left by a prior
        // test file (file order is not stable across runs).
        await truncateAllTestTables(sql);
    });
    afterAll(async () => {
        await sql.end();
    });

    it('reassigns swapped tmdb ids via clear-then-set without collision', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        // Series (tv) + its tmdb id so getTmdbId resolves.
        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('PermTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '880001', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // ep3 currently mis-bound to tmdb 78888 ("Das Experiment"); its file's chapter says "Wo sind Spinellis Eltern?" (79000).
        const [{ id: ep3 }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Das Experiment', 'episode', ${seasonId}, 1, 3, 'active') RETURNING id`;
        // ep25 currently holds tmdb 79000 ("Spinellis"); its file's chapter says "Mikey ist verliebt" (79002).
        const [{ id: ep25 }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wo sind Spinellis Eltern?', 'episode', ${seasonId}, 1, 25, 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${ep3}, 'tmdb', '78888', 'episode', true),
                         (${ep25}, 'tmdb', '79000', 'episode', true)`;

        const [{ id: fileA }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/permA.mkv') RETURNING id`;
        const [{ id: fileB }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/permB.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${ep3}, ${fileA}, true), (${ep25}, ${fileB}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileA}, 0, 'Wo sind Spinellis Eltern?', 0, 'file'),
                         (${fileB}, 0, 'Mikey ist verliebt', 0, 'file')`;

        try {
            const result = await applyReconciliation(sql, seriesId, 0.8);

            // ep3 must take 79000 (which ep25 held) — proves clear-then-set avoids the collision.
            const [ep3Ext] = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep3} AND provider = 'tmdb'`;
            const [ep25Ext] = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep25} AND provider = 'tmdb'`;
            const [ep3Row] = await sql<{ title: string; title_binding: string }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep3}`;
            const [ep25Row] = await sql<{ title: string; title_binding: string }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep25}`;

            expect(result.appliedExternalIds).toBe(2);
            expect(ep3Ext.external_id).toBe('79000');
            expect(ep25Ext.external_id).toBe('79002');
            expect(ep3Row.title).toBe('Wo sind Spinellis Eltern?');
            expect(ep3Row.title_binding).toBe('identity');
            expect(ep25Row.title).toBe('Mikey ist verliebt');
            expect(ep25Row.title_binding).toBe('identity');
        } finally {
            // external_ids does NOT cascade on media_items delete — clear by media_id first.
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${ep3}, ${ep25})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id IN (${fileA}, ${fileB})`;
        }
    });

    it('releases stale tmdb id held by un-reconciled episode before reassigning (out-of-set collision)', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        // Series (tv) + its tmdb id so getTmdbId resolves.
        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('StaleHolderTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '880002', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // epB: confident match — its chapter matches tmdb 79000 ("Wo sind Spinellis Eltern?").
        const [{ id: epBId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('EpB', 'episode', ${seasonId}, 1, 2, 'active') RETURNING id`;

        // epH: NOT reconciled — its chapter is generic ("Chapter 1"), produces no confident match.
        // It currently holds external_id 79000 (the stale holder).
        const [{ id: epHId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('EpH', 'episode', ${seasonId}, 1, 3, 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${epHId}, 'tmdb', '79000', 'episode', true)`;

        // epB's file has content chapter "Wo sind Spinellis Eltern?" → matches tmdb 79000.
        const [{ id: fileBId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/stale_b.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${epBId}, ${fileBId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileBId}, 0, 'Wo sind Spinellis Eltern?', 0, 'file')`;

        // epH's file has only a generic chapter — no confident match.
        const [{ id: fileHId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/stale_h.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${epHId}, ${fileHId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileHId}, 0, 'Chapter 1', 0, 'file')`;

        try {
            // Must not throw — Phase 1b should release epH's stale 79000 before epB claims it.
            const result = await applyReconciliation(sql, seriesId, 0.8);

            const epBExts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${epBId} AND provider = 'tmdb'`;
            const epHExts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${epHId} AND provider = 'tmdb'`;
            const [epBRow] = await sql<{ title_binding: string }[]>`
                SELECT title_binding FROM media_items WHERE id = ${epBId}`;

            // epB acquired 79000 and was reconciled.
            expect(result.appliedExternalIds).toBeGreaterThanOrEqual(1);
            expect(epBExts).toHaveLength(1);
            expect(epBExts[0].external_id).toBe('79000');
            expect(epBRow.title_binding).toBe('identity');
            // epH's stale 79000 was released; it holds no tmdb episode id now.
            expect(epHExts).toHaveLength(0);
        } finally {
            // external_ids does NOT cascade on media_items delete — clear by media_id first.
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${epBId}, ${epHId})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id IN (${fileBId}, ${fileHId})`;
        }
    });
});

// ---------------------------------------------------------------------------
// Additional reconciliation guard tests
// ---------------------------------------------------------------------------

describe('applyReconciliation guard cases (integration)', () => {
    let sql: postgres.Sql;
    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        // Self-isolate: start from a clean slate so the hardcoded tmdb-id
        // external_ids inserted below can't collide with rows left by a prior
        // test file (file order is not stable across runs).
        await truncateAllTestTables(sql);
    });
    afterAll(async () => {
        await sql.end();
    });

    // -----------------------------------------------------------------------
    // Test 1: metadata_locked episode is never overwritten
    // -----------------------------------------------------------------------
    it('locked episode is never overwritten — title and tmdb id unchanged after apply', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        mockCatalogHolder.episodes = [
            {
                id: 88001,
                name: 'Real Title Ep1',
                overview: 'O1',
                seasonNumber: 1,
                episodeNumber: 1,
            },
            {
                id: 88002,
                name: 'Real Title Ep2',
                overview: 'O2',
                seasonNumber: 1,
                episodeNumber: 2,
            },
        ];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('LockedEpTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990001', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // ep1: WRONG title, metadata_locked = true, holds tmdb '88888' (not a catalog id — deliberately wrong)
        const [{ id: ep1Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Wrong Title Ep1', 'episode', ${seasonId}, 1, 1, 'active', true) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${ep1Id}, 'tmdb', '88888', 'episode', true)`;

        // ep2: WRONG title, unlocked
        const [{ id: ep2Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Wrong Title Ep2', 'episode', ${seasonId}, 1, 2, 'active', false) RETURNING id`;

        // Combined file backing both ep1 + ep2 (both is_default = true)
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/locked_combined.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${ep1Id}, ${fileId}, true), (${ep2Id}, ${fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileId}, 0, 'Real Title Ep1', 0, 'file'),
                         (${fileId}, 1, 'Real Title Ep2', 0, 'file')`;

        try {
            const result = await applyReconciliation(sql, seriesId, 0.8);

            const [ep1Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep1Id}`;
            const ep1Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep1Id} AND provider = 'tmdb'`;
            const [ep2Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep2Id}`;
            const ep2Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep2Id} AND provider = 'tmdb'`;

            // ep1 is locked — title and external_id must be unchanged
            expect(ep1Row.title).toBe('Wrong Title Ep1');
            expect(ep1Exts).toHaveLength(1);
            expect(ep1Exts[0].external_id).toBe('88888');

            // ep2 is unlocked — must be reconciled to catalog entry 88002
            expect(ep2Row.title).toBe('Real Title Ep2');
            expect(ep2Row.title_binding).toBe('identity');
            expect(ep2Exts).toHaveLength(1);
            expect(ep2Exts[0].external_id).toBe('88002');

            expect(result.appliedExternalIds).toBeGreaterThanOrEqual(1);
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${ep1Id}, ${ep2Id})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });

    // -----------------------------------------------------------------------
    // Test 2: locked holder does not poison the batch
    // -----------------------------------------------------------------------
    it('locked holder does not poison the batch — epB skipped, epC reconciled, no throw', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        mockCatalogHolder.episodes = [
            {
                id: 77001,
                name: 'Episode T Name',
                overview: 'OT',
                seasonNumber: 1,
                episodeNumber: 1,
            },
            {
                id: 77002,
                name: 'Episode U Name',
                overview: 'OU',
                seasonNumber: 1,
                episodeNumber: 2,
            },
        ];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('LockedPoisonTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990002', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // epH: LOCKED, currently holds tmdb id '77001' (catalog id 'T')
        const [{ id: epHId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Locked Holder', 'episode', ${seasonId}, 1, 10, 'active', true) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${epHId}, 'tmdb', '77001', 'episode', true)`;

        // epB: UNLOCKED, chapter matches catalog 'T' (tmdb 77001) — but locked holder owns it
        const [{ id: epBId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Ep B Wrong', 'episode', ${seasonId}, 1, 1, 'active', false) RETURNING id`;
        const [{ id: fileBId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/batch_b.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${epBId}, ${fileBId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileBId}, 0, 'Episode T Name', 0, 'file')`;

        // epC: UNLOCKED, chapter matches catalog 'U' (tmdb 77002) — free id, must reconcile
        const [{ id: epCId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Ep C Wrong', 'episode', ${seasonId}, 1, 2, 'active', false) RETURNING id`;
        const [{ id: fileCId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/batch_c.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${epCId}, ${fileCId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileCId}, 0, 'Episode U Name', 0, 'file')`;

        try {
            // Must not throw — the locked-id filter prevents the collision
            const result = await applyReconciliation(sql, seriesId, 0.8);

            const epHExts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${epHId} AND provider = 'tmdb'`;
            const epBExts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${epBId} AND provider = 'tmdb'`;
            const epCExts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${epCId} AND provider = 'tmdb'`;
            const [epCRow] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${epCId}`;
            const [epHRow] = await sql<{ title: string }[]>`
                SELECT title FROM media_items WHERE id = ${epHId}`;

            // epH is locked — still holds '77001', title unchanged
            expect(epHExts).toHaveLength(1);
            expect(epHExts[0].external_id).toBe('77001');
            expect(epHRow.title).toBe('Locked Holder');

            // epB was NOT assigned '77001' because the locked holder pre-empts it
            expect(epBExts).toHaveLength(0);

            // epC got free id '77002' and was reconciled
            expect(epCExts).toHaveLength(1);
            expect(epCExts[0].external_id).toBe('77002');
            expect(epCRow.title).toBe('Episode U Name');
            expect(epCRow.title_binding).toBe('identity');
            expect(result.appliedExternalIds).toBeGreaterThanOrEqual(1);
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${epHId}, ${epBId}, ${epCId})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id IN (${fileBId}, ${fileCId})`;
        }
    });

    // -----------------------------------------------------------------------
    // Test 3: filename fallback for chapterless combined file
    // -----------------------------------------------------------------------
    it('filename fallback reconciles chapterless combined file via dotted episode filename', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        mockCatalogHolder.episodes = [
            {
                id: 66001,
                name: 'Vorname Ashley',
                overview: 'OA',
                seasonNumber: 1,
                episodeNumber: 5,
            },
            {
                id: 66002,
                name: 'Hilfe Miss Finster',
                overview: 'OF',
                seasonNumber: 1,
                episodeNumber: 6,
            },
        ];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('FilenameFallbackTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990003', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // ep5 and ep6 with wrong titles, both unlocked
        const [{ id: ep5Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Ep5', 'episode', ${seasonId}, 1, 5, 'active') RETURNING id`;
        const [{ id: ep6Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Ep6', 'episode', ${seasonId}, 1, 6, 'active') RETURNING id`;

        // The file_path basename is the dotted filename — getReconciliationGroups uses
        // regexp_replace(file_path, '^.*/', '') to extract it as fileName.
        const dottedFileName =
            'Show.S01E05E06.Vorname.Ashley.-.Hilfe.Miss.Finster.German.DL.480p.WEB-DL.mkv';
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${'/x/' + dottedFileName}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${ep5Id}, ${fileId}, true), (${ep6Id}, ${fileId}, true)`;
        // No episode_chapters rows — filename fallback path

        try {
            const result = await applyReconciliation(sql, seriesId, 0.8);

            const [ep5Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep5Id}`;
            const [ep6Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep6Id}`;
            const ep5Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep5Id} AND provider = 'tmdb'`;
            const ep6Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep6Id} AND provider = 'tmdb'`;

            expect(ep5Row.title).toBe('Vorname Ashley');
            expect(ep5Row.title_binding).toBe('identity');
            expect(ep5Exts).toHaveLength(1);
            expect(ep5Exts[0].external_id).toBe('66001');

            expect(ep6Row.title).toBe('Hilfe Miss Finster');
            expect(ep6Row.title_binding).toBe('identity');
            expect(ep6Exts).toHaveLength(1);
            expect(ep6Exts[0].external_id).toBe('66002');

            expect(result.appliedExternalIds).toBe(2);
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${ep5Id}, ${ep6Id})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });

    // -----------------------------------------------------------------------
    // Test 4: preloadedCatalog bypasses tmdbApi entirely
    // -----------------------------------------------------------------------
    it('reuses a catalog bound to its originating series evidence', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        // Set the mock to an empty list — if tmdbApi is used, no proposals will match.
        mockCatalogHolder.episodes = [];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('PreloadedCatalogTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${seriesId}, 'tmdb', '880505', 'tv')`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        const [{ id: ep1Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Ep1', 'episode', ${seasonId}, 1, 1, 'active') RETURNING id`;
        const [{ id: ep2Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Ep2', 'episode', ${seasonId}, 1, 2, 'active') RETURNING id`;

        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/preloaded_combined.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${ep1Id}, ${fileId}, true), (${ep2Id}, ${fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileId}, 0, 'First Episode', 0, 'file'),
                         (${fileId}, 1, 'Second Episode', 0, 'file')`;

        const preloadedCatalog: TmdbCatalogEpisode[] = [
            {
                tmdbEpisodeId: '55001',
                name: 'First Episode',
                overview: 'The first one',
                seasonNumber: 1,
                episodeNumber: 1,
                altNames: [],
                stillPath: null,
            },
            {
                tmdbEpisodeId: '55002',
                name: 'Second Episode',
                overview: 'The second one',
                seasonNumber: 1,
                episodeNumber: 2,
                altNames: [],
                stillPath: null,
            },
        ];

        mockCatalogHolder.episodes = preloadedCatalog.map((e) => ({
            id: Number(e.tmdbEpisodeId),
            name: e.name,
            overview: e.overview ?? '',
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
            stillPath: e.stillPath,
        }));
        const { loadTmdbCatalog } = await import('./episode-reconciliation.service.js');
        const boundCatalog = await loadTmdbCatalog(sql, seriesId);
        mockCatalogHolder.episodes = [];
        try {
            const result = await applyReconciliation(sql, seriesId, 0.9, undefined, boundCatalog);

            const [ep1Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep1Id}`;
            const [ep2Row] = await sql<{ title: string; title_binding: string | null }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${ep2Id}`;
            const ep1Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep1Id} AND provider = 'tmdb'`;
            const ep2Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep2Id} AND provider = 'tmdb'`;

            expect(result.appliedExternalIds).toBe(2);

            expect(ep1Row.title).toBe('First Episode');
            expect(ep1Row.title_binding).toBe('identity');
            expect(ep1Exts).toHaveLength(1);
            expect(ep1Exts[0].external_id).toBe('55001');

            expect(ep2Row.title).toBe('Second Episode');
            expect(ep2Row.title_binding).toBe('identity');
            expect(ep2Exts).toHaveLength(1);
            expect(ep2Exts[0].external_id).toBe('55002');
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${ep1Id}, ${ep2Id})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });

    // -----------------------------------------------------------------------
    // Test 5: still_path write honours metadata_locked (C3, 2026-09-24 security
    // review) - this write previously had NO lock guard at all, unlike the
    // sibling media_items title/overview UPDATE a few lines above it.
    //
    // A NATURALLY pre-locked episode never reaches this code at all -
    // previewReconciliation classifies a locked row as 'manually-locked' and
    // it never becomes a 'matched' proposal (see isProtectedEpisode /
    // protectedReason above in the source file), so the only way production
    // code can reach the still_path write for a locked destination is the
    // real TOCTOU race this comment describes: an admin locks the episode
    // AFTER matching decided it but BEFORE the write phase. The
    // getLockedHeldTmdbIds mock above reproduces exactly that race
    // deterministically (real SQL, real guard, only the JS-level timing of
    // the lock is controlled) instead of pre-locking the row, which would
    // make this test pass even without the fix.
    // -----------------------------------------------------------------------
    it('does NOT write still_path for an episode locked mid-apply; DOES for an unlocked one in the same batch', async () => {
        const { applyReconciliation } = await import('./episode-reconciliation.service.js');

        mockCatalogHolder.episodes = [];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('StillPathLockTest', 'tv', 'active') RETURNING id`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        const [{ id: ep1Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Wrong Ep1', 'episode', ${seasonId}, 1, 1, 'active', false) RETURNING id`;
        const [{ id: ep2Id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Wrong Ep2', 'episode', ${seasonId}, 1, 2, 'active', false) RETURNING id`;

        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/stillpath_combined.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${ep1Id}, ${fileId}, true), (${ep2Id}, ${fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileId}, 0, 'First Episode', 0, 'file'),
                         (${fileId}, 1, 'Second Episode', 0, 'file')`;

        const preloadedCatalog: TmdbCatalogEpisode[] = [
            {
                tmdbEpisodeId: '55101',
                name: 'First Episode',
                overview: 'The first one',
                seasonNumber: 1,
                episodeNumber: 1,
                altNames: [],
                stillPath: '/still-ep1.jpg',
            },
            {
                tmdbEpisodeId: '55102',
                name: 'Second Episode',
                overview: 'The second one',
                seasonNumber: 1,
                episodeNumber: 2,
                altNames: [],
                stillPath: '/still-ep2.jpg',
            },
        ];

        mockCatalogHolder.episodes = preloadedCatalog.map((e) => ({
            id: Number(e.tmdbEpisodeId),
            name: e.name,
            overview: e.overview ?? '',
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
            stillPath: e.stillPath,
        }));
        lockAfterMatchEpisodeId = ep1Id;
        try {
            const result = await applyReconciliation(sql, seriesId, 0.9);

            // A changed dependency invalidates the whole shared-file plan.
            expect(result.appliedExternalIds).toBe(0);
            const ep1Exts = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${ep1Id} AND provider = 'tmdb'`;
            expect(ep1Exts).toEqual([]);

            const [ep1Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${ep1Id} AND provider = 'tmdb'`;
            const [ep2Pm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${ep2Id} AND provider = 'tmdb'`;

            expect(ep1Pm).toBeUndefined();
            expect(ep2Pm).toBeUndefined();
        } finally {
            lockAfterMatchEpisodeId = null;
            await sql`DELETE FROM provider_metadata WHERE media_id IN (${ep1Id}, ${ep2Id})`;
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${ep1Id}, ${ep2Id})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });
});
