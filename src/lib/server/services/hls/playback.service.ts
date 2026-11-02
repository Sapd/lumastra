// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Playback Service
 *
 * Core HLS playback pipeline shared between the lumastra and Jellyfin-compat
 * master playlist endpoints. Handles file resolution, stream probing, transcode
 * job start, and playlist generation for both muxed and demux modes.
 */

import type postgres from 'postgres';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hasControlChars } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/filename-safety.js';
import type { HlsOutputConfig, MediaSourceInfo } from '../transcoding/types.js';
import {
    asAbsoluteStreamIndex,
    defaultAudioAbsoluteIndex,
    resolveAudioTrackByAbsoluteIndex,
} from '$lib/shared/stream-index';
import { playMethodFromDecision, type TranscodeJobConfig } from '../transcoding/types.js';
import { PlaySessionOwnedByAnotherUserError } from '../transcoding/play-session-owner-error.js';
import { UserJobCapReachedError } from '../transcoding/user-job-cap-error.js';
import {
    TranscodeCapacityError,
    TRANSCODE_CAPACITY_RETRY_AFTER_SECONDS,
} from '../transcoding/transcode-capacity-error.js';
import { getFFmpegTranscodeService } from '../ffmpeg-transcode.service.js';
import {
    buildMuxedVodPlaylist,
    jobManifestVideoOverrides,
    playlistUsesCopyGrid,
} from './muxed-vod-playlist.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { selectFileForPlayback } from '../../../../routes/api/playback/[itemId]/hls/file-selection.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { probeForTranscode } from '../transcoding/media-probe.service.js';
import {
    generateMasterPlaylist,
    generateMuxedMasterPlaylist,
    generateAudioOnlyMasterPlaylist,
    AUDIO_ONLY_BANDWIDTH,
    calculateEstimatedBandwidth,
    isNativeHlsClient,
    resolveSyntheticIframes,
    type MasterPlaylistOptions,
    resolveMasterHevcMain10,
} from '$lib/server/utils/hls-master-playlist.js';
import {
    waitForHlsPlaylist,
    HLS_CORS_HEADERS,
    addPlaybackIdentityToSearchParams,
    SAFE_PLAY_SESSION_ID_RE,
} from '$lib/server/utils/hls-request-utils.js';
import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import { setSessionSubtitleMethodByPlanId } from '$lib/server/database/queries/play-sessions.queries.js';
import { isTextBasedSubtitle } from '$lib/server/utils/hls-audio-injection.js';
import type { PlaybackPlan } from '$lib/schemas/playback-plan.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    FORMAT_WHITELIST_VALUE,
    getConcatPartFormatWhitelist,
    prepareMediaFormatWhitelist,
} from '$lib/server/utils/media-format-whitelist.js';
import { config } from '$lib/server/config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    checkPlayMethodAllowed,
    enforceStreamPolicy,
    getEffectivePolicy,
    type PolicyError,
} from '$lib/server/services/play-sessions.service.js';
import type { PolicyRow } from '$lib/server/database/queries/play-sessions.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { toUserId } from '$lib/shared/user-id.js';
import { isRawPreviewCacheSessionId } from '$lib/server/services/hls/job-item-binding.js';
import { verifyPlaySessionOwnership } from '$lib/server/services/hls/play-session-ownership.js';
import {
    computeCappedDimensions,
    computeCappedVideoBitrateMbps,
    computeEffectiveBudgetBps,
    computeAudioReservationBps,
    computeQualityCapReservation,
    resolveDeliveredAudioTracks,
    qualityCapForcesTranscode,
} from '$lib/server/services/transcoding/quality-cap.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';

const logger = Logger.for('HlsPlaybackService');

/**
 * Query parameter marking a request for the muxed MEDIA playlist rather than the
 * master that wraps it. Set by the master's own EXT-X-STREAM-INF URI, so the
 * client round-trips it back to us.
 */
export const MUXED_MEDIA_PLAYLIST_PARAM = 'hlsPlaylist';

const MASTER_PLAYLIST_TIMEOUT_MS = 30000;

// Detection latency for "has FFmpeg produced its playlist yet", NOT a throttle on
// FFmpeg itself. It sits directly on time-to-first-frame: the playlist response is
// held until a poll observes the file, so the client waits up to one full interval
// after FFmpeg is already done. At 200ms that was ~100ms of pure quantisation on
// average (measured: a ~525ms observed startup on prod against a real transcode).
//
// Each tick is one fs.stat on the transcode output dir, so tightening this trades
// a handful of extra stats for that latency. Do not raise it back without
// measuring — the cost of a stat here is far below the latency it buys.
const POLL_INTERVAL_MS = 25;

// Upper bound on the demux-mode startup failure check below. FFmpeg failures we
// care about (bad codec, missing file, permissions) surface within a few hundred
// ms of spawn; this is how long we are willing to hold the response to catch one.
const DEMUX_FAILURE_CHECK_MS = 500;

/**
 * Map a concrete GPU/software encoder name (e.g. 'hevc_qsv', 'libx265') to its
 * codec family. Used to pick a real target codec when subtitle burn-in forces a
 * transcode of a `copy` request, so the manifest matches what the strategy emits.
 */
function codecFamilyFromEncoder(encoder?: string): string | undefined {
    if (!encoder) return undefined;
    const e = encoder.toLowerCase();
    if (e.includes('av1')) return 'av1';
    if (e.includes('hevc') || e.includes('265')) return 'hevc';
    if (e.includes('264')) return 'h264';
    return undefined;
}

// Server-side keyframe-probe deduplication. Concurrent HLS requests for the
// same file (multi-tab, HLS.js retries, Safari preflights, a paused preload
// racing the actual play) all converge here — without dedup, each one spawns
// its own ffprobe, publishes conflicting progress values (causing the client
// bar to jitter / reset), and wastes CPU + disk bandwidth. Keyed by fileId;
// the promise owns all side effects (progress publishing, DB save, health
// detection) and is removed in a .finally() once the probe completes.
const inFlightProbes = new Map<string, Promise<number[] | null>>();

// Additional itemIds subscribed to an in-flight probe. The primary caller's
// progress writes fan out to each subscriber's item key so their own
// /probe-status poll reflects the probe. Concurrent callers usually share
// the same itemId, but edition-merged files can map multiple items to one
// file — without this, those waiters would poll their own item key, see no
// entry, and render a plain spinner while the probe blocks their m3u8.
const probeSubscribers = new Map<string, Set<string>>();

// ============================================================================
// Public Types
// ============================================================================

export interface HlsPlaybackRequest {
    sql: postgres.Sql;
    /**
     * Internal UUID or Jellyfin item ID, passed through verbatim to
     * `jobConfig.itemId` (`job.config.itemId`, `playback.service.ts:1099-1100`)
     * and the playlist. This is the value the job->item binding check
     * (fix plan 6, C1 — `services/hls/job-item-binding.ts`) later compares a
     * segment request's resolved+raw id pair against, so it must be the id
     * the caller's auth gate actually checked. `resolvePlaybackSelection`
     * requires it to own files directly (no series/season->episode hop) — a
     * file/version UUID passed here 404s before a job is ever started; see
     * `policyMediaId` below for the one place a file/version UUID legitimately
     * appears in this request shape.
     */
    itemId: string;
    username: string;
    deviceId: string;
    /**
     * Stable users.id UUID. When present (and STREAM_LIMITS_ENFORCED is on),
     * the manifest-level stream-limit check runs before a new transcode job is
     * started. When absent, that enforcement is skipped entirely — callers
     * that already enforce elsewhere (e.g. Jellyfin-compat at PlaybackInfo
     * time) may intentionally leave this unset.
     */
    userId?: string;
    /** Client IP address, used only for the manifest-level policy check above. */
    ipAddress?: string;
    /**
     * Client's stable device UUID (e.g. browser localStorage device id), used
     * ONLY for the stream-policy ghost exclusion above — never stored. `deviceId`
     * itself stays a fixed per-surface identifier (e.g. 'lumastra-player') because
     * it is load-bearing for watch-state, so the real per-device value travels
     * separately here.
     */
    policyDeviceId?: string;
    /**
     * Owner-resolved media item UUID for the stream-policy ghost exclusion, when it
     * differs from `itemId`. Jellyfin-compat can pass a file/version UUID as `itemId`
     * while the session row that findOrCreateJellyfinSession stores holds the OWNING
     * item id — so exclude by that id or the client's own session won't be excluded
     * (false 429 on its own stream). Falls back to `itemId` when unset.
     */
    policyMediaId?: string;
    /** Client-provided play session ID; service generates one when absent */
    playSessionId?: string;
    hlsOutput?: HlsOutputConfig;
    /** Explicit video codec override: 'copy', 'h264', 'hevc', etc. */
    videoCodec?: string;
    /** Explicit audio codec override: 'copy', 'aac', etc. */
    audioCodec?: string;
    /** PlaybackPlan ID — when present, plan is resolved from Valkey and passed to executor */
    planId?: string;
    seekSeconds?: number;
    /**
     * Per-request quality cap (see `quality-cap.ts`). Forces a video transcode
     * when the source exceeds either bound (even for a copy/remux request),
     * and constrains the encode's bitrate/resolution and the manifest's
     * BANDWIDTH/RESOLUTION to match.
     */
    qualityCap?: { maxBitrate?: number; maxHeight?: number };
    /**
     * The client's audio channel cap (`?maxAudioChannels`, i.e. the `mc:` it
     * declared to /info). A delivered track with more channels can't be
     * copied — audio is transcoded and downmixed to at most this many.
     */
    maxAudioChannels?: number;
    /**
     * At the per-user job cap, refuse with 429 instead of evicting another of
     * this principal's sessions. Set by callers whose principal several people
     * share (the showcase's per-IP `__showcase__:<ip>`), where the evicted
     * session is someone else's stream.
     */
    refuseAtUserCap?: boolean;
    fileId?: string;
    edition?: string;
    subtitleBurnIn?: { streamIndex: number; method: string };
    /**
     * Audio stream index to use in muxed mode (Jellyfin AudioStreamIndex param).
     * Ignored in demux mode (all tracks are included). The audio-only
     * (videoDisabled) rung always takes the muxed shape regardless of the
     * requested hlsAudioMode (see isMuxedMode below), so this value is
     * honored there too.
     */
    audioStreamIndex?: number;
    /**
     * Base URL for segment and sub-playlist references in the master playlist.
     * Example: "/api/playback/{itemId}/hls"
     *
     * In muxed mode this is also used for rewriting individual segment filenames.
     */
    segmentBase: string;
    /** URLSearchParams carrying auth and session info for segment URLs */
    segmentParams: URLSearchParams;
    deviceProfileId?: string;
    /** User-Agent header for automatic device profile detection */
    userAgent?: string;
    /**
     * Leave subtitle renditions (EXT-X-MEDIA TYPE=SUBTITLES) out of the master.
     * Set for the web player, which renders subtitles from its own <track>
     * elements. On iOS Safari a master that declares its own SUBTITLES group
     * next to a <track> child fails at once: AVFoundation -11800 / -50 on
     * availableMediaCharacteristicsWithMediaSelectionOptions, MediaError 4
     * (iPhone A/B 2026-10-15: same demux stream, no <track> played, with a
     * <track> failed, 2/2 each). Native clients (/api/v1, /j) keep them.
     */
    omitManifestSubtitles?: boolean;
    /**
     * Optional duration override (seconds) when caller already has the runtime
     * from a prior DB query (avoids redundant lookup inside the service).
     */
    durationOverride?: number;
    /**
     * When true the service returns a pre-generated VOD playlist immediately
     * without waiting for FFmpeg (Jellyfin compat fast path).
     */
    preGenerateVod?: boolean;
    /** Segment duration in seconds, required when preGenerateVod is true */
    segmentDuration?: number;
    /** API key to embed in pre-generated VOD playlist segment URLs */
    apiKey?: string;
    /**
     * Which muxed playlist to return. `'media'` forces the bare media playlist —
     * set by the route when the client follows the master's EXT-X-STREAM-INF URI.
     * Otherwise native-HLS clients get a master wrapping it (see the muxed branch).
     */
    muxedPlaylistKind?: 'master' | 'media';
}

export class HlsPlaybackError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        /** Set for a temporary refusal; routes send it as `Retry-After`. */
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'HlsPlaybackError';
    }

    /**
     * `Retry-After` (and the JSON content type of the structured body) for a
     * retryable refusal; empty otherwise.
     */
    get retryHeaders(): Record<string, string> {
        return this.retryAfterSeconds !== undefined
            ? {
                  'Retry-After': String(this.retryAfterSeconds),
                  'Content-Type': 'application/json',
              }
            : {};
    }
}

/**
 * 403 for a play method the user's stream policy forbids. JSON body (like the
 * structured 503s) so the route can attach the `playback-method-not-allowed`
 * diagnostic header and native clients can read the allowed methods — the same
 * fields `POST /api/play-sessions` returns for this refusal.
 */
function playMethodRefusal(
    error: Extract<PolicyError, { kind: 'transcode_not_allowed' }>,
    method: string,
): HlsPlaybackError {
    logger.info('Refusing HLS manifest: play method not allowed by stream policy', {
        method,
        allowedMethods: error.allowed_methods,
    });
    return new HlsPlaybackError(
        JSON.stringify({
            error: error.kind,
            allowed_methods: error.allowed_methods,
            suggestion: error.suggestion,
        }),
        403,
    );
}

export interface HlsPlaybackResult {
    playlistBody: string;
    contentType: string;
    headers: Record<string, string>;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build the ffmpeg concat-demuxer list body (`file '<path>'` per line).
 *
 * Exported so a unit test can drive it directly. A path is refused outright
 * (not escaped) when it contains a control character (C0, U+0000-U+001F, or
 * DEL) — the list is opened with `-f concat -safe 0`
 * (`ffmpeg-args-builder.ts`), and an embedded `\n`/`\r` would split it into
 * an attacker-influenced extra `file` directive that no amount of quote
 * escaping stops (S-P1 / P1).
 *
 * F3 (fix round 1): inside ffmpeg's concat-demuxer single-quoted token
 * (`libavutil/avstring.c`'s `av_get_token`, which the concat demuxer uses),
 * a backslash has NO escape meaning — everything between `'` and the next
 * `'` is copied verbatim, including backslashes, and a `'` cannot be escaped
 * with one. `\`/`'` doubling therefore corrupted every path containing
 * either character: a real ffprobe on `\`-then-`'`-escaped `Ocean's
 * Eleven.mkv` failed with `Impossible to open '.../Ocean\s'` — the escaped
 * quote ended the token early, leaving a stray backslash and truncating the
 * name. The only correct way to embed a literal `'` is the POSIX-shell
 * trick: close the quote, escape a bare `'` in the (unquoted) token stream
 * with a backslash — which DOES work outside quotes — then reopen the
 * quote (`'` → `'\''`). A literal `\` needs no escaping at all.
 */
export function buildConcatListContent(
    paths: string[],
    partFormatWhitelist: string | null = null,
): string {
    // F4: each part's own `-format_whitelist` (media-format-whitelist.ts,
    // getConcatPartFormatWhitelist). The list-level one must keep `concat`
    // and every part's open inherits it, so without this line a part
    // rewritten into an ffconcat body is followed. The input guard's sniff
    // can't cover it: the demuxer opens each part lazily, when playback
    // reaches it — long after the spawn the sniff ran before.
    const option =
        partFormatWhitelist && FORMAT_WHITELIST_VALUE.test(partFormatWhitelist)
            ? `\noption format_whitelist '${partFormatWhitelist}'`
            : '';
    return paths
        .map((p) => {
            if (hasControlChars(p)) {
                throw new Error(
                    'Refusing to build ffmpeg concat list: path contains a control character',
                );
            }
            return `file '${p.replace(/'/g, "'\\''")}'${option}`;
        })
        .join('\n');
}

async function writeConcatTmpFile(paths: string[]): Promise<string> {
    const tmpFile = path.join(tmpdir(), `lumastra-concat-${randomUUID()}.txt`);
    const whitelistReady = prepareMediaFormatWhitelist();
    if (whitelistReady) await whitelistReady;
    const listContent = buildConcatListContent(paths, getConcatPartFormatWhitelist());
    await fs.writeFile(tmpFile, listContent, 'utf-8');
    return tmpFile;
}

/**
 * Translate the wire-level `videoCodec` override into a first-class flag.
 *
 * 'none' is REQUEST vocabulary, not a codec. Forwarded into planHints it reaches
 * transcode-decision.ts's encoder map, misses every entry, falls through `?? hint`,
 * and becomes a video transcode targeting an encoder literally named "none".
 */
export function resolveVideoDisabled(videoCodecOverride: string | undefined): {
    videoDisabled: boolean;
    effectiveVideoCodec: string | undefined;
} {
    if (videoCodecOverride === 'none') {
        return { videoDisabled: true, effectiveVideoCodec: undefined };
    }
    return { videoDisabled: false, effectiveVideoCodec: videoCodecOverride };
}

// ============================================================================
// Main pipeline
// ============================================================================

/**
 * Run the full HLS playback pipeline: resolve file, probe, start transcode job,
 * wait for playlist, and return the playlist body with headers.
 *
 * Throws HlsPlaybackError on any recoverable failure so route wrappers can
 * convert to the appropriate HTTP response.
 */
export async function startHlsPlayback(request: HlsPlaybackRequest): Promise<HlsPlaybackResult> {
    const {
        sql,
        itemId,
        username,
        deviceId,
        userId,
        ipAddress,
        policyDeviceId,
        policyMediaId,
        hlsOutput,
        videoCodec: videoCodecOverride,
        audioCodec: audioCodecOverride,
        seekSeconds,
        qualityCap,
        maxAudioChannels,
        fileId,
        edition,
        subtitleBurnIn: subtitleBurnInParam,
        audioStreamIndex,
        segmentBase,
        segmentParams,
        deviceProfileId,
        userAgent,
        durationOverride,
        preGenerateVod,
        segmentDuration,
        apiKey,
        muxedPlaylistKind,
        omitManifestSubtitles,
    } = request;

    // Seam guard (C1): every caller's playSessionId lands here before it can
    // reach resolveOutputBaseDir / mkdir / fs.rm — validate charset now so the
    // three callers (web player, showcase, /j master.m3u8) all inherit the
    // same check regardless of whether the calling route validated its own
    // input. resolveOutputBaseDir asserts containment independently as a
    // backstop, but this is what turns a bad id into a 400 instead of ever
    // reaching the filesystem.
    //
    // A raw preview-cache artifact id is refused here too, with the segment
    // handler's own predicate: that id names the SHARED artifact job, which
    // preview-session.service.ts starts directly (never through this
    // function). Accepted, a request for another item found the artifact as
    // its existing job — skipping stream-limit enforcement below — and
    // startJob's config-change branch stopped it, deleting the artifact under
    // its viewers.
    if (
        request.playSessionId !== undefined &&
        (!SAFE_PLAY_SESSION_ID_RE.test(request.playSessionId) ||
            isRawPreviewCacheSessionId(request.playSessionId))
    ) {
        throw new HlsPlaybackError('Invalid PlaySessionId', 400);
    }
    const playSessionId = request.playSessionId ?? randomUUID();

    // Seam guard (D-HLS-3): every caller (web player, /j master.m3u8, showcase)
    // reaches startJob's reuse/stop path through this one function, and
    // startJobInternal stops or restarts an EXISTING job under this
    // PlaySessionId (hasPlaybackConfigChanged → stopJob('playback_config_changed'),
    // or the audio-track/seek-restart else-branch) with no ownership check of
    // its own — a caller holding another user's PlaySessionId could kill or
    // hijack that user's in-flight playback. Two arms, both must pass, run
    // BEFORE plan resolution and the stream-limit block below (which also
    // starts/reuses a job identity):
    //
    // Arm 1 — persisted ownership (`play_sessions` row), via the same
    // `verifyPlaySessionOwnership` the segment path already enforces. Only
    // meaningful when the caller SUPPLIED the id: a server-generated
    // (`randomUUID()`) id is brand-new by construction and cannot name
    // another user's row. Row-absent still means "allow" (warm-up window —
    // see verifyPlaySessionOwnership's own doc comment) — that allowance is
    // what arm 2 below exists to close for a session that will NEVER get a
    // row.
    //
    // Arm 2 — live in-process job ownership. Arm 1's row-absent allowance is
    // safe for real playback because the row lands moments later; it is NOT
    // safe for `/j` PlaySessionIds (`/j` keeps its play_sessions row under its
    // own id, so the PlaySessionId never gets one) or for the showcase mount
    // (its synthetic `__showcase__:<ip>` principal has no `users` row, so
    // `saveJob` skips persistence too) — those sessions are "brand new" by
    // arm 1 forever, so without this second arm the /j master route and
    // showcase route would stay fully open to this DoS.
    //
    // Arm 3 — the persisted TRANSCODE row's owner, for a job that is not
    // resident here. A `/j` job's row is written (without a play_sessions
    // stub), so its session can live on another pod, or be restored from that
    // row; arm 1 cannot see it and arm 2 only sees this process. A web
    // session's row names the same owner as its play_sessions row, so this
    // only adds a refusal arm 1 would also give.
    //
    // Showcase note: the showcase principal (`__showcase__:<ip>`) is compared
    // like any other username here, so a signed-in user cannot stop a
    // showcase viewer's job, a showcase caller cannot stop a signed-in user's
    // job, and one anonymous showcase viewer cannot stop another's on a
    // different IP. Two viewers behind one NAT share the principal; there the
    // guard rests on the PlaySessionId being unlearnable (browser-minted
    // randomUUID per page load, never exposed to others — hls-fixes report
    // §10). One outage-direction edge: an anonymous viewer whose IP changes
    // mid-session and re-requests the master with the same PlaySessionId is
    // refused (the "existing job's" principal no longer matches the new IP's
    // principal).
    // Ledger ruling S-C1b declined binding a showcase principal for RIDING an
    // existing job (no new content reaches the rider) — stopping one is a
    // denial of service, a different harm, so it is refused here.
    if (request.playSessionId !== undefined) {
        const ownedByPersistedRow = await verifyPlaySessionOwnership(playSessionId, username);
        if (!ownedByPersistedRow) {
            logger.warn('Refusing HLS master request: PlaySessionId owned by another user', {
                playSessionId: playSessionId.slice(0, 8),
                username,
                arm: 'persisted-row',
            });
            throw new HlsPlaybackError('Not authorized for this PlaySessionId', 401);
        }
    }

    // Exact comparison, matching arm 1 (verifyPlaySessionOwnership's
    // `owner === username`) and the segment path's ownership check — NOT
    // case-folded. `users.username` is unique case-SENSITIVELY
    // (`users_username_key`), and admin-created/native accounts are not
    // guaranteed to be lowercase-folded, so folding this comparison could
    // treat two DISTINCT accounts as the same owner. The request-side
    // `username` here is already the stored spelling (forward-auth folds at
    // ingress — forward-auth.ts:1986/2384 — and native/`/j` token auth
    // resolve it from the `users` row), so an exact comparison is not a
    // regression for any real caller, and it keeps master-route ownership
    // identical to segment-route ownership: this check must never refuse a
    // user whose segments `verifyPlaySessionOwnership`
    // (play-session-ownership.ts) would still serve.
    //
    // Deliberately NOT excluded by status: an earlier version skipped
    // 'error'/'stopped' jobs, which let a non-owner take over S the instant
    // A's job died (crash, eviction, transient FFmpeg failure) — and then
    // A's own recovery attempt got refused as the "non-owner". The owner
    // check must apply to ANY resident job regardless of status; A's own
    // recovery still passes because `config.username === username` for her,
    // whatever the job's status is.
    const liveJobForSession = getFFmpegTranscodeService().getJobByPlaySession(playSessionId);
    if (liveJobForSession && liveJobForSession.config.username !== username) {
        logger.warn('Refusing HLS master request: PlaySessionId owned by another user', {
            playSessionId: playSessionId.slice(0, 8),
            username,
            arm: 'live-job',
        });
        throw new HlsPlaybackError('Not authorized for this PlaySessionId', 401);
    }
    if (request.playSessionId !== undefined && !liveJobForSession) {
        let rowOwner: string | null = null;
        try {
            rowOwner = await getFFmpegTranscodeService().getPersistedJobOwner(playSessionId);
        } catch (err) {
            // Same as arm 1 on a failed lookup: pass through (fail open).
            logger.warn('Transcode-row ownership check failed, passing through', {
                playSessionId: playSessionId.slice(0, 8),
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (rowOwner !== null && rowOwner !== username) {
            logger.warn('Refusing HLS master request: PlaySessionId owned by another user', {
                playSessionId: playSessionId.slice(0, 8),
                username,
                arm: 'transcode-row',
            });
            throw new HlsPlaybackError('Not authorized for this PlaySessionId', 401);
        }
    }

    // Resolve PlaybackPlan from Valkey if plan ID provided
    let resolvedPlan: PlaybackPlan | undefined;
    if (request.planId) {
        const plan = await playbackPlanner.getPlan(request.planId);
        if (plan) {
            // Check if the plan has logically expired (belt-and-suspenders alongside Valkey TTL)
            if (plan.expires_at && new Date(plan.expires_at).getTime() < Date.now()) {
                logger.warn('PlaybackPlan found but expired, ignoring', {
                    planId: plan.plan_id,
                    expiresAt: plan.expires_at,
                });
            } else {
                resolvedPlan = plan;
                // Extend plan TTL so long playback sessions don't lose the plan
                playbackPlanner.refreshPlan(request.planId).catch(() => {
                    logger.debug('Failed to refresh plan TTL', {
                        planId: request.planId,
                    });
                });
                logger.info('Resolved PlaybackPlan from Valkey', {
                    planId: plan.plan_id,
                    method: plan.method,
                    videoAction: plan.video_action,
                    audioAction: plan.audio_action,
                });
            }
        } else {
            logger.warn('PlaybackPlan not found or expired', {
                planId: request.planId,
            });
        }
    }

    // -------------------------------------------------------------------------
    // Manifest-level stream-limit enforcement
    // -------------------------------------------------------------------------
    // Only runs when the caller resolved a userId (some callers, e.g.
    // Jellyfin-compat's master.m3u8, intentionally omit it because they already
    // enforce the policy elsewhere — see HlsPlaybackRequest.userId doc), the
    // session isn't a preview (previews are not user-facing streams — hover/hero
    // snippets — and are excluded from stream policy), and only for a genuinely
    // new job: seeks and audio-track changes re-enter this function with the
    // SAME playSessionId, and re-running enforcement for them would be both
    // wrong (they're not a new stream) and wasteful (per-manifest DB round-trip).
    // They are also excluded via session_id even if this ran.
    //
    // A `preview-` PREFIX ALONE must NOT exempt from stream policy: PlaySessionId
    // is client-supplied (validated only by charset), so an earlier design that
    // keyed the exemption on `playSessionId.startsWith('preview-')` let any
    // authenticated client pass ?PlaySessionId=preview-x on a normal full-length
    // stream and permanently skip STREAM_LIMITS_ENFORCED. The exemption is instead
    // granted by the presence of a live transcode job under this id: a genuine
    // preview always has its (isPreview) job registered by createPreview before
    // the manifest is ever fetched, so `existingJob` is truthy and enforcement is
    // skipped; a spoofed `preview-x` has no such job → `!existingJob` → enforced.
    // (This is the same `!existingJob` guard that already exempts seek/audio-track
    // re-entry, so no genuinely-new full stream can slip through.)
    //
    // The same gate also enforces `allowed_play_methods` against the method the
    // server is about to RUN. Session start (`POST /api/play-sessions`) only sees
    // the method the client CLAIMS, so a client that claimed "direct" and then
    // fetched a transcoded manifest was never stopped. Unlike the stream count,
    // this is not behind STREAM_LIMITS_ENFORCED — enforceStreamPolicy applies the
    // method rule regardless of that kill-switch too. Two checks: the plan's
    // method before spawning (cheap, no FFmpeg for an obvious refusal), then the
    // real decision after startJob, because the decision can still flip to a
    // transcode (quality cap, subtitle burn-in, audio-only) and a plan-less
    // request has no method until the decision is made.
    let methodPolicy: PolicyRow | null = null;
    if (userId) {
        const existingJob = getFFmpegTranscodeService().getJobByPlaySession(playSessionId);
        if (!existingJob) {
            const policy = await getEffectivePolicy(sql, username);
            if (policy.allowed_play_methods !== null) {
                methodPolicy = policy;
                if (resolvedPlan) {
                    const methodError = checkPlayMethodAllowed(policy, resolvedPlan.method);
                    if (methodError) throw playMethodRefusal(methodError, resolvedPlan.method);
                }
            }
        }
        if (!existingJob && config.STREAM_LIMITS_ENFORCED) {
            // Prefer the caller's owner-resolved id so the ghost exclusion matches the
            // stored session's media_id; fall back to itemId. UUID-guard because the
            // exclusion compares against a uuid column (a non-UUID would raise 22P02).
            const rawPolicyMediaId = policyMediaId ?? itemId;
            const mediaIdForPolicy = UUID_RE.test(rawPolicyMediaId) ? rawPolicyMediaId : undefined;
            const policyError = await withTx(sql, async (txSql) =>
                enforceStreamPolicy(
                    txSql as unknown as postgres.Sql,
                    toUserId(userId),
                    username,
                    ipAddress ?? '0.0.0.0',
                    // null: the play method is checked above and after startJob,
                    // against what actually runs. Passing a guessed method here
                    // (the old `?? 'full_transcode'` fallback) made a plan-less
                    // request return transcode_not_allowed BEFORE the count, so
                    // the stream limit was silently skipped for those users.
                    null,
                    {
                        session_id: playSessionId,
                        // policyDeviceId (the client's real device UUID) is used ONLY
                        // here, for the ghost exclusion — deviceId itself is a fixed
                        // per-surface constant (e.g. 'lumastra-player') and would never
                        // match the device_id stored on a prior session's row.
                        device_id: policyDeviceId ?? deviceId,
                        media_id: mediaIdForPolicy,
                    },
                ),
            );
            // ip_restriction is enforced at session start only. The play method is
            // handled above/after startJob; only the stream count blocks here.
            if (policyError?.kind === 'stream_limit_exceeded') {
                throw new HlsPlaybackError(
                    `Stream limit reached: ${policyError.active} of ${policyError.limit} streams in use`,
                    429,
                );
            }
        }
    }

    // -------------------------------------------------------------------------
    // 1. File resolution
    // -------------------------------------------------------------------------
    const selection = await resolvePlaybackSelection(sql, itemId, {
        fileId: fileId ?? undefined,
    });
    const mediaFiles = selection.files;

    if (mediaFiles.length === 0) {
        throw new HlsPlaybackError('No file found for this media item', 404);
    }

    const fileSelection = selectFileForPlayback(mediaFiles, edition ?? null);

    // Use the file ID from edition selection — resolvePlaybackSelection picks the
    // default file, but selectFileForPlayback may narrow to a different edition file.
    const activeFileId =
        fileSelection.type === 'single'
            ? fileSelection.fileId
            : (fileSelection.fileIds[0] ?? selection.fileId ?? fileId ?? null);

    // Validate plan belongs to the resolved file (defense-in-depth).
    // A stale or mismatched plan would apply wrong codec decisions.
    if (resolvedPlan && activeFileId && resolvedPlan.file_id !== activeFileId) {
        logger.warn('PlaybackPlan file_id does not match resolved file — ignoring plan', {
            planId: resolvedPlan.plan_id,
            planFileId: resolvedPlan.file_id,
            activeFileId,
        });
        resolvedPlan = undefined;
    }

    const plannedHlsAudioMode =
        resolvedPlan?.hls_audio_mode ??
        (resolvedPlan?.delivery_path === 'mse_hls' ? 'muxed' : undefined);
    let effectiveHlsOutput = hlsOutput;
    if (plannedHlsAudioMode) {
        const requestedHlsAudioMode = effectiveHlsOutput?.hlsAudioMode;
        if (requestedHlsAudioMode && requestedHlsAudioMode !== plannedHlsAudioMode) {
            logger.warn('Overriding HLS audio mode to match PlaybackPlan', {
                planId: resolvedPlan?.plan_id,
                playbackBranch: resolvedPlan?.playback_branch,
                deliveryPath: resolvedPlan?.delivery_path,
                requestedHlsAudioMode,
                plannedHlsAudioMode,
            });
        }

        effectiveHlsOutput = {
            ...effectiveHlsOutput,
            hlsAudioMode: plannedHlsAudioMode,
        };
    }

    // For probing always use a single physical file
    const probeFilePath =
        fileSelection.type === 'single' ? fileSelection.path : fileSelection.paths[0];

    // -------------------------------------------------------------------------
    // 2. Path resolution
    // -------------------------------------------------------------------------
    const pathInfo = await resolveMediaPath(probeFilePath, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        throw new HlsPlaybackError(
            `Media file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
            503,
        );
    }

    const localProbeFilePath = pathInfo.containerPath;

    // Build the actual FFmpeg input path (concat tmp file or single resolved path)
    let concatTmpFile: string | null = null;
    let localFilePath: string;

    if (fileSelection.type === 'single') {
        localFilePath = localProbeFilePath;
    } else {
        concatTmpFile = await writeConcatTmpFile(fileSelection.paths);
        localFilePath = concatTmpFile;
    }

    // -------------------------------------------------------------------------
    // 3. Stream probing
    // -------------------------------------------------------------------------
    let probeResult;
    try {
        probeResult = await probeForTranscode(sql, itemId, localProbeFilePath, durationOverride, {
            forceFileProbe: fileId !== undefined,
            fileId: activeFileId ?? undefined,
        });
    } catch (probeErr) {
        if (concatTmpFile) await fs.unlink(concatTmpFile).catch(() => {});
        throw new HlsPlaybackError(
            probeErr instanceof Error ? probeErr.message : String(probeErr),
            503,
        );
    }

    const audioTracks = probeResult.audioTracks;
    const subtitleTracks = probeResult.subtitleTracks;
    // What the master playlists advertise; the job itself still gets every track.
    const manifestSubtitleTracks = omitManifestSubtitles ? undefined : subtitleTracks;
    const streams = probeResult.streams;
    const sourceCodecStr = probeResult.videoCodec;
    const sourceVideoWidth = probeResult.videoWidth;
    const sourceVideoHeight = probeResult.videoHeight;
    // The planner's number (container bitrate, else video stream) — what the
    // quality cap is compared against on both sides. The per-stream video
    // bitrate alone is usually absent for MKV, which made the job read an
    // "unknown" the planner never saw.
    const sourceCapBitrate = probeResult.capBitrate ?? probeResult.videoBitrate;
    const sourceVideoRange = probeResult.videoRange;
    const durationSeconds = probeResult.durationSeconds;

    if (audioTracks.length === 0) {
        logger.warn('No audio tracks found in media file — proceeding with video-only HLS', {
            itemId,
        });
    }

    // -------------------------------------------------------------------------
    // 3b. Audio-only (videoCodec=none)
    // -------------------------------------------------------------------------
    // Resolved before burn-in / codec decisions below — both assume a real codec
    // string or no override, never the wire-level 'none' sentinel.
    const { videoDisabled, effectiveVideoCodec: videoCodecAfterDrop } =
        resolveVideoDisabled(videoCodecOverride);

    // -------------------------------------------------------------------------
    // 4. Subtitle burn-in
    // -------------------------------------------------------------------------
    // Resolved before the codec decision because active burn-in forces a video
    // transcode (see below). It may only activate for a BITMAP subtitle the
    // `overlay` filter can composite — a text, missing, or out-of-range stream
    // would make FFmpeg abort, so drop burn-in and fall back to no hardsub
    // (text subtitles are delivered via the sidecar/WebVTT path instead).
    let subtitleBurnIn: TranscodeJobConfig['subtitleBurnIn'];
    if (videoDisabled && subtitleBurnInParam) {
        // Burn-in composites onto a video stream. With video dropped there is none.
        logger.info('Dropping subtitle burn-in: video is disabled (audio-only)', { itemId });
    } else if (subtitleBurnInParam) {
        const { streamIndex, method } = subtitleBurnInParam;
        const subStream =
            method === 'Encode' && Number.isInteger(streamIndex) && streamIndex >= 0
                ? streams.find((s) => s.index === streamIndex && s.type === 'Subtitle')
                : undefined;
        const isBitmapSub = !!subStream?.codec && !isTextBasedSubtitle(subStream.codec);
        if (subStream) {
            subtitleBurnIn = {
                absoluteIndex: streamIndex,
                codec: subStream.codec,
                ...(!isBitmapSub
                    ? {
                          text: {
                              filePath: localProbeFilePath,
                              relativeIndex: streams
                                  .filter((stream) => stream.type === 'Subtitle')
                                  .findIndex((stream) => stream.index === streamIndex),
                          },
                      }
                    : {}),
            };
            logger.info('Subtitle burn-in requested', {
                absoluteIndex: streamIndex,
                codec: subStream.codec,
            });

            // Fire-and-forget: update the plan's subtitle_method so admin UI reflects burn-in
            if (resolvedPlan?.plan_id) {
                const planId = resolvedPlan.plan_id;
                playbackPlanner.updateSubtitleMethod(planId, 'burn_in').catch((err) => {
                    logger.debug('Failed to update plan subtitle_method', {
                        planId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
                // Persist to play_sessions so the Continue Watching card reflects
                // the burn-in decision even before the client's first heartbeat.
                // The row is matched by plan_id — the SQL is a no-op if no
                // session row has been created yet (rare race on first segment).
                setSessionSubtitleMethodByPlanId(sql, planId, 'burn_in').catch((err) => {
                    logger.debug('Failed to persist subtitle_method=burn_in to play_sessions', {
                        planId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
            }
        } else if (method === 'Encode') {
            logger.warn(
                'Subtitle burn-in requested for a missing subtitle stream — skipping burn-in',
                {
                    requestedIndex: streamIndex,
                    streamExists: !!subStream,
                },
            );
        }
    }

    // -------------------------------------------------------------------------
    // 5. Codec decisions
    // -------------------------------------------------------------------------
    // Burn-in composites on the CPU, so the video MUST be transcoded (you can't
    // overlay onto a copied stream). A requested `copy` is therefore incompatible:
    // coerce it to a concrete target codec so the manifest CODECS and the segment
    // timeline reflect the real (transcoded) output instead of advertising the
    // source codec + copy-mode keyframe boundaries. Prefer the plan's target, then
    // one derived from its GPU encoder, then HEVC — matching the strategy's own
    // libx265 fallback (full-transcode-strategy.ts burnInForcesTranscode).
    // Coerce whenever burn-in has no concrete transcode target: an explicit
    // `copy`, OR no videoCodec at all (e.g. a /j/-compat client, or a request
    // whose decision engine failed to produce a decision — leaving the strategy
    // to fall through to `-c:v copy` while still building an overlay `-map
    // [vout]`, an invalid FFmpeg invocation).
    const burnInNeedsRealCodec =
        !!subtitleBurnIn && (videoCodecAfterDrop === 'copy' || !videoCodecAfterDrop);
    const effectiveVideoCodec = burnInNeedsRealCodec
        ? (resolvedPlan?.target_video_codec ??
          codecFamilyFromEncoder(resolvedPlan?.gpu_encoder) ??
          'hevc')
        : videoCodecAfterDrop;
    if (burnInNeedsRealCodec) {
        logger.info('Subtitle burn-in forces a real video codec (was copy/none)', {
            requestedVideoCodec: videoCodecAfterDrop ?? null,
            effectiveVideoCodec,
        });
    }

    const isVideoCopy = effectiveVideoCodec === 'copy';
    const outputVideoCodec = isVideoCopy ? sourceCodecStr : effectiveVideoCodec;

    const videoInfo: NonNullable<TranscodeJobConfig['videoInfo']> = {
        codec: sourceCodecStr,
        width: sourceVideoWidth,
        height: sourceVideoHeight,
        outputCodec: outputVideoCodec ?? undefined,
        isTranscoded: !isVideoCopy,
        videoRange: sourceVideoRange,
        videoRangeType: probeResult.videoRangeType,
        frameRate: probeResult.frameRate,
        dvProfile: probeResult.dvProfile,
        dvLevel: probeResult.dvLevel,
        dvBlSignalCompatibilityId: probeResult.dvBlSignalCompatibilityId,
        bitDepth: probeResult.bitDepth,
        profile: probeResult.videoProfile,
        level: probeResult.videoLevel,
    };

    // Per-request quality cap: when it BINDS this source (forces a video
    // transcode via reconcileDecisionWithQualityCap), a copied audio track
    // whose bitrate is unknown or exceeds its reserved share of the budget
    // must switch to transcode too — otherwise a 640k AC-3 / ~1.5M E-AC-3
    // copied track (the one case audio can still be copied alongside a
    // transcoding video: subtitle burn-in) blows straight through a small
    // cap regardless of how tightly the video itself is constrained. Uses
    // ONLY source-known info (no job/decision exists yet at this point) —
    // the same "source KNOWN to exceed a bound" rule the planner
    // (media-compatibility) and the job's cap safety net
    // (qualityCapForcesTranscode) use, against the same bitrate
    // (capComparableBitrate). An unknown bitrate does not bind: trust the plan.
    const qualityCapBinding = qualityCapForcesTranscode(
        qualityCap,
        sourceVideoHeight,
        sourceCapBitrate,
    ).force;
    const qualityCapAudioReservationBpsForRequest = qualityCapBinding
        ? computeAudioReservationBps(
              computeEffectiveBudgetBps(
                  qualityCap,
                  sourceVideoHeight,
                  config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined,
              ),
          )
        : undefined;
    // The track a muxed job actually delivers. `/j` passes `audioStreamIndex`;
    // `/api/playback/.../hls` carries the selection as `?hlsAudioTrack`
    // (→ hlsOutput.hlsAudioTrackIndex), which is what the strategy maps. Checking
    // only `audioStreamIndex` judged the DEFAULT track on that route.
    const deliveredAudioTrackIndex = audioStreamIndex ?? effectiveHlsOutput?.hlsAudioTrackIndex;
    const audioForcedByQualityCap = ((): boolean => {
        const reservationBps = qualityCapAudioReservationBpsForRequest;
        if (reservationBps === undefined) return false;
        // A muxed job delivers only the SELECTED track — an unselected
        // track's huge bitrate must not force the whole job to transcode
        // audio it never actually sends. Audio-only (videoDisabled) always
        // takes the muxed shape too (see `isMuxedMode` below), so it's
        // folded in here even though `effectiveHlsOutput` may not say so yet.
        const deliveredTracks = resolveDeliveredAudioTracks(
            audioTracks,
            videoDisabled ? 'muxed' : effectiveHlsOutput?.hlsAudioMode,
            deliveredAudioTrackIndex,
        );
        return deliveredTracks.some(
            (track) => !track.bitrate || track.bitrate <= 0 || track.bitrate > reservationBps,
        );
    })();

    // Channel cap: a delivered track with more channels than the client
    // declared can't be copied — copied 5.1 E-AC-3 reaches an `mc:2` client
    // untouched. Force the transcode; the strategy downmixes to the cap. An
    // unknown channel count (0) does not bind, same as the planner.
    const audioForcedByChannelCap =
        maxAudioChannels !== undefined &&
        resolveDeliveredAudioTracks(
            audioTracks,
            videoDisabled ? 'muxed' : effectiveHlsOutput?.hlsAudioMode,
            deliveredAudioTrackIndex,
        ).some((track) => track.channels > maxAudioChannels);

    const forceAudioTranscode =
        audioCodecOverride === 'aac' || audioForcedByQualityCap || audioForcedByChannelCap;

    const ext = localProbeFilePath.split('.').pop() ?? 'mkv';
    const mediaSourceInfo: MediaSourceInfo = {
        id: activeFileId ?? itemId,
        path: localFilePath,
        container: ext,
        bitrate: sourceCapBitrate,
        streams,
    };

    let trickplayInfo: TranscodeJobConfig['trickplayInfo'];
    if (!preGenerateVod && activeFileId) {
        try {
            const { getBestTrickplayInfo } = await import('../trickplay-storage.service.js');
            const trickplay = await getBestTrickplayInfo(activeFileId, localProbeFilePath, itemId);
            if (trickplay) {
                trickplayInfo = trickplay;
            }
        } catch (error) {
            logger.warn('Failed to load trickplay info for HLS job', {
                itemId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // -------------------------------------------------------------------------
    // 5. Keyframe data for copy-mode video (accurate VOD playlist durations)
    // -------------------------------------------------------------------------
    // Matrix:
    //   video transcode  → keyframes NOT needed (FFmpeg creates exact boundaries)
    //   video copy/remux → keyframes REQUIRED for accurate VOD segment durations
    //   audio-only       → not relevant
    //   direct play      → not relevant
    //
    // Without keyframes, copy-mode video segments have variable durations (~10.177s)
    // but the VOD playlist uses synthetic uniform estimates (10.000s). Over hundreds
    // of segments, cumulative EXTINF drift causes hls.js to compute wrong segment
    // numbers on seek (e.g., requesting segment 491 instead of 358).
    let keyframeData: number[] | undefined;
    if (isVideoCopy && activeFileId) {
        try {
            const { getKeyframesForFile, updateKeyframes, updateHealthIssues } =
                await import('$lib/server/database/queries/media-files.queries.js');
            const { classifyKeyframeRow } = await import('./keyframe-classification.js');
            const fileRow = await getKeyframesForFile(sql, activeFileId);
            const keyframeAction = classifyKeyframeRow(fileRow);

            if (keyframeAction.kind === 'use') {
                keyframeData = keyframeAction.keyframes;
                logger.info('Loaded keyframe data from database', {
                    itemId,
                    fileId: activeFileId,
                    keyframeCount: keyframeData.length,
                });
            } else if (keyframeAction.kind === 'negative-cache') {
                // NEGATIVE CACHE: keyframes IS NOT NULL but empty ('[]') — the file
                // was already probed and legitimately has no usable keyframes. Treat
                // it as probed and fall through to the degraded EVENT playlist
                // (keyframeData stays undefined) instead of re-probing, which would
                // stall 10–30s on EVERY play with no payoff. Only NULL (never
                // probed) reaches the on-demand probe below.
                logger.info(
                    'File previously probed with no usable keyframes (negative cache) — ' +
                        'using degraded EVENT playlist, skipping on-demand re-probe',
                    {
                        itemId,
                        fileId: activeFileId,
                    },
                );
            } else {
                // On-demand probe: keyframes not in DB yet. Dedup concurrent
                // callers for the same file — only the first runs the probe
                // and owns progress publishing / DB save; the rest await the
                // shared result.
                const existing = inFlightProbes.get(activeFileId);
                if (existing) {
                    logger.info('Reusing in-flight keyframe probe', {
                        itemId,
                        fileId: activeFileId,
                    });
                    // Subscribe so the primary's progress writes land under
                    // our item key too — otherwise our client polls
                    // /probe-status and gets { probing: false } while the
                    // m3u8 fetch is still blocked.
                    let subs = probeSubscribers.get(activeFileId);
                    if (!subs) {
                        subs = new Set<string>();
                        probeSubscribers.set(activeFileId, subs);
                    }
                    subs.add(itemId);
                    try {
                        const shared = await existing;
                        if (shared && shared.length > 0) {
                            keyframeData = shared;
                        }
                    } finally {
                        subs.delete(itemId);
                        // For muxed mode the 'starting' seed below will
                        // overwrite our item key. For demux no 'starting'
                        // happens, so we must clear or the primary's last
                        // progress write sits under our item key until TTL.
                        if (effectiveHlsOutput?.hlsAudioMode !== 'muxed') {
                            void import('$lib/server/services/keyframe-probe-progress.service.js')
                                .then(({ clearProbeProgress }) =>
                                    clearProbeProgress(activeFileId, itemId),
                                )
                                .catch(() => {
                                    /* TTL safety net */
                                });
                        }
                    }
                } else {
                    const audioMode = effectiveHlsOutput?.hlsAudioMode;
                    const initialDuration = fileRow?.duration_seconds ?? durationSeconds ?? 0;
                    const fileIdForProbe = activeFileId;
                    const probePromise = (async (): Promise<number[] | null> => {
                        logger.info('Keyframes not in database, probing on-demand', {
                            itemId,
                            fileId: fileIdForProbe,
                            filePath: localProbeFilePath,
                        });
                        const { probeKeyframes } = await import('$lib/server/utils/ffprobe.js');
                        // Publish progress to Valkey so the video player can display
                        // "Analyzing video structure…" during the blocked m3u8 fetch.
                        const { setProbeProgress, clearProbeProgress } =
                            await import('$lib/server/services/keyframe-probe-progress.service.js');
                        // The duration in the DB can be slightly off from what ffprobe
                        // actually walks (container header lies, trailing silence, etc).
                        // Grow the denominator if currentPts overruns so the bar never
                        // pegs at 100% and then hangs there for a few seconds.
                        let effectiveDuration = initialDuration;
                        const probeStartedAt = Date.now();
                        // Guard against progress regressions caused by out-of-order
                        // Valkey writes under tail latency: if an earlier callback's
                        // setEx completes after a later one, the stored value would
                        // jump backward. Track the highest progress we've dispatched
                        // and skip writes that wouldn't move the needle forward.
                        let lastWrittenProgress = -1;
                        // Publish progress under the primary's itemId and
                        // every subscribed waiter's itemId so each client's
                        // /probe-status poll sees the probe regardless of
                        // which itemId it uses.
                        const publishProgress = (payload: {
                            currentPts: number;
                            totalDuration: number;
                            progress: number;
                        }): Promise<void> => {
                            const base = {
                                fileId: fileIdForProbe,
                                phase: 'probing' as const,
                                startedAt: probeStartedAt,
                                ...payload,
                            };
                            const writes: Promise<void>[] = [setProbeProgress({ ...base, itemId })];
                            const subs = probeSubscribers.get(fileIdForProbe);
                            if (subs) {
                                for (const waiterItemId of subs) {
                                    if (waiterItemId === itemId) continue;
                                    writes.push(
                                        setProbeProgress({
                                            ...base,
                                            itemId: waiterItemId,
                                        }),
                                    );
                                }
                            }
                            return Promise.all(writes).then(() => undefined);
                        };
                        // Seed an initial entry so the first poll while ffprobe starts up
                        // doesn't return { probing: false } — otherwise the overlay flickers.
                        await publishProgress({
                            currentPts: 0,
                            totalDuration: effectiveDuration,
                            progress: 0,
                        });
                        lastWrittenProgress = 0;
                        const probeRes = await probeKeyframes(localProbeFilePath, {
                            onProgress: (currentPts) => {
                                if (effectiveDuration > 0 && currentPts > effectiveDuration) {
                                    // Give ourselves 2% headroom so the bar can still
                                    // advance a little as the tail is processed.
                                    effectiveDuration = currentPts * 1.02;
                                }
                                const progress =
                                    effectiveDuration > 0
                                        ? Math.max(
                                              0,
                                              Math.min(0.99, currentPts / effectiveDuration),
                                          )
                                        : 0;
                                if (progress <= lastWrittenProgress) return;
                                lastWrittenProgress = progress;
                                publishProgress({
                                    currentPts,
                                    totalDuration: effectiveDuration,
                                    progress,
                                }).catch(() => {
                                    /* best-effort — never block probing on cache writes */
                                });
                            },
                        });
                        // For muxed mode, leave the entry in place: the 'starting' seed
                        // below will overwrite it atomically and the overlay stays on
                        // during FFmpeg startup. For demux mode there IS no 'starting'
                        // phase (master m3u8 builds from metadata), so we must clear
                        // here or the key would linger for the full 600s TTL and poison
                        // later polls for this same file.
                        if (audioMode !== 'muxed') {
                            clearProbeProgress(fileIdForProbe, itemId).catch(() => {
                                /* TTL will clean up on its own */
                            });
                        }
                        if (probeRes.success) {
                            // Persist the probe result even when EMPTY: a
                            // successful-but-zero-keyframe file (odd container,
                            // all-intra quirk, probe edge case) must be sentineled
                            // (keyframes = '[]', non-NULL) so it is NOT re-probed on
                            // every future play — the read path (classifyKeyframeRow)
                            // then treats '[]' as a negative cache. This mirrors
                            // background Phase B (media-probe.ts), which also persists
                            // []. Only a genuine probe ERROR (success === false, below)
                            // leaves keyframes NULL for a later retry.
                            const keyframes = probeRes.keyframes;
                            // Await the save inside the shared promise so a second
                            // caller that arrives after the probe completes but
                            // before the DB write lands still hits the dedup path
                            // instead of re-entering getKeyframesForFile and seeing
                            // a stale empty row.
                            try {
                                await updateKeyframes(sql, fileIdForProbe, keyframes);
                                if (keyframes.length > 0) {
                                    const lastPts = keyframes[keyframes.length - 1];
                                    const fileDuration = fileRow?.duration_seconds ?? null;
                                    if (
                                        fileDuration != null &&
                                        fileDuration > 0 &&
                                        lastPts < fileDuration * 0.9
                                    ) {
                                        const now = new Date().toISOString();
                                        await updateHealthIssues(sql, fileIdForProbe, [
                                            {
                                                type: 'truncated_video',
                                                detected_at: now,
                                                expected_duration: Math.round(fileDuration),
                                                actual_duration: Math.round(lastPts),
                                            },
                                        ]);
                                    }
                                }
                            } catch (err: unknown) {
                                logger.warn('Failed to save keyframes to database', {
                                    fileId: fileIdForProbe,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            }
                            if (keyframes.length > 0) {
                                logger.info('Keyframe probe successful, saved to database', {
                                    itemId,
                                    fileId: fileIdForProbe,
                                    keyframeCount: keyframes.length,
                                });
                                return keyframes;
                            }
                            logger.warn(
                                'Keyframe probe found NO usable keyframes — sentineled as ' +
                                    'negative cache; copy-mode video will use the degraded ' +
                                    'EVENT playlist and will NOT re-probe on future plays.',
                                {
                                    itemId,
                                    fileId: fileIdForProbe,
                                    filePath: localProbeFilePath,
                                },
                            );
                            return null;
                        }
                        logger.warn(
                            'KEYFRAME PROBE FAILED — copy-mode video will use degraded ' +
                                'EVENT playlist without pre-generated VOD segments. Seeking ' +
                                'will be limited to already-produced segments. The probe ' +
                                'errored (vs. found none), so keyframes stay unset for a ' +
                                'retry on the next play.',
                            {
                                itemId,
                                fileId: fileIdForProbe,
                                filePath: localProbeFilePath,
                                error: probeRes.error,
                            },
                        );
                        return null;
                    })().finally(() => {
                        inFlightProbes.delete(fileIdForProbe);
                        probeSubscribers.delete(fileIdForProbe);
                    });
                    inFlightProbes.set(activeFileId, probePromise);
                    const shared = await probePromise;
                    if (shared && shared.length > 0) {
                        keyframeData = shared;
                    }
                }
            }
        } catch (err) {
            logger.warn(
                'KEYFRAME LOADING FAILED — copy-mode video will use degraded ' +
                    'EVENT playlist without pre-generated VOD segments.',
                {
                    itemId,
                    fileId: activeFileId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            // Make sure a 'probing' entry seeded before the throw is removed.
            // For muxed mode the 'starting' seed below would overwrite it, but
            // for demux mode nothing else writes to this key — without this
            // clear it lingers for the full 600s TTL and future polls see a
            // stale probing:true for an already-failed probe.
            if (activeFileId) {
                void import('$lib/server/services/keyframe-probe-progress.service.js')
                    .then(({ clearProbeProgress }) => clearProbeProgress(activeFileId, itemId))
                    .catch(() => {
                        /* TTL safety net */
                    });
            }
        }
    }

    // -------------------------------------------------------------------------
    // 6. Build TranscodeJobConfig and start job
    // -------------------------------------------------------------------------
    // Audio-only always takes the muxed shape: buildAudioOnlyArgs forces a single
    // flat index.m3u8 regardless of the requested hlsAudioMode (see
    // full-transcode-strategy.ts — the demux var_stream_map unconditionally adds a
    // v:0 video variant, which FFmpeg cannot resolve once -vn drops the video
    // stream). This has to agree, or we'd wait on / describe a media playlist
    // FFmpeg never writes.
    const isMuxedMode = videoDisabled || effectiveHlsOutput?.hlsAudioMode === 'muxed';

    // The JOB CONFIG has to say muxed too, not just the args. `hlsAudioMode`
    // is what the serving side reads back: `canStreamTriggerSeekForJob` treats
    // a flat ('') stream as authoritative for seeking only when the config
    // says muxed, and audio-only is a single flat rendition with nothing else
    // to defer to. Leaving the requested/planned 'demux' in place made the
    // stream non-authoritative, so no seek could ever be triggered from it.
    //
    // Reachable on the normal path, not just a hand-built URL: the audio-only
    // rung reuses the PlaybackPlan built for the other play methods, and
    // resolveHlsAudioMode() stores 'demux' on it for every native_hls client —
    // which then overrides the muxed the client asked for (see
    // plannedHlsAudioMode above).
    const audioOnlyHlsOutput: HlsOutputConfig | undefined = videoDisabled
        ? { ...effectiveHlsOutput, hlsAudioMode: 'muxed' }
        : effectiveHlsOutput;

    // For muxed mode, thread the audioStreamIndex into hlsOutput
    const resolvedHlsOutput: HlsOutputConfig | undefined =
        isMuxedMode && audioStreamIndex !== undefined && !isNaN(audioStreamIndex)
            ? { ...audioOnlyHlsOutput, hlsAudioTrackIndex: audioStreamIndex }
            : audioOnlyHlsOutput;

    const jobConfig: TranscodeJobConfig = {
        itemId,
        username,
        deviceId,
        playSessionId,
        inputUrl: localFilePath,
        audioTracks,
        videoInfo,
        startTimeSeconds: seekSeconds,
        transcodeMode: 'full',
        localFilePath,
        useConcatDemuxer: concatTmpFile !== null,
        concatTmpFile: concatTmpFile ?? undefined,
        deviceProfileId,
        userAgent,
        mediaSourceInfo,
        subtitleTracks,
        fileId: activeFileId ?? undefined,
        trickplayInfo,
        forceAudioTranscode,
        hlsOutput: resolvedHlsOutput,
        subtitleBurnIn,
        videoDisabled,
        totalDurationSeconds: durationSeconds,
        // Build plan hints from the lumastra-info planner's codec choices (URL params).
        // When playbackPlan is also set, the executor should prefer the plan over hints
        // since the plan is the authoritative decision; hints are a legacy fallback.
        planHints:
            !videoDisabled && (effectiveVideoCodec || audioCodecOverride)
                ? {
                      targetVideoCodec: effectiveVideoCodec ?? undefined,
                      targetAudioCodec: audioCodecOverride ?? undefined,
                  }
                : undefined,
        playbackPlan: resolvedPlan,
        keyframeData,
        qualityCap,
        maxAudioChannels,
    };

    // Seed 'starting' progress so the player can show "Starting transcoder…"
    // while FFmpeg spawns and writes its first playlist. Only for muxed mode
    // — demux mode returns the master playlist immediately from metadata, so
    // the visible delay (the first segment request) is a separate HTTP round-
    // trip the overlay isn't listening on.
    const startupProgressFileId = isMuxedMode && activeFileId ? activeFileId : null;
    const clearStartupProgress = (): void => {
        if (!startupProgressFileId) return;
        void import('$lib/server/services/keyframe-probe-progress.service.js')
            .then(({ clearProbeProgress }) => clearProbeProgress(startupProgressFileId, itemId))
            .catch((err: unknown) => {
                logger.debug('Failed to clear startup progress', {
                    itemId,
                    fileId: startupProgressFileId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
    };
    if (startupProgressFileId) {
        const { setProbeProgress } =
            await import('$lib/server/services/keyframe-probe-progress.service.js');
        await setProbeProgress({
            fileId: startupProgressFileId,
            itemId,
            phase: 'starting',
            startedAt: Date.now(),
            currentPts: 0,
            totalDuration: 0,
            progress: 0,
        });
    }

    const transcodeService = getFFmpegTranscodeService();
    let job;
    try {
        // requireSameOwner re-runs the live-job arm (above) INSIDE startJob's
        // per-session lock: between that arm and here another user's start
        // for the same PlaySessionId could have registered its job, which this
        // start would otherwise stop (config differs) or ride (config equal).
        job = await transcodeService.startJob(jobConfig, {
            requireSameOwner: true,
            ...(request.refuseAtUserCap === true ? { refuseAtUserCap: true } : {}),
        });
    } catch (err) {
        if (concatTmpFile) await fs.unlink(concatTmpFile).catch(() => {});
        clearStartupProgress();
        if (err instanceof PlaySessionOwnedByAnotherUserError) {
            logger.warn('Refusing HLS master request: PlaySessionId owned by another user', {
                playSessionId: playSessionId.slice(0, 8),
                username,
                arm: 'start-lock',
            });
            throw new HlsPlaybackError('Not authorized for this PlaySessionId', 401);
        }
        if (err instanceof UserJobCapReachedError) {
            throw new HlsPlaybackError(err.message, 429);
        }
        if (err instanceof TranscodeCapacityError) {
            // The server-wide cap or system-load breaker refused admission. Refuse
            // this NEW stream (structured, retryable) instead of a generic
            // start failure; nobody mid-episode was interrupted for it.
            logger.warn('Refusing HLS master request: server at transcode capacity', {
                itemId,
                username,
                playSessionId: playSessionId.slice(0, 8),
                reason: err.message,
                code: err.code,
            });
            throw new HlsPlaybackError(
                JSON.stringify({
                    error: err.code,
                    message: 'The server is at its transcode capacity. Try again shortly.',
                    retry_after: TRANSCODE_CAPACITY_RETRY_AFTER_SECONDS,
                }),
                503,
                TRANSCODE_CAPACITY_RETRY_AFTER_SECONDS,
            );
        }
        throw new HlsPlaybackError(
            err instanceof Error ? err.message : 'Transcode job failed to start',
            503,
        );
    }

    // Play-method gate, second half: the decision is final only now (see the
    // manifest gate above). No decision means FFmpeg runs a full transcode.
    if (methodPolicy) {
        const actualMethod = job.transcodeDecisionResult
            ? playMethodFromDecision(job.transcodeDecisionResult)
            : 'full_transcode';
        const methodError = checkPlayMethodAllowed(methodPolicy, actualMethod);
        if (methodError) {
            await transcodeService
                .stopJob(playSessionId, 'play_method_not_allowed')
                .catch((err: unknown) => {
                    logger.warn('Failed to stop a job refused by the play-method policy', {
                        playSessionId: playSessionId.slice(0, 8),
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
            if (concatTmpFile) await fs.unlink(concatTmpFile).catch(() => {});
            clearStartupProgress();
            throw playMethodRefusal(methodError, actualMethod);
        }
    }

    logger.info('HLS transcode job started', {
        itemId,
        jobId: job.id,
        localFilePath,
        videoCodecOverride,
        audioCodecOverride,
        audioTrackCount: audioTracks.length,
    });

    // -------------------------------------------------------------------------
    // 6. Pre-generated VOD playlist (fast path for Jellyfin compat)
    // -------------------------------------------------------------------------
    if (preGenerateVod && isMuxedMode && durationSeconds && durationSeconds > 0) {
        // Always the whole item. Segment names are absolute (FFmpeg gets
        // -start_number, a job started at T writes segment T/d onwards) and the
        // client seeks to T inside this playlist, so a start position only moves
        // where FFmpeg begins. It used to shorten the playlist by T as well: a
        // Jellyfin client resuming at T saw a file T seconds too short and the
        // tail was unreachable (prod 2026-10-02: 8932 s film resumed at 3611 s
        // → 887 segments).
        const effectiveRuntime = durationSeconds;

        if (effectiveRuntime > 0) {
            const { generateVodPlaylist } =
                await import('$lib/server/handlers/hls/lumastra-segment-handler.js');

            const segDuration =
                segmentDuration !== undefined && segmentDuration > 0 ? segmentDuration : 6;

            const content = generateVodPlaylist({
                itemId,
                runtimeSeconds: effectiveRuntime,
                segmentDuration: segDuration,
                playSessionId,
                apiKey,
            });

            logger.info('Serving pre-generated VOD playlist', {
                itemId,
                playSessionId,
                durationSeconds,
                seekSeconds,
                totalSegments: uniformSegmentCount(effectiveRuntime, segDuration),
            });

            clearStartupProgress();
            return {
                playlistBody: content,
                contentType: 'application/vnd.apple.mpegurl',
                headers: {
                    ...HLS_CORS_HEADERS,
                    'Cache-Control': 'no-cache',
                },
            };
        }
    }

    // -------------------------------------------------------------------------
    // 7. Wait for playlist (muxed mode only)
    // -------------------------------------------------------------------------
    // Demux mode: the master playlist is generated from metadata (audio tracks,
    // codecs, resolution) — no FFmpeg output needed. Sub-playlist and segment
    // requests use the segment wait mechanism (up to 45s) so AVPlayer won't 404.
    // Skipping the wait here avoids AVPlayer timing out on slow transcodes
    // (e.g., AV1→HEVC software takes 15s+ before producing any output).
    //
    // Muxed mode: we still wait because the muxed VOD playlist generation path
    // above (step 6b) already returns early for existing jobs; this wait only
    // applies to the first request that just spawned FFmpeg.
    if (isMuxedMode) {
        const playlistName = 'index.m3u8';
        const playlistReady = await waitForHlsPlaylist(
            job.outputDir,
            playlistName,
            MASTER_PLAYLIST_TIMEOUT_MS,
            POLL_INTERVAL_MS,
            // Bail the moment the job dies — a failed startup (encoder couldn't
            // open) or a concurrent stop/eviction (global-cap or per-user LRU)
            // makes us poll the full 30s for a playlist that will never appear,
            // then report a misleading 'transcode_timeout'. 'stopping'/'stopped'
            // here (before any seek) means eviction, not a seek restart, so it's
            // safe to bail. Detect the real failure and surface it fast.
            () => job.status === 'error' || job.status === 'stopping' || job.status === 'stopped',
        );

        if (!playlistReady) {
            if (concatTmpFile) await fs.unlink(concatTmpFile).catch(() => {});
            clearStartupProgress();
            const startupFailed = job.status === 'error';
            const startupInterrupted = job.status === 'stopping' || job.status === 'stopped';
            throw new HlsPlaybackError(
                JSON.stringify({
                    error: startupFailed
                        ? 'transcode_start_failed'
                        : startupInterrupted
                          ? 'transcode_start_interrupted'
                          : 'transcode_start_timeout',
                    message: startupFailed
                        ? 'FFmpeg failed to start'
                        : startupInterrupted
                          ? 'HLS transcode startup was interrupted'
                          : 'HLS transcode startup timed out',
                }),
                503,
            );
        }
        clearStartupProgress();
    } else {
        // Demux mode: no playlist wait needed (master is generated from metadata).
        // But check for immediate FFmpeg failure (bad codec, missing file, permissions)
        // so the client gets a clean 503 instead of a delayed 404 on init segments.
        //
        // This used to be an unconditional `sleep(500)`, which put a flat 500ms on
        // every demux playback even when FFmpeg started cleanly in a few ms.
        //
        // Poll for FFmpeg's own master.m3u8 instead. Demux mode DOES produce one
        // (`-master_pl_name master.m3u8`, ffmpeg-args-builder.ts:1247, set by
        // full-transcode-strategy.ts:360-365 — muxed is the mode that has no
        // FFmpeg master), so its appearance is proof of a healthy start and lets
        // us return immediately.
        //
        // Deliberately NOT gated on `job.status === 'ready'`: that flag is only
        // flipped from checkMasterPlaylist, which is driven by FFmpeg stderr
        // `data` events, and FFmpeg runs with `-loglevel warning -stats` so
        // stderr stays silent until the first stats line ~500ms in. Watching the
        // status would therefore reproduce almost exactly the 500ms this change
        // exists to remove; watching the file does not.
        //
        // A timeout here is NOT a failure — the demux master we serve is
        // synthesized from metadata below, not read from disk, and this path is
        // designed for FFmpeg producing nothing for 15s+ (AV1→HEVC). So the
        // return value is ignored and the real verdict stays the job.status
        // check, exactly as before. Worst case is the previous 500ms.
        await waitForHlsPlaylist(
            job.outputDir,
            'master.m3u8',
            DEMUX_FAILURE_CHECK_MS,
            POLL_INTERVAL_MS,
            // Terminal states: 'error' is a failed spawn (set synchronously
            // before startJob even returns), 'stopping'/'stopped' mean the job
            // was evicted by the global cap or per-user LRU. All three make
            // further waiting pointless — mirrors the muxed branch's bail above.
            () => job.status === 'error' || job.status === 'stopping' || job.status === 'stopped',
        );
        if (job.status === 'error') {
            if (concatTmpFile) await fs.unlink(concatTmpFile).catch(() => {});
            throw new HlsPlaybackError(
                JSON.stringify({
                    error: 'transcode_start_failed',
                    message: 'FFmpeg failed to start',
                }),
                503,
            );
        }
    }

    // -------------------------------------------------------------------------
    // 8a. Codec / bandwidth metadata for the manifest
    // -------------------------------------------------------------------------
    // Computed before the muxed branch below: BOTH the muxed master and the demux
    // master need these, and the muxed branch returns early.
    const transcodeDecision = job.transcodeDecisionResult;

    // Whether audio is actually COPIED for this job. Computed BEFORE the
    // quality-cap block below, which needs it: subtitle burn-in forces a
    // video transcode while leaving HLS-compatible audio copy-eligible, so a
    // cap-active job's audio is not necessarily transcoded too.
    const isAudioCopied = !forceAudioTranscode && transcodeDecision?.audioAction === 'copy';

    // Per-request quality cap: when it forces OR ACCOMPANIES a video transcode
    // (any reason — codec mismatch, subtitle burn-in, etc.), the manifest's
    // BANDWIDTH/RESOLUTION must describe the CAPPED output, not the source.
    // Read from `job.config` (not this request's `qualityCap`) so a reused
    // job's manifest matches what THAT job is actually encoding — mirrors the
    // job-derived provenance rule documented on `outputHevcMain10` below.
    const activeQualityCap =
        job.config.qualityCap && transcodeDecision?.videoAction === 'transcode'
            ? job.config.qualityCap
            : undefined;
    // Dimensions and bitrate are independent — a maxBitrate-ONLY cap has no
    // height bound to shrink (cappedManifestDimensions stays undefined) but
    // must still override the advertised bitrate, and vice versa for a
    // maxHeight-only cap. Applying one only when the other is also present
    // (as an earlier version of this code did) silently advertised the
    // source's full bitrate for a bitrate-only cap.
    const cappedManifestDimensions = activeQualityCap
        ? computeCappedDimensions(
              videoInfo.width,
              videoInfo.height,
              activeQualityCap,
              config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined,
          )
        : undefined;
    // Only the track(s) THIS job actually delivers — see
    // resolveDeliveredAudioTracks. Read from `job.config.hlsOutput`, the same
    // job-derived provenance as `activeQualityCap` above.
    const deliveredAudioBitrates = resolveDeliveredAudioTracks(
        audioTracks,
        job.config.hlsOutput?.hlsAudioMode,
        job.config.hlsOutput?.hlsAudioTrackIndex,
    ).map((track) => track.bitrate);
    // Same effective-budget + audio-reservation derivation as the encode side
    // (ffmpeg-transcode.service.ts's ONE call to computeQualityCapReservation)
    // so the manifest's BANDWIDTH matches what FFmpeg is actually targeting —
    // including the height-only-cap case (budget IMPLIED from the output
    // resolution) and the copied-audio case (reservation bumped to the
    // largest delivered track's real bitrate).
    const {
        effectiveBudgetBps: activeEffectiveBudgetBps,
        audioReservationBps: activeAudioReservationBps,
    } = activeQualityCap
        ? computeQualityCapReservation(
              activeQualityCap,
              videoInfo.height,
              config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined,
              isAudioCopied,
              deliveredAudioBitrates,
          )
        : { effectiveBudgetBps: undefined, audioReservationBps: undefined };
    const cappedManifestVideoBitrateMbps = computeCappedVideoBitrateMbps(
        activeEffectiveBudgetBps,
        activeAudioReservationBps,
        config.VIDEO_BITRATE_MBPS,
    );
    // Codec / transcode / range as the JOB will actually produce them — see
    // jobManifestVideoOverrides (same job-first rule as the segment grid).
    const jobVideoOverrides = jobManifestVideoOverrides(
        transcodeDecision,
        sourceCodecStr,
        job.config.effectivePlan,
    );
    const manifestOutputCodec = jobVideoOverrides.outputCodec ?? outputVideoCodec ?? sourceCodecStr;
    const manifestVideoInfo = {
        ...videoInfo,
        ...jobVideoOverrides,
        ...(cappedManifestDimensions
            ? { width: cappedManifestDimensions.width, height: cappedManifestDimensions.height }
            : {}),
        ...(cappedManifestVideoBitrateMbps !== undefined
            ? { bitrate: Math.round(cappedManifestVideoBitrateMbps * 1_000_000) }
            : {}),
    };

    // A channel-capped job transcodes its audio down to the cap (see
    // `audioForcedByChannelCap`), so the renditions' CHANNELS and the audio
    // share of BANDWIDTH must describe the downmix, not the source. Read from
    // `job.config` for the same reused-job provenance reason as the quality cap.
    const jobMaxAudioChannels = job.config.maxAudioChannels;
    const manifestAudioTracks =
        jobMaxAudioChannels !== undefined && !isAudioCopied
            ? audioTracks.map((track) =>
                  track.channels > jobMaxAudioChannels
                      ? { ...track, channels: jobMaxAudioChannels }
                      : track,
              )
            : audioTracks;

    const bandwidth = calculateEstimatedBandwidth(manifestVideoInfo, manifestAudioTracks);
    // The muxed master advertises ONE audio codec and the segments carry whichever
    // track full-transcode-strategy mapped. Those live in different files, so they
    // agree only by resolving the track the SAME way — mirror the strategy's
    // expression exactly, including its no-request fallback to the file's default
    // track. Reading `audioTracks[0]` instead was consistent only by accident,
    // back when the strategy's `?? 0` also fell through to array position 0.
    //
    // Getting this wrong is not cosmetic: the manifest would say mp4a.40.2 while
    // the segments carry ec-3, and AVFoundation rejects the stream at playback
    // start ('fmt?', CoreMediaErrorDomain 1718449215) — see the audio-copy note in
    // full-transcode-strategy.ts for the same failure in the other direction.
    //
    // `job.config.hlsOutput`, not this request's `resolvedHlsOutput`: on a REUSED
    // job the two disagree. ffmpeg-transcode.service only rewrites
    // `existing.config.hlsOutput` when it detects an audio-track change, and
    // `newAudioIndex === undefined` is not a change — so a session started with
    // AudioStreamIndex=3 keeps muxing absolute 3 while a re-request that omits
    // the index would resolve the file's default here. For a fresh job
    // `job.config === jobConfig`, so this is identical on the common path.
    const muxedAudioTrack = resolveAudioTrackByAbsoluteIndex(
        audioTracks,
        asAbsoluteStreamIndex(
            job.config.hlsOutput?.hlsAudioTrackIndex ?? defaultAudioAbsoluteIndex(audioTracks),
        ),
    ).track;
    const primaryAudioCodec = muxedAudioTrack?.codec ?? audioTracks[0]?.codec ?? 'aac';

    const playlistOptions: MasterPlaylistOptions = {
        audioCodec: isAudioCopied ? primaryAudioCodec : 'aac',
        isAudioCopied,
        // A source with no audio streams reaches here (see the "proceeding with
        // video-only HLS" branch above) and the muxed master cannot infer it
        // from a media URI. Without this the manifest advertises mp4a.40.2 over
        // segments that carry no audio at all.
        hasAudio: audioTracks.length > 0,
        // MPEG-TS demux manifests must signal in-band codec forms (hev1/dvhe).
        hlsContainer: effectiveHlsOutput?.hlsContainer ?? 'fmp4',
        // AVPlayer draws scrubbing thumbnails only from an I-frame variant and
        // cannot request one itself. Decided here, once, so BOTH masters below
        // agree: copy-mode video on native_hls resolves to demux for tvOS, so
        // Apple TV takes the demux master — the muxed one is not the only path
        // that needs this.
        syntheticIframes: resolveSyntheticIframes({ deviceProfileId, userAgent }),
        // Demux master: mark the client's chosen track DEFAULT. The web player
        // switches audio by reloading with a new hlsAudioTrack, and iOS Safari
        // starts on the DEFAULT rendition. The request's index wins over the
        // job's: a demux job is never restarted for a new index (it already
        // delivers every track, see hasAudioTrackChanged), so job.config can
        // still hold the first request's choice.
        selectedAudioStreamIndex:
            effectiveHlsOutput?.hlsAudioTrackIndex ?? job.config.hlsOutput?.hlsAudioTrackIndex,
    };

    // The manifest profile_idc must match the real bitstream — see
    // resolveMasterHevcMain10, which derives every input from the JOB.
    //
    // This used to mix provenance: three inputs came from THIS REQUEST
    // (`!isVideoCopy`, `outputVideoCodec`, `subtitleBurnIn`) while `gpuEncoder`
    // came from the job. On a reused job that disagreed with the segment
    // handler's fully job-derived call, and the disagreement lands on the
    // profile byte — hvc1.1.6 here, hvc1.2.4 there, same session.
    const outputHevcMain10 = resolveMasterHevcMain10(job);

    // Enrich videoInfo with transcode decision for accurate CODECS/VIDEO-RANGE.
    // Without this, HDR-preserved transcodes would advertise SDR Main profile
    // because videoInfo.preserveHdr defaults to undefined (falsy).
    // Spread from `manifestVideoInfo`, not `videoInfo` — its width/height/bitrate
    // are already substituted with the quality-cap-derived output geometry above
    // when a cap forces/accompanies this transcode, so RESOLUTION/BANDWIDTH (and
    // any CODECS level derived from resolution) describe what FFmpeg actually
    // encodes rather than the source.
    const playlistVideoInfo = transcodeDecision?.preserveHdr10
        ? {
              ...manifestVideoInfo,
              outputHevcMain10,
              preserveHdr: true,
              // Use the decision's output range to set videoRangeType for VIDEO-RANGE attr
              videoRangeType:
                  transcodeDecision.outputVideoRange === 'HLG'
                      ? 'HLG'
                      : transcodeDecision.outputVideoRange === 'HDR10'
                        ? 'HDR10'
                        : manifestVideoInfo.videoRangeType,
          }
        : { ...manifestVideoInfo, outputHevcMain10 };

    // -------------------------------------------------------------------------
    // 8. Generate response
    // -------------------------------------------------------------------------
    // Muxed mode: publish a server-owned VOD timeline. FFmpeg's index.m3u8
    // is private producer state whose segment numbers start at the current
    // generation. Public URLs stay on the logical movie timeline and the
    // segment handler maps them back to physical files.
    if (isMuxedMode) {
        const segmentExtension = effectiveHlsOutput?.hlsContainer === 'mpegts' ? 'ts' : 'm4s';
        let muxedRuntimeSeconds = durationSeconds ?? job.config.totalDurationSeconds ?? 0;

        // When keyframe data reveals the actual video is significantly shorter
        // than the reported duration (e.g. truncated file where format.duration
        // comes from subtitle streams), cap the playlist to the real video length.
        // This makes truncated files playable instead of silently broken.
        if (isVideoCopy && keyframeData && keyframeData.length > 0) {
            const lastKeyframePts = keyframeData[keyframeData.length - 1];
            // Add one segment duration as padding for the final segment
            const keyframeDerivedDuration = lastKeyframePts + job.segmentDurationSeconds;
            if (keyframeDerivedDuration < muxedRuntimeSeconds * 0.9) {
                logger.warn(
                    'Truncated file detected: capping playlist duration to actual video length',
                    {
                        itemId,
                        reportedDuration: muxedRuntimeSeconds,
                        keyframeDerivedDuration,
                        lastKeyframePts,
                    },
                );
                muxedRuntimeSeconds = keyframeDerivedDuration;
            }
        }

        // The segment grid follows the JOB's video action, not this request's
        // — see playlistUsesCopyGrid.
        const copyGrid = playlistUsesCopyGrid(job, isVideoCopy);
        if (copyGrid !== isVideoCopy) {
            logger.info('Muxed VOD playlist follows the job video action, not the request', {
                itemId,
                playSessionId,
                requestIsVideoCopy: isVideoCopy,
                jobVideoAction: job.transcodeDecisionResult?.videoAction,
            });
        }
        const muxedPlaylist = buildMuxedVodPlaylist({
            runtimeSeconds: muxedRuntimeSeconds,
            segmentDuration: job.segmentDurationSeconds,
            segmentBase,
            segmentParams,
            segmentExtension,
            keyframeData: copyGrid ? keyframeData : undefined,
            seekStartTime: copyGrid ? (job.config.startTimeSeconds ?? 0) : undefined,
        });

        logger.info('Serving server-owned muxed VOD playlist', {
            itemId,
            playSessionId,
            durationSeconds,
            seekSeconds,
            seekGridAnchor: copyGrid ? (job.config.startTimeSeconds ?? 0) : undefined,
            segmentOffset: job.segmentOffset,
            segmentExtension,
            keyframeSegments: copyGrid ? (keyframeData?.length ?? 0) : 0,
        });

        // Native HLS (AVPlayer) gets a master playlist wrapping the muxed rendition
        // rather than the bare media playlist.
        //
        // tvOS configures the display's HDR mode from the manifest BEFORE it parses
        // any media, so `VIDEO-RANGE=PQ` has to be declared on an EXT-X-STREAM-INF.
        // With no master there was nowhere to put it: HDR10 titles decoded and played
        // correctly while the TV stayed in SDR and tone-mapped them, showing no HDR
        // indicator. (Dolby Vision escaped this because its `dvvC` box signals in-band.)
        // Apple's authoring spec also requires CODECS on every variant.
        //
        // MSE/web is deliberately left on the bare media playlist: hls.js drives its
        // own variant selection and works today, so there is no reason to change what
        // it receives.
        // Gate on the CLIENT, not on delivery_path. `mse_hls` does not mean "browser
        // using MSE" — selectDeliveryPath() falls back to it whenever the video needs
        // transcoding (see info.service.ts), so a tvOS client playing AV1 lands there
        // too. Gating on delivery_path therefore withheld the master from AVPlayer for
        // exactly the content that gets transcoded, leaving HDR unsignalled.
        //
        // Native-HLS clients (AVPlayer) need the master to learn VIDEO-RANGE before
        // they configure the display. Browsers keep the bare media playlist: hls.js
        // drives its own variant selection and works today.
        const isNativeClient = isNativeHlsClient({ deviceProfileId, userAgent });
        // Audio-only always gets the master, on every client — not just native HLS.
        // hls.js drives its own ABR/buffer sizing off the master's BANDWIDTH
        // attribute (see AUDIO_ONLY_BANDWIDTH), so unlike the regular muxed
        // rendition there is no "bare media playlist is fine" case here.
        const wantsMuxedMaster = (videoDisabled || isNativeClient) && muxedPlaylistKind !== 'media';

        if (wantsMuxedMaster) {
            const mediaParams = new URLSearchParams(segmentParams);
            mediaParams.set(MUXED_MEDIA_PLAYLIST_PARAM, 'media');
            // Pin the audio mode on the follow-up request. Muxed mode is normally
            // derived from the resolved PlaybackPlan, but segmentParams carries no
            // plan id — so without this the second request re-derives demux and
            // answers with the demux master instead of the media playlist, leaving
            // the client in a master→master loop.
            mediaParams.set('hlsAudioMode', 'muxed');
            if (effectiveHlsOutput?.hlsContainer) {
                mediaParams.set('hlsContainer', effectiveHlsOutput.hlsContainer);
            }
            // The selected track decides the audio copy/transcode call (quality
            // and channel caps) — a follow-up that fell back to the default track
            // could compute a different forceAudioTranscode and respawn FFmpeg.
            if (effectiveHlsOutput?.hlsAudioTrackIndex !== undefined) {
                mediaParams.set('hlsAudioTrack', String(effectiveHlsOutput.hlsAudioTrackIndex));
            }
            // Same for the rest of the playback identity — plan id, the negotiated
            // codecs and the burn-in. None can be re-derived from the follow-up URL,
            // and each one that goes missing makes the second request compute a
            // different config and respawn FFmpeg.
            addPlaybackIdentityToSearchParams(mediaParams, {
                planId: request.planId,
                videoCodec: videoCodecOverride,
                audioCodec: audioCodecOverride,
                subtitleBurnIn,
            });
            const mediaUri = `${segmentBase}${mediaParams.toString() ? `?${mediaParams.toString()}` : ''}`;

            // Audio-only gets its own master shape: no RESOLUTION, no AUDIO= group,
            // and a fixed BANDWIDTH rather than the resolution-tiered estimate (see
            // AUDIO_ONLY_BANDWIDTH — calculateEstimatedBandwidth would advertise
            // ~40 Mbps for a 128 kbps stream and wreck hls.js's ABR/buffer math).
            const masterContent = videoDisabled
                ? generateAudioOnlyMasterPlaylist(
                      mediaUri,
                      AUDIO_ONLY_BANDWIDTH,
                      manifestSubtitleTracks,
                      segmentBase,
                      segmentParams,
                      activeFileId ?? undefined,
                  )
                : generateMuxedMasterPlaylist(
                      mediaUri,
                      bandwidth,
                      playlistVideoInfo,
                      manifestOutputCodec,
                      playlistOptions,
                      {
                          segmentBase,
                          params: segmentParams,
                          trickplayInfo,
                          itemId,
                          fileId: activeFileId,
                          // Text subtitle tracks belong on the muxed master too:
                          // "muxed" is about audio sharing the video's segments,
                          // and subtitles are a separate MEDIA group either way.
                          // Without these an AVPlayer on any transcoded stream
                          // (delivery_path mse_hls → hlsAudioMode muxed) saw zero
                          // subtitle tracks, while the same title played
                          // direct/remux via the demux master offered all of them.
                          subtitleTracks: manifestSubtitleTracks,
                      },
                  );

            logger.info('Serving muxed master playlist for native HLS', {
                itemId,
                playSessionId,
                mediaUri,
                videoDisabled,
            });

            return {
                playlistBody: masterContent,
                contentType: 'application/vnd.apple.mpegurl',
                headers: {
                    ...HLS_CORS_HEADERS,
                    'Cache-Control': 'no-cache',
                },
            };
        }

        return {
            playlistBody: muxedPlaylist,
            contentType: 'application/vnd.apple.mpegurl',
            headers: {
                ...HLS_CORS_HEADERS,
                'Cache-Control': 'no-cache',
            },
        };
    }

    const masterContent = generateMasterPlaylist(
        manifestAudioTracks,
        manifestSubtitleTracks,
        segmentBase,
        segmentParams,
        bandwidth,
        playlistVideoInfo,
        manifestOutputCodec,
        itemId,
        activeFileId ?? undefined,
        trickplayInfo,
        playlistOptions,
    );

    const responseHeaders: Record<string, string> = {
        ...HLS_CORS_HEADERS,
        'Cache-Control': 'no-cache',
    };

    // Warn client when copy-mode video is missing keyframe data
    if (isVideoCopy && !keyframeData) {
        responseHeaders['X-Lumastra-Playback-Warning'] =
            'missing-keyframes: copy-mode video without keyframe data, seeking may be limited';
    }

    // Expose custom headers to client-side JS (CORS)
    const exposedHeaders = Object.keys(responseHeaders).filter((h) => h.startsWith('X-Lumastra-'));
    if (exposedHeaders.length > 0) {
        responseHeaders['Access-Control-Expose-Headers'] = exposedHeaders.join(', ');
    }

    return {
        playlistBody: masterContent,
        contentType: 'application/vnd.apple.mpegurl',
        headers: responseHeaders,
    };
}
