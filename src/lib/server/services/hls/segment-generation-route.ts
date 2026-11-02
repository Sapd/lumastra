// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from 'path';

import type { SegmentGenerationRoute } from '../ffmpeg-transcode.service.js';
import type { TranscodeJob } from '../transcoding/types.js';
import type { SegmentInfo } from '../../utils/hls-segment-utils.js';
import { isPathInsideDirectory } from '../../utils/hls-segment-utils.js';

export interface HlsSegmentGenerationRouteService {
    resolveSegmentRoute(
        playSessionId: string,
        streamDir: string,
        requestedSegmentNum: number,
        options: {
            normalizedPath: string;
            segmentExtension: string;
            fallbackSegmentExtension: string;
            requireRetainedFile: boolean;
            fileExists: (candidatePath: string) => Promise<boolean>;
            allowReclaim?: boolean;
        },
    ): Promise<SegmentGenerationRoute | undefined>;
}

export interface ResolveHlsSegmentGenerationRouteOptions {
    job: TranscodeJob;
    playSessionId: string;
    normalizedPath: string;
    filePath: string;
    isSegment: boolean;
    segmentInfo: SegmentInfo | null;
    requestedSegmentNum: number;
    segmentExtension: string;
    fallbackSegmentExtension: string;
    corsHeaders: Record<string, string>;
    transcodeService: HlsSegmentGenerationRouteService;
    accessFile: (filePath: string) => Promise<void>;
    /**
     * False for an I-frame/thumbnail byte-range request: it must never reclaim
     * a parked generation (that moves the session the player is reading).
     */
    allowReclaim?: boolean;
    logInfo: (message: string, metadata: Record<string, unknown>) => void;
    logWarn: (message: string, metadata: Record<string, unknown>) => void;
}

export interface ResolveHlsSegmentGenerationRouteResult {
    response?: Response;
    job: TranscodeJob;
    filePath: string;
    segmentGenerationRoute?: SegmentGenerationRoute;
}

export async function resolveHlsSegmentGenerationRoute(
    options: ResolveHlsSegmentGenerationRouteOptions,
): Promise<ResolveHlsSegmentGenerationRouteResult> {
    let { job, filePath } = options;
    let segmentGenerationRoute: SegmentGenerationRoute | undefined;

    if (!options.isSegment || !options.segmentInfo || options.requestedSegmentNum < 0) {
        return { job, filePath };
    }

    segmentGenerationRoute = await options.transcodeService.resolveSegmentRoute(
        options.playSessionId,
        options.segmentInfo.streamDir,
        options.requestedSegmentNum,
        {
            normalizedPath: options.normalizedPath,
            segmentExtension: options.segmentExtension,
            fallbackSegmentExtension: options.fallbackSegmentExtension,
            requireRetainedFile: true,
            allowReclaim: options.allowReclaim,
            fileExists: async (candidatePath) => {
                try {
                    await options.accessFile(candidatePath);
                    return true;
                } catch {
                    return false;
                }
            },
        },
    );

    for (const miss of segmentGenerationRoute?.retainedFileMiss ?? []) {
        if (miss.reason === 'path_escape') {
            options.logWarn('Path escapes retained output directory', {
                playSessionId: options.playSessionId,
                filePath: miss.filePath,
                outputDir: miss.job.outputDir,
            });
            continue;
        }

        options.logInfo('Retained generation covered segment by progress but file is missing', {
            ps: options.playSessionId.slice(0, 8),
            stream: options.segmentInfo.streamDir,
            req: options.requestedSegmentNum,
            actual: miss.actualIndex,
            offset: miss.offset,
            generation: miss.job.generationIndex,
            jobId: miss.job.id,
        });
    }

    const resolvedJob = segmentGenerationRoute?.job;
    if (resolvedJob && resolvedJob.id !== job.id) {
        job = resolvedJob;
        filePath = path.join(job.outputDir, options.normalizedPath);

        if (!isPathInsideDirectory(filePath, job.outputDir)) {
            options.logWarn('Path escapes routed output directory', {
                playSessionId: options.playSessionId,
                filePath,
                outputDir: job.outputDir,
            });
            return {
                response: new Response('Invalid path', {
                    status: 400,
                    headers: options.corsHeaders,
                }),
                job,
                filePath,
                segmentGenerationRoute,
            };
        }
    }

    return { job, filePath, segmentGenerationRoute };
}
