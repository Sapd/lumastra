// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/library/coverage
 *
 * Paginated coverage grid: for each media item returns its stage completion
 * map plus aggregate status counts. Powers the Library Completeness page.
 *
 * Query params:
 *   ?mediaType=movie              (repeatable; 'series' mapped to DB 'tv')
 *   ?incompleteOnly=1             (only items with at least one non-covered stage)
 *   ?missingStage=tmdb-metadata-sync
 *   ?search=avatar                (ILIKE filter on title and series_title)
 *   ?limit=50                     (default 50)
 *   ?offset=0                     (default 0)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadCoverageGridItems,
    loadCoverageGridSummary,
    type CoverageGridCursor,
} from '$lib/server/database/queries/coverage-grid.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { getCachedCoverageSummary } from '$lib/server/services/library-coverage-summary-cache.js';

const CoverageQuerySchema = z.object({
    mediaType: z.union([z.string(), z.array(z.string())]).optional(),
    incompleteOnly: z.string().optional(),
    missingStage: z.string().optional(),
    search: z.string().max(200).optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
    // Opaque keyset cursor returned as `nextCursor` on a previous response.
    // When present, ignores `offset` and pages by (added_at, id) instead.
    cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Keyset cursor — opt-in, additive. Absent `cursor` param preserves the
// pre-existing offset+limit response byte-for-byte (aside from the new
// optional `nextCursor` bootstrap field, Gate J1). Mirrors the shared
// keyset-cursor builder used by `getPublicPlaylists`
// (src/lib/server/database/queries/playlists.queries.ts). The `lc1.` tag
// prefix stops a cursor minted by a DIFFERENT feed (e.g. admin/ingest/map,
// whose cursors have the identical `(timestamp, uuid)` shape since both page
// over `media_items`) from silently decoding here and paginating nonsense.
// ---------------------------------------------------------------------------

const LIBRARY_COVERAGE_CURSOR_TAG = 'lc1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCoverageCursor(parts: CoverageGridCursor): string {
    return `${LIBRARY_COVERAGE_CURSOR_TAG}.${encodeKeysetCursor({ ts: parts.addedAt, id: parts.id })}`;
}

function decodeCoverageCursor(cursor: string): CoverageGridCursor | null {
    const dotIdx = cursor.indexOf('.');
    if (dotIdx <= 0) return null;
    if (cursor.slice(0, dotIdx) !== LIBRARY_COVERAGE_CURSOR_TAG) return null;
    const decoded = decodeKeysetCursor(cursor.slice(dotIdx + 1));
    if (!decoded) return null;
    const { ts: addedAt, id } = decoded;
    // decodeKeysetCursor never throws on malformed input, and base64 decoding
    // is lenient, so both halves must be validated here — otherwise a
    // decodable-but-bogus cursor reaches Postgres as `'foo'::timestamptz` / a
    // uuid column comparison and 500s instead of a validation error.
    if (Number.isNaN(Date.parse(addedAt))) return null;
    if (!UUID_RE.test(id)) return null;
    return { addedAt, id };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { query: CoverageQuerySchema },
    handlers: {
        GET: async (event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const url = event.url;
            const rawMediaTypes = url.searchParams.getAll('mediaType');
            const mediaTypes =
                rawMediaTypes.length > 0
                    ? rawMediaTypes.map((t) => (t === 'series' ? 'tv' : t))
                    : undefined;

            const incompleteOnly = url.searchParams.get('incompleteOnly') === '1';
            const missingStage = url.searchParams.get('missingStage') ?? undefined;
            const search = url.searchParams.get('search') ?? undefined;

            const { limit, offset } = parsePagination(url, {
                defaultLimit: 50,
                maxLimit: 500,
            });

            const cursorParam = url.searchParams.get('cursor') ?? undefined;
            let cursor: CoverageGridCursor | undefined;
            if (cursorParam) {
                const decoded = decodeCoverageCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');
                cursor = decoded;
            }

            if (cursor) {
                // Cursor mode ONLY: oversample by one row so `hasMore`/
                // `nextCursor` can be derived without a separate COUNT query.
                // `items` is then sliced back to `limit`. Confined to this
                // branch so offset mode's query call/computation below stays
                // untouched (this feed is always cursor-eligible:
                // media_items.created_at is NOT NULL, so no null-group
                // handling applies).
                const filterOpts = { mediaTypes, incompleteOnly, missingStage, search };
                const [rawItems, summary] = await Promise.all([
                    loadCoverageGridItems(sql, { ...filterOpts, limit: limit + 1, offset, cursor }),
                    getCachedCoverageSummary(filterOpts, () =>
                        loadCoverageGridSummary(sql, filterOpts),
                    ),
                ]);

                const hasMore = rawItems.length > limit;
                const items = rawItems.slice(0, limit);

                let nextCursor: string | undefined;
                if (hasMore && items.length > 0) {
                    const last = items[items.length - 1];
                    // added_at_cursor is `added_at::text` straight from
                    // Postgres — never the parsed `Date`, whose toISOString()
                    // truncates to milliseconds (see CoverageGridItem doc
                    // comment).
                    if (last.added_at_cursor !== undefined) {
                        nextCursor = encodeCoverageCursor({
                            addedAt: last.added_at_cursor,
                            id: last.id,
                        });
                    }
                }

                // Cursor mode: drop the offset-mode-only `offset` echo in
                // favor of the explicit `hasMore` boolean; keep items/limit.
                return json({
                    items,
                    summary,
                    page: { limit, hasMore, ...(nextCursor ? { nextCursor } : {}) },
                });
            }

            // Offset pages use one lookahead row; the summary keeps the requested window.
            const opts = { mediaTypes, incompleteOnly, missingStage, search, limit, offset };
            const [rawItems, summary] = await Promise.all([
                loadCoverageGridItems(sql, { ...opts, limit: limit + 1 }),
                // Summary is polled by the processing hero — shared 15 s cache,
                // keyed on the filter only (see library-coverage-summary-cache.ts).
                getCachedCoverageSummary(opts, () => loadCoverageGridSummary(sql, opts)),
            ]);

            // Bootstrap a keyset cursor from the last returned row when a next page exists.
            const items = rawItems.slice(0, limit);
            const hasMore = rawItems.length > limit;
            let nextCursor: string | undefined;
            if (hasMore && items.length > 0) {
                const last = items[items.length - 1];
                if (last.added_at_cursor !== undefined) {
                    nextCursor = encodeCoverageCursor({
                        addedAt: last.added_at_cursor,
                        id: last.id,
                    });
                }
            }

            return json({
                items,
                summary,
                page: { limit, offset, hasMore, ...(nextCursor ? { nextCursor } : {}) },
            });
        },
    },
});
