// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cluster-wide stream throughput for the admin sessions page: media bandwidth
 * (aggregated across replicas by the bandwidth tracker, with 60 min of history)
 * and the CPU/memory of every running FFmpeg job across pods. Cheap on purpose —
 * Valkey reads only, no GPU probe — so the sessions page can poll it every 5 s.
 */

import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import { bandwidthTracker } from './bandwidth-tracker.service.js';
import type {
    FFmpegAggregateMetrics,
    MediaBandwidth,
    StreamThroughput,
} from '$lib/types/admin-metrics.js';

export async function getStreamThroughput(): Promise<StreamThroughput> {
    const ffmpegJobs = await (async () => {
        try {
            return await getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();
        } catch {
            return [];
        }
    })();

    let ffmpegAggregate: FFmpegAggregateMetrics | undefined;
    if (ffmpegJobs.length > 0) {
        let totalCpu = 0;
        let totalMem = 0;
        for (const job of ffmpegJobs) {
            if (job.cpuPercent !== undefined) totalCpu += job.cpuPercent;
            if (job.memoryMB !== undefined) totalMem += job.memoryMB;
        }
        ffmpegAggregate = {
            totalJobs: ffmpegJobs.length,
            totalCpuPercent: Math.round(totalCpu * 10) / 10,
            totalMemoryMB: Math.round(totalMem),
        };
    }

    let mediaBandwidth: MediaBandwidth | undefined;
    const currentBandwidth = await bandwidthTracker.getAggregatedMetrics();
    if (currentBandwidth) {
        mediaBandwidth = {
            ...currentBandwidth,
            history: await bandwidthTracker.getAggregatedHistory(),
        };
    }
    return { mediaBandwidth, ffmpegAggregate };
}
