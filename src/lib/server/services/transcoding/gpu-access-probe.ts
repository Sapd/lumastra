// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GPU access probe: is the configured hardware encoder usable from THIS process,
 * which GPU is it, and what can it do (a real one-frame test encode, plus
 * nvidia-smi / vainfo for names and live NVIDIA figures).
 *
 * Moved out of the admin system-metrics def so the cluster heartbeat can publish
 * the cached result per service ({@link getGpuAccessSummary}). The probe spawns
 * FFmpeg, so it is shared: the endpoint reuses one result per 30 s, the heartbeat
 * one per GPU_SUMMARY_MAX_AGE_MS.
 */

import { spawn, execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { GpuInfo } from '$lib/types/admin-metrics.js';
import { getMaxNvencSessions, INTEL_GPU_NAMES } from '../../../../shared/gpu-metrics.js';

const logger = Logger.for('gpu-access-probe');

/**
 * Async on purpose: the heartbeat runs this probe in every web and worker process,
 * so nvidia-smi / vainfo must never block the event loop (they can take seconds on
 * a loaded GPU).
 */
const execFileAsync = promisify(execFile);

/** First Intel DRM card that has a render node, e.g. /sys/class/drm/card1. */
function intelCardPath(): string | undefined {
    try {
        for (const node of fs.readdirSync('/sys/class/drm').filter((e) => e.startsWith('renderD')).sort()) {
            const cards = fs
                .readdirSync(`/sys/class/drm/${node}/device/drm`)
                .filter((e) => /^card\d+$/.test(e));
            const vendor = fs.readFileSync(`/sys/class/drm/${node}/device/vendor`, 'utf-8').trim();
            if (vendor === '0x8086' && cards[0]) return `/sys/class/drm/${cards[0]}`;
        }
    } catch {
        // No sysfs (macOS) or no DRM devices.
    }
    return undefined;
}

let ffmpegFiltersCache: Set<string> | null = null;

function getFFmpegFilters(): Set<string> {
    if (ffmpegFiltersCache) return ffmpegFiltersCache;
    try {
        const output = execFileSync(config.FFMPEG_PATH, ['-hide_banner', '-filters'], {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const filters = new Set<string>();
        for (const line of output.split('\n')) {
            const match = line.match(/[T.][S.][C.]\s+(\w+)/);
            if (match) filters.add(match[1]);
        }
        ffmpegFiltersCache = filters;
        return filters;
    } catch {
        return new Set();
    }
}

function detectTranscodingCapabilities(gpuType: string, gpuAccessible: boolean): string[] {
    const caps: string[] = [];
    const filters = getFFmpegFilters();

    if (gpuAccessible) {
        if (gpuType === 'nvenc') caps.push('NVENC', 'NVDEC');
        else if (gpuType === 'qsv') caps.push('QSV Encode', 'QSV Decode');
        else if (gpuType === 'vaapi') caps.push('VAAPI Encode', 'VAAPI Decode');
    }

    if (gpuAccessible && gpuType === 'nvenc' && filters.has('tonemap_cuda'))
        caps.push('HDR Tonemapping (CUDA)');
    else if (gpuAccessible && gpuType === 'vaapi' && filters.has('tonemap_vaapi'))
        caps.push('HDR Tonemapping (VAAPI)');
    else if (gpuAccessible && gpuType === 'qsv' && filters.has('vpp_qsv'))
        caps.push('HDR Tonemapping (QSV)');
    else if (filters.has('tonemap') || filters.has('zscale')) caps.push('HDR Tonemapping (CPU)');

    if (gpuAccessible && gpuType === 'nvenc' && filters.has('scale_cuda'))
        caps.push('CUDA Scaling');

    return caps;
}


let lastIntelGpuStats: {
    rc6ResidencyMs: number;
    energyMicrojoules: number;
    timestamp: number;
} | null = null;

function getIntelGpuUtilization(): GpuInfo['utilization'] | undefined {
    try {
        // The card behind the render node, not card0: on a VM or a board with its own
        // display controller card0 is something else (prod's media node: bochs-drm).
        const basePath = intelCardPath();
        if (!basePath) return undefined;
        const gtPath = `${basePath}/gt/gt0`;
        const hwmonDir = `${basePath}/device/hwmon`;
        const hwmon = fs.existsSync(hwmonDir) ? fs.readdirSync(hwmonDir).sort()[0] : undefined;
        const hwmonPath = `${hwmonDir}/${hwmon ?? 'hwmon0'}`;

        const vendorPath = `${basePath}/device/vendor`;
        if (!fs.existsSync(vendorPath)) return undefined;
        const vendor = fs.readFileSync(vendorPath, 'utf-8').trim();
        if (vendor !== '0x8086') return undefined;

        const rc6Residency = parseInt(
            fs.readFileSync(`${gtPath}/rc6_residency_ms`, 'utf-8').trim(),
            10,
        );
        const freqMhz = parseInt(fs.readFileSync(`${gtPath}/rps_act_freq_mhz`, 'utf-8').trim(), 10);
        const freqMaxMhz = parseInt(
            fs.readFileSync(`${gtPath}/rps_RP0_freq_mhz`, 'utf-8').trim(),
            10,
        );

        let energyMicrojoules = 0;
        const energyPath = `${hwmonPath}/energy1_input`;
        if (fs.existsSync(energyPath)) {
            energyMicrojoules = parseInt(fs.readFileSync(energyPath, 'utf-8').trim(), 10);
        }

        const now = Date.now();
        let busy = 0;
        let powerWatts: number | undefined;

        if (lastIntelGpuStats) {
            const deltaMs = now - lastIntelGpuStats.timestamp;
            if (deltaMs > 0) {
                const rc6DeltaMs = rc6Residency - lastIntelGpuStats.rc6ResidencyMs;
                busy = Math.max(0, Math.min(100, 100 - (rc6DeltaMs / deltaMs) * 100));
                busy = Math.round(busy * 10) / 10;

                if (energyMicrojoules > 0 && lastIntelGpuStats.energyMicrojoules > 0) {
                    const energyDeltaJ =
                        (energyMicrojoules - lastIntelGpuStats.energyMicrojoules) / 1_000_000;
                    const deltaSec = deltaMs / 1000;
                    powerWatts = Math.round((energyDeltaJ / deltaSec) * 10) / 10;
                }
            }
        }

        lastIntelGpuStats = { rc6ResidencyMs: rc6Residency, energyMicrojoules, timestamp: now };

        const freqPercent = freqMaxMhz > 0 ? Math.round((freqMhz / freqMaxMhz) * 100) : 0;

        return { busy, freqMhz, freqMaxMhz, freqPercent, powerWatts };
    } catch (error) {
        logger.debug('Failed to read Intel GPU utilization', { error });
        return undefined;
    }
}


async function testQsvAccess(): Promise<{
    accessible: boolean;
    name?: string;
    error?: string;
    testOutput?: string;
}> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ accessible: false, error: 'Test timed out after 5 seconds' });
        }, 5000);

        try {
            const device = config.QSV_DEVICE || '/dev/dri/renderD128';
            const args = [
                '-hide_banner',
                '-init_hw_device',
                `qsv=qsv:${device}`,
                '-filter_hw_device',
                'qsv',
                '-f',
                'lavfi',
                '-i',
                'testsrc=duration=0.1:size=256x256',
                '-vf',
                'hwupload=extra_hw_frames=8,format=qsv',
                '-c:v',
                'h264_qsv',
                '-frames:v',
                '1',
                '-f',
                'null',
                '-',
            ];

            let stderr = '';
            const proc = spawn(config.FFMPEG_PATH, args, { timeout: 5000 });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                clearTimeout(timeout);

                if (code === 0) {
                    let gpuName: string | undefined;

                    const deviceMatch =
                        stderr.match(/Using device[:\s]+([^\n]+)/i) ||
                        stderr.match(/Initialize MFX session[:\s]+([^\n]+)/i);
                    if (deviceMatch) gpuName = deviceMatch[1].trim();

                    if (!gpuName) {
                        try {
                            const cards = fs
                                .readdirSync('/sys/class/drm')
                                .filter((c) => c.startsWith('card') && !c.includes('-'));
                            for (const card of cards) {
                                const vendorPath = `/sys/class/drm/${card}/device/vendor`;
                                const devicePath = `/sys/class/drm/${card}/device/device`;
                                if (fs.existsSync(vendorPath)) {
                                    const vendor = fs.readFileSync(vendorPath, 'utf-8').trim();
                                    if (vendor === '0x8086') {
                                        const deviceId = fs.existsSync(devicePath)
                                            ? fs.readFileSync(devicePath, 'utf-8').trim()
                                            : '';
                                        gpuName =
                                            INTEL_GPU_NAMES[deviceId] ||
                                            `Intel GPU (${deviceId || card})`;
                                        break;
                                    }
                                }
                            }
                        } catch {
                            // sysfs not available
                        }
                    }

                    if (!gpuName) gpuName = 'Intel QSV';

                    resolve({
                        accessible: true,
                        name: gpuName,
                        testOutput: 'QSV encoding test passed',
                    });
                } else {
                    resolve({
                        accessible: false,
                        error: stderr.substring(0, 500) || `FFmpeg exited with code ${code}`,
                        testOutput: stderr.substring(0, 500),
                    });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ accessible: false, error: err.message });
            });
        } catch (error) {
            clearTimeout(timeout);
            resolve({
                accessible: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });
}

async function testNvencAccess(): Promise<Partial<GpuInfo> & { accessible: boolean }> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ accessible: false, error: 'Test timed out after 5 seconds' });
        }, 5000);

        try {
            const args = [
                '-hide_banner',
                '-hwaccel',
                'cuda',
                '-f',
                'lavfi',
                '-i',
                'testsrc=duration=0.1:size=256x256',
                '-c:v',
                'h264_nvenc',
                '-frames:v',
                '1',
                '-f',
                'null',
                '-',
            ];

            let stderr = '';
            const proc = spawn(config.FFMPEG_PATH, args, { timeout: 5000 });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                void (async () => {
                    clearTimeout(timeout);

                    if (code === 0) {
                        let gpuName: string | undefined;
                        let driver: string | undefined;
                        let vramTotalMB: number | undefined;
                        let vramUsedMB: number | undefined;
                        let gpuUtil: number | undefined;
                        let encUtil: number | undefined;
                        let decUtil: number | undefined;
                        let encSessions: number | undefined;
                        let encFps: number | undefined;
                        let encLatency: number | undefined;
                        let tempC: number | undefined;
                        let powerDraw: number | undefined;
                        let powerLimit: number | undefined;
                        let pstate: string | undefined;

                        try {
                            const csv = (
                                await execFileAsync(
                                    'nvidia-smi',
                                    [
                                        '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,utilization.encoder,utilization.decoder,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency,temperature.gpu,power.draw,power.limit,pstate',
                                        '--format=csv,noheader,nounits',
                                    ],
                                    { encoding: 'utf-8', timeout: 3000 },
                                )
                            ).stdout.trim();
                            const v = csv.split(',').map((s) => s.trim());
                            const num = (s: string): number | undefined => {
                                const n = parseFloat(s);
                                return isNaN(n) ? undefined : n;
                            };
                            const int = (s: string): number | undefined => {
                                const n = parseInt(s, 10);
                                return isNaN(n) ? undefined : n;
                            };
                            if (v.length >= 14) {
                                gpuName = v[0] || undefined;
                                driver = v[1] || undefined;
                                vramTotalMB = num(v[2]);
                                vramUsedMB = num(v[3]);
                                gpuUtil = num(v[4]);
                                encUtil = num(v[5]);
                                decUtil = num(v[6]);
                                encSessions = int(v[7]);
                                encFps = int(v[8]);
                                encLatency = int(v[9]);
                                tempC = int(v[10]);
                                powerDraw = num(v[11]);
                                powerLimit = num(v[12]);
                                pstate = v[13] || undefined;
                            }
                        } catch {
                            // nvidia-smi not available
                        }

                        resolve({
                            accessible: true,
                            name: gpuName,
                            driver,
                            testOutput: 'NVENC encoding test passed',
                            vramTotalMB,
                            vramUsedMB,
                            gpuUtilization: gpuUtil,
                            encoderUtilization: encUtil,
                            decoderUtilization: decUtil,
                            encodeSessions: encSessions,
                            maxEncodeSessions: getMaxNvencSessions(gpuName ?? '', driver),
                            encodeFps: encFps,
                            encodeLatencyUs: encLatency,
                            temperatureC: tempC,
                            powerDrawW: powerDraw,
                            powerLimitW: powerLimit,
                            pstate,
                        });
                    } else {
                        resolve({
                            accessible: false,
                            error: stderr.substring(0, 500) || `FFmpeg exited with code ${code}`,
                            testOutput: stderr.substring(0, 500),
                        });
                    }
                })();
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ accessible: false, error: err.message });
            });
        } catch (error) {
            clearTimeout(timeout);
            resolve({
                accessible: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });
}

async function testVaapiAccess(): Promise<{
    accessible: boolean;
    name?: string;
    error?: string;
    testOutput?: string;
}> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ accessible: false, error: 'Test timed out after 5 seconds' });
        }, 5000);

        try {
            const device = config.VAAPI_DEVICE || '/dev/dri/renderD128';
            const args = [
                '-hide_banner',
                '-hwaccel',
                'vaapi',
                '-vaapi_device',
                device,
                '-f',
                'lavfi',
                '-i',
                'testsrc=duration=0.1:size=256x256',
                '-vf',
                'format=nv12,hwupload',
                '-c:v',
                'h264_vaapi',
                '-frames:v',
                '1',
                '-f',
                'null',
                '-',
            ];

            let stderr = '';
            const proc = spawn(config.FFMPEG_PATH, args, { timeout: 5000 });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                void (async () => {
                    clearTimeout(timeout);

                    if (code === 0) {
                        let gpuName: string | undefined;

                        const driverMatch =
                            stderr.match(/driver[:\s]+([^\n,]+)/i) ||
                            stderr.match(/Using device[:\s]+([^\n]+)/i);
                        if (driverMatch) gpuName = `VA-API (${driverMatch[1].trim()})`;

                        if (!gpuName) {
                            try {
                                const vainfo = (
                                    await execFileAsync('vainfo', [], {
                                        encoding: 'utf-8',
                                        timeout: 2000,
                                    })
                                ).stdout
                                    .split('\n')
                                    .slice(0, 5)
                                    .join('\n')
                                    .trim();
                                const vainfoDriverMatch = vainfo.match(/Driver\s+version:\s*(.+)/i);
                                if (vainfoDriverMatch) gpuName = `VA-API ${vainfoDriverMatch[1]}`;
                            } catch {
                                // vainfo not available
                            }
                        }

                        if (!gpuName) gpuName = 'VA-API';

                        resolve({
                            accessible: true,
                            name: gpuName,
                            testOutput: 'VAAPI encoding test passed',
                        });
                    } else {
                        resolve({
                            accessible: false,
                            error: stderr.substring(0, 500) || `FFmpeg exited with code ${code}`,
                            testOutput: stderr.substring(0, 500),
                        });
                    }
                })();
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ accessible: false, error: err.message });
            });
        } catch (error) {
            clearTimeout(timeout);
            resolve({
                accessible: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });
}

async function testVideoToolboxAccess(): Promise<{
    accessible: boolean;
    name?: string;
    error?: string;
    testOutput?: string;
}> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            resolve({ accessible: false, error: 'Test timed out after 5 seconds' });
        }, 5000);

        try {
            const args = [
                '-hide_banner',
                '-hwaccel',
                'videotoolbox',
                '-f',
                'lavfi',
                '-i',
                'testsrc=duration=0.1:size=256x256',
                '-c:v',
                'h264_videotoolbox',
                '-frames:v',
                '1',
                '-f',
                'null',
                '-',
            ];

            let stderr = '';
            const proc = spawn(config.FFMPEG_PATH, args, { timeout: 5000 });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                clearTimeout(timeout);

                if (code === 0) {
                    resolve({
                        accessible: true,
                        name: 'Apple VideoToolbox',
                        testOutput: 'VideoToolbox encoding test passed',
                    });
                } else {
                    resolve({
                        accessible: false,
                        error: stderr.substring(0, 500) || `FFmpeg exited with code ${code}`,
                        testOutput: stderr.substring(0, 500),
                    });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ accessible: false, error: err.message });
            });
        } catch (error) {
            clearTimeout(timeout);
            resolve({
                accessible: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    });
}

function detectUnusedGpuAdvisory(): string | undefined {
    try {
        // Admin endpoint only (GPU_ACCELERATION=none is never probed by the heartbeat).
        const out = execFileSync('nvidia-smi', ['-L'], {
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
        if (/^GPU \d+:/m.test(out)) {
            return 'An NVIDIA GPU was detected but GPU_ACCELERATION=none — transcoding is CPU-only. Set GPU_ACCELERATION=nvenc and pass the GPU through to enable hardware encoding. See https://lumastra.org/guides/gpu-transcoding/.';
        }
    } catch {
        // nvidia-smi absent or no NVIDIA GPU
    }
    try {
        if (fs.existsSync('/dev/dri/renderD128')) {
            return 'A GPU render node (/dev/dri) was detected but GPU_ACCELERATION=none — transcoding is CPU-only. Set GPU_ACCELERATION=qsv or vaapi to enable Intel/AMD hardware encoding. See https://lumastra.org/guides/gpu-transcoding/.';
        }
    } catch {
        // ignore — advisory is best-effort
    }
    return undefined;
}

// The access probe runs a real test encode (and nvidia-smi/vainfo); every
// open admin tab polls this endpoint, so share one probe per 30 s instead of
// opening a GPU session per poll. Live utilization is still read per call.
const GPU_PROBE_TTL_MS = 30_000;
let gpuProbeCache: { at: number; promise: Promise<GpuInfo> } | null = null;

export async function testGpuAccess(): Promise<GpuInfo> {
    const now = Date.now();
    if (!gpuProbeCache || now - gpuProbeCache.at >= GPU_PROBE_TTL_MS) {
        const promise = probeGpuAccess();
        gpuProbeCache = { at: now, promise };
        promise.catch(() => {
            if (gpuProbeCache?.promise === promise) gpuProbeCache = null;
        });
    }
    const probed = { ...(await gpuProbeCache.promise) };
    if ((probed.configured === 'qsv' || probed.configured === 'vaapi') && probed.accessible) {
        probed.utilization = getIntelGpuUtilization();
    }
    return probed;
}

async function probeGpuAccess(): Promise<GpuInfo> {
    const gpuType = config.GPU_ACCELERATION;

    const result: GpuInfo = {
        configured: gpuType,
        detected: false,
        accessible: false,
    };

    if (gpuType === 'none') {
        result.advisory = detectUnusedGpuAdvisory();
        return result;
    }

    let testResult: Partial<GpuInfo> & { accessible: boolean };

    switch (gpuType) {
        case 'qsv':
            testResult = await testQsvAccess();
            break;
        case 'nvenc':
            testResult = await testNvencAccess();
            break;
        case 'vaapi':
            testResult = await testVaapiAccess();
            break;
        case 'videotoolbox':
            testResult = await testVideoToolboxAccess();
            break;
        default:
            testResult = { accessible: false, error: `Unknown GPU type: ${gpuType}` };
    }

    Object.assign(result, testResult);
    result.detected = testResult.accessible;

    result.capabilities = detectTranscodingCapabilities(gpuType, testResult.accessible);

    return result;
}

/** Probe result as the heartbeat publishes it: no test output, no live figures. */
export interface GpuAccessSummary {
    configured: string;
    accessible: boolean;
    name?: string;
    capabilities?: string[];
    error?: string;
}

const PROBED_ACCELERATIONS = new Set<string>(['qsv', 'nvenc', 'vaapi', 'videotoolbox']);

/** The heartbeat refreshes its probe this rarely: each probe is a real test encode. */
export const GPU_SUMMARY_MAX_AGE_MS = 30 * 60_000;
/**
 * A failed probe is retried much sooner: it may only have hit a full NVENC session
 * cap or a busy GPU, and must not read as "access failed" for half an hour.
 */
export const GPU_SUMMARY_RETRY_MS = 60_000;
let summaryCache: { at: number; value: GpuAccessSummary } | null = null;
let summaryInFlight: Promise<void> | null = null;

/**
 * The last probe result, refreshed in the background at most every
 * GPU_SUMMARY_MAX_AGE_MS. Never waits for a probe: the first beats after start
 * publish nothing until the first probe finishes. Undefined with
 * GPU_ACCELERATION=none (nothing to probe).
 */
export function getGpuAccessSummary(now: number = Date.now()): GpuAccessSummary | undefined {
    if (!PROBED_ACCELERATIONS.has(config.GPU_ACCELERATION)) return undefined;
    const maxAge = summaryCache?.value.accessible === false ? GPU_SUMMARY_RETRY_MS : GPU_SUMMARY_MAX_AGE_MS;
    if ((!summaryCache || now - summaryCache.at >= maxAge) && !summaryInFlight) {
        summaryInFlight = testGpuAccess()
            .then((gpu) => {
                summaryCache = {
                    at: Date.now(),
                    value: {
                        configured: gpu.configured,
                        accessible: gpu.accessible,
                        name: gpu.name,
                        capabilities: gpu.capabilities,
                        error: gpu.accessible ? undefined : gpu.error?.slice(0, 200),
                    },
                };
            })
            .catch((err: unknown) => {
                logger.debug('GPU access probe failed', { error: String(err) });
            })
            .finally(() => {
                summaryInFlight = null;
            });
    }
    return summaryCache?.value;
}

/** Test hook. */
export function resetGpuAccessSummary(): void {
    summaryCache = null;
    summaryInFlight = null;
}
