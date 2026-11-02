// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { refreshRateLimit } from './_refresh-rate-limit.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { def as readDef, UpcomingQuerySchemaFromDocs, handleUpcoming } from './upcoming.js';

const RefreshBody = UpcomingQuerySchemaFromDocs.loose().superRefine((body, ctx) => {
    for (const field of ['refresh']) {
        if (field in body)
            ctx.addIssue({
                code: 'custom',
                path: [field],
                message: 'Not accepted by this refresh action',
            });
    }
});

const refreshDocs = { ...readDef.docs!.GET! };
delete refreshDocs.query;

export const def = defineEndpoint({
    auth: readDef.auth,
    rateLimit: refreshRateLimit,
    docs: {
        POST: {
            ...refreshDocs,
            responses: {
                ...refreshDocs.responses,
                422: 'Invalid refresh filters',
                429: 'Refresh budget exhausted (30/minute per user)',
            },
            summary: 'Refresh upcoming',
            description:
                'Explicit synchronous refresh of the existing result. ' +
                'Calendar view reads the existing calendar; it does not synchronize Sonarr.',
            body: UpcomingQuerySchemaFromDocs,
        },
    },
    request: { body: RefreshBody },
    handlers: { POST: (event, ctx) => handleUpcoming(event, ctx, ctx.input!.body!, true) },
});
