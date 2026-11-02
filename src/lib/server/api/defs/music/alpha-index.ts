// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/alpha-index.ts — `GET /music/alpha-index`.
 *
 * Per-initial offsets for an A–Z seek rail over one of the music browse
 * collections. A client asks once, then jumps straight to `?offset=` for the
 * letter the user touched instead of paging forward until it finds it.
 *
 * The offsets address the SAME listing `sort=alpha` returns, under the same
 * filters — see `getAlphaIndex` for why they are computed with ROW_NUMBER()
 * rather than by summing per-letter counts (database collation does not sort
 * strictly by first character, so cumulative counts drift out of alignment and
 * the rail lands on the wrong row).
 *
 * One endpoint with an `entity` parameter rather than three sub-resources: the
 * three collections differ only in which filters apply, and a single shape
 * keeps the client's rail code identical across tabs.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getAlphaIndex,
    type AlphaIndexEntity,
} from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';

const logger = Logger.for('MusicAlphaIndexDef');

const QuerySchema = z.object({
    entity: z.enum(['tracks', 'albums', 'artists']).optional().meta({
        description: 'Which collection to index. Default: tracks.',
    }),
    genre: z.string().optional().meta({ description: 'Same genre filter as the browse call.' }),
    artist: z.string().optional().meta({
        description: 'Same artist-name filter as the browse call (albums/tracks).',
    }),
    artistId: z.string().optional().meta({
        description: 'Same credit-aware artist UUID filter as the browse call (albums/tracks).',
    }),
});

const AlphaIndexBucketSchema = z.object({
    key: z.string().meta({ description: "Upper-case initial, or '#' for anything not A–Z." }),
    offset: z.number().int().meta({
        description: 'Zero-based offset of this bucket in the sort=alpha listing.',
    }),
    count: z
        .number()
        .int()
        .meta({
            description:
                'Length of the listing segment starting at `offset` — the distance to the next ' +
                "bucket's offset. `offset + count` is where the next letter begins, and the " +
                'counts sum to the total listing size, so a scrollbar can be sized off them. ' +
                'This is NOT a population count of that initial: database collation scatters a ' +
                'few rows away from their own letter (e.g. `[theatre]` sorts under T), and a ' +
                'per-letter population would not line up with the offsets.',
        }),
});

const AlphaIndexResponseSchema = z
    .object({
        entity: z.enum(['tracks', 'albums', 'artists']),
        buckets: z.array(AlphaIndexBucketSchema),
    })
    .meta({ id: 'MusicAlphaIndexResponse' });

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: QuerySchema },

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Alphabetical seek index for a music collection',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the offset and size of each A–Z bucket in the `sort=alpha` listing of ' +
                'tracks, albums, or artists, so an A–Z rail can jump straight to a letter. Pass ' +
                'the SAME filters you pass to the browse call — the offsets only address the ' +
                'listing produced by those filters. Buckets with no rows are omitted, so a rail ' +
                'can grey out the letters it does not get back. Keys are always A–Z or `#`: ' +
                'accented initials fold to their base letter (`ÄTNA` is under A), which is ' +
                'where the collation orders them anyway.',
            query: QuerySchema,
            responses: {
                200: { schema: AlphaIndexResponseSchema, description: 'Alphabetical buckets' },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const entityParam = event.url.searchParams.get('entity');
            const entity: AlphaIndexEntity =
                entityParam === 'albums' || entityParam === 'artists' ? entityParam : 'tracks';

            const accessCtx = await buildSearchAccessContext(sql, user);
            const buckets = await getAlphaIndex(sql, entity, searchAccessBoundary(accessCtx), {
                genre: event.url.searchParams.get('genre') ?? undefined,
                artist: event.url.searchParams.get('artist') ?? undefined,
                artistId: event.url.searchParams.get('artistId') ?? undefined,
            });

            logger.debug('Alpha index built', {
                username: user.username,
                entity,
                buckets: buckets.length,
            });

            return json({ entity, buckets });
        },
    },
});
