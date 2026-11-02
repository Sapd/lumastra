// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { requireAdminCeilingForTargetId } from '$lib/server/api/token-minting.js';
export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_USER_PATS',
        then: { kind: 'scope', anyOf: ['tokens:admin'] },
    },
    request: {
        params: z.object({ id: z.string().uuid(), tokenId: z.coerce.number().int().positive().max(2147483647) }),
    },
    docs: {
        DELETE: {
            tags: ['Users'],
            summary: 'Revoke a user’s PAT',
            stability: 'stable',
            auth: 'bearer',
            responses: { 204: 'Revoked', 404: 'Token not found', 422: 'Invalid ID' },
        },
    },
    handlers: {
        DELETE: async (event) => {
            const id = Number(event.params.tokenId);
            if (!Number.isSafeInteger(id) || id <= 0)
                return ApiProblem.validationFailed('Invalid token ID');
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');
            // Admin ceiling (release review 2026-10-21, finding 3): a
            // tokens:admin delegate must not revoke an administrator's PATs.
            const ceilingErr = await requireAdminCeilingForTargetId(
                event,
                db,
                event.params.id!,
                "Only administrators can revoke an administrator's tokens",
            );
            if (ceilingErr) return ceilingErr;
            // revoke() is scoped to (id, user_id): a PAT of another user is a 404.
            if (!(await getPatService().revoke(id, toUserId(event.params.id!))))
                return ApiProblem.notFound('Token not found');
            const target = await getUserById(db, event.params.id!).catch(() => null);
            auditLog('pat.revoke', target?.username ?? event.params.id!, auditActor(event), {
                patId: id,
            });
            return new Response(null, { status: 204 });
        },
    },
});
