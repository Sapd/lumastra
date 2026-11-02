// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/ffmpeg-jobs
 *
 * GET    → { jobs, count, config }   list all active FFmpeg transcoding jobs
 * DELETE → { stopped, playSessionId } stop a specific job (by ?playSessionId=)
 *
 * Auth:    playback:admin (or admin)
 * Surface: internal
 *
 * Errors: problem+json
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { FFmpegJobsResponseSchema } from '$lib/schemas/admin-types.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';
import { config, features } from '$lib/server/config.js';

const logger = Logger.for('ffmpeg-jobs-admin');

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['playback:admin', 'admin'] },
    visibility: 'internal',
    // No shared request schema — GET has no query params; DELETE validates
    // ?playSessionId inline (required only for DELETE).
    handlers: {
        GET: async () => {
            const service = getFFmpegTranscodeService();
            const jobs = await service.getAllActiveJobsInfoMultiPod();

            return json(
                FFmpegJobsResponseSchema.parse({
                    jobs,
                    count: jobs.length,
                    config: {
                        enabled: features.ffmpegAvailable,
                        transcodingMode: config.TRANSCODING_MODE,
                        gpuAcceleration: config.GPU_ACCELERATION,
                        segmentDuration: config.FFMPEG_SEGMENT_DURATION,
                        maxJobsPerUser: config.FFMPEG_MAX_JOBS_PER_USER,
                        inactivityTimeoutSeconds: config.FFMPEG_INACTIVITY_TIMEOUT_SECONDS,
                        progressTimeoutSeconds: config.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
                        segmentsKeepBehind: config.FFMPEG_SEGMENT_KEEP_BEHIND,
                        transcodeDir: config.FFMPEG_TRANSCODE_DIR,
                    },
                }),
            );
        },

        DELETE: async (event) => {
            const playSessionId = event.url.searchParams.get('playSessionId');
            if (!playSessionId) {
                return ApiProblem.validationFailed('playSessionId query parameter is required');
            }

            const service = getFFmpegTranscodeService();
            const stopped = await service.stopJob(playSessionId, 'admin_request');

            if (stopped) {
                logger.info('Admin stopped FFmpeg job', { playSessionId });
                return json({ stopped: true as const, playSessionId });
            } else {
                return ApiProblem.notFound('FFmpeg job not found');
            }
        },
    },
});
