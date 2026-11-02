// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/map
 *
 * Returns items recently added OR with in-flight stages, joined to all their
 * stage rows. Powers the Metro Map page initial data load.
 *
 * Query params:
 *   ?window=1h|24h|7d|30d|all   (default 24h)
 *   ?mediaType=movie             (repeatable; 'series' is mapped to DB 'tv')
 *   ?limit=500                   (default 500; max respected silently)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadIngestMap,
    loadIngestMapSummaryBuckets,
    type IngestMapCursor,
} from '$lib/server/database/queries/ingest-map.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parsePagination } from '$lib/server/utils/pagination.js';

const logger = Logger.for('IngestMapEndpoint');

// ---------------------------------------------------------------------------
// Keyset cursor — opt-in, additive. Absent `cursor` param preserves the
// pre-existing window+limit snapshot behavior byte-for-byte (aside from the
// new optional `nextCursor` bootstrap field, Gate J1). Mirrors the shared
// keyset-cursor builder used by `getPublicPlaylists`
// (src/lib/server/database/queries/playlists.queries.ts). The `im1.` tag
// prefix stops a cursor minted by a DIFFERENT feed (e.g. library-coverage,
// whose cursors have the identical `(timestamp, uuid)` shape since both page
// over `media_items`) from silently decoding here and paginating nonsense.
// ---------------------------------------------------------------------------

const INGEST_MAP_CURSOR_TAG = 'im1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeIngestMapCursor(parts: IngestMapCursor): string {
    return `${INGEST_MAP_CURSOR_TAG}.${encodeKeysetCursor({ ts: parts.createdAt, id: parts.id })}`;
}

function decodeIngestMapCursor(cursor: string): IngestMapCursor | null {
    const dotIdx = cursor.indexOf('.');
    if (dotIdx <= 0) return null;
    if (cursor.slice(0, dotIdx) !== INGEST_MAP_CURSOR_TAG) return null;
    const decoded = decodeKeysetCursor(cursor.slice(dotIdx + 1));
    if (!decoded) return null;
    const { ts: createdAt, id } = decoded;
    // decodeKeysetCursor never throws on malformed input, and base64 decoding
    // is lenient, so both halves must be validated here — otherwise a
    // decodable-but-bogus cursor reaches Postgres as `'foo'::timestamptz` / a
    // uuid column comparison and 500s instead of a validation error.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!UUID_RE.test(id)) return null;
    return { createdAt, id };
}

const WINDOW_MAP: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    all: 100 * 365 * 24 * 60 * 60 * 1000,
};

const DEFAULT_WINDOW_KEY = '24h';
const DEFAULT_LIMIT = 500;

const IngestMapQuerySchema = z.object({
    window: z.enum(['1h', '24h', '7d', '30d', 'all']).optional(),
    mediaType: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z
        .string()
        .optional()
        .transform((v) => (v !== undefined ? parseInt(v, 10) : undefined)),
    // Opaque keyset cursor returned as `nextCursor` on a previous response.
    // When present, pages by (created_at, id) instead of the plain
    // window+limit snapshot.
    cursor: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { query: IngestMapQuerySchema },
    handlers: {
        GET: async (event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const url = event.url;
            const windowKey = url.searchParams.get('window') ?? DEFAULT_WINDOW_KEY;
            const windowSinceMs = WINDOW_MAP[windowKey] ?? WINDOW_MAP[DEFAULT_WINDOW_KEY];

            const rawMediaTypes = url.searchParams.getAll('mediaType');
            const mediaTypes =
                rawMediaTypes.length > 0
                    ? rawMediaTypes.map((t) => (t === 'series' ? 'tv' : t))
                    : undefined;

            const { limit } = parsePagination(url, {
                defaultLimit: DEFAULT_LIMIT,
                maxLimit: 2000,
            });

            const cursorParam = url.searchParams.get('cursor') ?? undefined;
            let cursor: IngestMapCursor | undefined;
            if (cursorParam) {
                const decoded = decodeIngestMapCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');
                cursor = decoded;
            }

            const until = new Date();
            const since = new Date(until.getTime() - windowSinceMs);
            const windowBlock = {
                since: since.toISOString(),
                until: until.toISOString(),
            };

            if (cursor) {
                // Cursor mode ONLY: oversample by one row so `hasMore`/
                // `nextCursor` can be derived without a separate COUNT query.
                // `items` is then sliced back to `limit`. Confined to this
                // branch so offset mode's query call/computation below stays
                // untouched (this feed is always cursor-eligible:
                // media_items.created_at is NOT NULL, so no null-group
                // handling applies).
                const [rawRows, summaryBuckets] = await Promise.all([
                    loadIngestMap(sql, { windowSinceMs, mediaTypes, limit: limit + 1, cursor }),
                    loadIngestMapSummaryBuckets(sql, { windowSinceMs }),
                ]);

                const hasMore = rawRows.length > limit;
                const items = rawRows.slice(0, limit);

                let nextCursor: string | undefined;
                if (hasMore && items.length > 0) {
                    const last = items[items.length - 1];
                    // created_at_cursor is `created_at::text` straight from
                    // Postgres — never the parsed `Date`, whose toISOString()
                    // truncates to milliseconds (see IngestMapItem doc comment).
                    if (last.created_at_cursor !== undefined) {
                        nextCursor = encodeIngestMapCursor({
                            createdAt: last.created_at_cursor,
                            id: last.media_item_id,
                        });
                    }
                }

                // Cursor mode: drop the offset-mode-only `truncated` signal in
                // favor of the explicit `hasMore` boolean; keep items/limit.
                return json({
                    items,
                    summaryBuckets,
                    window: windowBlock,
                    page: { limit, hasMore, ...(nextCursor ? { nextCursor } : {}) },
                });
            }

            // First page: use a lookahead row so an exact-limit result is terminal.
            const [rawItems, summaryBuckets] = await Promise.all([
                loadIngestMap(sql, { windowSinceMs, mediaTypes, limit: limit + 1 }),
                loadIngestMapSummaryBuckets(sql, { windowSinceMs }),
            ]);

            const truncated = rawItems.length > limit;
            const items = rawItems.slice(0, limit);
            if (truncated) {
                logger.warn('GET /api/admin/ingest/map: result set hit limit cap', {
                    limit,
                    windowKey,
                });
            }

            // Mint continuation from the last returned item, excluding the lookahead row.
            let nextCursor: string | undefined;
            if (truncated && items.length > 0) {
                const last = items[items.length - 1];
                if (last.created_at_cursor !== undefined) {
                    nextCursor = encodeIngestMapCursor({
                        createdAt: last.created_at_cursor,
                        id: last.media_item_id,
                    });
                }
            }

            return json({
                items,
                summaryBuckets,
                window: windowBlock,
                page: { limit, hasMore: truncated, ...(nextCursor ? { nextCursor } : {}) },
            });
        },
    },
});
