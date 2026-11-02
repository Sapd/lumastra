// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/system-metrics — system CPU/GPU/memory/bandwidth metrics endpoint def.
 *
 * GET /api/admin/system-metrics → bare SystemMetrics object.
 *
 * THIS REPLICA ONLY: cpu, memory, network, gpu, dashboard, hostname and uptime are
 * read by whichever web process answered (the response names it in `hostname`).
 * With two web pods and a worker that is one random pod, not the machine the
 * transcodes run on. Kept for compatibility (GET /api/v1/system-metrics,
 * `metrics:read` scrapers) and for the encoder check on the cluster tab. The
 * cluster-wide answer is `hosts`: every machine's CPU, memory and GPU from the
 * services' Valkey heartbeats (the same data as GET /api/admin/cluster).
 * mediaBandwidth and ffmpegAggregate are cluster-wide (stream-throughput.service).
 * Auth: metrics:read (admin-scoped observability). Errors: problem+json.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { getStreamThroughput } from '$lib/server/services/stream-throughput.service.js';
import { testGpuAccess } from '$lib/server/services/transcoding/gpu-access-probe.js';
import { toClusterHostMetrics } from '$lib/utils/admin/cluster-host-metrics.js';

export { getMaxNvencSessions } from '../../../../../../shared/gpu-metrics.js';
import type {
    CpuUsage,
    MemoryInfo,
    NetworkInfo,
    ProcessMetrics,
    SystemMetrics,
} from '$lib/types/admin-metrics.js';

const logger = Logger.for('system-metrics-admin');

let lastNetworkStats: { rx: number; tx: number; timestamp: number } | null = null;

export interface CpuTimesTotals {
    user: number;
    sys: number;
    idle: number;
    all: number;
}

export function sumCpuTimes(cpus: Pick<os.CpuInfo, 'times'>[]): CpuTimesTotals {
    const t = { user: 0, sys: 0, idle: 0, all: 0 };
    for (const cpu of cpus) {
        t.user += cpu.times.user;
        t.sys += cpu.times.sys;
        t.idle += cpu.times.idle;
        t.all += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    return t;
}

/**
 * CPU usage between two samples. os.cpus() times are cumulative since boot, so
 * a single sample is the average since boot — a pegged box that idled for a
 * week reads as idle. With no previous sample (first call) the cumulative
 * figure is the only one available.
 */
export function cpuUsageBetween(prev: CpuTimesTotals | null, cur: CpuTimesTotals): CpuUsage {
    const d =
        prev && cur.all - prev.all > 0
            ? {
                  user: cur.user - prev.user,
                  sys: cur.sys - prev.sys,
                  idle: cur.idle - prev.idle,
                  all: cur.all - prev.all,
              }
            : cur;
    if (d.all <= 0) return { user: 0, system: 0, idle: 0, total: 0 };
    return {
        user: Math.round((d.user / d.all) * 100),
        system: Math.round((d.sys / d.all) * 100),
        idle: Math.round((d.idle / d.all) * 100),
        total: Math.round(((d.all - d.idle) / d.all) * 100),
    };
}

// Shared across callers (several tabs, a scraper): a sample closer than this
// to the previous one is too short to mean anything, so keep the old baseline.
const CPU_MIN_SAMPLE_MS = 1_000;
let lastCpuTimes: { totals: CpuTimesTotals; at: number } | null = null;
let lastCpuReading: CpuUsage | null = null;

function getCpuUsage(): CpuUsage {
    const now = Date.now();
    if (lastCpuTimes && lastCpuReading && now - lastCpuTimes.at < CPU_MIN_SAMPLE_MS) {
        return lastCpuReading;
    }
    const totals = sumCpuTimes(os.cpus());
    lastCpuReading = cpuUsageBetween(lastCpuTimes?.totals ?? null, totals);
    lastCpuTimes = { totals, at: now };
    return lastCpuReading;
}

function getMemoryInfo(): MemoryInfo {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
        totalMB: Math.round(totalMem / 1024 / 1024),
        usedMB: Math.round(usedMem / 1024 / 1024),
        freeMB: Math.round(freeMem / 1024 / 1024),
        usedPercent: Math.round((usedMem / totalMem) * 100),
    };
}

function getNetworkInfo(): NetworkInfo | undefined {
    try {
        if (process.platform === 'linux' && fs.existsSync('/proc/net/dev')) {
            const content = fs.readFileSync('/proc/net/dev', 'utf-8');
            const lines = content.split('\n');
            let totalRx = 0,
                totalTx = 0;

            for (const line of lines) {
                if (line.includes('|') || !line.trim()) continue;
                const parts = line.trim().split(/\s+/);
                if (parts.length < 10) continue;
                const iface = parts[0].replace(':', '');
                if (iface === 'lo') continue;
                totalRx += parseInt(parts[1], 10) || 0;
                totalTx += parseInt(parts[9], 10) || 0;
            }

            const now = Date.now();

            if (lastNetworkStats) {
                const deltaTime = (now - lastNetworkStats.timestamp) / 1000;
                if (deltaTime > 0) {
                    const rxBytesPerSec = (totalRx - lastNetworkStats.rx) / deltaTime;
                    const txBytesPerSec = (totalTx - lastNetworkStats.tx) / deltaTime;

                    lastNetworkStats = { rx: totalRx, tx: totalTx, timestamp: now };

                    return {
                        rxBytesPerSec: Math.max(0, rxBytesPerSec),
                        txBytesPerSec: Math.max(0, txBytesPerSec),
                        rxMbps: Math.max(0, (rxBytesPerSec * 8) / 1_000_000),
                        txMbps: Math.max(0, (txBytesPerSec * 8) / 1_000_000),
                    };
                }
            }

            lastNetworkStats = { rx: totalRx, tx: totalTx, timestamp: now };
        }
    } catch (error) {
        logger.debug('Failed to get network stats', { error });
    }

    return undefined;
}

// The binary does not change while the process runs; cache the first answer.
let ffmpegVersionCache: { value: string | undefined } | null = null;

function getFFmpegVersion(): string | undefined {
    if (ffmpegVersionCache) return ffmpegVersionCache.value;
    ffmpegVersionCache = { value: readFFmpegVersion() };
    return ffmpegVersionCache.value;
}

function readFFmpegVersion(): string | undefined {
    try {
        const output = execFileSync(config.FFMPEG_PATH, ['-version'], {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const firstLine = output.split('\n')[0];
        const match = firstLine.match(/ffmpeg version (\S+)/);
        return match ? match[1] : firstLine;
    } catch {
        return undefined;
    }
}

let lastCpuUsage: { user: number; system: number; timestamp: number } | null = null;

function getDashboardProcessMetrics(): ProcessMetrics {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();

    const memoryMB = Math.round(memUsage.rss / 1024 / 1024);
    const memoryPercent = Math.round((memUsage.rss / totalMem) * 100 * 10) / 10;

    const cpuUsage = process.cpuUsage();
    const now = Date.now();
    let cpuPercent = 0;

    if (lastCpuUsage) {
        const elapsedMs = now - lastCpuUsage.timestamp;
        if (elapsedMs > 0) {
            const userDiff = cpuUsage.user - lastCpuUsage.user;
            const sysDiff = cpuUsage.system - lastCpuUsage.system;
            const totalCpuMs = (userDiff + sysDiff) / 1000;
            cpuPercent = Math.round((totalCpuMs / elapsedMs) * 100 * 10) / 10;
        }
    }

    lastCpuUsage = { user: cpuUsage.user, system: cpuUsage.system, timestamp: now };

    return { cpuPercent, memoryMB, memoryPercent, pid: process.pid };
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['metrics:read', 'admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            try {
                const [gpuInfo, { mediaBandwidth, ffmpegAggregate }, cluster] = await Promise.all([
                    testGpuAccess(),
                    getStreamThroughput(),
                    // Cluster-wide figures from the services' Valkey heartbeats (15 s cache).
                    // Lazy: the cluster core pulls in the task registry and the admin pool.
                    import('$lib/server/services/admin-cluster-core.service.js')
                        .then(({ getClusterCore }) => getClusterCore())
                        .catch((err: unknown) => {
                            logger.warn('Cluster core unavailable for system metrics', {
                                error: String(err),
                            });
                            return null;
                        }),
                ]);

                const metrics: SystemMetrics = {
                    cpu: getCpuUsage(),
                    memory: getMemoryInfo(),
                    gpu: gpuInfo,
                    network: getNetworkInfo(),
                    mediaBandwidth,
                    dashboard: getDashboardProcessMetrics(),
                    ffmpegAggregate,
                    ffmpegPath: config.FFMPEG_PATH,
                    ffmpegVersion: getFFmpegVersion(),
                    platform: process.platform,
                    hostname: os.hostname(),
                    uptime: Math.floor(os.uptime()),
                    hosts: cluster ? toClusterHostMetrics(cluster) : undefined,
                    hostsGeneratedAt: cluster?.generatedAt,
                };

                return json(metrics);
            } catch (error) {
                logger.error(
                    'Failed to get system metrics',
                    error instanceof Error ? error : undefined,
                );
                return ApiProblem.internalError('Failed to retrieve system metrics');
            }
        },
    },
});
