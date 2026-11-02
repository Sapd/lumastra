// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resource Monitor Utilities
 *
 * Provides utilities for monitoring process resource usage (CPU, memory, GPU)
 * for FFmpeg transcode jobs.
 */

import { promisify } from 'util';
import { exec } from 'child_process';
import { isRecord } from '$lib/utils/data-extraction';

const execAsync = promisify(exec);

export interface ProcessResourceUsage {
    cpuPercent?: number;
    memoryMB?: number;
}

/**
 * Get CPU and memory usage for a process by PID.
 * Returns undefined values if stats cannot be retrieved.
 */
export async function getProcessResourceUsage(pid: number): Promise<ProcessResourceUsage> {
    try {
        // Use ps command to get CPU and memory usage
        // Works on macOS and Linux
        const { stdout } = await execAsync(`ps -p ${pid} -o %cpu=,rss=`);
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
            const cpuPercent = parseFloat(parts[0]);
            const rssKB = parseInt(parts[1], 10);
            return {
                cpuPercent: isNaN(cpuPercent) ? undefined : cpuPercent,
                memoryMB: isNaN(rssKB) ? undefined : rssKB / 1024,
            };
        }
    } catch {
        // Process may have ended or ps command failed
    }
    return {};
}

/**
 * Get Intel GPU video engine usage percentage from intel_gpu_top.
 * This shows the percentage of the video encode/decode engine being used,
 * which is relevant for transcoding workloads.
 * Returns undefined if intel_gpu_top is not available or on error.
 */
export async function getIntelGpuVideoUsage(): Promise<number | undefined> {
    try {
        // Run intel_gpu_top with JSON output for one sample
        // -J enables JSON output, -s 1 takes one sample
        const { stdout } = await execAsync(
            'timeout 2 intel_gpu_top -J -s 1 2>/dev/null | head -2 | tail -1',
            {
                timeout: 3000,
            },
        );

        if (!stdout.trim()) return undefined;

        // Parse JSON output
        const data: unknown = JSON.parse(stdout);

        // intel_gpu_top JSON format has engines object with percentages
        // We want the "Video" engine (or "VideoEnhance" on some GPUs)
        const engines = isRecord(data) && isRecord(data.engines) ? data.engines : undefined;
        if (!engines) return undefined;

        const getEngineBusy = (key: string): number | undefined => {
            const engine = engines[key];
            if (!isRecord(engine)) return undefined;
            const busy = engine.busy;
            return typeof busy === 'number' ? busy : undefined;
        };

        // Try different engine names (varies by GPU generation)
        // Use nullish coalescing to handle 0 values correctly
        const videoEngine =
            getEngineBusy('Video/0') ??
            getEngineBusy('Video') ??
            getEngineBusy('VideoEnhance/0') ??
            getEngineBusy('VideoEnhance');

        if (videoEngine !== undefined) {
            return Math.round(videoEngine * 10) / 10; // Round to 1 decimal
        }
    } catch {
        // intel_gpu_top not available or failed
    }
    return undefined;
}
