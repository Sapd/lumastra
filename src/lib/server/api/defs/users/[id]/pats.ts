// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { requireAdminCeilingForTargetId } from '$lib/server/api/token-minting.js';
import { patCreateBodySchema } from '$lib/schemas/admin.js';
import {
    UserTokenListResponseSchema,
    AdminPatCreateResponseSchema,
} from '$lib/schemas/api-user-responses';
import { def as admin } from '../../admin/pats.js';
const body = patCreateBodySchema.omit({ userId: true });
export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_USER_PATS',
        then: { kind: 'scope', anyOf: ['tokens:admin'] },
    },
    request: { params: z.object({ id: z.string().uuid() }), body },
    docs: {
        GET: {
            tags: ['Users'],
            summary: 'List a user’s PATs',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: UserTokenListResponseSchema, description: 'Personal access tokens' },
                404: 'User not found',
                422: 'Invalid user ID',
            },
        },
        POST: {
            tags: ['Users'],
            summary: 'Create a user’s PAT',
            stability: 'stable',
            auth: 'bearer',
            body,
            responses: {
                201: { schema: AdminPatCreateResponseSchema, description: 'Token shown once' },
                404: 'User not found',
                422: 'Invalid input',
            },
        },
    },
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!(await getUserById(db, event.params.id!)))
                return ApiProblem.notFound('User not found');
            // Admin ceiling: a tokens:admin delegate must not enumerate an
            // administrator's PATs (release review 2026-10-21, finding 3).
            const ceilingErr = await requireAdminCeilingForTargetId(
                event,
                db,
                event.params.id!,
                "Only administrators can list an administrator's tokens",
            );
            if (ceilingErr) return ceilingErr;
            const items = await getPatService().listForUser(toUserId(event.params.id!));
            return Response.json(
                paginate(items, { limit: items.length, offset: 0, hasMore: false }),
            );
        },
        POST: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!(await getUserById(db, event.params.id!)))
                return ApiProblem.notFound('User not found');
            let raw: unknown;
            try {
                raw = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid JSON');
            }
            const parsed = body.safeParse(raw);
            if (!parsed.success) return ApiProblem.validationFailed('Invalid PAT body');
            // Keep the caller's headers (user-agent, forwarded-for, …) for the
            // downstream handler; only the body changes, so drop the stale
            // content-length.
            const headers = new Headers(event.request.headers);
            headers.delete('content-length');
            headers.set('content-type', 'application/json');
            event.request = new Request(event.request.url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...parsed.data, userId: event.params.id }),
            });
            return admin.handlers.POST!(event, { surface: ctx.surface });
        },
    },
});
