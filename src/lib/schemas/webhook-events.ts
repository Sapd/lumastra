// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '$lib/shared/webhook-events.js';

export const WebhookEventsResponseSchema = z
    .object({
        items: z.array(
            z.object({
                type: z.enum(WEBHOOK_EVENT_TYPES),
                description: z.string(),
                label: z.string(),
            }),
        ),
    })
    .meta({ id: 'WebhookEventsResponse' });
