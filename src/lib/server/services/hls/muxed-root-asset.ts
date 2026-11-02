// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from 'path';

import type { TranscodeJob } from '../transcoding/types.js';
import { isPathInsideDirectory } from '../../utils/hls-segment-utils.js';
import { isCompleteMp4Init, stripMp4InitEditLists } from '../../utils/mp4-init-edit-list.js';
// Shared with `waitForInitSegment` on purpose: the two waits cover the same
// create->write window and must agree on what counts as a job that has died.
import { isTranscodeJobDead } from './segment-availability.js';

export interface ServeMuxedRootAssetOptions {
    job: TranscodeJob;
    playSessionId: string;
    normalizedPath: string;
    contentType: string;
    isInitSegment: boolean;
    corsHeaders: Record<string, string>;
    waitTimeoutMs: number;
    pollIntervalMs: number;
    getJobByPlaySession: (playSessionId: string) => TranscodeJob | undefined;
    readFile: (filePath: string) => Promise<Buffer>;
    trackHlsSegment: (bytes: number) => void;
    logWarn: (message: string, metadata: Record<string, unknown>) => void;
    sleep?: (ms: number) => Promise<void>;
}

export async function serveMuxedRootAsset(options: ServeMuxedRootAssetOptions): Promise<Response> {
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const job = options.getJobByPlaySession(options.playSessionId) ?? options.job;
    const filePath = path.join(job.outputDir, options.normalizedPath);

    if (!isPathInsideDirectory(filePath, job.outputDir)) {
        options.logWarn('Muxed asset path escapes routed output directory', {
            playSessionId: options.playSessionId,
            filePath,
            outputDir: job.outputDir,
        });
        return new Response('Invalid path', {
            status: 400,
            headers: options.corsHeaders,
        });
    }

    const waitStartedAt = Date.now();
    // A timeout below one poll interval would expire on the first iteration and
    // never retry at all, defeating the wait for the create->write window this
    // exists to cover. Guarantee at least one retry however it is configured.
    const waitTimeoutMs = Math.max(options.waitTimeoutMs, options.pollIntervalMs);
    while (true) {
        let fileBuffer: Buffer | undefined;
        try {
            fileBuffer = await options.readFile(filePath);
        } catch (error) {
            const code =
                error && typeof error === 'object' && 'code' in error
                    ? String((error as { code?: string }).code)
                    : undefined;
            if (code !== 'ENOENT') {
                throw error;
            }
        }

        // Existence is not readiness. FFmpeg creates the file before writing
        // ftyp+moov into it, so after a seek — which deletes the previous init and
        // restarts FFmpeg — a request can land in that create->write window and
        // read 0 bytes, or a part-written prefix. Either is served as a
        // valid-looking 200 that hls.js cannot demux (`fragParsingError`), so both
        // count as "not written yet" and keep the poll going. `isCompleteMp4Init`
        // fails open, so only a definite truncation withholds the file.
        const readyBuffer =
            fileBuffer !== undefined &&
            fileBuffer.length > 0 &&
            (!options.isInitSegment || isCompleteMp4Init(fileBuffer))
                ? fileBuffer
                : undefined;
        if (readyBuffer !== undefined) {
            const body = options.isInitSegment
                ? // Drop edit lists so hls.js doesn't double-apply the seek offset on Firefox.
                  stripMp4InitEditLists(readyBuffer)
                : readyBuffer;
            const fileSize = body.length;
            job.lastAccessedAt = new Date();
            options.trackHlsSegment(fileSize);

            return new Response(body as unknown as ArrayBuffer, {
                status: 200,
                headers: {
                    ...options.corsHeaders,
                    'Content-Type': options.contentType,
                    'Content-Length': fileSize.toString(),
                    'Cache-Control': 'no-cache',
                },
            });
        }

        const jobIsDead = isTranscodeJobDead(
            options.getJobByPlaySession(options.playSessionId) ?? job,
        );
        if (jobIsDead || Date.now() - waitStartedAt >= waitTimeoutMs) {
            options.logWarn('Muxed root asset not ready', {
                playSessionId: options.playSessionId,
                path: options.normalizedPath,
                outputDir: job.outputDir,
                isInitSegment: options.isInitSegment,
                reason: jobIsDead ? 'job-dead' : 'timeout',
                bytesRead: fileBuffer?.length ?? null,
            });
            return new Response(
                options.isInitSegment ? 'Init segment not ready' : 'Segment not ready',
                {
                    status: 404,
                    headers: options.corsHeaders,
                },
            );
        }

        await sleep(options.pollIntervalMs);
    }
}
