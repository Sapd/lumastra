// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/playback/gpu-detect
 *
 * Admin-only hardware transcode probe for configuration. Mirrors the setup
 * wizard's one-frame encoder test but lives under admin playback settings.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { detectGpuForOnboarding } from '$lib/server/services/transcoding/gpu-detection.js';

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const result = await detectGpuForOnboarding();
        return json({
            ffmpegReady: result.ffmpegReady,
            recommended: result.recommended,
            recommendedVendor: result.recommendedVendor,
            candidates: result.candidates,
        });
    }),
);
