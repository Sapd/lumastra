// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/transcode-capabilities/index.ts
 *
 * GET  /api/admin/transcode-capabilities
 *   Returns the learned GPU decode-capability cache snapshot (source codecs
 *   the GPU failed to hardware-decode on this host).
 *
 * POST /api/admin/transcode-capabilities  { "action": "reset-decode-cache" }
 *   Resets the learned GPU decode-capability cache. Use after a driver/GPU
 *   change so codecs recorded as not-hardware-decodable get re-probed on the
 *   next play.
 *
 * Auth: admin.
 * Surface: internal-only.
 * Response: bare capability snapshot object.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection.js';
import { config } from '$lib/server/config.js';
import type { GpuAcceleration } from '$lib/server/services/transcoding/types.js';

const logger = Logger.for('transcode-capabilities-admin');

const PostBodySchema = z.object({
    action: z.enum(['reset-decode-cache']),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        // Body only applies to POST; GET ignores it. mount() is lenient about
        // bodies on GET requests (strips + validates only when a body is sent).
        body: PostBodySchema.optional(),
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const backend = config.GPU_ACCELERATION as GpuAcceleration;
            // Ensure hardware detection (incl. the VA-API HDR tone-map probe) has run.
            await hardwareDetection.getCapabilities();
            const snapshot = hardwareDetection.getDecodeCapabilitySnapshot(backend);
            return json({
                gpuAcceleration: config.GPU_ACCELERATION,
                hdrTonemap: hardwareDetection.getHdrTonemapMode(backend),
                ...snapshot,
            });
        },

        POST: async (event, ctx) => {
            const body = ctx.input?.body;
            const action = body?.action ?? 'reset-decode-cache';

            if (action !== 'reset-decode-cache') {
                return ApiProblem.validationFailed([
                    {
                        field: 'action',
                        message: `Unknown action '${action}'. Supported: 'reset-decode-cache'.`,
                    },
                ]);
            }

            // No backend argument -> clear every backend's learned set.
            const cleared = await hardwareDetection.resetDecodeCapabilities();
            logger.info('Admin reset of learned GPU decode-capability cache', { cleared });
            auditLog('transcode_capabilities.reset', 'decode-cache', auditActor(event), {
                cleared,
            });

            const backend = config.GPU_ACCELERATION as GpuAcceleration;
            return json({
                cleared,
                message: `Cleared ${cleared} learned GPU decode-capability entr${cleared === 1 ? 'y' : 'ies'}.`,
                ...hardwareDetection.getDecodeCapabilitySnapshot(backend),
            });
        },
    },
});
