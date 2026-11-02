// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'FEATURE_USER_PATS', then: { kind: 'user' } },
    request: { params: z.object({ id: z.coerce.number().int().positive() }) },
    docs: {
        DELETE: {
            tags: ['User'],
            summary: 'Revoke a personal access token',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Revoked',
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                404: 'Token not found',
                422: 'Invalid token ID',
            },
        },
    },
    handlers: {
        DELETE: async (event) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const id = Number(event.params.id);
            if (!Number.isSafeInteger(id) || id <= 0)
                return ApiProblem.validationFailed('Invalid token ID');
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();
            if (!(await getPatService().revoke(id, userId)))
                return ApiProblem.notFound('Token not found');
            return new Response(null, { status: 204 });
        },
    },
});
