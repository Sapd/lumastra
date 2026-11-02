// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { toPublicMediaType } from '$lib/shared/media-type-domain.js';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { classifyMediaInfraError } from '../../infra-retry.js';
import { registry } from '../../registry.js';
import { getMediaItemForImageSync } from '$lib/server/database/queries/image-sync.queries.js';
import { maintainEpisodePictures } from '$lib/server/services/episode-picture-maintenance.service.js';
import { extractFramesBatch } from '$lib/server/services/video-frame-extractor.service.js';

const reviewedInputSchema = z.object({
    episodeId: z.string().uuid(),
    fileId: z.string().uuid(),
    videoPath: z.string(),
    selectedCandidateId: z.string().uuid().nullable(),
    durationSeconds: z.number(),
    fileGeneration: z.string(),
    mediaGeneration: z.string(),
    siblingGeneration: z.string(),
    artworkGeneration: z.string(),
    physicalIdentity: z.string(),
    span: z.object({ base: z.number(), duration: z.number() }),
});

const inputSchema = z.object({
    mediaItemId: z.string().uuid(),
    scope: z.enum(['series', 'season', 'episode']).optional(),
    mode: z.enum(['execute', 'plan']).default('execute'),
    reviewedInput: reviewedInputSchema.optional(),
});

/** Explicit admin work, isolated from the fast per-item image scanning queue. */
export const episodeThumbnailExtractTask = defineTask({
    id: 'episode-thumbnail-extract',
    purpose: 'library',
    name: 'Extract Episode Thumbnails',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, ffmpeg: true },
    identityFor: (input) => input.mediaItemId,
    exclusiveWith: { scope: 'global', ttl: '130m' },
    scope: 'global',
    manualOnly: true,
    resourceClass: 'analysis',
    quotas: { maxConcurrent: 1 },
    timeout: { hard: '2h', soft: '115m' },
    retry: { attempts: 6, backoff: [30_000], retryOn: classifyMediaInfraError },
    inputSchema,
    async execute(ctx) {
        const item = await getMediaItemForImageSync(ctx.sql, ctx.input.mediaItemId);
        if (!item) throw new TaskError({ kind: 'permanent', message: 'Media item does not exist' });
        const scope = toPublicMediaType(item.media_type);
        if (scope !== 'series' && scope !== 'season' && scope !== 'episode')
            throw new TaskError({
                kind: 'permanent',
                message: 'Expected a series, season or episode',
            });
        if (ctx.input.scope && ctx.input.scope !== scope)
            throw new TaskError({
                kind: 'permanent',
                message: 'Thumbnail scope does not match media item',
            });
        const signal = ctx.softSignal ? AbortSignal.any([ctx.signal, ctx.softSignal]) : ctx.signal;
        const result =
            scope === 'episode'
                ? await extractFramesBatch(ctx.sql, {
                      mediaItemId: item.id,
                      scope,
                      mode: ctx.input.mode,
                      artworkType: 'thumb',
                      force: true,
                      selectAsAdmin: true,
                      signal,
                      reviewedInput: ctx.input.reviewedInput,
                      onProgress: (processed, total) => ctx.reportProgress(processed, total),
                  })
                : await maintainEpisodePictures(
                      ctx.sql,
                      item.id,
                      signal,
                      ctx.input.mode,
                      (processed, total) => ctx.reportProgress(processed, total),
                  );
        if (result.transientError && !signal.aborted) {
            throw new TaskError({ kind: 'transient', message: result.transientError });
        }
        return {
            success:
                !signal.aborted && result.errors === 0 && !('capped' in result && result.capped),
            itemsProcessed: result.extracted,
            ...(signal.aborted ? { stopReason: 'aborted' as const } : {}),
            result,
        };
    },
});
registry.registerTask(episodeThumbnailExtractTask);
