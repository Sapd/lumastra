// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { getDb } from '$lib/server/database/connection.js';
import { resolveCatalogInternalId } from './resolve-id.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { SharingPolicySchema, type SharingPolicy } from '$lib/schemas/api-content-responses.js';
import {
    buildSocialAudienceReach,
    getDesignatedTrustGroups,
    resolveSocialAudienceMode,
} from '$lib/server/database/queries/builders/social-visibility.builder.js';

const BodySchema = z.object({ shared: z.boolean() });

export async function readSharingPolicy(
    sql: NonNullable<ReturnType<typeof getDb>>,
    userId: string,
    mediaId: string,
): Promise<SharingPolicy | null> {
    const designated = getDesignatedTrustGroups();
    const audience = resolveSocialAudienceMode(undefined, designated);
    const rows = await sql<
        {
            shared: boolean;
            globally_shared: boolean;
            hide_streams: boolean;
            has_audience: boolean;
        }[]
    >`
        SELECT
            NOT EXISTS (
                SELECT 1 FROM user_media_share_opt_out opt
                WHERE opt.user_id = u.id AND opt.media_id = ${mediaId}::uuid
            ) AS shared,
            u.share_audiobook_activity AS globally_shared,
            u.hide_streams,
            ${buildSocialAudienceReach(sql, 'u', audience, designated)} AS has_audience
        FROM users u
        WHERE u.id = ${userId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;
    const blockedBy: SharingPolicy['blockedBy'] = [];
    if (!row.globally_shared) blockedBy.push('global_sharing_off');
    if (row.hide_streams) blockedBy.push('hidden');
    if (!row.shared) blockedBy.push('item_opted_out');
    if (!row.has_audience) blockedBy.push('no_audience');
    return {
        shared: row.shared,
        globallyShared: row.globally_shared,
        effectiveShared: blockedBy.length === 0,
        audience,
        blockedBy,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    docs: {
        GET: {
            tags: ['Catalog'],
            summary: 'Get audiobook sharing preference',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns SharingPolicy: global and per-book preferences, the resolved operator audience (auto without groups means household), and every reason sharing is blocked. Effective sharing requires global sharing on, streams not hidden, no item opt-out, and at least one other live user in the audience who opted in to audiobook sharing.',
            responses: {
                200: { schema: SharingPolicySchema },
                401: 'Authentication required',
                404: 'Audiobook not found',
                503: 'Database unavailable',
            },
        },
        PUT: {
            tags: ['Catalog'],
            summary: 'Update audiobook sharing preference',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Shares or suppresses the authenticated user’s historical and future social activity for one audiobook.',
            body: BodySchema,
            responses: {
                200: { schema: SharingPolicySchema },
                401: 'Authentication required',
                404: 'Audiobook not found',
                503: 'Database unavailable',
            },
        },
    },
    request: { body: BodySchema },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');
            const user = event.locals.principal ?? event.locals.user;
            if (!user?.userId) return ApiProblem.unauthorized();

            const mediaId = await resolveCatalogInternalId(event);
            if (!mediaId || !(await checkMediaAccess(sql, mediaId, event.locals.user))) {
                return ApiProblem.notFound('Audiobook not found');
            }
            const media = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${mediaId}::uuid
            `;
            if (media[0]?.media_type !== 'audiobook') {
                return ApiProblem.notFound('Audiobook not found');
            }

            const response = await readSharingPolicy(sql, user.userId, mediaId);
            return response ? typedJson(SharingPolicySchema, response) : ApiProblem.unauthorized();
        },
        PUT: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');
            const user = event.locals.principal ?? event.locals.user;
            if (!user?.userId) return ApiProblem.unauthorized();

            const mediaId = await resolveCatalogInternalId(event);
            if (!mediaId || !(await checkMediaAccess(sql, mediaId, event.locals.user))) {
                return ApiProblem.notFound('Audiobook not found');
            }
            const media = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${mediaId}::uuid
            `;
            if (media[0]?.media_type !== 'audiobook') {
                return ApiProblem.notFound('Audiobook not found');
            }

            const body = ctx.input?.body as z.infer<typeof BodySchema> | undefined;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);
            if (body.shared) {
                await sql`
                    DELETE FROM user_media_share_opt_out
                    WHERE user_id = ${user.userId}::uuid AND media_id = ${mediaId}::uuid
                `;
            } else {
                await sql`
                    INSERT INTO user_media_share_opt_out (user_id, media_id)
                    VALUES (${user.userId}::uuid, ${mediaId}::uuid)
                    ON CONFLICT (user_id, media_id) DO NOTHING
                `;
            }

            const response = await readSharingPolicy(sql, user.userId, mediaId);
            return response ? typedJson(SharingPolicySchema, response) : ApiProblem.unauthorized();
        },
    },
});
