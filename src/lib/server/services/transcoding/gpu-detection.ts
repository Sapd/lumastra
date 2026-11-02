// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GPU Onboarding Detection
 *
 * Probes the host for a working hardware video encoder and recommends a
 * `GPU_ACCELERATION` value for the first-run setup wizard. Unlike a bare
 * capability list (which only says what FFmpeg was compiled with), every
 * candidate here is verified with a real one-frame encode via
 * {@link hardwareDetection.probeEncoder}, so "detected" means "actually works
 * on this box" — not "might work".
 *
 * Scope is deliberately narrow: only the three backends we can build a clean
 * Linux/container recommendation for (NVENC, QSV, VAAPI). AMF (Windows) and
 * VideoToolbox (macOS) are intentionally not auto-suggested.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';

import { config } from '../../config.js';
import { Logger } from '../../utils/logger.js';
import { hardwareDetection } from './hardware-detection.js';
import type { GpuAcceleration } from './types.js';
import type { LiveClusterNode } from '../cluster-heartbeat.service.js';
import { workerUnavailableReasons } from '../worker-runtime-reason.js';

const logger = Logger.for('GpuDetection');

/** A hardware backend we probed, and whether its encoder actually ran. */
export interface GpuCandidate {
    /** The `GPU_ACCELERATION` value this candidate maps to. */
    accel: Extract<GpuAcceleration, 'nvenc' | 'qsv' | 'vaapi'>;
    /** The H.264 encoder probed (the lowest common denominator per backend). */
    encoder: string;
    /** Friendly vendor label for the UI (e.g. "NVIDIA GeForce RTX 4070"). */
    vendor: string;
    /** True when the one-frame probe encode succeeded. */
    works: boolean;
}

export interface GpuDetectionResult {
    /** False when FFmpeg itself couldn't be probed (e.g. binary not ready). */
    ffmpegReady: boolean;
    /** Best working `GPU_ACCELERATION` value, or null when none worked. */
    recommended: Extract<GpuAcceleration, 'nvenc' | 'qsv' | 'vaapi'> | null;
    /** Friendly label for the recommended backend, for the UI copy. */
    recommendedVendor: string | null;
    /** Every backend we probed and its result (for diagnostics / UI detail). */
    candidates: GpuCandidate[];
}

/** Quality/perf preference order when more than one backend works. */
const PRIORITY: Array<GpuCandidate['accel']> = ['nvenc', 'qsv', 'vaapi'];

export interface OnboardingGpuHost {
    id: string;
    hostname: string;
    local: boolean;
    transcodeEligible: boolean;
    gpus: string[];
    recommended: GpuDetectionResult['recommended'];
    verified: boolean;
}

export interface ClusterGpuDetectionResult extends GpuDetectionResult {
    hosts: OnboardingGpuHost[];
    onlyLocalHost: boolean;
    recommendedHost: string | null;
    recommendationVerified: boolean;
    modeConflict: boolean;
}

interface HostRecommendation {
    accel: GpuCandidate['accel'];
    vendor: string;
    verified: boolean;
}

function preferredRecommendation<Recommendation extends HostRecommendation>(
    recommendations: Recommendation[],
): Recommendation | undefined {
    return [...recommendations].sort(
        (left, right) =>
            Number(right.verified) - Number(left.verified) ||
            PRIORITY.indexOf(left.accel) - PRIORITY.indexOf(right.accel),
    )[0];
}

export function summarizeClusterGpuDetection(
    localHostname: string,
    local: GpuDetectionResult,
    nodes: LiveClusterNode[],
    heartbeatTtlMs: number,
): ClusterGpuDetectionResult {
    const localNode = nodes.find((node) => node.hostname === localHostname);
    const hostKey = (node: LiveClusterNode): string => node.host?.id ?? node.hostname;
    const localId = localNode ? hostKey(localNode) : localHostname;
    const grouped = new Map<string, LiveClusterNode[]>();
    grouped.set(localId, []);
    for (const node of nodes) {
        const id = hostKey(node);
        const group = grouped.get(id) ?? [];
        group.push(node);
        grouped.set(id, group);
    }

    const hasWorker = nodes.some((node) => node.role === 'worker' || node.role === 'general');
    const onlyLocalHost = grouped.size === 1;
    const localCanTranscode = localNode?.role === 'worker' || localNode?.role === 'general';
    const choices: Array<HostRecommendation & { hostname: string }> = [];
    const hosts = [...grouped].map(([id, members]): OnboardingGpuHost => {
        const isLocal = id === localId;
        const name =
            members.find((node) => node.host?.name)?.host?.name ??
            members[0]?.hostname ??
            localHostname;
        const eligible = members.filter(
            (node) =>
                (node.role === 'worker' || node.role === 'general') &&
                typeof node.heartbeatAgeMs === 'number' &&
                node.heartbeatAgeMs >= 0 &&
                node.heartbeatAgeMs < heartbeatTtlMs &&
                workerUnavailableReasons(node.runtime).length === 0,
        );
        const transcodeEligible =
            eligible.length > 0 ||
            (isLocal && (!hasWorker || (onlyLocalHost && localCanTranscode)));
        const devices = members.flatMap((node) => node.host?.gpus ?? []);
        const gpus = [
            ...new Set([
                ...devices.map(
                    (device) =>
                        device.name ??
                        device.driver ??
                        (device.kind === 'nvidia' ? 'NVIDIA' : device.device),
                ),
                ...members.flatMap((node) => {
                    const name =
                        node.gpuAccess?.name ??
                        (node.gpuAccess?.accessible ? node.gpuAccess.configured : undefined);
                    return name ? [name] : [];
                }),
                ...(isLocal ? local.candidates.map((candidate) => candidate.vendor) : []),
            ]),
        ];
        const recommendations: HostRecommendation[] = [];
        if (isLocal && transcodeEligible && local.recommended) {
            recommendations.push({
                accel: local.recommended,
                vendor: local.recommendedVendor ?? local.recommended,
                verified: localCanTranscode,
            });
        }
        for (const node of eligible) {
            if (node.hostname === localHostname) continue;
            const access = node.gpuAccess;
            for (const accel of PRIORITY) {
                if (access?.configured === accel) {
                    if (access.accessible) {
                        recommendations.push({
                            accel,
                            vendor: access.name ?? accel,
                            verified: true,
                        });
                    }
                    continue;
                }
                const device = node.host?.gpus?.find((gpu) =>
                    accel === 'nvenc'
                        ? gpu.kind === 'nvidia'
                        : accel === 'qsv'
                          ? gpu.kind === 'dri' && ['i915', 'xe'].includes(gpu.driver ?? '')
                          : gpu.kind === 'dri' &&
                            ['i915', 'xe', 'amdgpu', 'radeon'].includes(gpu.driver ?? ''),
                );
                if (device) {
                    recommendations.push({
                        accel,
                        vendor:
                            device.name ??
                            device.driver ??
                            (device.kind === 'nvidia' ? 'NVIDIA' : 'GPU'),
                        verified: false,
                    });
                }
            }
        }
        const best = preferredRecommendation(recommendations);
        if (best) choices.push({ ...best, hostname: name });
        return {
            id,
            hostname: name,
            local: isLocal,
            transcodeEligible,
            gpus,
            recommended: best?.accel ?? null,
            verified: best?.verified ?? false,
        };
    });
    const eligibleHosts = hosts.filter((host) => host.transcodeEligible);
    const modeConflict = new Set(eligibleHosts.map((host) => host.recommended)).size > 1;
    const selected = modeConflict ? undefined : preferredRecommendation(choices);
    return {
        ...local,
        recommended: selected?.accel ?? null,
        recommendedVendor: selected?.vendor ?? null,
        recommendedHost: selected?.hostname ?? null,
        recommendationVerified:
            selected?.verified === true && eligibleHosts.every((host) => host.verified),
        modeConflict,
        hosts,
        onlyLocalHost,
    };
}

/**
 * True when a DRM render node is present, i.e. a VAAPI/QSV-capable GPU is
 * exposed to the container. Gates the QSV/VAAPI probes so we don't spawn
 * pointless test encodes on NVIDIA-only or CPU-only hosts.
 */
function hasRenderNode(): boolean {
    try {
        if (config.VAAPI_DEVICE && existsSync(config.VAAPI_DEVICE)) return true;
        return readdirSync('/dev/dri').some((entry) => entry.startsWith('renderD'));
    } catch {
        return false;
    }
}

/**
 * True when an NVIDIA device node is exposed (bare metal or via the NVIDIA
 * container runtime). Without one, an NVENC probe can only fail — so skip it.
 */
function hasNvidiaDevice(): boolean {
    return ['/dev/nvidiactl', '/dev/nvidia0'].some((node) => existsSync(node));
}

/**
 * Read the PCI vendor of the configured VAAPI render node from sysfs to label
 * a VAAPI candidate as AMD vs Intel. Cheap (a single file read, no subprocess)
 * and best-effort — falls back to a generic label when sysfs isn't readable.
 */
function vaapiVendorLabel(): string {
    try {
        const node = (config.VAAPI_DEVICE || '/dev/dri/renderD128').split('/').pop();
        const vendorId = readFileSync(`/sys/class/drm/${node}/device/vendor`, 'utf8')
            .trim()
            .toLowerCase();
        if (vendorId === '0x8086') return 'Intel';
        if (vendorId === '0x1002' || vendorId === '0x1022') return 'AMD';
        if (vendorId === '0x10de') return 'NVIDIA';
    } catch {
        // sysfs not mounted / node missing — fall through to generic label.
    }
    return 'GPU';
}

/**
 * Detect and verify a hardware encoder for onboarding. Returns the recommended
 * `GPU_ACCELERATION` value (or null) plus the full candidate list. Never throws
 * — on any failure it reports "no GPU" so onboarding can degrade to CPU.
 */
export async function detectGpuForOnboarding(): Promise<GpuDetectionResult> {
    const empty: GpuDetectionResult = {
        ffmpegReady: false,
        recommended: null,
        recommendedVendor: null,
        candidates: [],
    };

    let caps;
    try {
        caps = await hardwareDetection.getCapabilities();
    } catch (error) {
        logger.warn('GPU onboarding detection: capability probe failed', {
            error: error instanceof Error ? error.message : String(error),
        });
        return empty;
    }

    if (!caps.detected) return empty;

    // Build the probe list from encoders FFmpeg actually lists, gated by the
    // presence of the matching device so we don't run doomed probes.
    const planned: Array<Omit<GpuCandidate, 'works'>> = [];

    if (caps.encoders.includes('h264_nvenc')) {
        const name = await hardwareDetection.getNvidiaGpuName();
        // FFmpeg lists h264_nvenc whenever it is compiled in; only probe when
        // the host actually shows an NVIDIA GPU (nvidia-smi answered or the
        // device nodes exist). A CPU-only host has nothing to probe.
        if (name || hasNvidiaDevice()) {
            planned.push({ accel: 'nvenc', encoder: 'h264_nvenc', vendor: name || 'NVIDIA' });
        }
    }

    if (hasRenderNode()) {
        if (caps.encoders.includes('h264_qsv')) {
            planned.push({ accel: 'qsv', encoder: 'h264_qsv', vendor: 'Intel Quick Sync' });
        }
        if (caps.encoders.includes('h264_vaapi')) {
            planned.push({
                accel: 'vaapi',
                encoder: 'h264_vaapi',
                vendor: `${vaapiVendorLabel()} (VAAPI)`,
            });
        }
    }

    const candidates: GpuCandidate[] = await Promise.all(
        planned.map(async (c) => ({
            ...c,
            works: await hardwareDetection.probeEncoder(c.encoder),
        })),
    );

    let recommended: GpuDetectionResult['recommended'] = null;
    let recommendedVendor: string | null = null;
    for (const accel of PRIORITY) {
        const hit = candidates.find((c) => c.accel === accel && c.works);
        if (hit) {
            recommended = hit.accel;
            recommendedVendor = hit.vendor;
            break;
        }
    }

    logger.info('GPU onboarding detection complete', {
        recommended: recommended ?? 'none',
        candidates: candidates.map((c) => ({ accel: c.accel, works: c.works })),
    });

    return { ffmpegReady: true, recommended, recommendedVendor, candidates };
}
