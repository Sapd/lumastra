// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineEndpoint } from '$lib/server/api/define.js';
import { StreamPrivacyResponseSchema } from '$lib/schemas/api-user-responses.js';
import { def as streamPrivacyDef, StreamPrivacyBody } from '../user/stream-privacy.js';

/** Public app contract over the web's existing self-scoped privacy implementation. */
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { body: StreamPrivacyBody },
    docs: {
        GET: {
            operationId: 'getMyPrivacy',
            tags: ['Me'],
            summary: 'Get my privacy preferences',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns only the authenticated user’s privacy preferences. Accepts device tokens and personal access tokens.',
            responses: {
                200: { schema: StreamPrivacyResponseSchema },
                401: 'Authentication required',
                404: 'User not found',
                503: 'Database unavailable',
            },
        },
        PATCH: {
            operationId: 'updateMyPrivacy',
            tags: ['Me'],
            summary: 'Update my privacy preferences',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Updates only the authenticated user’s privacy preferences. Accepts device tokens and personal access tokens. Supply at least one boolean; omitted fields keep their stored values. Audiobook activity sharing has no effect while hideFromOthers is true.',
            body: StreamPrivacyBody,
            responses: {
                200: { schema: StreamPrivacyResponseSchema },
                401: 'Authentication required',
                403: 'Token does not permit this method',
                404: 'User not found',
                422: 'At least one privacy boolean is required',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: streamPrivacyDef.handlers.GET!,
        PATCH: streamPrivacyDef.handlers.POST!,
    },
});
