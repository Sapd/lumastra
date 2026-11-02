// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/trickplay-hwaccel-deny/index.ts
 *
 * GET    /api/admin/trickplay-hwaccel-deny
 * DELETE /api/admin/trickplay-hwaccel-deny?codec=…&pixFmt=…
 *
 * Read/reset surface for the trickplay generator's learned hardware-decode
 * deny list (see trickplay-generator.service.ts's `HwaccelDenyList` — codecs
 * this box has been PROVEN unable to hardware-decode). GET lists what is
 * currently denied for `TRICKPLAY_HWACCEL_DEVICE` so an operator can see WHAT
 * is being avoided before deciding to clear it.
 *
 * DELETE clears entries: one `${codec}:${pixFmt}` entry when both `codec` and
 * `pixFmt` are given, otherwise every entry for the device. Deleting the cache
 * keys alone would leave every replica's in-process latch enforcing the old
 * verdict — this dispatches through `resetOneHwaccelDeny`/`resetAllHwaccelDeny`,
 * which also publish the reset to every replica (see
 * `$lib/server/cache/trickplay-hwaccel-deny-bus.ts`). That cross-replica step
 * is the whole point: an admin action that only cleared the cache is exactly
 * what did NOT fix the 2026-08-07 incident.
 *
 * Auth: admin.
 * Surface: internal-only (human-dashboard diagnostics, no automation value —
 * mirrors defs/admin/transcode-capabilities, the same shape of surface for
 * the transcoding backend's own deny-map).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    listHwaccelDenyEntries,
    resetAllHwaccelDeny,
    resetOneHwaccelDeny,
} from '$lib/server/services/trickplay-generator.service.js';
import {
    TrickplayHwaccelDenyListResponseSchema,
    TrickplayHwaccelDenyClearedResponseSchema,
} from '$lib/schemas/api-trickplay-hwaccel-deny.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminTrickplayHwaccelDenyAPI');

const TrickplayHwaccelDenyQuerySchema = z
    .object({
        // DELETE-only. GET ignores these. Both together pick one entry; neither
        // present is the clear-all case — mirrors defs/admin/transcode-failures's
        // "presence of category" scoping.
        codec: z.string().min(1).optional(),
        pixFmt: z.string().min(1).optional(),
    })
    .refine((q) => (q.codec === undefined) === (q.pixFmt === undefined), {
        message: 'codec and pixFmt must be given together, or not at all',
    });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: TrickplayHwaccelDenyQuerySchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List trickplay hardware-decode deny entries',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Codec/pixel-format combinations this box has been proven unable to ' +
                'hardware-decode for trickplay generation, scoped to `TRICKPLAY_HWACCEL_DEVICE`.',
            responses: {
                200: {
                    schema: TrickplayHwaccelDenyListResponseSchema,
                    description: 'Currently denied entries',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin'],
            summary: 'Clear trickplay hardware-decode deny entries',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Clears the learned deny entries and resets the in-process latch on every ' +
                'replica — a reset that only cleared the cache would leave replicas that had ' +
                'already latched a codec off enforcing it until they restarted. With `codec` ' +
                'and `pixFmt` it clears that one entry; without, it clears every entry for the ' +
                'device.',
            responses: {
                200: {
                    schema: TrickplayHwaccelDenyClearedResponseSchema,
                    description: 'Entries removed',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async () => {
            const denied = await listHwaccelDenyEntries();
            return json(
                TrickplayHwaccelDenyListResponseSchema.parse({
                    device: config.TRICKPLAY_HWACCEL_DEVICE,
                    denied,
                }),
            );
        },
        DELETE: async (_event, ctx) => {
            const { codec, pixFmt } = ctx.input!.query!;

            const cleared =
                codec !== undefined && pixFmt !== undefined
                    ? await resetOneHwaccelDeny(`${codec}:${pixFmt}`)
                    : await resetAllHwaccelDeny();

            logger.info('Trickplay hwaccel deny entries cleared', {
                scope: codec !== undefined ? `${codec}:${pixFmt}` : '(all)',
                cleared,
            });

            return json(TrickplayHwaccelDenyClearedResponseSchema.parse({ cleared }));
        },
    },
});
