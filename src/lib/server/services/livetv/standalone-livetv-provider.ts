// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standalone LiveTV Provider
 *
 * Provider implementation for standalone mode — connects to PostgreSQL for
 * channel/program data and the stream proxy for HLS playback.
 *
 * @module services/livetv/standalone-livetv-provider
 */

import { channelImageSet } from '$lib/server/services/image-descriptor/resources.js';
import type postgres from 'postgres';
import type {
    LiveTvChannel,
    LiveTvFeedProgram,
    LiveTvCategory,
    LiveTvStreamInfo,
    ProgramSearchAiring,
} from '$lib/schemas/livetv.js';
import type { LiveTvJoinCompat, LiveTvJoinOptions, LiveTvProvider } from './livetv-provider.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getAllVisibleChannels,
    getChannelWithSource,
    getBackupGroupFeeds,
    searchChannels as searchChannelsQuery,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    getCurrentProgram as getCurrentProgramQuery,
    getCurrentProgramsForAllChannels,
    getProgramsByDateRange,
    getGuidePrograms,
    searchProgramAirings,
    getVisibleCategories,
} from '$lib/server/database/queries/livetv-programs.queries.js';
import { viewerChannelName, viewerChannelNames } from './viewer-channel-name.js';
import { collapseProgramRows } from './epg-schedule.js';
import { channelNumberKey, ensureChannelNumbers } from './channel-numbers.service.js';
import { getStreamProxyClient } from './stream-proxy-client.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { getLiveTvRung } from '$lib/shared/livetv-rungs.js';
import { redactLiveTvUrl, redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import type {
    CapReason,
    EgressRefusal,
    JoinAdaptiveRequest,
    JoinCapRequest,
} from '../../../../shared/livetv-proxy-types.js';
import {
    isLiveTvFailureReason,
    type LiveTvFailureReason,
} from '../../../../shared/livetv-failure-reason.js';
import type { LiveTvFeedTried } from '$lib/server/api/problem.js';
import {
    failureFacts,
    legacyCodeForReason,
    reasonForLegacyProxyError,
    translateFeedsTried,
    type StationFeedRef,
} from './livetv-failure-mapping.js';
import { recordStartFailure, recordStartSuccess } from './channel-health.service.js';

/**
 * How long a cold join may wait for the first segment before it answers anyway. Only the
 * playback-session start asks for it; the total stays far under the proxy client's 45 s
 * whole-exchange timeout.
 */
const JOIN_AWAIT_READY_MS = 12_000;

/**
 * Map a refusal onto the reason reported alongside a fallback stream.
 *
 * Every refusal the feasibility pipeline can produce has its own reason. Collapsing
 * them onto 'capacity' told operators to add CPU for a 480p channel that can never
 * carry a ladder, and for a source ffprobe simply could not read.
 */
function refusalToReason(refusal: EgressRefusal): CapReason {
    switch (refusal) {
        case 'hdr_source':
        case 'unprobeable':
        case 'below_ladder':
        case 'insufficient_ladder':
        case 'capacity':
            return refusal;
        // 'invalid' and 'internal' are bugs, not policy — 'capacity' is the closest
        // honest thing to tell a viewer whose stream still has to come from somewhere.
        default:
            return 'capacity';
    }
}
/** Convert a channel ID + raw logo_url to a proxied image URL (or undefined).
 *  Channel logos display at 32–48px so `thumb` (250w) is plenty even at 3× DPR.
 *  `fallback: 'none'` makes an unfetchable logo (provider logo host down, 404)
 *  a real 404, so the UI's onerror falls back to the name monogram instead of
 *  rendering the generic popcorn placeholder as the channel's logo. */
import type { ChannelRow } from '$lib/server/database/queries/livetv-channels.queries.js';
import type { ProgramRow } from '$lib/server/database/queries/livetv-programs.queries.js';

const logger = Logger.for('StandaloneLiveTvProvider');

/**
 * Typed error for stream limit exceeded — enables instanceof checks in route handlers
 * instead of fragile string matching.
 */
export class StreamLimitError extends Error {
    readonly limit: number;
    readonly activeChannels: Array<{
        channelId: string;
        channelName: string;
        viewers: number;
    }>;
    readonly sourceId: string | undefined;

    constructor(
        limit: number,
        activeChannels: Array<{
            channelId: string;
            channelName: string;
            viewers: number;
        }>,
        sourceId?: string,
    ) {
        super(`Stream limit reached: ${limit} concurrent streams allowed`);
        this.name = 'StreamLimitError';
        this.limit = limit;
        this.activeChannels = activeChannels;
        this.sourceId = sourceId;
    }
}

/**
 * Known stream failure error codes matching StreamFailureErrorSchema in livetv.ts.
 */
export type StreamFailureErrorCode =
    | 'spawn_failed'
    | 'source_unreachable'
    | 'channel_not_found'
    | 'no_segments'
    | 'proxy_unreachable'
    | 'internal_error';

export class CapUnavailableError extends Error {
    constructor(readonly refusal: EgressRefusal) {
        super(`Live TV cap unavailable: ${refusal}`);
        this.name = 'CapUnavailableError';
    }
}

/**
 * Typed error for stream failures (non-limit) — enables instanceof checks in route handlers.
 * Covers: spawn_failed, source_unreachable, proxy_unreachable, no_segments, internal_error
 */
export class StreamFailureError extends Error {
    readonly errorCode: StreamFailureErrorCode;
    readonly channelId: string;

    constructor(code: StreamFailureErrorCode, channelId: string, message: string) {
        super(message);
        this.name = 'StreamFailureError';
        this.errorCode = code;
        this.channelId = channelId;
    }
}

/**
 * A stream failure the proxy or the app classified into the typed taxonomy
 * (src/shared/livetv-failure-reason.ts). It IS a StreamFailureError so the Jellyfin-compat
 * routes keep answering their flat `errorCode`; the typed routes read `reason` and friends.
 */
export class LiveTvFailureError extends StreamFailureError {
    readonly reason: LiveTvFailureReason;
    readonly retryable: boolean;
    readonly retryAfterMs: number | undefined;
    /** Feed ids and names only; shown to admins. */
    readonly feedsTried: LiveTvFeedTried[];

    constructor(
        reason: LiveTvFailureReason,
        channelId: string,
        message: string,
        facts: { retryable: boolean; retryAfterMs?: number; feedsTried?: LiveTvFeedTried[] },
    ) {
        super(legacyCodeForReason(reason), channelId, message);
        this.name = 'LiveTvFailureError';
        this.reason = reason;
        this.retryable = facts.retryable;
        this.retryAfterMs = facts.retryAfterMs;
        this.feedsTried = facts.feedsTried ?? [];
    }
}

const CHANNEL_CACHE_TTL_MS = 30_000; // 30 seconds
const GUIDE_CACHE_TTL_MS = 60_000; // 1 minute
const GUIDE_CACHE_MAX_ENTRIES = 8; // bounded to avoid leaking memory on shifting windows
const GUIDE_WINDOW_BUCKET_MS = 60_000; // round window endpoints to the minute for cache hits

function getSql(): postgres.Sql {
    const sql = getDb();
    if (!sql) {
        throw new Error('Database connection not available');
    }
    return sql;
}

function programRowToLiveTvFeedProgram(row: ProgramRow): LiveTvFeedProgram {
    return {
        id: row.id,
        channelId: row.channel_id,
        title: row.title,
        description: row.description ?? undefined,
        startTime: row.start_time.toISOString(),
        endTime: row.end_time.toISOString(),
        epgId: row.epg_id ?? undefined,
        genres: row.genres ?? undefined,
        officialRating: row.official_rating ?? undefined,
        sourceId: row.source_id ?? undefined,
    };
}

function channelRowToLiveTvChannel(row: ChannelRow): LiveTvChannel {
    return {
        id: row.id,
        name: row.name,
        images: channelImageSet('internal', row.id, row.logo_url),
        category: row.category_name ?? undefined,
        categoryId: row.category_id ?? undefined,
        sortOrder: row.sort_order,
        isVisible: row.is_visible,
        qualityTier: (row.quality_tier as LiveTvChannel['qualityTier']) ?? undefined,
        currentProgram: undefined,
        backupGroupId: row.backup_group_id ?? undefined,
        sourceId: row.source_id ?? undefined,
    };
}

export class StandaloneLiveTvProvider implements LiveTvProvider {
    private channelCache: {
        channels: LiveTvChannel[];
        fetchedAt: number;
    } | null = null;

    // Map<bucketKey, {result, fetchedAt}>. Keyed by minute-rounded window so
    // back-to-back guide opens dedupe to a single DB query within GUIDE_CACHE_TTL_MS.
    private guideCache = new Map<
        string,
        { result: Record<string, LiveTvFeedProgram[]>; fetchedAt: number }
    >();

    // Visible category list, memoized for the same ~30s window as channelCache.
    // Categories change on the exact same admin mutations that change the channel
    // lineup (add/hide/rename/reorder), so they are busted together in bustCaches().
    private categoryCache: {
        categories: LiveTvCategory[];
        fetchedAt: number;
    } | null = null;

    /** Last channel numbers read (card key → number); used when a read fails. */
    private lastChannelNumbers: Map<string, number> | null = null;

    /** Viewer names of `channelCache`'s lineup, keyed to that lineup array. */
    private lineupNameCache: { lineup: LiveTvChannel[]; names: Map<string, string> } | null = null;

    /** Bumped by bustCaches() so a fetch already in flight when an admin
     *  mutation lands doesn't write its now-stale snapshot back after the bust. */
    private cacheGeneration = 0;

    async getChannels(): Promise<LiveTvChannel[]> {
        if (this.channelCache && Date.now() - this.channelCache.fetchedAt < CHANNEL_CACHE_TTL_MS) {
            return this.channelCache.channels;
        }

        const gen = this.cacheGeneration;
        const sql = getSql();
        const [rows, programRows] = await Promise.all([
            getAllVisibleChannels(sql),
            getCurrentProgramsForAllChannels(sql),
        ]);

        // Build a map of channel ID → current program
        const programByChannel = new Map(
            programRows.map((row) => [row.channel_id, programRowToLiveTvFeedProgram(row)]),
        );

        // The name viewers see: no provider tag ("UK:", "[Bouquet]") or
        // quality/feed words (FHD, HDraw, HEVC, ²), unless an admin renamed the
        // channel — their override always wins (viewer-channel-name.ts).
        const viewerNames = config.LIVETV_HIDE_QUALITY_TAGS
            ? viewerChannelNames(
                  rows.map((row) => ({
                      id: row.id,
                      name: row.name,
                      adminDisplayName: row.admin_display_name,
                  })),
              )
            : undefined;
        // Stable channel numbers (one per station card). A failure here must
        // not take the lineup down: the channels endpoint then falls back to
        // lineup positions.
        // On a failure keep the last numbers this node read: falling back to
        // lineup positions would show viewers different numbers for a while.
        let channelNumbers: Map<string, number> | undefined;
        try {
            channelNumbers = (await ensureChannelNumbers(sql, rows)).numbers;
            this.lastChannelNumbers = channelNumbers;
        } catch (error) {
            channelNumbers = this.lastChannelNumbers ?? undefined;
            logger.warn('Channel numbers unavailable', { error: (error as Error).message });
        }
        const channels = rows.map((row) => {
            const channel = channelRowToLiveTvChannel(row);
            channel.name = viewerNames?.get(row.id) ?? channel.name;
            channel.currentProgram = programByChannel.get(row.id);
            channel.channelNumber = channelNumbers?.get(channelNumberKey(row));
            return channel;
        });

        // Skip the write-back if bustCaches() ran while this fetch was in flight
        // (the data we just read predates the invalidation).
        if (gen === this.cacheGeneration) {
            this.channelCache = { channels, fetchedAt: Date.now() };
        }
        logger.info(`Loaded ${channels.length} visible channels`);
        return channels;
    }

    async getChannel(channelId: string): Promise<LiveTvChannel | undefined> {
        const sql = getSql();
        const row = await getChannelWithSource(sql, channelId);
        if (!row) return undefined;
        const channel = channelRowToLiveTvChannel(row);
        channel.name = await this.viewerName(channel.id, channel.name);
        return channel;
    }

    /**
     * The lineup's viewer names by channel id, rebuilt when the lineup cache
     * is. Empty when the lineup cannot be read: callers fall back to cleaning
     * the name alone.
     */
    private async lineupNames(): Promise<Map<string, string>> {
        try {
            const lineup = await this.getChannels();
            if (this.lineupNameCache?.lineup !== lineup) {
                this.lineupNameCache = {
                    lineup,
                    names: new Map(lineup.map((channel) => [channel.id, channel.name])),
                };
            }
            return this.lineupNameCache.names;
        } catch (err) {
            logger.debug(`Lineup names unavailable: ${String(err)}`);
            return new Map();
        }
    }

    /**
     * A channel's name as the lineup shows it, so the player, search and /j
     * agree with the card. A channel outside the lineup (a hidden feed) is
     * cleaned on its own.
     */
    private async viewerName(channelId: string, rawName: string): Promise<string> {
        if (!config.LIVETV_HIDE_QUALITY_TAGS) return rawName;
        return (await this.lineupNames()).get(channelId) ?? viewerChannelName(rawName);
    }

    async getCurrentProgram(channelId: string): Promise<LiveTvFeedProgram | undefined> {
        const sql = getSql();
        const row = await getCurrentProgramQuery(sql, channelId);
        if (!row) return undefined;
        return programRowToLiveTvFeedProgram(row);
    }

    async getPrograms(channelId: string, start: Date, end: Date): Promise<LiveTvFeedProgram[]> {
        const sql = getSql();
        const rows = await getProgramsByDateRange(sql, channelId, start, end);
        return collapseProgramRows(rows).map(programRowToLiveTvFeedProgram);
    }

    async getGuidePrograms(start: Date, end: Date): Promise<Record<string, LiveTvFeedProgram[]>> {
        // Round window endpoints to a 1-minute bucket so multiple clients opening
        // the guide within the same minute share a single DB hit. EPG cells span
        // minutes anyway; up to 60s of staleness on the boundaries is invisible.
        const bucketStart =
            Math.floor(start.getTime() / GUIDE_WINDOW_BUCKET_MS) * GUIDE_WINDOW_BUCKET_MS;
        const bucketEnd =
            Math.ceil(end.getTime() / GUIDE_WINDOW_BUCKET_MS) * GUIDE_WINDOW_BUCKET_MS;
        const cacheKey = `${bucketStart}-${bucketEnd}`;

        const cached = this.guideCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < GUIDE_CACHE_TTL_MS) {
            return cached.result;
        }

        const sql = getSql();
        const rows = collapseProgramRows(
            await getGuidePrograms(sql, new Date(bucketStart), new Date(bucketEnd)),
        );
        const result: Record<string, LiveTvFeedProgram[]> = {};
        for (const row of rows) {
            const prog = programRowToLiveTvFeedProgram(row);
            if (!result[row.channel_id]) result[row.channel_id] = [];
            result[row.channel_id].push(prog);
        }

        // Evict expired or surplus entries before insert. With both a TTL sweep and
        // a hard cap, the map can't grow unbounded even if Android TV starts polling
        // with constantly shifting windows.
        const now = Date.now();
        for (const [k, v] of this.guideCache) {
            if (now - v.fetchedAt >= GUIDE_CACHE_TTL_MS) this.guideCache.delete(k);
        }
        if (this.guideCache.size >= GUIDE_CACHE_MAX_ENTRIES) {
            const oldestKey = this.guideCache.keys().next().value;
            if (oldestKey) this.guideCache.delete(oldestKey);
        }
        this.guideCache.set(cacheKey, { result, fetchedAt: now });

        return result;
    }

    async searchChannels(query: string, limit: number = 20): Promise<LiveTvChannel[]> {
        const sql = getSql();
        const rows = await searchChannelsQuery(sql, query, limit);
        const channels = rows.map(channelRowToLiveTvChannel);
        for (const channel of channels) {
            channel.name = await this.viewerName(channel.id, channel.name);
        }
        return channels;
    }

    async searchPrograms(
        query: string,
        limit: number = 20,
        offset: number = 0,
    ): Promise<ProgramSearchAiring[]> {
        const rows = await searchProgramAirings(getSql(), query, limit, offset);
        return rows.map((row) => ({
            id: row.id,
            stationId: row.station_id,
            title: row.title,
            description: row.description ?? undefined,
            startTime: row.start_time.toISOString(),
            endTime: row.end_time.toISOString(),
            temporalStatus: row.temporal_status,
        }));
    }

    /**
     * Re-join uncapped and report why the ceiling was dropped.
     *
     * Re-entering getStreamInfo() without cap/adaptive is deliberate: the multiplexer
     * reconciles this viewer's rung/adaptive membership from the join body, so the
     * uncapped join is also what releases whatever the refused attempt was holding.
     */
    private async fallbackToSource(
        channelId: string,
        viewerId: string,
        reason: CapReason,
        compat?: LiveTvJoinCompat,
        options?: LiveTvJoinOptions,
    ): Promise<LiveTvStreamInfo> {
        // The player's capabilities ride along: an HEVC channel's "source" may still be
        // a compat variant for this player.
        const fallback = await this.getStreamInfo(
            channelId,
            viewerId,
            undefined,
            undefined,
            compat,
            options,
        );
        return { ...fallback, reason };
    }

    /**
     * Refuse a request the proxy has ALREADY admitted, releasing the slot it reserved.
     *
     * Always throws. Without the leave, a FRESH admission counted against the source's
     * maxStreams until the proxy's orphan sweep expired the heartbeat — a refusal the
     * viewer sees instantly kept a stream reserved for another half-minute.
     *
     * `existingViewer` gates it, because the same call also serves quality SWITCHES by a
     * viewer already watching. That join admits nobody and reserves nothing, so there is
     * no slot to release — and leaving would evict a live session, breaking the
     * attach-before-detach contract that deliberately keeps a refused switch playing
     * (see StreamMultiplexer.applyCap and PlayerController.switchLiveTvQuality). The
     * viewer's heartbeat would then 404 and their stream would die seconds later.
     *
     * An older proxy omits the field; `undefined` therefore means "cannot prove this was
     * fresh", and we skip the leave. That trades a bounded 30s slot hold for never
     * killing a stream that was working — the same trade the pre-`refuseAfterJoin`
     * behaviour made, and only reachable against a version-skewed deployment.
     */
    private async refuseAfterJoin(
        channelId: string,
        viewerId: string,
        refusal: EgressRefusal,
        existingViewer: boolean | undefined,
    ): Promise<never> {
        if (existingViewer === false) {
            try {
                await getStreamProxyClient().leaveChannel(channelId, viewerId);
            } catch (leaveError) {
                logger.warn(`Failed to release slot after refusing ${channelId}`, {
                    error: leaveError instanceof Error ? leaveError.message : String(leaveError),
                });
            }
        }
        throw new CapUnavailableError(refusal);
    }

    async getStreamInfo(
        channelId: string,
        viewerId: string,
        cap?: JoinCapRequest,
        adaptive?: JoinAdaptiveRequest,
        compat?: LiveTvJoinCompat,
        options?: LiveTvJoinOptions,
    ): Promise<LiveTvStreamInfo> {
        const sql = getSql();
        const channel = await getChannelWithSource(sql, channelId);

        if (!channel) {
            throw new Error(`Channel ${channelId} not found`);
        }

        if (!channel.stream_url) {
            throw new LiveTvFailureError(
                'channel_offline',
                channelId,
                'No stream URL configured for this channel',
                failureFacts('channel_offline', {}, []),
            );
        }

        // Build stream URLs: primary + backup group
        const rawFeeds: Array<StationFeedRef & { url: string }> = [
            { id: channelId, name: channel.name, url: channel.stream_url },
        ];
        if (channel.backup_group_id) {
            const backups = await getBackupGroupFeeds(sql, channel.backup_group_id, channelId);
            rawFeeds.push(...backups.map((b) => ({ id: b.id, name: b.name, url: b.stream_url })));
        }

        // Per-entry SSRF validation: reject stream URLs that resolve to private
        // addresses (unless the operator has opted in via LIVETV_ALLOW_PRIVATE_URLS).
        //
        // NOTE: `result.resolvedIp` is intentionally NOT pinned/forwarded here.
        // The validated URL crosses a process boundary next — it travels as a
        // plain string over HTTP to the (possibly separate-container) stream
        // proxy service via proxyClient.joinChannel() — so there is no
        // connection object here to pin to an IP, and rewriting the URL's host
        // to the resolved IP would break TLS SNI/cert validation for https
        // sources. The authenticated join contract carries the same resolved
        // allow-private policy to the stream proxy, which independently checks
        // the URL right before it opens any connection (assertStreamUrlNotPrivate()
        // in ssrf-check.ts, called from FfmpegManager.spawn() both before probing
        // and again immediately before the FFmpeg spawn). This is still
        // TOCTOU-vulnerable to DNS rebinding between checks — see the warning
        // in src/lib/server/utils/url-validator.ts — the redundant, close-in-
        // time checks narrow rather than eliminate that window.
        const allowPrivateUrls = config.LIVETV_ALLOW_PRIVATE_URLS;
        const streamUrls: string[] = [];
        // Parallel to streamUrls: the proxy reports failures by index into it.
        const sentFeeds: StationFeedRef[] = [];
        const blockedFeeds: StationFeedRef[] = [];
        for (const feed of rawFeeds) {
            const url = feed.url;
            const result = await validateUrl(url, {
                allowPrivateIps: allowPrivateUrls,
            });
            if (result.valid) {
                streamUrls.push(url);
                sentFeeds.push({ id: feed.id, name: feed.name });
            } else {
                blockedFeeds.push({ id: feed.id, name: feed.name });
                logger.warn(
                    `Stream URL blocked by SSRF guard for channel ${channelId}: ${result.reason}`,
                    { url: redactLiveTvUrl(url) },
                );
            }
        }

        options?.onFeedsSent?.(sentFeeds.map((f) => ({ id: f.id, name: f.name })));

        if (streamUrls.length === 0) {
            const feedsTried: LiveTvFeedTried[] = blockedFeeds.map((f) => ({
                feedId: f.id,
                feedName: f.name,
                reason: 'provider_unreachable',
            }));
            await recordStartFailure(sql, channelId, {
                reason: 'provider_unreachable',
                feeds: feedsTried.map((f) => ({ feedId: f.feedId, reason: f.reason })),
            });
            throw new LiveTvFailureError(
                'provider_unreachable',
                channelId,
                'All stream URLs for this channel were blocked by the SSRF guard',
                { retryable: true, retryAfterMs: 10_000, feedsTried },
            );
        }

        const proxyClient = getStreamProxyClient();
        logger.info(
            `Requesting stream for channel ${channelId} (${channel.name}), viewer ${viewerId}`,
        );

        let result;
        try {
            result = await proxyClient.joinChannel(channelId, {
                viewerId,
                streamUrls,
                feedIds: sentFeeds.map((f) => f.id),
                ...(options?.awaitReady ? { awaitReadyMs: JOIN_AWAIT_READY_MS } : {}),
                allowPrivateUrls,
                sourceId: channel.source_id ?? channelId,
                maxStreams: channel.max_streams ?? 1,
                channelName: channel.name,
                cap,
                adaptive,
                ...(compat?.client ? { client: compat.client } : {}),
            });
        } catch (fetchError) {
            // Proxy unreachable (network error, container down)
            const message = redactLiveTvUrlsInText(
                fetchError instanceof Error ? fetchError.message : String(fetchError),
            );
            logger.error(`Stream proxy unreachable for channel ${channelId}: ${message}`);
            throw new StreamFailureError(
                'proxy_unreachable',
                channelId,
                'Stream proxy is unreachable',
            );
        }

        if ('error' in result) {
            if (result.error === 'stream_limit_reached') {
                throw new StreamLimitError(
                    result.limit,
                    result.active,
                    channel.source_id ?? undefined,
                );
            }
            if (result.error === 'cap_unavailable') {
                // Only `adaptive` needs an app-side fallback: EgressManager applies
                // `cap.fallback` itself and answers 200-uncapped, whereas
                // AdaptiveEgressManager always refuses and leaves the policy here.
                const policy = adaptive?.fallback ?? cap?.fallback;
                if (adaptive && policy === 'source') {
                    return this.fallbackToSource(
                        channelId,
                        viewerId,
                        refusalToReason(result.refusal),
                        compat,
                        options,
                    );
                }
                throw new CapUnavailableError(result.refusal);
            }
            if (result.error === 'channel_failed') {
                const reason = isLiveTvFailureReason(result.reason)
                    ? result.reason
                    : 'all_feeds_failed';
                const feedsTried = translateFeedsTried(result.feedsTried, sentFeeds);
                logger.warn(`Channel ${channelId} failed to start: ${reason}`);
                throw new LiveTvFailureError(
                    reason,
                    channelId,
                    `Channel failed: ${reason}`,
                    failureFacts(reason, result, feedsTried),
                );
            }
            // The legacy proxy errors keep their strings on the wire and get a taxonomy reason here.
            const legacyReason = reasonForLegacyProxyError(result.error);
            if (legacyReason) {
                const message =
                    'message' in result && typeof result.message === 'string'
                        ? redactLiveTvUrlsInText(result.message)
                        : `Stream error: ${result.error}`;
                logger.warn(
                    `Stream failure for channel ${channelId}: ${result.error} — ${message}`,
                );
                throw new LiveTvFailureError(
                    legacyReason,
                    channelId,
                    message,
                    failureFacts(legacyReason, {}, []),
                );
            }
            // All other proxy errors → StreamFailureError
            const errorCode = result.error;
            // The proxy's message can echo the upstream stream URL, and it reaches
            // the (non-admin) viewer through StreamFailureError.
            const errorMessage =
                'message' in result && typeof result.message === 'string'
                    ? redactLiveTvUrlsInText(result.message)
                    : `Stream error: ${errorCode}`;
            logger.warn(`Stream failure for channel ${channelId}: ${errorCode} — ${errorMessage}`);
            throw new StreamFailureError(errorCode, channelId, errorMessage);
        }

        // Everything below this point runs AFTER the proxy has already admitted the
        // viewer, so a refusal here owes it a compensating leave — see
        // `refuseAfterJoin`. Returning without one held a slot against the source's
        // maxStreams until the proxy's orphan sweep (LIVETV_VIEWER_TIMEOUT_SECONDS).
        const hasCapResponse =
            Object.prototype.hasOwnProperty.call(result, 'rungId') &&
            Object.prototype.hasOwnProperty.call(result, 'appliedMaxBitrate') &&
            Object.prototype.hasOwnProperty.call(result, 'reason');

        // Version-skew: an old proxy silently ignores the additive fields and cannot
        // serve adaptive or rung paths. Both branches below treat that exactly like an
        // infeasible cap — including honouring the operator's fallback, which the
        // adaptive branch previously skipped, so `source` still meant "no Live TV".
        if (adaptive && !result.adaptive) {
            if (adaptive.fallback === 'refuse') {
                await this.refuseAfterJoin(channelId, viewerId, 'capacity', result.existingViewer);
            }
            return this.fallbackToSource(channelId, viewerId, 'capacity', compat, options);
        }
        if (cap && !hasCapResponse) {
            if (cap.fallback === 'refuse') {
                await this.refuseAfterJoin(channelId, viewerId, 'capacity', result.existingViewer);
            }
            return {
                streamUrl: `/api/livetv/channels/${channelId}/stream/master.m3u8`,
                requiresProxy: true,
                sourceId: channel.source_id ?? undefined,
                maxStreams: channel.max_streams ?? undefined,
                rungId: null,
                requestedMaxBitrateBps: cap.requestedMaxBitrate,
                appliedMaxBitrateBps: null,
                appliedMaxHeight: null,
                reason: 'capacity',
            };
        }

        const rungId = hasCapResponse ? result.rungId : null;
        const appliedRung = rungId ? getLiveTvRung(rungId) : undefined;
        if (rungId && (!appliedRung || (cap && rungId !== cap.rung.id))) {
            await this.refuseAfterJoin(channelId, viewerId, 'internal', result.existingViewer);
        }

        // Only an uncapped answer can carry a variant; ignore one on anything else rather
        // than hand out a URL the proxy did not set up.
        const variant =
            !result.adaptive && !rungId && (result.variant === 'fmp4' || result.variant === 'h264')
                ? result.variant
                : undefined;

        // A start counts as successful only when the proxy said the first segment exists. An
        // older proxy (no `ready`) never proves it. The serving feed is the one the proxy names
        // (feedId, else the index into the URLs sent); without a report it is the requested feed.
        if (options?.awaitReady && (result as { ready?: unknown }).ready === true) {
            const served = result as { feedId?: unknown; streamUrlIndex?: unknown };
            const byId =
                typeof served.feedId === 'string'
                    ? sentFeeds.find((f) => f.id === served.feedId)
                    : undefined;
            const byIndex =
                typeof served.streamUrlIndex === 'number' && Number.isInteger(served.streamUrlIndex)
                    ? sentFeeds[served.streamUrlIndex]
                    : undefined;
            await recordStartSuccess(sql, (byId ?? byIndex)?.id ?? channelId);
        }

        return {
            streamUrl: result.adaptive
                ? `/api/livetv/channels/${channelId}/stream/a/master.m3u8`
                : rungId
                  ? `/api/livetv/channels/${channelId}/stream/r/${rungId}/master.m3u8`
                  : variant
                    ? `/api/livetv/channels/${channelId}/stream/v/${variant}/master.m3u8`
                    : `/api/livetv/channels/${channelId}/stream/master.m3u8`,
            requiresProxy: true,
            sourceId: channel.source_id ?? undefined,
            maxStreams: channel.max_streams ?? undefined,
            rungId,
            requestedMaxBitrateBps: cap?.requestedMaxBitrate ?? null,
            appliedMaxBitrateBps: hasCapResponse ? result.appliedMaxBitrate : null,
            appliedMaxHeight: appliedRung?.height ?? null,
            reason: hasCapResponse ? result.reason : null,
            adaptive: result.adaptive
                ? {
                      ...result.adaptive,
                      rungs: result.adaptive.rungs.map(({ maxBitrate, ...rung }) => ({
                          ...rung,
                          maxBitrateBps: maxBitrate,
                      })),
                  }
                : undefined,
            ...(variant ? { variant } : {}),
        };
    }

    async getCategories(): Promise<LiveTvCategory[]> {
        if (
            this.categoryCache &&
            Date.now() - this.categoryCache.fetchedAt < CHANNEL_CACHE_TTL_MS
        ) {
            return this.categoryCache.categories;
        }

        const gen = this.cacheGeneration;
        const sql = getSql();
        const rows = await getVisibleCategories(sql);
        const categories = rows.map((row) => ({
            id: row.id,
            name: row.name,
            sortOrder: row.sort_order,
            isVisible: row.is_visible,
            channelCount: row.channel_count,
        }));

        if (gen === this.cacheGeneration) {
            this.categoryCache = { categories, fetchedAt: Date.now() };
        }
        return categories;
    }

    /**
     * Clear this node's in-memory channel/category/guide caches.
     *
     * Called by invalidateLiveTvCaches() after any admin mutation that changes the
     * channel lineup or category set (rename/reorder/hide/add/merge). Without it, the
     * node that processed the mutation keeps serving its memoized channels (<=30s),
     * categories (<=30s) and guide (<=60s) from these private fields — which the
     * browseChannels Valkey clear never touches — until each field's TTL lapses.
     *
     * These caches are per-node; the Valkey layers cleared alongside this propagate
     * cluster-wide, and every other node's in-memory copy self-heals within its TTL.
     */
    bustCaches(): void {
        // Invalidate any in-flight getChannels/getCategories write-back (see cacheGeneration).
        this.cacheGeneration++;
        this.channelCache = null;
        this.categoryCache = null;
        this.guideCache.clear();
    }
}
