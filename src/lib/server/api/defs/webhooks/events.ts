// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { WEBHOOK_EVENTS } from '$lib/shared/webhook-events.js';
import { WebhookEventsResponseSchema } from '$lib/schemas/webhook-events.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Webhooks'],
            summary: 'List delivered webhook event types',
            stability: 'beta',
            description:
                'Returns the catalogue of event types with production webhook delivery. ' +
                'Requires `webhooks:write`, like the webhook list. Use these types in ' +
                '`eventFilter`; an empty filter matches delivered task and media types only; user notifications require explicit selection and user opt-in.',
            responses: {
                200: {
                    schema: WebhookEventsResponseSchema,
                    description: 'Delivered event catalogue',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
            },
        },
    },
    auth: { kind: 'scope', anyOf: ['webhooks:write'] },
    handlers: {
        GET: async () => json({ items: WEBHOOK_EVENTS }),
    },
});
