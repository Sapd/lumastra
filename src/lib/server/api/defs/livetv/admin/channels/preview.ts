// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/preview.ts — GET /livetv/admin/channels/preview
 *
 * The channel lineup exactly as viewers and /j clients receive it: after
 * visibility and backup-group filtering, in viewer order, with /j channel
 * numbers.
 *
 * The admin channel list shows every row, but only a backup group's primary
 * reaches viewers — so a "visible" row can still be withheld. This endpoint is
 * the ground truth to compare that list against.
 *
 * Composed through the LiveTV provider rather than the raw queries, and
 * deliberately so: the provider also applies the display-name cleanup
 * (`viewerChannelNames` under LIVETV_HIDE_QUALITY_TAGS) that every viewer
 * surface sees. Reading the queries directly would render "UK: MTK FHD" where
 * viewers see "MTK" — a preview that drifts from the viewer is worse than no
 * preview.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { numberChannelsForLineup } from '$lib/server/services/livetv/channel-numbering.js';
import { ViewerPreviewResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Preview the lineup as viewers receive it',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ViewerPreviewResponseSchema,
                    description: 'Viewer-visible channels in viewer order with /j numbers',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const provider = await getLiveTvProvider();
            const [channels, categories] = await Promise.all([
                provider.getChannels(),
                provider.getCategories(),
            ]);

            const categoryNames = new Map(categories.map((cat) => [cat.id, cat.name]));
            const numbered = numberChannelsForLineup(channels, categories);

            return json({
                channels: numbered.map(({ channel, number }) => ({
                    id: channel.id,
                    name: channel.name,
                    number,
                    categoryId: channel.categoryId,
                    categoryName: channel.categoryId
                        ? categoryNames.get(channel.categoryId)
                        : undefined,
                    qualityTier: channel.qualityTier,
                })),
                totalChannels: numbered.length,
            });
        },
    },
});
