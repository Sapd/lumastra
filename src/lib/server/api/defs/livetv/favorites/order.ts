// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/favorites/order.ts — PUT /livetv/favorites/order
 *
 * Body: { channelIds } — the desired display order.
 * Response: { channelIds } (the resulting list).
 *
 * PERMUTE ONLY. This never inserts and never deletes: ids that are not current
 * favorites are ignored, and current favorites the payload omits are appended
 * in their existing relative order. That is what lets a reorder from one Apple
 * TV coexist with a favorite added seconds earlier on another without either
 * write losing data — no version token or 409 retry loop required.
 *
 * Auth: feature:FEATURE_LIVETV → user; the LIVETV_GROUPS membership gate is
 * validated inline (user trait, not a bearer scope) — same as /livetv/channels.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    lockSimpleModeRow,
    simpleModeLocksFavorites,
} from '$lib/server/database/queries/livetv-simple-mode.queries.js';
import {
    batchUpdateFavoriteSortOrder,
    feedStationMap,
    stationIdsOfFeeds,
    getFavoriteChannelIds,
    getFavoritesForUpdate,
    type FavoriteOrderRow,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    LiveTvFavoritesOrderSchema,
    LiveTvFavoritesResponseSchema,
    type LiveTvFavoritesOrder,
} from '$lib/schemas/livetv.js';

/**
 * Canonical display comparator, mirroring
 * `ORDER BY sort_order NULLS LAST, created_at, channel_id`
 * in getFavoriteChannelIds.
 *
 * NULL must be handled explicitly: a bare `a.sort_order - b.sort_order` yields
 * NaN for unhealed rows and silently scrambles the list.
 *
 * Exported for test only. `order.test.ts` asserts this stays in agreement with
 * the SQL sort key — the two are separate expressions of one rule, and nothing
 * but that test links them.
 */
export function compareFavorites(a: FavoriteOrderRow, b: FavoriteOrderRow): number {
    if (a.sort_order === null && b.sort_order !== null) return 1;
    if (a.sort_order !== null && b.sort_order === null) return -1;
    if (a.sort_order !== null && b.sort_order !== null && a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
    }
    const aTime = a.created_at.getTime();
    const bTime = b.created_at.getTime();
    if (aTime !== bTime) return aTime - bTime;
    return a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0;
}

/**
 * Resolve the requested order against the user's actual favorites.
 *
 * PERMUTE ONLY — the result is always a permutation of `rows`, never longer or
 * shorter. `requestedIds` entries that are not current favorites (stale ids,
 * another user's channels, valid-but-unfavorited UUIDs) are dropped, duplicates
 * collapse to their first occurrence, and favorites the payload omitted are
 * appended in their existing display order.
 *
 * That last part is why the caller must not feed this the raw locked rows:
 * getFavoritesForUpdate locks in channel_id order for deadlock avoidance, which
 * is not display order. Sorting happens here so the two cannot drift apart.
 *
 * Exported and pure so the ordering rules are testable without a live request.
 */
export function computeFavoriteOrder(rows: FavoriteOrderRow[], requestedIds: string[]): string[] {
    const ordered = [...rows].sort(compareFavorites);

    const current = new Set(ordered.map((row) => row.channel_id));
    const seen = new Set<string>();
    const head: string[] = [];
    for (const id of requestedIds) {
        if (current.has(id) && !seen.has(id)) {
            seen.add(id);
            head.push(id);
        }
    }
    const tail = ordered.map((row) => row.channel_id).filter((id) => !seen.has(id));

    return [...head, ...tail];
}

export const def = defineEndpoint({
    docs: {
        PUT: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Reorder your favourite Live TV stations',
            responses: {
                200: {
                    schema: LiveTvFavoritesResponseSchema,
                    description: 'Favorite channel ids in the new display order',
                },
                401: 'Authentication required',
                404: 'Live TV not available',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    request: {
        body: LiveTvFavoritesOrderSchema,
    },
    handlers: {
        PUT: async (event, ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const body = ctx.input?.body as LiveTvFavoritesOrder | undefined;
            if (!body) return ApiProblem.validationFailed('Missing body');

            const userId = locals.user.userId;
            // Locked Live TV simple mode: its channels are these favorites. The
            // check runs under the simple-mode row lock inside the write, so a
            // lock set while this request was in flight cannot be slipped past.
            const stationIds = await sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as typeof sql;
                await lockSimpleModeRow(tx, userId);
                if (await simpleModeLocksFavorites(tx, userId)) return null;

                // Locked in channel_id order (deadlock avoidance);
                // computeFavoriteOrder re-sorts into display order itself.
                const locked = await getFavoritesForUpdate(tx, userId);

                const mapping = await feedStationMap(
                    tx,
                    locked.map((row) => row.channel_id),
                );
                const requestedFeeds = body.stationIds
                    .map((id) => id.toLowerCase())
                    .flatMap((stationId) =>
                        [...locked]
                            .sort(compareFavorites)
                            .filter((row) => mapping.get(row.channel_id) === stationId)
                            .map((row) => row.channel_id),
                    );

                // An empty payload still rewrites every rank — that is a
                // deliberate NULL-healing path, not a no-op. Do not early-return.
                await batchUpdateFavoriteSortOrder(
                    tx,
                    userId,
                    computeFavoriteOrder(locked, requestedFeeds),
                );

                // Re-read inside the transaction. Under READ COMMITTED each
                // statement takes a fresh snapshot, so a favorite added after
                // the lock above is included. Returning the computed list
                // instead would hand the client a stale list and make that
                // favorite vanish locally.
                return stationIdsOfFeeds(tx, await getFavoriteChannelIds(tx, userId));
            });
            if (stationIds === null) {
                return ApiProblem.forbidden('Live TV simple mode is locked; ask your helper', {
                    details: 'simple_mode_locked',
                });
            }

            return json(
                { stationIds },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },
    },
});
