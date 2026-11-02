// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getArtists, countArtists } from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { toArtistSummary } from '$lib/server/services/music/track-projection.js';

const logger = Logger.for('MusicArtistsAPI');

// This route is mounted under /api, so it emits internal-surface URLs.

export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ url, locals }) => {
        if (!locals.user) return ApiProblem.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

        const genre = url.searchParams.get('genre') ?? undefined;
        const sortParam = url.searchParams.get('sort');
        // Annotated, not inferred: this now feeds an object literal, and a
        // widened `string` no longer satisfies MusicQueryOptions['sort'].
        const sort: 'alpha' | 'year' | 'recent' =
            sortParam === 'alpha' || sortParam === 'year' || sortParam === 'recent'
                ? sortParam
                : 'alpha';
        const { limit, offset } = parsePagination(url, { defaultLimit: 100, maxLimit: 200 });

        // Push the access boundary INTO the SQL so LIMIT/OFFSET operate over the
        // already-filtered set. The previous code fetched a page then dropped
        // inaccessible rows with filterAccessibleRows(), which (a) returned
        // short pages and (b) made hasMore/total uncomputable. Over-fetch one
        // extra row to derive a correct hasMore without a COUNT query.
        // Opt-in total: index rows want a count, infinite scroll does not want
        // to pay for a COUNT on every page. Absent the flag this is byte-for-
        // byte the previous behaviour.
        const includeTotalParam = url.searchParams.get('includeTotal');
        const includeTotal = includeTotalParam === '1' || includeTotalParam === 'true';

        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        const queryOptions = {
            genre,
            sort,
            access: searchAccessBoundary(accessCtx),
            excludeVariousArtists: true,
        };
        const [rows, total] = await Promise.all([
            getArtists(sql, { ...queryOptions, limit: limit + 1, offset }),
            includeTotal ? countArtists(sql, queryOptions) : Promise.resolve(undefined),
        ]);

        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const imageSets = await resolveImageSets(
            sql,
            url.pathname.startsWith('/api/v1/') ? 'v1' : 'internal',
            pageRows.map((row) => ({ id: row.id, mediaType: 'artist' })),
        );
        const items = pageRows.map((row) => toArtistSummary(row, imageSets.get(row.id) ?? {}));

        logger.debug('Artists listed', {
            username: locals.user.username,
            count: items.length,
            hasMore,
            genre,
            sort,
        });

        return json(
            paginate(items, {
                limit,
                offset,
                hasMore,
                ...(total !== undefined ? { total } : {}),
            }),
        );
    }),
);
