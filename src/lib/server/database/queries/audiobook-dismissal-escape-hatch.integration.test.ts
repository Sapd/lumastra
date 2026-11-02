// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operator escape hatch the AudiobookShelf retention design depends on.
 *
 * The ingest sweep never sets `status = 'deleted'` for a book that vanished
 * upstream — that is a 30-day purge sentence which would destroy ratings and
 * listening progress, and its only physical guard (`NOT EXISTS
 * media_file_items`) is trivially passed by file-less audiobooks. Instead the
 * sweep sets `is_dismissed = true` + `has_files = false`, forever.
 *
 * "Forever" is only acceptable because an operator can find such a row in the
 * admin media browser and purge it by hand. That makes reachability a LOAD-BEARING
 * property of the retention design, not a UI nicety — and it is not obvious:
 *
 *   - the list filters `AND NOT mi.is_dismissed` unless `showDismissed`
 *   - AND it filters `AND mi.has_files = true` unless `showUnavailable`
 *
 * A dismissed audiobook fails BOTH. Testing only `showDismissed` (as the existing
 * decoupling tests do) would report the row reachable while the real UI, whose
 * availability toggle defaults off, still hides it.
 *
 * These are the claims a previous session reported as already-shipped. This file
 * exercises them instead of reading them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listAdminMediaItems, countAdminMediaItems } from './admin-media.queries.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import {
    resolveTypes,
    inferDomain,
    defaultTypeForDomain,
    AUDIOBOOK_TYPES,
    ALL_BROWSABLE_TYPES,
} from '../../../../routes/admin/library/media/media-filters.js';

const GROUP_ID = '00000000-0000-0000-0000-0000000abd00';
const BOOK_ID = '00000000-0000-0000-0000-0000000abd01';

describe('admin media filters expose the audiobook domain', () => {
    // Pure mappers, but they are the reason the row below is reachable at all: a
    // filter that resolves to the wrong media_type set queries the wrong rows.
    it('resolves `audiobook` as its own top-level type set', () => {
        expect(resolveTypes('audiobook')).toEqual(['audiobook']);
        expect(AUDIOBOOK_TYPES).toEqual(['audiobook']);
    });

    it('routes the audiobook type filter to the audiobook domain, not `other`', () => {
        // `other` resolves to OTHER_TYPES, so falling through would render the
        // Audiobooks tab over a list of home videos.
        expect(inferDomain('audiobook')).toBe('audiobook');
        expect(defaultTypeForDomain('audiobook')).toBe('audiobook');
        expect(resolveTypes(defaultTypeForDomain('audiobook'), 'audiobook')).toEqual(['audiobook']);
    });

    it('includes audiobooks in the "Everything" filter', () => {
        expect(ALL_BROWSABLE_TYPES).toContain('audiobook');
        expect(resolveTypes('all')).toContain('audiobook');
    });

    it('keeps audiobooks OUT of the unidentified domain', () => {
        // Unidentified is about TMDB identification, which ABS books never get.
        expect(resolveTypes('audiobook', 'unidentified')).toEqual(['movie', 'tv']);
    });
});

describe('a dismissed audiobook stays reachable and purgeable', () => {
    let sql: postgres.Sql;

    /** Exactly what the sweep writes for a book that vanished upstream. */
    async function insertDismissedAudiobook(): Promise<void> {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed, library_group_id)
            VALUES (${BOOK_ID}, 'Vanished Upstream Book', 'audiobook', 'active', false, true, ${GROUP_ID})
        `;
    }

    const baseOpts = {
        types: ['audiobook'],
        query: '',
        limit: 50,
        offset: 0,
    };

    beforeAll(async () => {
        sql = await getTestDb();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${GROUP_ID}, 'Audiobooks (escape hatch test)')
            ON CONFLICT (id) DO NOTHING
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ${BOOK_ID}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP_ID}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE id = ${BOOK_ID}`;
        // Re-assert the group every time rather than only in `beforeAll`.
        // Sibling suites truncate `TEST_TABLES.media` in their own hooks against
        // this same database, and relying on a one-shot `beforeAll` makes this
        // file's result depend on which other files ran first — a test that only
        // fails in company is worse than one that fails alone.
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${GROUP_ID}, 'Audiobooks (escape hatch test)')
            ON CONFLICT (id) DO NOTHING
        `;
    });

    it('is hidden from the default view', async () => {
        await insertDismissedAudiobook();
        const rows = await listAdminMediaItems(sql, {
            ...baseOpts,
            showDismissed: false,
            showUnavailable: false,
        });
        expect(rows.map((r) => r.id)).not.toContain(BOOK_ID);
    });

    it('is STILL hidden with only the dismissed toggle on', async () => {
        await insertDismissedAudiobook();
        // The trap. `showDismissed` alone is not enough, because dismissal also
        // clears `has_files`, and availability is a separate filter. A test that
        // stopped here would certify an unreachable row as reachable.
        const rows = await listAdminMediaItems(sql, {
            ...baseOpts,
            showDismissed: true,
            showUnavailable: false,
        });
        expect(rows.map((r) => r.id)).not.toContain(BOOK_ID);
    });

    it('becomes reachable with BOTH the dismissed and unavailable toggles on', async () => {
        await insertDismissedAudiobook();
        const opts = { ...baseOpts, showDismissed: true, showUnavailable: true };

        const rows = await listAdminMediaItems(sql, opts);
        expect(rows.map((r) => r.id)).toContain(BOOK_ID);

        // The count must agree with the list, or the row is reachable on a page
        // the paginator claims does not exist.
        const total = await countAdminMediaItems(sql, opts);
        expect(total).toBeGreaterThanOrEqual(1);
    });

    it('is reachable without opting into the unidentified domain', async () => {
        await insertDismissedAudiobook();
        // Pins the decoupling claim: dismissed visibility must not require
        // `unidentified`, which an ABS book would never satisfy anyway (the
        // sweep writes no external_ids TMDB row for it).
        const rows = await listAdminMediaItems(sql, {
            ...baseOpts,
            showDismissed: true,
            showUnavailable: true,
            unidentified: false,
        });
        expect(rows.map((r) => r.id)).toContain(BOOK_ID);
    });

    it('is purgeable, and the purge actually removes the row', async () => {
        await insertDismissedAudiobook();

        // This is the escape hatch itself. `hardDelete` is what
        // DELETE /api/admin/media/[id] calls.
        await MediaDeletionService.hardDelete(sql, BOOK_ID, { cascade: false });

        const [row] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_items WHERE id = ${BOOK_ID}
        `;
        expect(row.n).toBe(0);

        // And it is gone from the most permissive view too, not merely
        // soft-hidden behind another flag.
        const rows = await listAdminMediaItems(sql, {
            ...baseOpts,
            showDismissed: true,
            showUnavailable: true,
        });
        expect(rows.map((r) => r.id)).not.toContain(BOOK_ID);
    });
});
