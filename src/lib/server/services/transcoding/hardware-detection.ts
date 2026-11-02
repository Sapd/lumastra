// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hardware Detection Service
 *
 * Detects available FFmpeg encoders, decoders, hardware accelerators, and filters.
 * Used to automatically select the best encoder for the configured GPU.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { config } from '../../config.js';
import { onConfigChange } from '../../config/index.js';
import { Logger } from '../../utils/logger.js';
import { spawnFFmpegSafely } from '../../utils/ffmpeg-spawn.js';
import { cacheGet, cacheSet } from '../../cache/valkey.js';
import {
    publishDecodeDenySync,
    onRemoteDecodeDenyLearn,
    onRemoteDecodeDenyReset,
} from '../../cache/decode-deny-bus.js';
import type { HardwareCapabilities, GpuAcceleration } from './types.js';
import { NVENC_BUSY_RE } from './transcode-failure-classifier.js';

/**
 * A probe that failed only because the encoder had no free session (another
 * app — game streaming, OBS, instant replay — holds it) is retried after this
 * long instead of being cached until a restart: Lumastra started while a game
 * stream ran would otherwise transcode on the CPU for the rest of its life.
 */
export const BUSY_ENCODER_PROBE_RETRY_MS = 60_000;

const logger = Logger.for('HardwareDetection');
const execFileAsync = promisify(execFile);

/**
 * Source video codecs the VA-API family (Intel QSV, Intel/AMD VA-API) can
 * hardware-decode into a GPU surface on modern parts (including Arc/DG2).
 * Anything outside this set — notably MPEG-4 ASP (Xvid/DivX) and VC-1, which Arc
 * dropped from its fixed-function decoders — must be software-decoded and bridged
 * onto a GPU surface (hwupload) before the scale/vpp filters or the encoder, or
 * the encoder fails to open (auto_scale -38 → "Could not open encoder" → -22).
 *
 * Whitelisting is the safe default: a too-narrow entry only costs a zero-copy
 * decode for that one source, while a too-wide entry crashes the encoder open.
 * The list is a static best guess — learn-on-failure (see
 * {@link HardwareDetectionService.markSourceNotHardwareDecodable}) corrects false
 * positives at runtime (e.g. AV1/VP9/HEVC are hardware-decodable on Arc but NOT on
 * older QSV iGPUs).
 */
const VAAPI_FAMILY_HW_DECODABLE_CODECS = new Set([
    'h264',
    'avc',
    'hevc',
    'h265',
    'vp9',
    'av1',
    'mpeg2video',
    'mpeg2',
]);

/**
 * Source codecs NVIDIA NVDEC decodes on a typical modern GPU (Maxwell+). NVDEC's
 * codec coverage is broad — it keeps MPEG-4 ASP and VC-1, unlike Intel Arc — so
 * the whitelist is wide and the real gaps (10-bit H.264, 4:2:2/4:4:4 chroma, AV1
 * on pre-Ampere, oversized resolutions) are caught by bit-depth-aware
 * learn-on-failure rather than enumerated here. (Verified on an RTX 3090: 8-bit
 * H.264 zero-copies; 10-bit H.264 hits the surface mismatch and is bridged.)
 */
const NVENC_HW_DECODABLE_CODECS = new Set([
    'h264',
    'avc',
    'hevc',
    'h265',
    'vp8',
    'vp9',
    'av1',
    'mpeg1video',
    'mpeg2video',
    'mpeg2',
    'mpeg4',
    'vc1',
]);

/**
 * Per-backend hardware-decode whitelists. Only backends with a verified
 * software-decode bridge appear here. A backend absent from this map is treated
 * as "always decodable" (no bridge) — this is where AMF stays until it can be
 * verified on real AMD hardware. NVENC's bridge is "encoder-only" (software
 * decode + software scale; the encoder ingests system frames), distinct from the
 * VA-API family's hwupload bridge — see FFmpegArgsBuilder.enableHwAccel.
 */
const HW_DECODABLE_BY_BACKEND: Partial<Record<GpuAcceleration, Set<string>>> = {
    qsv: VAAPI_FAMILY_HW_DECODABLE_CODECS,
    vaapi: VAAPI_FAMILY_HW_DECODABLE_CODECS,
    nvenc: NVENC_HW_DECODABLE_CODECS,
};

/** Valkey key holding the learned per-backend codecs that can't be hw-decoded. */
const GPU_DECODE_DENY_KEY = 'v1:transcode:gpu-non-hw-decodable';

/**
 * Build identities that do NOT distinguish one build from another.
 *
 * `dev` is the `Dockerfile` default for `ARG APP_VERSION`, so every self-built
 * image carries it; `unknown` is config.ts's last-resort fallback. Neither can
 * tell yesterday's build from today's, which is the whole basis of lesson
 * retirement — see {@link isLearnedEntryExpired}.
 */
const INDISTINCT_BUILD_IDS = new Set(['dev', 'unknown', '']);

/**
 * This build's identity, read defensively.
 *
 * `config` is partially mocked in several suites (a Proxy over a small literal
 * with no `buildInfo`), so a bare `config.buildInfo.version` throws there — and
 * on the learn path that throw propagates into transcode failure handling. An
 * absent build identity degrades to `unknown`, which is itself indistinct, so
 * lessons simply are not enforced rather than being enforced on a wrong stamp.
 */
function currentBuildId(): string {
    return config.buildInfo?.version ?? 'unknown';
}

/**
 * How long a learned "not hardware-decodable" lesson stays in effect before it
 * is re-verified. A learned entry can never be contradicted by observation (once
 * a codec is denied, every future job is bridged, so hardware decode is never
 * re-attempted) — so expiry is the ONLY way a lesson self-heals. A genuine
 * silicon gap simply re-learns on the next play (one transparent retry cycle); a
 * false positive (e.g. a busy-GPU episode that slipped past the strict learn
 * signature) evaporates instead of lingering until a manual reset. 30 days
 * matches the codebase's other suppression TTLs.
 */
const LEARNED_DECODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a learned deny entry has aged past {@link LEARNED_DECODE_TTL_MS} — or
 * was recorded by a DIFFERENT build, which counts as expired.
 *
 * See {@link LearnedDecodeEntry.learnedBy}: a lesson is inferred from an FFmpeg
 * failure, so our own argument bugs can teach false ones, and nothing ever
 * re-verifies a denied codec. Tying validity to the build means shipping the fix
 * also retires the lessons that fix invalidates, instead of leaving them to
 * masquerade as hardware limitations for the rest of the TTL.
 *
 * A pre-existing entry has no `learnedBy` at all; those are treated as expired
 * for the same reason (they were written by an older build, by definition).
 */
function isLearnedEntryExpired(entry: LearnedDecodeEntry, now = Date.now()): boolean {
    // NOTE: an INDISTINCT build id is deliberately NOT rejected here. Doing so read
    // side made every lesson inert for the whole process on `dev` builds, while
    // markSourceNotHardwareDecodable still reported success — so the ladder skipped
    // `forceSoftwareDecodeBridge`, respawned the SAME unbridged args, and then
    // refused further rescue because `gpuBridgeRetried` was set. A codec that used
    // to recover after one transparent retry failed permanently instead, on exactly
    // the self-built images that carry the Dockerfile's default stamp. Indistinct
    // stamps are rejected at HYDRATE time instead (see hydrateGpuDecodeDenyList),
    // which gives the intended relearn-per-restart without disarming the bridge.
    if (entry.learnedBy !== currentBuildId()) return true;
    const learnedAtMs = Date.parse(entry.learnedAt);
    // Unparseable timestamp → treat as expired so a corrupt entry re-verifies
    // rather than sticking forever.
    return Number.isNaN(learnedAtMs) || learnedAtMs + LEARNED_DECODE_TTL_MS < now;
}

/**
 * Deny-map key for a (codec, bitDepth) pair. 8-bit (or unknown depth) keys on the
 * bare codec so the common case stays simple; >8-bit appends the depth so a
 * 10-bit failure is scoped to 10-bit sources only.
 */
function decodeKey(codec: string, bitDepth?: number): string {
    const lc = codec.toLowerCase();
    return bitDepth && bitDepth > 8 ? `${lc}@${bitDepth}bit` : lc;
}

/** Details recorded the first time a (backend, codec) was learned undecodable. */
export interface LearnedDecodeEntry {
    /** Source codec (lowercase) that fell back to software decode. */
    codec: string;
    /**
     * Source bit depth that failed. Lessons are keyed by codec+depth so a 10-bit
     * H.264 failure (no GPU has a Hi10P decoder) does NOT force the far more
     * common 8-bit H.264 onto the software path. Required: a lesson without a
     * depth cannot be scoped, so it is never created and never loaded. Recorded
     * for every depth — including 8, where {@link decodeKey} folds it into the
     * bare codec key — so the admin UI can state the real scope.
     */
    bitDepth: number;
    /** ISO-8601 timestamp of when this lesson was first recorded. */
    learnedAt: string;
    /**
     * Build that recorded the lesson ({@link config.buildInfo.version}).
     *
     * A lesson is only ever inferred from an FFmpeg failure, so a bug in OUR
     * argument construction can teach one that is simply false — and it then
     * outlives the fix, because nothing re-verifies a denied codec (once denied,
     * hardware decode is never attempted again). That happened: a `-color_range`
     * bug made a perfectly decodable AV1 source emit the surface-mismatch
     * signature, the lesson stuck, and it kept forcing the software bridge for
     * days after the bug was fixed — long enough to look like a hardware gap.
     *
     * Treating a lesson from a different build as expired makes shipping a fix
     * the thing that clears the lessons that fix invalidates. The cost is the
     * same one the TTL already accepts: a genuine silicon gap re-learns on the
     * next play, one transparent retry cycle.
     */
    learnedBy?: string;
    /** Example source filename that triggered the lesson, if known. */
    sample?: string;
}

/** A human-readable view of one backend's decode-capability state, for admin UI. */
/** A codec/depth combination denied statically (never attempted, never learned). */
export interface StaticSoftwareDecodeEntry {
    codec: string;
    /** Human-readable bit-depth qualifier, e.g. "10/12-bit". */
    bitDepths: string;
    /** Why the combination is software-decoded on every GPU. */
    reason: string;
}

/**
 * A learned entry enriched for display: the raw lesson plus the answers to the
 * two questions an operator actually has when they see a row — *which* sources
 * does this divert, and *why is it here*. Derived here rather than in the admin
 * component so the wording can never drift from {@link decodeKey}'s real
 * matching behaviour.
 */
export interface LearnedDecodeEntryView extends LearnedDecodeEntry {
    /** Which sources this lesson diverts to software decode, in plain words. */
    scope: string;
    /** Why the lesson was recorded. */
    reason: string;
    /** ISO-8601 instant at which the lesson stops being enforced (TTL expiry). */
    expiresAt: string;
}

/** Why a learn-on-failure entry exists — one cause, stated once. */
const LEARNED_DECODE_REASON =
    'Two consecutive transcodes failed with a decode-surface mismatch: FFmpeg ' +
    'software-decoded this source and the GPU-only filter/encoder rejected the ' +
    'system-memory frames.';

/** Human-readable scope for a learned lesson, mirroring {@link decodeKey}. */
function describeLearnedScope(entry: LearnedDecodeEntry): string {
    const codec = entry.codec.toUpperCase();
    if (entry.bitDepth > 8) {
        return `${entry.bitDepth}-bit ${codec} sources only. 8-bit ${codec} still hardware-decodes.`;
    }
    return `8-bit ${codec} sources (and any whose depth was never probed). Higher-depth ${codec} is scoped separately.`;
}

export interface GpuDecodeCapabilitySnapshot {
    backend: GpuAcceleration;
    /** Whether this backend uses the software-decode bridge at all. */
    bridgeable: boolean;
    /** Static whitelist of codecs this backend can hardware-decode. */
    hardwareDecodableCodecs: string[];
    /** Codecs learned at runtime as NOT hardware-decodable (software-decoded). */
    learned: LearnedDecodeEntryView[];
    /**
     * Codec/depth combinations denied statically by isSourceHardwareDecodable
     * (bridged from the first playback, so they never appear in `learned`).
     */
    staticSoftwareDecoded: StaticSoftwareDecodeEntry[];
}

/**
 * Statically-denied codec/depth combinations for bridgeable backends —
 * mirrors the hard rule in {@link HardwareDetectionService.isSourceHardwareDecodable}.
 * Surfaced in the admin snapshot so operators can see WHY such a source is
 * software-decoded even though the codec appears in the hardware whitelist.
 */
const STATIC_SOFTWARE_DECODED: StaticSoftwareDecodeEntry[] = [
    {
        codec: 'h264',
        bitDepths: '10/12-bit',
        reason: 'No GPU ships a high-bit-depth H.264 (Hi10P) hardware decoder',
    },
];

/**
 * Whether a given NVIDIA GPU actually has an AV1 NVENC encoder.
 *
 * AV1 hardware encode arrived with Ada Lovelace: GeForce RTX 40-series and newer
 * (and the Ada datacenter cards L4 / L40 / L40S). Everything older — Ampere
 * (RTX 30xx, A100/A40/A10), Turing (RTX 20xx / GTX 16xx), GTX, and older
 * datacenter (T4/V100/P-series) — still *lists* `av1_nvenc` in FFmpeg's
 * `-encoders` output but fails at runtime with -22 ("Invalid argument"). Since
 * `selectTranscodeCodec` is quality-first (av1 > hevc > h264) and trusts the
 * listed encoders, it would pick AV1 and then hard-fail with no fallback.
 * Parsing the model number keeps this a cheap, deterministic guard (no probe
 * encode needed) — the runtime probe in getBestEncoder remains a backstop.
 */
export function nvencSupportsAv1(gpuName: string): boolean {
    const name = gpuName.toLowerCase();
    // GeForce / RTX-workstation cards carry a 4-digit model number; Ada (4000)
    // and newer have AV1 NVENC. (RTX 3090 → 3090 < 4000 → no AV1.)
    const model = name.match(/(?:rtx|gtx)\s*(\d{4})/);
    if (model) return parseInt(model[1], 10) >= 4000;
    // Ada-generation datacenter GPUs (L4 / L40 / L40S) have AV1 NVENC.
    if (/\bl40s?\b/.test(name) || /\bl4\b/.test(name)) return true;
    // Unknown / older datacenter (A100, A40, T4, V100, P-series, etc.): assume
    // no AV1 NVENC. Falling back to HEVC/H.264 NVENC is always safe; a wrong
    // "supported" guess would hard-fail the transcode.
    return false;
}

/**
 * Singleton service for detecting hardware transcoding capabilities.
 * Caches detection results to avoid repeated FFmpeg probing.
 */
class HardwareDetectionService {
    private capabilities: HardwareCapabilities | null = null;
    private detecting = false;
    /** Cache for runtime encoder probes (encoder name → result promise) */
    private encoderProbeCache = new Map<string, Promise<boolean>>();
    /** Encoder → wall-clock time after which a "busy" probe failure is retried. */
    private busyProbeRetryAt = new Map<string, number>();
    private detectPromise: Promise<HardwareCapabilities> | null = null;
    /** Cache for the NVIDIA GPU model name (undefined = not yet queried). */
    private nvidiaGpuName: string | null | undefined;
    /**
     * Per-backend source codecs this host's GPU stack failed to hardware-decode
     * at runtime (learn-on-failure). Consulted synchronously by the transcode arg
     * builder to pick the software-decode + hwupload bridge. Mirrored to Valkey so
     * the lesson survives restarts and is shared across replicas; cleared via
     * {@link resetDecodeCapabilities}.
     */
    private gpuDecodeDeny = new Map<GpuAcceleration, Map<string, LearnedDecodeEntry>>();
    /** Guard so the Valkey hydrate runs at most once. */
    private gpuDenyHydrated = false;
    /**
     * Whether the active VA-API driver supports hardware HDR tone-mapping
     * (`tonemap_vaapi`). null = not yet probed. Intel iHD = true, AMD radeonsi =
     * false → HDR/HLG/DV → SDR must tonemap in software on AMD.
     */
    private vaapiHdrTonemap: boolean | null = null;
    /** In-flight tone-map probe, shared so concurrent first transcodes spawn one FFmpeg. */
    private vaapiHdrTonemapProbe: Promise<boolean> | null = null;
    /**
     * Bumped when the GPU settings change. A probe or detection started under
     * the old settings must not write its result over the cleared state.
     */
    private gpuConfigGeneration = 0;

    /**
     * Query the NVIDIA GPU model name via nvidia-smi (cached). Returns null when
     * nvidia-smi is unavailable or errors (e.g. no NVIDIA GPU / not in PATH).
     */
    private async detectNvidiaGpuName(): Promise<string | null> {
        if (this.nvidiaGpuName !== undefined) return this.nvidiaGpuName;
        try {
            const { stdout } = await execFileAsync(
                'nvidia-smi',
                ['--query-gpu=name', '--format=csv,noheader'],
                { timeout: 5000 },
            );
            this.nvidiaGpuName = stdout.split('\n')[0]?.trim() || null;
        } catch {
            this.nvidiaGpuName = null;
        }
        return this.nvidiaGpuName;
    }

    /**
     * Get cached hardware capabilities or detect them.
     */
    async getCapabilities(): Promise<HardwareCapabilities> {
        if (this.capabilities) {
            return this.capabilities;
        }

        // If detection is in progress, wait for it
        if (this.detecting && this.detectPromise) {
            return this.detectPromise;
        }

        this.detecting = true;
        const promise = this.detectCapabilities();
        this.detectPromise = promise;
        const generation = this.gpuConfigGeneration;

        try {
            const detected = await promise;
            if (generation === this.gpuConfigGeneration) this.capabilities = detected;
            return detected;
        } finally {
            // A GPU settings change may have handed the slot to a newer
            // detection; only clear our own.
            if (this.detectPromise === promise) {
                this.detecting = false;
                this.detectPromise = null;
            }
        }
    }

    /**
     * Already-probed capabilities, or null if nothing has probed yet.
     *
     * Exists for callers that must NOT trigger a probe — notably the transcode
     * failure recorder, which runs on the FFmpeg exit path where spawning ffmpeg
     * would contend with the GPU that just failed. Never make this probe.
     */
    getCachedCapabilities(): HardwareCapabilities | null {
        return this.capabilities ?? null;
    }

    /**
     * Already-queried NVIDIA GPU model name, or null when nothing has queried
     * yet (cold cache) OR nvidia-smi found no card. Synchronous and NEVER
     * probes — same contract as {@link getCachedCapabilities}, for the same
     * reason: the transcode failure recorder runs on the FFmpeg exit path,
     * where spawning nvidia-smi would contend with the GPU that just failed.
     */
    getCachedNvidiaGpuName(): string | null {
        return this.nvidiaGpuName ?? null;
    }

    /**
     * Force re-detection of hardware capabilities.
     */
    async refreshCapabilities(): Promise<HardwareCapabilities> {
        this.capabilities = null;
        return this.getCapabilities();
    }

    /**
     * Check if a specific encoder is available.
     */
    async supportsEncoder(encoder: string): Promise<boolean> {
        const caps = await this.getCapabilities();
        return caps.encoders.includes(encoder);
    }

    /**
     * Check if a specific decoder is available.
     */
    async supportsDecoder(decoder: string): Promise<boolean> {
        const caps = await this.getCapabilities();
        return caps.decoders.includes(decoder);
    }

    /**
     * Check if a hardware accelerator is available.
     */
    async supportsHwaccel(hwaccel: string): Promise<boolean> {
        const caps = await this.getCapabilities();
        return caps.hwaccels.includes(hwaccel);
    }

    /**
     * Check if a filter is available.
     */
    async supportsFilter(filter: string): Promise<boolean> {
        const caps = await this.getCapabilities();
        return caps.filters.includes(filter);
    }

    /**
     * Invalidate a cached runtime encoder probe result.
     * Called when a transcode job fails, so the next job will re-probe the encoder
     * instead of trusting the stale cached result.
     */
    invalidateEncoderProbe(encoderName: string): void {
        this.busyProbeRetryAt.delete(encoderName);
        if (this.encoderProbeCache.delete(encoderName)) {
            logger.info('Invalidated cached probe for encoder', {
                encoder: encoderName,
            });
        }
    }

    /**
     * Clear all cached runtime encoder probe results.
     * Useful for manual recovery via admin endpoint without server restart.
     */
    refreshAllProbes(): void {
        const count = this.encoderProbeCache.size;
        this.encoderProbeCache.clear();
        this.busyProbeRetryAt.clear();
        // Re-probe tone-mapping too: a transient failure (busy device) must not
        // pin an Intel iHD host to software tone-mapping until restart.
        this.vaapiHdrTonemap = null;
        this.vaapiHdrTonemapProbe = null;
        this.gpuConfigGeneration++;
        logger.info('Cleared all encoder probe cache entries', { count });
    }

    /**
     * GPU_ACCELERATION, VAAPI_DEVICE or QSV_DEVICE changed. Every cached answer
     * was measured against the old settings: the encoder probes and the VA-API
     * tone-map probe bake the device path into their FFmpeg args, and detection
     * prunes av1_nvenc only when NVENC was selected at detection time. A probe
     * that failed under the old settings (wrong device, GPU not passed through
     * yet) would otherwise stay false for the life of the process.
     *
     * Running transcodes are untouched: they hold their own FFmpeg args. The
     * next transcode re-probes. Capabilities already detected are kept until
     * the fresh detection finishes, so readers never see a cold cache.
     */
    resetForGpuSettingsChange(): void {
        this.refreshAllProbes();
        // A detection still running was started under the old settings: callers
        // arriving from now on must not join it.
        this.detecting = false;
        this.detectPromise = null;
        if (!this.capabilities) return;
        const generation = this.gpuConfigGeneration;
        void this.detectCapabilities()
            .then((detected) => {
                if (generation === this.gpuConfigGeneration) this.capabilities = detected;
            })
            .catch((err: unknown) => {
                logger.warn('Hardware re-detection after GPU settings change failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
    }

    // =========================================================================
    // GPU decode-capability learning (learn-on-failure)
    //
    // Hardware-decode support is GPU-generation-specific and is NOT reflected by
    // `ffmpeg -decoders` (which lists compiled-in wrappers, not silicon
    // capability). The static HW_DECODABLE_BY_BACKEND whitelist is a best guess;
    // when a real transcode proves it wrong (the encoder fails to open because
    // software-decoded frames can't reach a GPU-only filter/encoder), the
    // transcode service records the (backend, codec) here and retries with the
    // bridge. Only the VA-API family (qsv/vaapi) is bridged today.
    // =========================================================================

    /** Whether this backend supports the software-decode + hwupload bridge. */
    canSoftwareDecodeBridge(backend: GpuAcceleration): boolean {
        return HW_DECODABLE_BY_BACKEND[backend] !== undefined;
    }

    /**
     * Whether `backend` can hardware-decode `codec` into a GPU surface on this
     * host. Combines the static per-backend whitelist with the runtime
     * learn-on-failure deny-set. Backends without bridge support are always
     * "decodable" (no bridge). For a bridgeable backend, an unknown/absent codec
     * is treated as not decodable (bridge; always safe).
     */
    isSourceHardwareDecodable(
        backend: GpuAcceleration,
        codec: string | undefined,
        bitDepth?: number,
    ): boolean {
        const whitelist = HW_DECODABLE_BY_BACKEND[backend];
        if (!whitelist) return true; // backend has no bridge → never divert to it
        if (!codec) return false;
        const lc = codec.toLowerCase();
        if (!whitelist.has(lc)) return false;
        // No GPU silicon ships an H.264 High 10 (Hi10P) decoder — >8-bit H.264
        // is software-only on every vendor. Deny statically so the first
        // playback bridges immediately instead of burning a fail→retry→learn
        // cycle (and so a mis-keyed lesson can never be needed to cover it).
        if (lc === 'h264' && bitDepth !== undefined && bitDepth > 8) return false;
        const entry = this.gpuDecodeDeny.get(backend)?.get(decodeKey(lc, bitDepth));
        // No lesson, or an expired one → decodable (an expired lesson is re-verified
        // on the next play and re-learned only if it fails the strict signature).
        return !entry || isLearnedEntryExpired(entry);
    }

    /**
     * Record that `backend` could NOT hardware-decode `codec` (at `opts.bitDepth`)
     * on this host. Future transcodes of this codec/depth use the software-decode
     * bridge. `opts.sample` is an example source (e.g. filename) shown in the admin
     * UI. Persisted to Valkey (best-effort) so the lesson survives restarts.
     *
     * Returns whether the lesson was persisted. A caller that gets `false` must
     * still rescue its own job (config.forceSoftwareDecodeBridge) — the failure
     * was real, it just wasn't safely generalizable.
     *
     * REFUSES to persist when the source bit depth is unknown. Hardware decode
     * support is depth-specific (a GPU that decodes 8-bit H.264 at full speed has
     * no Hi10P decoder at all), so a depth-less lesson can only be written to the
     * bare-codec key — which then diverts every 8-bit source of that codec to
     * software decode on the strength of a 10-bit failure. That exact over-reach
     * shipped once; keeping the guard here means no future caller can reintroduce
     * it by forgetting to thread the depth through.
     */
    markSourceNotHardwareDecodable(
        backend: GpuAcceleration,
        codec: string,
        opts?: { bitDepth?: number; sample?: string },
    ): boolean {
        const lc = codec.toLowerCase();
        if (opts?.bitDepth === undefined) {
            logger.warn(
                'Refusing to learn a GPU decode-capability lesson without a known source bit depth — bridging this job only',
                { backend, codec: lc, sample: opts?.sample },
            );
            return false;
        }
        const key = decodeKey(lc, opts.bitDepth);
        let entries = this.gpuDecodeDeny.get(backend);
        if (!entries) {
            entries = new Map<string, LearnedDecodeEntry>();
            this.gpuDecodeDeny.set(backend, entries);
        }
        // Skip only when a still-valid lesson exists; refresh an expired one so its
        // TTL window restarts (a genuine gap re-confirmed after expiry stays denied).
        const existing = entries.get(key);
        if (existing && !isLearnedEntryExpired(existing)) return true;
        const entry: LearnedDecodeEntry = {
            codec: lc,
            // Recorded at its real value even for 8-bit (where the key folds to
            // the bare codec) so the admin UI can state the true scope.
            bitDepth: opts.bitDepth,
            learnedAt: new Date().toISOString(),
            learnedBy: currentBuildId(),
            sample: opts.sample,
        };
        entries.set(key, entry);
        // Tell the other replicas, so each one does not have to rediscover this by
        // failing a playback of its own — and so their whole-map writes cannot
        // erase this entry from Valkey.
        publishDecodeDenySync({ kind: 'learn', backend, key, entry });
        logger.info('Learned: GPU cannot hardware-decode source codec on this host', {
            backend,
            codec: lc,
            bitDepth: opts.bitDepth,
            key,
            sample: opts.sample,
            total: entries.size,
        });
        void this.persistGpuDecodeDenyList();
        return true;
    }

    /**
     * Apply a lesson learned on ANOTHER replica.
     *
     * Local-only by design: no publish (the origin already did) and no persist
     * (likewise), so the bus cannot echo and two replicas cannot take turns
     * rewriting the same Valkey blob. The entry is stored exactly as it arrived —
     * rewriting `learnedBy` with this replica's build would disguise a peer's
     * lesson as locally learned and let it outlive the build that recorded it.
     */
    applyRemoteDecodeDenyLearn(
        backend: GpuAcceleration,
        key: string,
        entry: LearnedDecodeEntry,
    ): void {
        let entries = this.gpuDecodeDeny.get(backend);
        if (!entries) {
            entries = new Map<string, LearnedDecodeEntry>();
            this.gpuDecodeDeny.set(backend, entries);
        }
        entries.set(key, entry);
        logger.debug('Applied decode-capability lesson from another replica', {
            backend,
            key,
            learnedBy: entry.learnedBy,
        });
    }

    /** Apply a reset performed on another replica. Local-only, for the same reasons. */
    applyRemoteDecodeDenyReset(backend?: GpuAcceleration): void {
        if (backend) this.gpuDecodeDeny.delete(backend);
        else this.gpuDecodeDeny.clear();
        logger.info('Cleared decode-capability lessons on request from another replica', {
            backend: backend ?? 'all',
        });
    }

    /**
     * Sorted deny-map keys learned as not hardware-decodable and still in effect
     * (expired lessons are excluded, matching {@link isSourceHardwareDecodable}).
     * With a backend, returns that backend's keys; without, the union. Compact
     * summary / diagnostics.
     */
    getNonHardwareDecodableCodecs(backend?: GpuAcceleration): string[] {
        const liveKeys = (entries: Map<string, LearnedDecodeEntry>): string[] =>
            [...entries].filter(([, e]) => !isLearnedEntryExpired(e)).map(([k]) => k);
        if (backend) {
            const entries = this.gpuDecodeDeny.get(backend);
            return entries ? liveKeys(entries).sort() : [];
        }
        const all = new Set<string>();
        for (const entries of this.gpuDecodeDeny.values())
            for (const k of liveKeys(entries)) all.add(k);
        return [...all].sort();
    }

    /** Static whitelist of codecs `backend` can hardware-decode (sorted). */
    getHardwareDecodableCodecs(backend: GpuAcceleration): string[] {
        return [...(HW_DECODABLE_BY_BACKEND[backend] ?? [])].sort();
    }

    /**
     * Full decode-capability view for one backend — the static whitelist plus the
     * learned-undecodable entries with their timestamps and example sources.
     * Powers the admin UI "details" panel.
     */
    getDecodeCapabilitySnapshot(backend: GpuAcceleration): GpuDecodeCapabilitySnapshot {
        // Expired lessons are no longer enforced (isSourceHardwareDecodable treats
        // them as decodable) — hide them so the admin panel reflects what is
        // actually in effect rather than stale history.
        const learned: LearnedDecodeEntryView[] = [
            ...(this.gpuDecodeDeny.get(backend)?.values() ?? []),
        ]
            .filter((e) => !isLearnedEntryExpired(e))
            .sort((a, b) => a.codec.localeCompare(b.codec) || a.bitDepth - b.bitDepth)
            .map((e) => ({
                ...e,
                scope: describeLearnedScope(e),
                reason: LEARNED_DECODE_REASON,
                expiresAt: new Date(Date.parse(e.learnedAt) + LEARNED_DECODE_TTL_MS).toISOString(),
            }));
        return {
            backend,
            bridgeable: this.canSoftwareDecodeBridge(backend),
            hardwareDecodableCodecs: this.getHardwareDecodableCodecs(backend),
            learned,
            staticSoftwareDecoded: this.canSoftwareDecodeBridge(backend)
                ? STATIC_SOFTWARE_DECODED
                : [],
        };
    }

    /**
     * Clear learned decode-capability lessons (in-memory + Valkey). With a
     * backend, clears just that backend; without, clears all. The static
     * whitelist still applies; codecs are re-learned on the next failure.
     * Exposed for manual recovery via admin endpoint without a restart.
     */
    async resetDecodeCapabilities(backend?: GpuAcceleration): Promise<number> {
        let cleared = 0;
        if (backend) {
            cleared = this.gpuDecodeDeny.get(backend)?.size ?? 0;
            this.gpuDecodeDeny.delete(backend);
        } else {
            for (const entries of this.gpuDecodeDeny.values()) cleared += entries.size;
            this.gpuDecodeDeny.clear();
        }
        // THE reason this bus exists. A reset is the operator's only escape hatch
        // from a false lesson, and an admin request lands on exactly one replica —
        // so without this, the button appears to work while every other replica
        // goes on enforcing the lesson it was clicked to remove.
        publishDecodeDenySync({ kind: 'reset', backend });
        try {
            await this.persistGpuDecodeDenyList();
        } catch (err) {
            logger.warn('Failed to persist cleared GPU decode deny-list', {}, err as Error);
        }
        logger.info('Reset learned GPU decode-capability cache', {
            backend: backend ?? 'all',
            cleared,
        });
        return cleared;
    }

    /** Serialize the in-memory deny-map to `{ backend: LearnedDecodeEntry[] }`. */
    private serializeGpuDecodeDeny(): Record<string, LearnedDecodeEntry[]> {
        const out: Record<string, LearnedDecodeEntry[]> = {};
        for (const [backend, entries] of this.gpuDecodeDeny) {
            if (entries.size > 0) {
                out[backend] = [...entries.values()].sort((a, b) => a.codec.localeCompare(b.codec));
            }
        }
        return out;
    }

    /**
     * Load the persisted deny-map from Valkey into memory once (best-effort).
     * Entries that don't carry a codec and a real bit depth are skipped — the
     * same rule {@link markSourceNotHardwareDecodable} applies on write.
     */
    private async hydrateGpuDecodeDenyList(): Promise<void> {
        if (this.gpuDenyHydrated) return;
        this.gpuDenyHydrated = true;
        try {
            const raw = await cacheGet(GPU_DECODE_DENY_KEY);
            if (!raw) return;
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null) return;
            for (const [backend, value] of Object.entries(parsed)) {
                if (!Array.isArray(value)) continue;
                const entries = new Map<string, LearnedDecodeEntry>();
                for (const item of value) {
                    if (!item || typeof item !== 'object') continue;
                    const e = item as Record<string, unknown>;
                    const codec = typeof e.codec === 'string' ? e.codec.toLowerCase() : null;
                    // Same rule as the write path: a lesson without a codec and a
                    // real bit depth cannot be scoped, so it is not loaded. The
                    // deny-map only ever holds entries it would create itself.
                    const bitDepth =
                        typeof e.bitDepth === 'number' && e.bitDepth > 0 ? e.bitDepth : null;
                    if (!codec || bitDepth === null) continue;
                    // Refuse a lesson whose stamp cannot identify the build that
                    // wrote it. Retirement works by comparing stamps, so `dev`
                    // (the Dockerfile default, hence every self-built image) would
                    // match forever and pin a possibly-false lesson across every
                    // upgrade — the staleness this whole mechanism exists to end.
                    // Rejecting on the way IN, rather than on every read, is what
                    // makes those deployments relearn per restart while the lesson
                    // still does its job — including arming the software-decode
                    // bridge — for the lifetime of the process that learned it.
                    if (
                        INDISTINCT_BUILD_IDS.has(typeof e.learnedBy === 'string' ? e.learnedBy : '')
                    )
                        continue;
                    entries.set(decodeKey(codec, bitDepth), {
                        codec,
                        bitDepth,
                        learnedAt:
                            typeof e.learnedAt === 'string'
                                ? e.learnedAt
                                : new Date(0).toISOString(),
                        // MUST round-trip: validity is keyed on this (see
                        // isLearnedEntryExpired). Dropping it here would make every
                        // hydrated lesson read as "written by another build" and so
                        // permanently expired — silently turning this whole cache into
                        // dead weight and re-learning a genuine gap on every restart.
                        learnedBy: typeof e.learnedBy === 'string' ? e.learnedBy : undefined,
                        sample: typeof e.sample === 'string' ? e.sample : undefined,
                    });
                }
                if (entries.size > 0) this.gpuDecodeDeny.set(backend as GpuAcceleration, entries);
            }
            logger.info('Hydrated learned GPU decode-capability cache from Valkey', {
                backends: this.serializeGpuDecodeDeny(),
            });
        } catch (err) {
            logger.warn('Failed to hydrate GPU decode deny-list from Valkey', {}, err as Error);
        }
    }

    /** Write the current deny-map to Valkey (best-effort, no TTL). */
    private async persistGpuDecodeDenyList(): Promise<void> {
        try {
            await cacheSet(GPU_DECODE_DENY_KEY, JSON.stringify(this.serializeGpuDecodeDeny()));
        } catch (err) {
            logger.warn('Failed to persist GPU decode deny-list to Valkey', {}, err as Error);
        }
    }

    /**
     * Public runtime probe for a single encoder: runs a minimal one-frame encode
     * to verify the encoder actually works on this hardware (not merely that
     * FFmpeg lists it as compiled in). Shares the same cache as the transcode
     * path, so a probe here primes the real transcode and vice-versa.
     *
     * Used by first-run GPU onboarding detection to suggest hardware transcoding
     * only when a candidate encoder genuinely runs.
     */
    async probeEncoder(encoder: string): Promise<boolean> {
        return this.probeEncoderRuntime(encoder);
    }

    /**
     * Public accessor for the detected NVIDIA GPU model name (via nvidia-smi),
     * or null when unavailable (no NVIDIA GPU / nvidia-smi not in PATH). Cached.
     */
    async getNvidiaGpuName(): Promise<string | null> {
        return this.detectNvidiaGpuName();
    }

    /**
     * Runtime probe: try a minimal encode to verify a GPU encoder actually works.
     * FFmpeg lists encoders compiled in, but the GPU hardware may not support them
     * (e.g. av1_nvenc listed on RTX 3090 which lacks AV1 NVENC).
     * Results are cached until invalidated by a transcode failure or manual refresh.
     */
    private probeEncoderRuntime(encoder: string): Promise<boolean> {
        const retryAt = this.busyProbeRetryAt.get(encoder);
        if (retryAt !== undefined && Date.now() >= retryAt) {
            this.busyProbeRetryAt.delete(encoder);
            this.encoderProbeCache.delete(encoder);
        }
        if (this.encoderProbeCache.has(encoder)) {
            return this.encoderProbeCache.get(encoder)!;
        }

        // Only probe GPU encoders — software encoders always work if listed
        if (!isGpuEncoder(encoder)) {
            const result = Promise.resolve(true);
            this.encoderProbeCache.set(encoder, result);
            return result;
        }

        // Store the promise immediately to deduplicate concurrent probes
        // expectFailure: a probe failing is a measurement (no such GPU), not an
        // incident — keep the ffmpeg banner/config dump out of the ERROR log.
        const probe = this.runFFmpeg(buildEncoderProbeArgs(encoder), { expectFailure: true })
            .then(() => {
                logger.info('Runtime encoder probe succeeded', { encoder });
                return true;
            })
            .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                if (NVENC_BUSY_RE.test(message)) {
                    // Busy, not missing: try again on a later job.
                    this.busyProbeRetryAt.set(encoder, Date.now() + BUSY_ENCODER_PROBE_RETRY_MS);
                    logger.info(
                        'Runtime encoder probe failed — encoder busy (no free session); retrying on a later job',
                        { encoder, retryInSeconds: BUSY_ENCODER_PROBE_RETRY_MS / 1000 },
                    );
                    return false;
                }
                logger.info('Runtime encoder probe failed — encoder unavailable on this host', {
                    encoder,
                    reason: summarizeProbeFailure(err),
                });
                return false;
            });
        this.encoderProbeCache.set(encoder, probe);
        return probe;
    }

    /**
     * Probe (once, cached) whether the VA-API driver can hardware tone-map HDR.
     * AMD `radeonsi` cannot; Intel `iHD` can. Only meaningful when
     * GPU_ACCELERATION=vaapi — when false, the transcode pipeline tonemaps HDR in
     * software (tonemapx) and uploads the SDR result to a VA-API surface.
     */
    async probeVaapiHdrTonemap(): Promise<boolean> {
        if (this.vaapiHdrTonemap !== null) return this.vaapiHdrTonemap;
        const generation = this.gpuConfigGeneration;
        this.vaapiHdrTonemapProbe ??= this.runFFmpeg(buildVaapiHdrTonemapProbeArgs(), {
            expectFailure: true,
        })
            .then(() => true)
            .catch(() => false)
            .then((supported) => {
                // Settings changed while this probe ran: its answer is about
                // the old device. Leave the cleared state and answer the
                // waiting callers from a probe of the current device.
                if (generation !== this.gpuConfigGeneration) return this.probeVaapiHdrTonemap();
                this.vaapiHdrTonemap = supported;
                this.vaapiHdrTonemapProbe = null;
                logger.info('VA-API HDR tone-map probe complete', {
                    supported,
                    note: supported ? 'hardware tonemap_vaapi' : 'software tonemap fallback',
                });
                return supported;
            });
        return this.vaapiHdrTonemapProbe;
    }

    /**
     * True unless we positively probed that the VA-API driver lacks hardware HDR
     * tone-mapping. Safe default (true = current hardware behaviour) until the
     * probe resolves.
     */
    supportsVaapiHdrTonemap(): boolean {
        return this.vaapiHdrTonemap !== false;
    }

    /**
     * How HDR → SDR tone-mapping runs for `backend` on this host, for admin UI.
     * 'hardware' = GPU VPP (tonemap_vaapi / vpp_qsv / tonemap_cuda); 'software' =
     * CPU tonemapx; 'n/a' = no GPU (software-only) or backend doesn't tonemap.
     */
    getHdrTonemapMode(backend: GpuAcceleration): 'hardware' | 'software' | 'n/a' {
        switch (backend) {
            case 'vaapi':
                return this.supportsVaapiHdrTonemap() ? 'hardware' : 'software';
            case 'qsv': // vpp_qsv (Intel) tonemaps in hardware
            case 'nvenc': // tonemap_cuda (NVIDIA) tonemaps in hardware
                return 'hardware';
            case 'none':
                return 'software';
            default:
                return 'n/a';
        }
    }

    /**
     * Get the best available encoder for a codec based on configured preferences.
     * @param codec Base codec name (h264, hevc, av1)
     * @returns Best available encoder name or null if none available
     */
    async getBestEncoder(codec: 'h264' | 'hevc' | 'av1'): Promise<string | null> {
        // Check if encoding is allowed for this codec
        if (codec === 'hevc' && !config.ALLOW_HEVC_ENCODING) {
            logger.debug('HEVC encoding disabled by config, falling back to H.264');
            return this.getBestEncoder('h264');
        }
        if (codec === 'av1' && !config.ALLOW_AV1_ENCODING) {
            logger.debug('AV1 encoding disabled by config, falling back to H.264');
            return this.getBestEncoder('h264');
        }

        const caps = await this.getCapabilities();

        // GPU_ACCELERATION config takes priority - user explicitly selected this GPU type
        const gpuAccel = config.GPU_ACCELERATION?.toLowerCase() || 'none';

        logger.debug('GPU acceleration config for encoder selection', {
            codec,
            configValue: config.GPU_ACCELERATION,
            gpuAccel,
        });

        // Encoder mapping by GPU type
        const encodersByType: Record<string, Record<string, string>> = {
            h264: {
                nvenc: 'h264_nvenc',
                qsv: 'h264_qsv',
                amf: 'h264_amf',
                vaapi: 'h264_vaapi',
                videotoolbox: 'h264_videotoolbox',
                software: 'libx264',
            },
            hevc: {
                nvenc: 'hevc_nvenc',
                qsv: 'hevc_qsv',
                amf: 'hevc_amf',
                vaapi: 'hevc_vaapi',
                videotoolbox: 'hevc_videotoolbox',
                software: 'libx265',
            },
            av1: {
                nvenc: 'av1_nvenc',
                qsv: 'av1_qsv',
                amf: 'av1_amf',
                vaapi: 'av1_vaapi',
                software: 'libsvtav1',
            },
        };

        const codecEncoders = encodersByType[codec];
        if (!codecEncoders) return null;

        // User selected a specific GPU type - use ONLY that, no fallback
        if (gpuAccel !== 'none') {
            const preferredEncoder = codecEncoders[gpuAccel];

            // Invalid GPU type configured
            if (!preferredEncoder) {
                logger.error('Invalid GPU_ACCELERATION type configured', undefined, {
                    gpuAccel,
                    codec,
                    validTypes: Object.keys(codecEncoders).filter((k) => k !== 'software'),
                });
                return null;
            }

            // Check if encoder is listed in FFmpeg AND works at runtime
            if (caps.encoders.includes(preferredEncoder)) {
                const works = await this.probeEncoderRuntime(preferredEncoder);
                if (works) {
                    // Detection only probes VA-API HDR tone-mapping when vaapi was
                    // already configured at boot. A fresh install switches to vaapi
                    // at runtime (setup wizard), so probe here before the first
                    // transcode; otherwise AMD radeonsi gets tonemap_vaapi and
                    // every HDR→SDR transcode fails. Cached after the first run.
                    if (
                        gpuAccel === 'vaapi' &&
                        this.vaapiHdrTonemap === null &&
                        caps.filters.includes('tonemap_vaapi')
                    ) {
                        await this.probeVaapiHdrTonemap();
                    }
                    logger.debug('Using encoder matching GPU_ACCELERATION config', {
                        gpuAccel,
                        encoder: preferredEncoder,
                    });
                    return preferredEncoder;
                }
                logger.warn('GPU encoder listed but runtime probe failed', {
                    encoder: preferredEncoder,
                    codec,
                });
                // Fall through to "not available" error
            }

            // Configured GPU encoder not available - fail, no fallback.
            // AV1 is the expected case on pre-Ada NVIDIA / older Intel/AMD: the
            // caller falls back to HEVC/H.264, so it is not an operator error.
            const details = {
                gpuAccel,
                preferredEncoder,
                codec,
                availableEncoders: caps.encoders.filter((e) => e.includes(codec)),
            };
            if (codec === 'av1') {
                logger.info('GPU has no AV1 encoder; AV1 output falls back to HEVC/H.264', details);
            } else {
                logger.error('Configured GPU encoder not available in FFmpeg', undefined, details);
            }
            return null;
        }

        // GPU_ACCELERATION=none: Use software encoder only
        const softwareEncoder = codecEncoders['software'];
        if (softwareEncoder && caps.encoders.includes(softwareEncoder)) {
            logger.debug('Using software encoder (GPU_ACCELERATION=none)', {
                encoder: softwareEncoder,
            });
            return softwareEncoder;
        }

        logger.error('Software encoder not available', undefined, {
            codec,
            softwareEncoder,
            availableEncoders: caps.encoders.filter((e) => e.includes(codec)),
        });
        return null;
    }

    /**
     * Get the best decoder for a codec with hardware acceleration.
     * @param codec The codec to decode
     * @param is10Bit Whether the source is 10-bit color depth
     */
    async getBestDecoder(codec: string, is10Bit = false): Promise<string | null> {
        const caps = await this.getCapabilities();
        const gpuAccel = config.GPU_ACCELERATION;

        // Check if 10-bit hardware decoding is enabled for this codec
        if (is10Bit) {
            const hw10BitCodecs = config.HW_DECODE_10BIT.split(',').map((c) =>
                c.trim().toLowerCase(),
            );
            if (!hw10BitCodecs.includes(codec.toLowerCase())) {
                logger.debug(
                    '10-bit hardware decoding not enabled for codec, using software decoder',
                    { codec },
                );
                return codec;
            }
        }

        // Hardware decoder mapping
        // For NVIDIA, use CUVID decoders when NVDEC_ENHANCED is true (default)
        // When NVDEC_ENHANCED is false, we don't specify a decoder and let FFmpeg pick
        const nvencDecoders: Record<string, string> = config.NVDEC_ENHANCED
            ? {
                  h264: 'h264_cuvid',
                  hevc: 'hevc_cuvid',
                  av1: 'av1_cuvid',
                  vp9: 'vp9_cuvid',
              }
            : {}; // Empty = use hwaccel instead of explicit decoder

        // For QSV, use specific decoders unless HW_PREFER_NATIVE_DECODERS is true
        // When true, use OS native DXVA/VA-API via hwaccel instead
        const qsvDecoders: Record<string, string> = config.HW_PREFER_NATIVE_DECODERS
            ? {} // Empty = use hwaccel (DXVA on Windows, VA-API on Linux)
            : {
                  h264: 'h264_qsv',
                  hevc: 'hevc_qsv',
                  av1: 'av1_qsv',
                  vp9: 'vp9_qsv',
                  mpeg2: 'mpeg2_qsv',
              };

        const hwDecoders: Record<GpuAcceleration, Record<string, string>> = {
            none: {},
            nvenc: nvencDecoders,
            qsv: qsvDecoders,
            vaapi: {}, // VAAPI uses hwaccel, not specific decoders
            amf: {}, // AMF uses d3d11va hwaccel for decoding
            videotoolbox: {}, // VideoToolbox uses hwaccel, not specific decoders
        };

        const hwDecoder = hwDecoders[gpuAccel]?.[codec];
        if (hwDecoder && caps.decoders.includes(hwDecoder)) {
            return hwDecoder;
        }

        // Return base codec name (FFmpeg will use software decoder)
        return codec;
    }

    /**
     * Run FFmpeg command and capture output using the safe spawn wrapper.
     */
    private async runFFmpeg(
        args: string[],
        opts: { expectFailure?: boolean } = {},
    ): Promise<string> {
        const result = await spawnFFmpegSafely({
            args,
            timeout: 10000,
            expectFailure: opts.expectFailure,
            context: {
                operation: 'hardware-detection',
                args: args.join(' '),
            },
        });

        // FFmpeg often outputs to stderr for -encoders, -decoders, etc.
        return result.stdout || result.stderr;
    }

    /**
     * Parse FFmpeg encoder/decoder list output.
     */
    private parseCodecList(output: string): string[] {
        const codecs: string[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Format: " V..... h264_nvenc           NVIDIA NVENC H.264 encoder"
            // or:     " V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10"
            const match = line.match(/^\s*[VASFXBD.]+\s+(\w+)/);
            if (match) {
                codecs.push(match[1]);
            }
        }

        return codecs;
    }

    /**
     * Parse FFmpeg hwaccel list output.
     */
    private parseHwaccelList(output: string): string[] {
        const hwaccels: string[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            // Skip header lines and empty lines
            if (trimmed && !trimmed.startsWith('Hardware') && trimmed !== '') {
                hwaccels.push(trimmed);
            }
        }

        return hwaccels;
    }

    /**
     * Parse FFmpeg filter list output.
     */
    private parseFilterList(output: string): string[] {
        const filters: string[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Format: " T.. tonemap            V->V       Apply tone map"
            const match = line.match(/^\s*[T.]+[SC.]+[r.]+\s+(\w+)/);
            if (match) {
                filters.push(match[1]);
            }
        }

        return filters;
    }

    /**
     * Parse FFmpeg version from output.
     */
    private parseVersion(output: string): string {
        const match = output.match(/ffmpeg version (\S+)/);
        return match ? match[1] : 'unknown';
    }

    /**
     * Detect all hardware capabilities by probing FFmpeg.
     */
    private async detectCapabilities(): Promise<HardwareCapabilities> {
        logger.info('Detecting hardware transcoding capabilities...');

        // Hydrate the learned GPU decode deny-map from Valkey early (best-effort,
        // fire-and-forget). Detection runs once at startup, well before any
        // transcode, so the synchronous isSourceHardwareDecodable() read is
        // populated by the time it matters; a race only costs one extra failure.
        void this.hydrateGpuDecodeDenyList();

        const defaultCaps: HardwareCapabilities = {
            encoders: [],
            decoders: [],
            hwaccels: [],
            filters: [],
            ffmpegVersion: 'unknown',
            detected: false,
        };

        try {
            // Run all probes in parallel
            const [versionOutput, encoderOutput, decoderOutput, hwaccelOutput, filterOutput] =
                await Promise.all([
                    this.runFFmpeg(['-version']).catch(() => ''),
                    this.runFFmpeg(['-encoders']).catch(() => ''),
                    this.runFFmpeg(['-decoders']).catch(() => ''),
                    this.runFFmpeg(['-hwaccels']).catch(() => ''),
                    this.runFFmpeg(['-filters']).catch(() => ''),
                ]);

            let encoders = this.parseCodecList(encoderOutput);
            const decoders = this.parseCodecList(decoderOutput);
            const hwaccels = this.parseHwaccelList(hwaccelOutput);
            const filters = this.parseFilterList(filterOutput);
            const ffmpegVersion = this.parseVersion(versionOutput);

            // Prune AV1 NVENC on GPUs that don't actually have an AV1 encoder.
            // FFmpeg lists av1_nvenc on every NVIDIA GPU, but pre-Ada cards
            // (RTX 30xx and older) fail at runtime, and the quality-first codec
            // selector would otherwise pick AV1 and hard-fail with no fallback.
            // Only relevant when NVENC is the configured accelerator.
            if (encoders.includes('av1_nvenc') && config.GPU_ACCELERATION === 'nvenc') {
                const gpuName = await this.detectNvidiaGpuName();
                // Prune unless we can POSITIVELY confirm the GPU has AV1 NVENC.
                // If nvidia-smi is unavailable (gpuName null) we can't confirm,
                // so prune conservatively: GPU selection is strict (no fallback
                // on a probe failure), so selecting av1_nvenc and hard-failing is
                // worse than using HEVC/H.264 NVENC, which every NVENC GPU has.
                if (!gpuName || !nvencSupportsAv1(gpuName)) {
                    encoders = encoders.filter((e) => e !== 'av1_nvenc');
                    logger.info(
                        'AV1 NVENC disabled — GPU has no (confirmable) AV1 encoder; will use HEVC/H.264 NVENC',
                        {
                            gpuName: gpuName ?? 'unknown (nvidia-smi unavailable)',
                        },
                    );
                }
            }

            const capabilities: HardwareCapabilities = {
                encoders,
                decoders,
                hwaccels,
                filters,
                ffmpegVersion,
                detected: true,
            };

            logger.info('Hardware detection complete', {
                ffmpegVersion,
                hwaccels,
                videoEncoders: encoders.filter(
                    (e) =>
                        e.includes('264') ||
                        e.includes('265') ||
                        e.includes('hevc') ||
                        e.includes('av1') ||
                        e.includes('vp9'),
                ),
            });

            // When VA-API is the active backend, probe whether its driver can
            // hardware tone-map HDR (Intel iHD yes, AMD radeonsi no). Done here so
            // the synchronous supportsVaapiHdrTonemap() read is populated before
            // the first transcode; without it AMD HDR→SDR would emit tonemap_vaapi
            // and fail. Software backends / other GPUs don't use tonemap_vaapi.
            if (config.GPU_ACCELERATION === 'vaapi' && filters.includes('tonemap_vaapi')) {
                await this.probeVaapiHdrTonemap();
            }

            return capabilities;
        } catch (error) {
            logger.error(
                'Failed to detect hardware capabilities',
                error instanceof Error ? error : undefined,
            );
            return defaultCaps;
        }
    }
}

// Export singleton instance
export const hardwareDetection = new HardwareDetectionService();

// Apply deny-map changes made on OTHER replicas. Both handlers mutate the local
// map directly and deliberately do NOT re-publish or re-persist: the originating
// replica already did both, and echoing would loop the bus and let two replicas
// take turns rewriting the same blob.
onRemoteDecodeDenyLearn((backend, key, entry) => {
    hardwareDetection.applyRemoteDecodeDenyLearn(backend as GpuAcceleration, key, entry);
});
onRemoteDecodeDenyReset((backend) => {
    hardwareDetection.applyRemoteDecodeDenyReset(backend as GpuAcceleration | undefined);
});

// Re-probe when the GPU settings change. Every process that loaded this module
// holds its own probe cache; a save reaches each of them through the
// config-change listener (local save, or the reload the save broadcasts).
// The listener gets null keys after a reload, so compare the values.
function gpuSettingsFingerprint(): string {
    return [config.GPU_ACCELERATION, config.VAAPI_DEVICE, config.QSV_DEVICE].join('\u0000');
}
let lastGpuSettings = gpuSettingsFingerprint();
// (Guarded: a test that mocks the config module partially has no listener API.)
if (typeof onConfigChange === 'function') {
    onConfigChange(() => {
        const next = gpuSettingsFingerprint();
        if (next === lastGpuSettings) return;
        lastGpuSettings = next;
        logger.info('GPU settings changed; clearing hardware probe results');
        hardwareDetection.resetForGpuSettingsChange();
    });
}

// Export class for testing
export { HardwareDetectionService };

/**
 * True when the encoder ID refers to a GPU/hardware encoder (nvenc/qsv/amf/
 * vaapi/videotoolbox). Software encoders (libx264, libx265, libsvtav1, libaom)
 * return false. Used to classify an encoder ID returned by `getBestEncoder`,
 * which may fall back to software when no GPU is configured.
 */
export function isGpuEncoder(encoder: string | undefined | null): boolean {
    if (!encoder) return false;
    return /_nvenc|_qsv|_amf|_vaapi|_videotoolbox/.test(encoder);
}

/**
 * One-line reason for a failed probe: the last non-empty stderr line (ffmpeg
 * prints the actual cause last, e.g. "Could not open encoder before EOF"),
 * never the multi-line banner/config dump.
 */
export function summarizeProbeFailure(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    return (lines[lines.length - 1] ?? 'unknown').slice(0, 200);
}

/**
 * Build a minimal one-frame encode command to verify a GPU encoder works.
 *
 * VAAPI encoders require an explicit `-vaapi_device` AND frames uploaded to a
 * hardware surface (`format=nv12,hwupload`) — feeding a plain software frame
 * straight into `*_vaapi` always fails with "Could not open encoder", which made
 * the probe reject a perfectly working VAAPI encoder and silently fall back to
 * CPU (libx264, which then can't even encode 10-bit/HDR). This mirrors the real
 * transcode's hardware setup so the probe reflects reality. NVENC/QSV/AMF accept
 * software input frames (the encoder uploads internally), so they keep the
 * simple form.
 */
/**
 * Probe args for whether the active VA-API driver supports hardware HDR
 * tone-mapping (`tonemap_vaapi`). Intel iHD does; AMD Mesa `radeonsi` does NOT —
 * it reports "VAAPI driver doesn't support HDR" and the filter fails to configure
 * (-22), which otherwise breaks EVERY HDR/HLG/DV → SDR transcode on AMD. We
 * upload a BT.2020/PQ-tagged p010 frame and try to tonemap it: exit 0 = hardware
 * HDR tonemap available. Verified on a Radeon 760M (radeonsi): exits non-zero,
 * while the same minus the tonemap filter succeeds (so it's specifically the
 * tonemap, not the upload).
 */
export function buildVaapiHdrTonemapProbeArgs(): string[] {
    return [
        '-vaapi_device',
        config.VAAPI_DEVICE,
        '-f',
        'lavfi',
        '-i',
        'color=black:s=256x256:d=0.04',
        '-vf',
        'format=p010,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,hwupload,tonemap_vaapi=format=nv12',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
    ];
}

export function buildEncoderProbeArgs(encoder: string): string[] {
    const source = ['-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.04'];
    const sink = ['-frames:v', '1', '-f', 'null', '-'];
    if (encoder.endsWith('_vaapi')) {
        return [
            '-vaapi_device',
            config.VAAPI_DEVICE,
            ...source,
            '-vf',
            'format=nv12,hwupload',
            '-c:v',
            encoder,
            ...sink,
        ];
    }
    if (encoder.endsWith('_qsv')) {
        // QSV (oneVPL) needs an initialised device and frames on a QSV surface —
        // a bare software-frame probe fails to even create the MFX session.
        // Derive the QSV device from VA-API (the reliable path on Intel Linux /
        // Arc) and upload the frame, mirroring the real transcode.
        return [
            '-init_hw_device',
            `vaapi=va:${config.VAAPI_DEVICE}`,
            '-init_hw_device',
            'qsv=qs@va',
            ...source,
            '-vf',
            'format=nv12,hwupload=extra_hw_frames=16,format=qsv',
            '-c:v',
            encoder,
            ...sink,
        ];
    }
    return [...source, '-c:v', encoder, ...sink];
}

/**
 * True when the decoder ID refers to a GPU/hardware decoder. `getBestDecoder`
 * returns the bare codec name (e.g. `'hevc'`) as a fallback when no hardware
 * decoder matches — those fallbacks must not classify as GPU, otherwise
 * `useGpu = !!(gpuEncoder || gpuDecoder)` flips true on software-only boxes.
 */
export function isGpuDecoder(decoder: string | undefined | null): boolean {
    if (!decoder) return false;
    return /_cuvid|_qsv|_vaapi|_videotoolbox|_d3d11va|_dxva2/.test(decoder);
}
