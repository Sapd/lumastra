// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the sweep's database port.
 *
 * The one thing unit tests cannot reach here is the check-then-insert against a
 * real `external_ids` unique index. Two failure modes live in that gap and both
 * are permanent data corruption rather than a recoverable error:
 *
 * 1. Two overlapping sweeps both call `insert` for the same ABS item. The
 *    `external_ids` write is `ON CONFLICT DO UPDATE`, so the second one does
 *    NOT raise — it silently re-points the mapping at its own new row, leaving
 *    the first `media_items` row with no external id. Such a row is invisible
 *    to `listAudiobooksForAbsLibrary` (which joins through `external_ids`), so
 *    no later sweep can update, dismiss or reconcile it, while browse, stats
 *    and the admin media browser show it forever.
 * 2. An item moves between ABS libraries. Local rows are partitioned by
 *    `custom_metadata.audiobookshelf.libraryId` while `external_ids` is unique
 *    install-wide, so the new library's diff calls it an addition. A blind
 *    insert would then throw on the composite key every 15 minutes forever.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
    listAudiobooksForAbsLibrary,
    type AudiobookWriteParams,
    type AudiobookshelfMetadata,
} from '$lib/server/database/queries/audiobooks.queries.js';
import { createAudiobookSweepStore } from './sweep-store.js';

const GROUP_A = '00000000-0000-0000-0000-0000000ab101';
const GROUP_B = '00000000-0000-0000-0000-0000000ab102';
const LIBRARY_A = 'store-lib-a';
const LIBRARY_B = 'store-lib-b';

function metadata(overrides: Partial<AudiobookshelfMetadata> = {}): AudiobookshelfMetadata {
    return {
        derivedSeries: { name: null, sequence: null, source: 'none' },
        audioFiles: [],
        libraryId: LIBRARY_A,
        libraryPathId: '11111111-1111-1111-1111-111111111111',
        updatedAt: 1_700_000_000_000,
        mtimeMs: 1_699_000_000_000,
        addedAt: 1_698_000_000_000,
        relPath: 'Autor/Buch',
        coverPath: null,
        subtitle: null,
        authors: ['Autor'],
        narrators: [],
        series: [],
        genres: [],
        publisher: null,
        publishedYear: null,
        language: 'de',
        isbn: null,
        asin: null,
        explicit: false,
        abridged: false,
        duration: 3600,
        chapters: [],
        ...overrides,
    };
}

function writeParams(overrides: Partial<AudiobookWriteParams> = {}): AudiobookWriteParams {
    return {
        sortOrder: null,
        title: 'Ein Buch',
        sortTitle: 'ein buch',
        overview: null,
        year: null,
        runtimeSeconds: 3600,
        hasFiles: true,
        libraryGroupId: GROUP_A,
        libraryAddedAt: null,
        metadata: metadata(),
        ...overrides,
    };
}

describe('createAudiobookSweepStore.insert', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO library_groups (id, name) VALUES
                (${GROUP_A}, 'Store Test A'),
                (${GROUP_B}, 'Store Test B')
            ON CONFLICT DO NOTHING
        `;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    // countRows() counts every audiobook row, so clear before each test too: an earlier file
    // in the same run can leave audiobooks behind (seen as { items: 3 } in a full run).
    async function clearAudiobooks(): Promise<void> {
        // external_ids FK-cascades from media_items.
        await sql`DELETE FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}`;
    }
    beforeEach(clearAudiobooks);
    afterEach(clearAudiobooks);

    async function countRows(absItemId: string): Promise<{ items: number; ids: number }> {
        const [row] = await sql<Array<{ items: string; ids: string }>>`
            SELECT
                (SELECT COUNT(*)::text FROM media_items WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}) AS items,
                (SELECT COUNT(*)::text FROM external_ids
                  WHERE provider = ${AUDIOBOOKSHELF_PROVIDER}
                    AND external_id = ${absItemId}
                    AND media_type = ${AUDIOBOOK_MEDIA_TYPE}) AS ids
        `;
        return { items: Number(row.items), ids: Number(row.ids) };
    }

    it('creates the row and its external id atomically', async () => {
        const store = createAudiobookSweepStore(sql);

        const mediaId = await store.insert('abs-1', writeParams());

        expect(await countRows('abs-1')).toEqual({ items: 1, ids: 1 });
        const rows = await listAudiobooksForAbsLibrary(sql, LIBRARY_A);
        expect(rows.map((r) => r.mediaId)).toEqual([mediaId]);
    });

    it('is idempotent: a second insert of the same id reuses the row', async () => {
        const store = createAudiobookSweepStore(sql);

        const first = await store.insert('abs-1', writeParams());
        const second = await store.insert('abs-1', writeParams({ title: 'Zweiter Versuch' }));

        expect(second).toBe(first);
        // The failure this guards: a second media_items row that has no
        // external_ids row at all, invisible to every future sweep.
        expect(await countRows('abs-1')).toEqual({ items: 1, ids: 1 });
    });

    it('serialises the check-then-insert on a per-item advisory lock', async () => {
        // Deterministic proof that the lock is taken AND keyed on the ABS item
        // id: hold the same key session-scoped from another connection and the
        // insert must not proceed. (A `Promise.all` race is not a reliable
        // regression test — whether the two transactions interleave in the
        // dangerous order is up to the scheduler.)
        const store = createAudiobookSweepStore(sql);
        const holder = await sql.reserve();
        let settled = false;

        try {
            await holder`SELECT pg_advisory_lock(hashtext(${'abs-item:abs-locked'}))`;

            const pending = store.insert('abs-locked', writeParams()).then((id) => {
                settled = true;
                return id;
            });

            await new Promise((resolve) => setTimeout(resolve, 250));
            expect(settled).toBe(false);
            expect(await countRows('abs-locked')).toEqual({ items: 0, ids: 0 });

            await holder`SELECT pg_advisory_unlock(hashtext(${'abs-item:abs-locked'}))`;
            await expect(pending).resolves.toEqual(expect.any(String));
            expect(await countRows('abs-locked')).toEqual({ items: 1, ids: 1 });
        } finally {
            await holder`SELECT pg_advisory_unlock_all()`;
            holder.release();
        }
    });

    it('maintains stable contributor/series links through repeated metadata updates and flags-only revival', async () => {
        const store = createAudiobookSweepStore(sql);
        const data = writeParams({
            metadata: metadata({
                authors: ['Store Writer'],
                narrators: ['store writer'],
                derivedSeries: { name: 'Store Cycle', sequence: 2.5, source: 'abs-series' },
            }),
        });
        // Live sweeps only flag books whose ABS library is still configured.
        await sql`INSERT INTO library_paths (id, path, media_type, language, provider, library_group_id, enabled)
            VALUES ('11111111-1111-1111-1111-111111111111', 'abs://store-links', 'audiobook', 'de', 'audiobookshelf', ${GROUP_A}, true)
            ON CONFLICT (id) DO NOTHING`;
        const mediaId = await store.insert('abs-catalog-links', data);
        const links = async () =>
            sql<
                { contributor_id: string; role: string }[]
            >`SELECT contributor_id, role FROM audiobook_book_contributors WHERE media_id = ${mediaId} ORDER BY role`;
        const before = await links();
        expect(before).toHaveLength(2);
        expect(before[0].contributor_id).toBe(before[1].contributor_id);
        await store.update(mediaId, data);
        expect(await links()).toEqual(before);
        await store.setFlags([mediaId], { hasFiles: false, isDismissed: true });
        expect(await links()).toEqual([]);
        await store.setFlags([mediaId], { hasFiles: true, isDismissed: false });
        expect(await links()).toHaveLength(2);
        const [series] = await sql<
            { sequence: string }[]
        >`SELECT sequence FROM audiobook_book_series WHERE media_id = ${mediaId}`;
        expect(Number(series.sequence)).toBe(2.5);
    });

    it('leaves no orphaned row when two inserts race for the same ABS id', async () => {
        const store = createAudiobookSweepStore(sql);

        const [a, b] = await Promise.all([
            store.insert('abs-race', writeParams()),
            store.insert('abs-race', writeParams()),
        ]);

        expect(b).toBe(a);
        expect(await countRows('abs-race')).toEqual({ items: 1, ids: 1 });
        // The corruption this whole path exists to prevent: a media_items row
        // with no external_ids row is invisible to `listLocal` forever.
        const orphans = await sql<Array<{ id: string }>>`
            SELECT mi.id FROM media_items mi
            WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id)
        `;
        expect(orphans).toEqual([]);
    });

    it('adopts an item that ABS moved to another library instead of colliding', async () => {
        const store = createAudiobookSweepStore(sql);
        const mediaId = await store.insert('abs-moved', writeParams());
        // The old library dismissed it when it vanished from that listing.
        await store.setFlags([mediaId], { hasFiles: false, isDismissed: true });

        const adopted = await store.insert(
            'abs-moved',
            writeParams({
                libraryGroupId: GROUP_B,
                metadata: metadata({ libraryId: LIBRARY_B }),
            }),
        );

        expect(adopted).toBe(mediaId);
        expect(await listAudiobooksForAbsLibrary(sql, LIBRARY_A)).toEqual([]);
        const [row] = await listAudiobooksForAbsLibrary(sql, LIBRARY_B);
        expect(row).toMatchObject({ mediaId, isDismissed: false, hasFiles: true });
    });

    it('keeps the operator-assigned library group when adopting', async () => {
        // Group placement is organisation, not metadata (design doc §6): the
        // reconcile must not move a book an operator filed elsewhere.
        const store = createAudiobookSweepStore(sql);
        const mediaId = await store.insert('abs-moved', writeParams());
        await sql`UPDATE media_items SET library_group_id = ${GROUP_B} WHERE id = ${mediaId}`;

        await store.insert('abs-moved', writeParams({ libraryGroupId: GROUP_A }));

        const [row] = await sql<Array<{ library_group_id: string }>>`
            SELECT library_group_id FROM media_items WHERE id = ${mediaId}
        `;
        expect(row.library_group_id).toBe(GROUP_B);
    });
});
