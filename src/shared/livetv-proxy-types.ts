// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared type contracts between SvelteKit app and the Stream Proxy process.
 *
 * RULES:
 * - Plain TypeScript interfaces ONLY — no Zod, no runtime dependencies
 * - ZERO imports from any package (no node:*, no $lib, no npm packages)
 * - The app uses these types for the Rust proxy JSON protocol
 * - Type-only imports of sibling src/shared modules are fine (erased at build)
 */

import type {
    LiveTvChannelFailedBody,
    LiveTvFailureReason,
    LiveTvFeedFailure,
} from './livetv-failure-reason.js';

/** Proxy status response from GET /status */
export interface ProxyStatus {
    healthy: boolean;
    uptime: number;
    activeChannels: number;
    totalViewers: number;
    ffmpegAvailable: boolean;
    channels: ProxyChannelInfo[];
    perSourceLimits: Array<{
        sourceId: string;
        activeStreams: number;
        maxStreams: number;
    }>;
    /**
     * Encoder-output budget (LIVETV_MAX_EGRESS_ENCODERS), shared by fixed rungs and
     * adaptive groups. Surfaced because it is the least obvious capacity ceiling an
     * operator hits: ONE adaptive viewer on a 1080p channel reserves the whole default
     * budget of 4, after which every other channel's cap is refused.
     */
    egressCapacity?: {
        used: number;
        limit: number;
    };
    /**
     * Encoders whose channel is no longer registered with FfmpegManager.
     *
     * `channels[]` is built by walking the ACTIVE channel list, so an encoder that
     * outlives its ingest — a crash, or a teardown ordering slip — belongs to no row
     * and vanishes from the inventory while still holding its ledger slot. Reported
     * separately rather than dropped, because an unexplainable `egressCapacity.used`
     * is exactly the symptom this whole surface exists to remove.
     */
    orphanedEncoders?: ProxyEncoderInfo[];
}

/**
 * One FFmpeg process serving a channel.
 *
 * A channel used to mean exactly one process; with the quality ladder it can mean
 * several (one ingest, plus a per-rung encoder for every distinct fixed quality in
 * use, plus at most one synchronized adaptive group). The admin surfaces show these
 * per channel so "why is this box busy" has an answer that matches `ps`.
 */
/**
 * ONE health vocabulary for every encoder kind.
 *
 * Ingest and egress track health separately and disagreed on wording: ingest reports
 * `healthy | degraded | error`, egress `starting | healthy | restarting | failed`. Six
 * tokens across two namespaces on one field meant an operator saw `error` on an ingest
 * chip and `failed` on a rung chip for the same class of failure. Both sides map onto
 * this set at the boundary, so the field is translatable and comparable.
 */
export type ProxyEncoderHealth = 'starting' | 'healthy' | 'degraded' | 'failed';

export interface ProxyEncoderInfo {
    kind: 'ingest' | 'rung' | 'adaptive';
    /** Ladder rung for `kind: 'rung'`. Absent for ingest and adaptive. */
    rungId?: string;
    /** Outputs this ONE process writes: 1 for ingest/rung, N for an adaptive group. */
    outputs: string[];
    /** Viewers attached to this encoder specifically, not to the channel. */
    viewers: number;
    health: ProxyEncoderHealth;
    /** The channel this process serves. Set on orphans, whose channel is already gone. */
    channelId?: string;
    /** Slots this process holds against `egressCapacity.limit`. Ingest holds none. */
    reservedOutputs: number;
    /**
     * Terminating: signalled, but the process has not exited yet.
     *
     * Such an encoder serves nobody, yet it still holds its slot until the exit
     * settles (bounded at 8s). Listing it is what makes `egressCapacity.used`
     * explainable — hiding it produced a budget reading of 4/4 with no encoders shown
     * to account for it.
     */
    stopping?: boolean;
    startedAt?: string;
}

export interface ProxyChannelInfo {
    channelId: string;
    channelName: string;
    viewers: number;
    sourceId: string;
    ffmpegHealthy: boolean;
    ffmpegHealth?: 'healthy' | 'degraded' | 'error';
    startedAt: string;
    activeStreamUrl?: string;
    streamUrlIndex?: number;
    failoverExhausted?: boolean;
    failoverCount?: number;
    /** Typed reason of the last failed attempt on this channel (see livetv-failure-reason.ts). */
    lastFailureReason?: LiveTvFailureReason;
    /** True once every URL failed: HLS routes answer 410 channel_failed until a new join. */
    terminal?: boolean;
    /** Container format: 'fmp4' or 'mpegts' (legacy) */
    containerFormat?: 'fmp4' | 'mpegts';
    /** Number of segments in the ring buffer */
    segmentCount?: number;
    /** Latest complete newly ingested segment; absent until actual progress. */
    lastSegmentAt?: string;
    /** Passive ingest-output observations; counters reset when FFmpeg restarts. */
    outputDiagnostics?: {
        bufferedSeconds: number;
        timestampSamples: number;
        gapCount: number;
        resetCount: number;
        largestGapSeconds: number;
        lastGapAt?: string;
    };
    /** Total memory used by ring buffer segments (bytes) */
    memoryBytes?: number;
    /** Whether the init segment has been received */
    initSegmentReady?: boolean;
    /** Last FFmpeg stderr output (truncated) when health is error/degraded */
    ffmpegError?: string;
    /** Probe result from source analysis */
    probeResult?: {
        videoCodec: string | null;
        audioCodec: string | null;
        interlaced: boolean;
        hdr: boolean;
        bitDepth: number;
        width: number;
        height: number;
    };
    /**
     * Every FFmpeg process currently serving this channel — ingest plus any rung or
     * adaptive encoders. Optional so an older proxy simply reports nothing here.
     */
    encoders?: ProxyEncoderInfo[];
    /** Transcode decision made for this channel */
    transcodeDecision?: {
        videoAction: 'copy' | 'transcode';
        audioAction: 'copy' | 'transcode';
        videoEncoder: string | null;
        deinterlace: boolean;
        /** Absent on older TypeScript proxies; null when no filter is applied. */
        deinterlaceFilterName?: string | null;
        sourceCodec?: string | null;
        sourceHdr?: boolean;
        sourceInterlaced?: boolean;
        reason: string;
    };
}

/** Resolved app-owned quality rung sent to the zero-dependency proxy. */
export interface RungSpec {
    /** Opaque ladder token. Never parse policy back out of this value. */
    id: string;
    height: number;
    /** Total mux budget (video + audio), in bits per second. */
    maxBitrate: number;
    codec: 'h264';
}

/**
 * Why the served quality differs from the requested one.
 *
 * `unprobeable` and `insufficient_ladder` are distinct members rather than being
 * folded into `hdr_source`/`capacity`: an operator told "encoder capacity" about a
 * 480p channel that can never carry a ladder will go buy CPU that changes nothing.
 * Every refusal reason the proxy can produce has a `CapReason` counterpart so the
 * fallback path can report the real cause.
 */
export type CapReason =
    | 'source_within_cap'
    | 'hdr_source'
    | 'unprobeable'
    | 'capacity'
    | 'below_ladder'
    | 'insufficient_ladder';

export type EgressRefusal =
    | 'capacity'
    | 'invalid'
    | 'internal'
    | 'hdr_source'
    | 'unprobeable'
    | 'below_ladder'
    | 'insufficient_ladder';

export interface JoinCapRequest {
    /** Bottom rung when belowLadder=true; the proxy intentionally owns no ladder. */
    rung: RungSpec;
    /** Raw client ceiling in bps; source-within-cap compares against this value. */
    requestedMaxBitrate: number;
    belowLadder: boolean;
    /** Rung-URL recovery join; skips feasibility already decided by /stream. */
    pinned: boolean;
    fallback: 'refuse' | 'source';
}

export interface JoinAdaptiveRequest {
    /** App-owned ladder. The proxy only validates and filters it against source height. */
    rungs: RungSpec[];
    /** Experimental permission; the proxy reports whether it was actually included. */
    includeOriginal: boolean;
    /** App-side policy when the complete adaptive group cannot be admitted. */
    fallback: 'refuse' | 'source';
}

/**
 * What the joining player can do with HEVC video.
 *
 * - `any`: the player decodes HEVC from MPEG-TS and fMP4 (hls.js over an MSE that reports hvc1).
 * - `fmp4`: Apple's native HLS (Safari, AVPlayer): HEVC plays only from fMP4 segments.
 * - `none`: no HEVC decode at all (Firefox, Chrome without hardware HEVC).
 *
 * Absent means "not reported" (older apps, Jellyfin clients) and keeps the original stream.
 */
export type LiveTvClientHevc = 'any' | 'fmp4' | 'none';

/**
 * A per-channel compatibility output for players that cannot use the original HEVC stream.
 * `fmp4` copies the video into fMP4 segments (no encode), `h264` re-encodes to H.264 (tone
 * mapping HDR to SDR). Served at /streams/{channelId}/v/{variant}/.
 */
export type LiveTvCompatVariant = 'fmp4' | 'h264';

export interface JoinClientCaps {
    hevc: LiveTvClientHevc;
}

/** POST /streams/{channelId}/join request body */
export interface JoinRequest {
    viewerId: string;
    streamUrls: string[];
    /** App-resolved SSRF policy. Missing/false keeps the proxy fail-closed. */
    allowPrivateUrls?: boolean;
    sourceId: string;
    maxStreams: number;
    channelName: string;
    cap?: JoinCapRequest;
    adaptive?: JoinAdaptiveRequest;
    /** Decode capability of the joining player; decides whether a compat variant is needed. */
    client?: JoinClientCaps;
    /**
     * Cold join: answer when the first segment exists, when the channel turns terminal (502
     * `channel_failed`) or after this many milliseconds, whichever comes first.
     */
    awaitReadyMs?: number;
    /** Feed ids parallel to `streamUrls`; only labels failure events and `feedsTried`. */
    feedIds?: string[];
}

/** POST /streams/{channelId}/join 200 response */
export interface JoinResponse {
    success: true;
    channelId: string;
    rungId: string | null;
    appliedMaxBitrate: number | null;
    reason: CapReason | null;
    /**
     * True when the channel had published a segment when the proxy answered; false when
     * the join answered at the `awaitReadyMs` deadline, or without waiting, before one
     * existed. The app records a feed as working only on `ready: true`.
     */
    ready: boolean;
    /**
     * True when this viewer was ALREADY on the channel and the join only reconciled
     * their quality — i.e. it admitted nobody and reserved no new slot.
     *
     * The app needs this to decide whether a refusal it raises AFTER a 200 owes a
     * compensating `leave`. On a fresh admission it does, or the slot is held until the
     * orphan sweep. On a re-join it must NOT: the viewer is mid-playback, a refused
     * quality switch is contractually required to leave their current stream alone
     * (see EgressManager/applyCap's attach-before-detach), and leaving would evict a
     * session that was never in question.
     *
     * Optional so an older proxy omitting it reads as `undefined` — which the app must
     * treat as "cannot prove this was fresh", the conservative answer.
     */
    existingViewer?: boolean;
    adaptive?: {
        rungs: RungSpec[];
        includesOriginal: boolean;
    };
    /** Set when this viewer is served a compat variant instead of the original stream. */
    variant?: LiveTvCompatVariant;
}

export interface CapUnavailableResponse {
    error: 'cap_unavailable';
    refusal: EgressRefusal;
}

/** POST /streams/{channelId}/join 503 response */
export interface StreamLimitResponse {
    error: 'stream_limit_reached';
    limit: number;
    active: Array<{
        channelId: string;
        channelName: string;
        viewers: number;
    }>;
}

/** POST /streams/{channelId}/join error responses (non-limit failures) */
export interface SpawnFailedResponse {
    error: 'spawn_failed';
    message: string;
    reason?: 'encoder_failed';
    retryable?: boolean;
    retryAfterMs?: number;
}

/** 502: the channel failed (every feed, or its only feed) before it produced a segment. */
export interface ChannelFailedResponse extends LiveTvChannelFailedBody {
    error: 'channel_failed';
}

/** HLS routes on a failed channel (410): reaches players, so never `feedsTried`. */
export type ChannelFailedHlsResponse = Omit<ChannelFailedResponse, 'feedsTried'>;

export interface SourceUnreachableResponse {
    error: 'source_unreachable';
    message: string;
}

export interface ChannelNotFoundResponse {
    error: 'channel_not_found';
    channelId: string;
}

export interface NoSegmentsResponse {
    error: 'no_segments';
    channelId: string;
}

export interface InternalErrorResponse {
    error: 'internal_error';
    message: string;
}

/** Discriminated union of all proxy error responses */
export type ProxyErrorResponse =
    | StreamLimitResponse
    | CapUnavailableResponse
    | SpawnFailedResponse
    | ChannelFailedResponse
    | SourceUnreachableResponse
    | ChannelNotFoundResponse
    | NoSegmentsResponse
    | InternalErrorResponse;

/** POST /streams/{channelId}/heartbeat response */
export interface HeartbeatResponse {
    success: boolean;
    message?: string;
    /** Present when the channel failed (terminal): why, and whether a retry makes sense. */
    failure?: {
        reason: LiveTvFailureReason;
        retryable?: boolean;
        retryAfterMs?: number;
        feedsTried?: LiveTvFeedFailure[];
    };
}

/** DELETE /streams/{channelId}/leave response */
export interface LeaveResponse {
    success: boolean;
}

/** DELETE /streams/{channelId}/kill response */
export interface KillChannelResponse {
    success: boolean;
    viewersRemoved: number;
}
