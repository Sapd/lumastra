// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiProblem } from '$lib/server/api/problem.js';
import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { streamRowToJellyfin } from '$lib/server/jellyfin-compat/serializers/base-item';
import type {
    JellyfinPlaybackInfoResponse,
    JellyfinMediaSourceInfo,
    JellyfinMediaStream,
} from '$lib/server/jellyfin-compat/types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { playTokenMintedByAdmin } from '$lib/server/jellyfin-compat/play-token-user';
import { hasLiveTvPermission } from '$lib/server/jellyfin-compat/utils';
import { getMediaItemById } from '$lib/server/database/queries/catalog-operations.queries';
import {
    getFilesForMediaItem,
    getOwnerItemForFile,
} from '$lib/server/database/queries/media-files.queries';
import { fileRunTimeTicks, partLayout } from '$lib/server/jellyfin-compat/multi-part';
import {
    getStreamsForMediaItem,
    getStreamsForFile,
} from '$lib/server/database/queries/media-streams.queries';
import { getExternalSubtitlesForFile } from '$lib/server/database/queries/external-subtitles.queries';
import {
    externalSubtitleStreamIndex,
    pairExternalStreamRowsWithSidecars,
} from '$lib/server/utils/external-subtitle-index';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import {
    deriveLiveTvViewerKey,
    liveTvCredentialFingerprint,
} from '$lib/server/services/livetv/livetv-viewer-key.js';
import { deviceProfiles } from '$lib/server/services/transcoding/device-profiles.js';
import type {
    JellyfinDeviceProfile,
    DeviceProfile,
} from '$lib/server/services/transcoding/types.js';
import {
    containerFromPath,
    isAudioContainer,
    deriveQualityLabel,
} from '$lib/server/jellyfin-compat/media-container-utils';
import {
    checkCompatibility,
    mediaInfoFromStreamRows,
    deviceCapsFromProfile,
} from '$lib/server/utils/media-compatibility.js';
import { getJfToken, getParam } from '$lib/server/jellyfin-compat/utils';
import { armSilentStart } from '$lib/server/jellyfin-compat/silent-start';
import { config } from '$lib/server/config';
import { MAX_MAX_AUDIO_CHANNELS } from '$lib/server/services/transcoding/quality-cap';
import {
    allowsDirectPlay,
    resolveDeliverableSubtitle,
    type SubtitleDeliveryContext,
} from '$lib/server/jellyfin-compat/subtitle-delivery';
import {
    issuePlayToken,
    issueFileToken,
    validatePlayToken,
    revokePlayTokenBySession,
} from '$lib/server/jellyfin-compat/play-token';
import { StreamLimitError } from '$lib/server/services/livetv/standalone-livetv-provider.js';
import {
    buildStreamLimitPlaybackInfo,
    freshPlaySessionId,
    noticeLanguage,
    rateLimitedPlaybackInfo,
} from '$lib/server/jellyfin-compat/stream-limit-notice';
import { isAudio, isAudiobook } from '$lib/server/utils/media-types';
import {
    parseProgressiveRequest,
    planProgressiveTranscode,
} from '$lib/server/jellyfin-compat/progressive-transcode';
import { mediaAttachmentsForSource } from '$lib/server/jellyfin-compat/video-attachments';

// DeviceProfiles run to tens of KB; 1 MiB leaves ample room.
const MAX_PLAYBACK_INFO_BODY_BYTES = 1024 * 1024;

const logger = Logger.for('JellyfinCompat:PlaybackInfo');

/**
 * The viewer key the live.m3u8 / segment routes will derive from this play
 * token. Joining under the same key here means one client is ONE proxy viewer:
 * the join that PlaybackInfo does to surface stream-limit / source errors
 * early is the very viewer the playlist polls keep alive, instead of a phantom
 * keyed by bare username that nothing heartbeats and that the orphan sweep
 * reaps 30 s later.
 */
function liveTvViewerForToken(event: RequestEvent, streamToken: string): string {
    event.locals.liveTvCredentialId = liveTvCredentialFingerprint('jf-play', streamToken);
    return deriveLiveTvViewerKey(event);
}

/**
 * Join the channel for a Live TV tune, or explain the refusal in a way every
 * Jellyfin client can show.
 *
 * A source's concurrent-stream cap is an ordinary, expected outcome, such as a
 * two-stream IPTV package. It used to reach the handler's generic catch and come back
 * as HTTP 500, so jellyfin-androidtv showed "This item cannot be played", which
 * reads as a broken server. The client now gets a short clip saying the TV
 * provider's streams are all in use (see stream-limit-notice.ts); clients play it
 * like any video, where Jellyfin's own `ErrorCode` refusal only reaches the few apps that render it.
 * If the clip cannot be produced, the answer falls back to that refusal — a 200
 * carrying `RateLimitExceeded`, which the SDK turns into a PlaybackException.
 *
 * Returns null when the tune succeeded.
 */
async function refuseLiveTvTuneIfCapped(
    provider: { getStreamInfo: (channelId: string, viewerId: string) => Promise<unknown> },
    channelId: string,
    viewerId: string,
    playSessionId: string,
    notice: { userId: string | undefined; request: Request },
): Promise<Response | null> {
    try {
        await provider.getStreamInfo(channelId, viewerId);
        return null;
    } catch (err) {
        if (!(err instanceof StreamLimitError)) throw err;
        logger.info('Live TV tune refused — source stream limit reached', {
            channelId,
            limit: err.limit,
            active: err.activeChannels.length,
        });
        // The token was issued before the join because the viewer key is derived
        // from it. Nothing will use it now, so do not leave it usable.
        await revokePlayTokenBySession(playSessionId);
        const clip =
            notice.userId && err.limit > 0
                ? await buildStreamLimitPlaybackInfo({
                      kind: 'livetv_source',
                      userId: notice.userId,
                      cap: err.limit,
                      lang: noticeLanguage(notice.request),
                      itemId: channelId,
                  })
                : null;
        return json(clip ?? rateLimitedPlaybackInfo(playSessionId));
    }
}

interface PlaybackInfoRequestBody {
    DeviceProfile?: JellyfinDeviceProfile;
    MaxStreamingBitrate?: number;
    AutoOpenLiveStream?: boolean;
    EnableDirectPlay?: boolean;
    EnableDirectStream?: boolean;
    EnableTranscoding?: boolean;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
    MaxAudioChannels?: number;
    MediaSourceId?: string;
    PlaySessionId?: string;
    StartTimeTicks?: number;
}

/** A strict decimal integer (`-1`, `2`), else undefined — no `0x10`, `1e3` or `2abc`. */
function strictInt(raw: unknown): number | undefined {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined;
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return undefined;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : undefined;
}

const NUMERIC_OPTIONS = [
    'MaxStreamingBitrate',
    'StartTimeTicks',
    'AudioStreamIndex',
    'SubtitleStreamIndex',
    'MaxAudioChannels',
] as const;

/**
 * Jellyfin's MediaInfoController takes the playback options as query params AND
 * as body fields, and the query wins (`audioStreamIndex ??= dto.AudioStreamIndex`).
 * jellyfin-web and the SDKs send the track selection in the QUERY — reading only
 * the body dropped the chosen audio/subtitle track on the floor.
 */
function withQueryOptions(
    url: URL,
    body: PlaybackInfoRequestBody | undefined,
): PlaybackInfoRequestBody {
    const merged: PlaybackInfoRequestBody = { ...body };
    for (const key of NUMERIC_OPTIONS) {
        // A body value that is not an integer (null, "2") counts as absent, so it
        // can never reach the TranscodingUrl as `AudioStreamIndex=null`.
        merged[key] = strictInt(getParam(url, key)) ?? strictInt(body?.[key]);
    }
    for (const key of ['EnableDirectPlay', 'EnableDirectStream', 'EnableTranscoding'] as const) {
        const value = getParam(url, key)?.toLowerCase();
        if (value === 'true' || value === 'false') merged[key] = value === 'true';
    }
    merged.MediaSourceId = getParam(url, 'MediaSourceId') || body?.MediaSourceId;
    return merged;
}

/** File extension for a sidecar subtitle URL — the profile format, as Jellyfin builds it. */
function subtitleUrlExtension(format: string): string {
    const ext = format.trim().toLowerCase();
    return /^[a-z0-9_]+$/.test(ext) ? ext : 'vtt';
}

/** A positive channel count from a profile's string field (`"2"`), else undefined. */
function parseChannels(raw: string | number | undefined | null): number | undefined {
    const n = strictInt(raw);
    return n !== undefined && n > 0 ? n : undefined;
}

/**
 * Build a DeviceProfile from a client-sent JellyfinDeviceProfile.
 */
function buildDeviceProfile(clientProfile: JellyfinDeviceProfile): DeviceProfile {
    return {
        ...clientProfile,
        id: 'client-provided',
        supportsHdr: detectHdrFromProfile(clientProfile),
        supportsDolbyVision: false,
        supportsAtmos: false,
        preferredContainer: 'ts',
    };
}

function detectHdrFromProfile(profile: JellyfinDeviceProfile): boolean {
    if (!profile.CodecProfiles) return false;
    for (const cp of profile.CodecProfiles) {
        if (!cp.Conditions) continue;
        for (const cond of cp.Conditions) {
            if (cond.Property === 'VideoRangeType' && cond.Value) {
                const ranges = cond.Value.split('|').map((r) => r.trim());
                if (ranges.some((r) => r.includes('HDR') || r.includes('HLG'))) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Evaluate whether media can be direct-played given a device profile.
 * Returns playback capability flags based on codec/container compatibility.
 */
function evaluatePlaybackCapabilities(
    streamRows: MediaStreamRow[],
    container: string,
    profile: DeviceProfile,
    maxBitrate?: number,
    totalBitrate?: number | null,
    audioStream?: MediaStreamRow,
    isAudioOnly = false,
    maxAudioChannels?: number,
): { supportsDirectPlay: boolean; supportsDirectStream: boolean; remuxParams?: URLSearchParams } {
    // Imported/legacy rows can include album art as Video, without an attached_pic
    // column. Native ffprobe excludes attached_pic before mapping to these rows.
    const videoStream = isAudioOnly ? undefined : streamRows.find((s) => s.stream_type === 'video');

    const videoCodec = videoStream?.codec ?? undefined;
    const audioCodec = audioStream?.codec ?? undefined;

    // Check full direct play (container + codecs)
    const typedProfile = {
        ...profile,
        DirectPlayProfiles:
            profile.DirectPlayProfiles?.filter(
                (dp) => dp.Type === (isAudioOnly || !videoStream ? 'Audio' : 'Video'),
            ) ?? [],
    };
    const canDirectPlay = deviceProfiles.canDirectPlay(
        typedProfile,
        container,
        videoCodec,
        audioCodec,
    );

    // Check codec conditions (profile, level, HDR range, etc.)
    let conditionsPass = true;
    if (videoStream?.codec) {
        const properties: Record<string, string | number | boolean> = {};
        if (videoStream.profile) properties['VideoProfile'] = videoStream.profile;
        if (videoStream.level !== undefined && videoStream.level !== null) {
            properties['VideoLevel'] = videoStream.level;
        }
        if (videoStream.video_range_type) {
            properties['VideoRangeType'] = videoStream.video_range_type;
        }

        const { pass } = deviceProfiles.checkCodecConditions(
            profile,
            videoStream.codec,
            properties,
            container,
        );
        conditionsPass = pass;
    }

    // Check bitrate limit
    let bitrateOk = true;
    if (maxBitrate && totalBitrate && totalBitrate > maxBitrate) {
        bitrateOk = false;
    }

    const supportsDirectPlay = canDirectPlay && conditionsPass && bitrateOk;

    // A direct stream is a copy-only container change through the existing
    // progressive route. Never advertise it if that route is disabled, a codec
    // condition fails, or the planner would actually need an encoder.
    if (
        !supportsDirectPlay &&
        videoStream?.codec &&
        bitrateOk &&
        config.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT > 0
    ) {
        for (const dp of typedProfile.DirectPlayProfiles) {
            for (const target of dp.Container.split(',').map((c) => c.trim().toLowerCase())) {
                if (
                    !deviceProfiles.canDirectPlay(
                        { ...typedProfile, DirectPlayProfiles: [dp] },
                        target,
                        videoCodec,
                        audioCodec,
                    )
                )
                    continue;
                const properties: Record<string, string | number | boolean> = {};
                if (videoStream.profile) properties.VideoProfile = videoStream.profile;
                if (videoStream.level != null) properties.VideoLevel = videoStream.level;
                if (videoStream.video_range_type)
                    properties.VideoRangeType = videoStream.video_range_type;
                if (
                    !deviceProfiles.checkCodecConditions(
                        profile,
                        videoStream.codec,
                        properties,
                        target,
                    ).pass
                )
                    continue;
                const params = new URLSearchParams({
                    static: 'false',
                    container: target,
                    videoCodec: videoStream.codec,
                });
                if (audioStream?.codec) params.set('audioCodec', audioStream.codec);
                if (audioStream) params.set('AudioStreamIndex', String(audioStream.stream_index));
                if (maxAudioChannels) params.set('audioChannels', String(maxAudioChannels));
                const request = parseProgressiveRequest(params);
                if (!request) continue;
                const plan = planProgressiveTranscode(request, {
                    container,
                    video: {
                        codec: videoStream.codec,
                        width: videoStream.width ?? null,
                        height: videoStream.height ?? null,
                        bitrate: videoStream.bitrate ?? null,
                        isHdr:
                            !!videoStream.video_range_type &&
                            videoStream.video_range_type !== 'SDR',
                    },
                    audio: streamRows
                        .filter((s) => s.stream_type === 'audio' && s.codec)
                        .map((s) => ({
                            index: s.stream_index,
                            codec: s.codec,
                            channels: s.channels ?? null,
                            isDefault: s.is_default,
                        })),
                });
                if (
                    plan.kind === 'transcode' &&
                    plan.video?.mode === 'copy' &&
                    (!audioStream || plan.audio?.mode === 'copy')
                ) {
                    return {
                        supportsDirectPlay: false,
                        supportsDirectStream: true,
                        remuxParams: params,
                    };
                }
            }
        }
    }
    return { supportsDirectPlay, supportsDirectStream: supportsDirectPlay };
}

/**
 * Arm the silent-start detector for a real-media answer: only on a POST that
 * carried a DeviceProfile from a /j session login with a known device, and only
 * while client diagnostics are on (its incidents are client_diagnostics rows).
 * Fire and forget; armSilentStart never throws.
 */
function armDetector(
    event: RequestEvent,
    requestBody: PlaybackInfoRequestBody | undefined,
    playSessionId: string,
    itemId: string,
    response: JellyfinPlaybackInfoResponse,
): void {
    if (!config.FEATURE_CLIENT_DIAGNOSTICS) return;
    const device = event.locals.jfDevice;
    const user = event.locals.user;
    if (
        event.request.method !== 'POST' ||
        !requestBody?.DeviceProfile ||
        !device?.deviceId ||
        !user ||
        event.locals.authMethod !== 'jellyfin_compat_session'
    ) {
        return;
    }
    void armSilentStart({
        playSessionId,
        userId: user.userId,
        username: user.username,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        clientName: device.clientName ?? 'unknown',
        clientVersion: device.clientVersion,
        itemId,
        response,
    });
}

async function handlePlaybackInfo(event: RequestEvent): Promise<Response> {
    const { params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId || !isUuid(itemId)) {
        return ApiResponses.badRequest('Item ID is required');
    }

    // Get auth token for stream URLs (VLC/embedded players need api_key in URL)
    const apiKey = getJfToken(event.locals as unknown as Record<string, unknown>);
    const clientName =
        ((event.locals as unknown as Record<string, unknown>).jfClientName as string) ?? '';
    // Browser MKV playback is not reliable for the captured jellyfin-web
    // profile, which advertises MKV even when the raw resource cannot play.
    // Prefer HLS for that client/container pair; native MKV profiles stay intact.
    const isJellyfinWeb = clientName.toLowerCase().includes('jellyfin web');

    // Parse POST body if present (GET requests have no body)
    let requestBody: PlaybackInfoRequestBody | undefined;
    if (event.request.method === 'POST') {
        try {
            requestBody = (await readBoundedJson(
                event.request,
                MAX_PLAYBACK_INFO_BODY_BYTES,
            )) as PlaybackInfoRequestBody;
        } catch {
            // Invalid JSON or empty body — fall through with no profile
        }
    }
    requestBody = withQueryOptions(event.url, requestBody);

    try {
        // Android TV may call POST /Items/{MediaSource.Id}/PlaybackInfo when the
        // user selects a specific version. MediaSource.Id in our responses is a
        // media_files UUID, not a media_items UUID. Resolve file → owning item,
        // and treat the fileId as the requested source so the version is respected.
        const ownerItemId = await getOwnerItemForFile(sql, itemId);
        const resolvedItemId = ownerItemId ?? itemId;
        const impliedFileId = ownerItemId ? itemId : undefined;

        const mediaItem = await getMediaItemById(sql, resolvedItemId);
        if (!mediaItem) {
            // Live TV channel fallback — channels share UUIDs between
            // livetv_channels and media_items but may not be accessible via
            // getMediaItemById when media_items.status is not 'active'.
            const provider = await getLiveTvProvider();
            const tvChannel = await provider.getChannel(resolvedItemId);
            if (tvChannel) {
                if (!config.FEATURE_LIVETV || !hasLiveTvPermission(event.locals.user)) {
                    return ApiProblem.notFound();
                }
                // The /api stream endpoints' channel access rule, before a token is issued.
                if (!(await canStreamLiveTvChannel(event.locals, resolvedItemId))) {
                    return ApiResponses.notFound('Item not found');
                }
                const playSessionId = await freshPlaySessionId(requestBody?.PlaySessionId);
                const streamToken = await issuePlayToken(
                    itemId,
                    event.locals.user.username,
                    playSessionId,
                    null,
                );
                const refusal = await refuseLiveTvTuneIfCapped(
                    provider,
                    itemId,
                    liveTvViewerForToken(event, streamToken),
                    playSessionId,
                    { userId: event.locals.user?.userId, request: event.request },
                );
                if (refusal) return refusal;
                return json({
                    PlaySessionId: playSessionId,
                    MediaSources: [
                        {
                            Id: itemId,
                            Container: 'mpegts',
                            Protocol: 'Http',
                            Type: 'Default',
                            IsLiveTv: true,
                            IsRemote: false,
                            ReadAtNativeFramerate: false,
                            IgnoreDts: false,
                            IgnoreIndex: false,
                            GenPtsInput: false,
                            IsInfiniteStream: true,
                            RequiresOpening: false,
                            RequiresClosing: false,
                            RequiresLooping: false,
                            SupportsProbing: false,
                            HasSegments: false,
                            SupportsDirectPlay: false,
                            SupportsDirectStream: false,
                            SupportsTranscoding: true,
                            TranscodingUrl: `/Videos/${itemId}/live.m3u8?api_key=${streamToken}`,
                            TranscodingContainer: 'ts',
                            TranscodingSubProtocol: 'hls',
                            MediaStreams: [],
                        },
                    ],
                } satisfies JellyfinPlaybackInfoResponse);
            }
            return ApiResponses.notFound('Media item not found');
        }

        // Library access + age gate
        const allowed = await checkMediaAccess(sql, resolvedItemId, event.locals.user);
        if (!allowed) {
            return ApiResponses.notFound('Media item not found');
        }

        // LiveTV branch: tvchannel items use live HLS streaming
        if ((mediaItem.media_type as string) === 'tvchannel') {
            if (!config.FEATURE_LIVETV || !hasLiveTvPermission(event.locals.user)) {
                return ApiProblem.notFound();
            }
            // The /api stream endpoints' channel access rule, before a token is issued.
            if (!isUuid(itemId) || !(await canStreamLiveTvChannel(event.locals, itemId))) {
                return ApiResponses.notFound('Item not found');
            }

            const provider = await getLiveTvProvider();
            const playSessionId = await freshPlaySessionId(requestBody?.PlaySessionId);
            const streamToken = await issuePlayToken(
                itemId,
                event.locals.user.username,
                playSessionId,
                null,
            );
            const refusal = await refuseLiveTvTuneIfCapped(
                provider,
                itemId,
                liveTvViewerForToken(event, streamToken),
                playSessionId,
                { userId: event.locals.user?.userId, request: event.request },
            );
            if (refusal) return refusal;
            const response: JellyfinPlaybackInfoResponse = {
                PlaySessionId: playSessionId,
                MediaSources: [
                    {
                        Id: itemId,
                        Container: 'mpegts',
                        Protocol: 'Http',
                        Type: 'Default',
                        IsLiveTv: true,
                        IsRemote: false,
                        ReadAtNativeFramerate: false,
                        IgnoreDts: false,
                        IgnoreIndex: false,
                        GenPtsInput: false,
                        IsInfiniteStream: true,
                        RequiresOpening: false,
                        RequiresClosing: false,
                        RequiresLooping: false,
                        SupportsProbing: false,
                        HasSegments: false,
                        SupportsDirectPlay: false,
                        SupportsDirectStream: false,
                        SupportsTranscoding: true,
                        TranscodingUrl: `/Videos/${itemId}/live.m3u8?api_key=${streamToken}`,
                        TranscodingContainer: 'ts',
                        TranscodingSubProtocol: 'hls',
                        MediaStreams: [],
                    },
                ],
            };

            armDetector(event, requestBody, playSessionId, resolvedItemId, response);
            return json(response);
        }

        // Collect all playable files for this item
        interface FileSpec {
            fileId: string;
            filePath: string;
            fileSizeBytes: number | null;
            totalBitrate: number | null;
            ownerItemId: string;
            /** Set for a part of a multi-part movie: that file's own length. */
            partRunTimeTicks?: number;
        }

        // Determine the requested source. MediaSourceId may be:
        //   - a file token (from a previous PlaybackInfo response) → decode via validatePlayToken
        //   - a raw fileId (from the item detail MediaSource.Id)
        //   - impliedFileId (when the route was called with a fileId as itemId)
        const requestedSourceId = requestBody?.MediaSourceId ?? impliedFileId;
        const requestedFileId = requestedSourceId
            ? ((await validatePlayToken(requestedSourceId))?.fileId ?? requestedSourceId)
            : undefined;

        // A multi-part movie plays part 1 as the item and parts 2..N as items of
        // their own (file id as item id), each a single source (multi-part.ts).
        // A part 2..N named as MediaSourceId on the movie (an item cached from
        // before parts were split off) plays that part the same way.
        const layout = partLayout(await getFilesForMediaItem(sql, resolvedItemId));
        const partIndex = requestedFileId ? layout.partIndex(requestedFileId) : -1;
        const playable =
            partIndex > 0 ? [layout.stackOf(requestedFileId!)![partIndex]] : layout.sources;
        const fileSpecs: FileSpec[] = playable.map((f) => ({
            fileId: f.id,
            filePath: f.file_path,
            fileSizeBytes: f.file_size_bytes ? Number(f.file_size_bytes) : null,
            totalBitrate: f.total_bitrate ? Number(f.total_bitrate) : null,
            ownerItemId: resolvedItemId,
            partRunTimeTicks: layout.partIndex(f.id) >= 0 ? fileRunTimeTicks(f) : undefined,
        }));

        const playSessionId = await freshPlaySessionId(requestBody?.PlaySessionId);

        const userId = event.locals.user?.username ?? '';
        // The admin capability checkMediaAccess just decided with; the stream
        // routes honour it, so an admin can stream what they could open here.
        const mintedByAdmin = playTokenMintedByAdmin(event.locals.user);
        // Issue the play-session token (TTL recorded server-side, not returned
        // here — clients use `mediaSourceId` as the play credential).
        await issuePlayToken(resolvedItemId, userId, playSessionId, mediaItem.runtime_seconds, {
            mintedByAdmin,
        });

        if (requestedFileId && fileSpecs.length > 1) {
            const idx = fileSpecs.findIndex((s) => s.fileId === requestedFileId);
            if (idx > 0) {
                const [selected] = fileSpecs.splice(idx, 1);
                fileSpecs.unshift(selected);
            }
        }

        // Evaluate device profile once for capability flags
        let clientProfile: ReturnType<typeof buildDeviceProfile> | undefined;
        let maxStreamingBitrate: number | undefined;

        if (requestBody?.DeviceProfile) {
            clientProfile = buildDeviceProfile(requestBody.DeviceProfile);
            maxStreamingBitrate =
                requestBody.MaxStreamingBitrate ?? clientProfile.MaxStreamingBitrate ?? undefined;
        }

        // Build one MediaSource per file spec
        const mediaSources: JellyfinMediaSourceInfo[] = [];
        // One attachment listing per source (index-aligned with mediaSources),
        // run in parallel and awaited after the loop: a cold ffprobe must not
        // hold up the other versions of a multi-version item.
        const attachmentLists: Array<Promise<JellyfinMediaSourceInfo['MediaAttachments']>> = [];

        for (const spec of fileSpecs) {
            const streamRows = await getStreamsForFile(sql, spec.fileId);
            const resolvedStreams =
                streamRows.length > 0
                    ? streamRows
                    : await getStreamsForMediaItem(sql, spec.ownerItemId);

            const mediaStreams: JellyfinMediaStream[] = resolvedStreams.map((s) =>
                streamRowToJellyfin(s, resolvedItemId, apiKey, spec.fileId),
            );

            // Append external subtitle files that aren't already in media_streams.
            // Index = 1000 + position in this file's sidecar list: the number the
            // /Subtitles route (resolveSubtitle) maps back to the file. A sidecar
            // an external media_streams row already lists (the pairing the
            // resolver serves that row from) is skipped but keeps its position.
            const externalSubs = await getExternalSubtitlesForFile(sql, spec.fileId);
            if (externalSubs.length > 0) {
                const listedByRow = new Set(
                    pairExternalStreamRowsWithSidecars(resolvedStreams, externalSubs).values(),
                );
                for (const [position, sub] of externalSubs.entries()) {
                    if (listedByRow.has(position)) continue;

                    const isText = !['sub', 'sup'].includes(sub.format.toLowerCase());
                    const langLabel = sub.language?.toUpperCase() ?? 'Unknown';
                    const formatLabel = sub.format.toUpperCase();
                    const flags = [
                        sub.is_forced ? 'Forced' : null,
                        sub.is_sdh ? 'SDH' : null,
                        'External',
                    ]
                        .filter(Boolean)
                        .join(', ');

                    const index = externalSubtitleStreamIndex(position);
                    mediaStreams.push({
                        Index: index,
                        Type: 'Subtitle',
                        Codec: sub.format,
                        Language: sub.language ?? undefined,
                        DisplayTitle: `${langLabel} (${formatLabel}, ${flags})`,
                        IsDefault: false,
                        IsForced: sub.is_forced,
                        IsHearingImpaired: sub.is_sdh,
                        IsOriginal: false,
                        IsInterlaced: false,
                        VideoRange: 'Unknown',
                        VideoRangeType: 'Unknown',
                        IsExternal: true,
                        IsTextSubtitleStream: isText,
                        SupportsExternalStream: isText,
                        DeliveryMethod: 'External',
                        DeliveryUrl: `/Videos/${resolvedItemId}/${spec.fileId}/Subtitles/${index}/0/Stream.vtt?api_key=${apiKey}`,
                    });
                }
            }

            const defaultSubtitle = resolvedStreams.find(
                (s) => s.stream_type === 'subtitle' && s.is_default,
            );

            const container = containerFromPath(spec.filePath);
            const eTag = spec.fileId.slice(0, 8);

            // Audio-only containers (FLAC, MP3, AAC, …) sometimes embed album art as
            // a mjpeg/png "video" stream — never treat that as video.
            const isAudioOnly =
                isAudioContainer(container) ||
                isAudio(mediaItem.media_type) ||
                isAudiobook(mediaItem.media_type);

            // Track selection as Jellyfin's StreamBuilder makes it: the requested
            // index when it names a stream of that type, else the file's default.
            const defaultAudio =
                resolvedStreams.find((s) => s.stream_type === 'audio' && s.is_default) ??
                resolvedStreams.find((s) => s.stream_type === 'audio');
            const requestedAudioIndex = requestBody?.AudioStreamIndex;
            const selectedAudio =
                (requestedAudioIndex !== undefined
                    ? resolvedStreams.find(
                          (s) =>
                              s.stream_type === 'audio' && s.stream_index === requestedAudioIndex,
                      )
                    : undefined) ?? defaultAudio;
            // -1 is "subtitles off" and is passed through as such.
            const selectedSubtitleIndex =
                requestBody?.SubtitleStreamIndex ?? defaultSubtitle?.stream_index;
            const selectedSubtitle =
                selectedSubtitleIndex !== undefined && selectedSubtitleIndex >= 0
                    ? mediaStreams.find(
                          (s) => s.Type === 'Subtitle' && s.Index === selectedSubtitleIndex,
                      )
                    : undefined;
            // Without subtitle profiles there is nothing to decide against; such
            // clients keep the serializer's delivery methods and a pass-through
            // SubtitleStreamIndex.
            const subtitleProfiles = clientProfile?.SubtitleProfiles?.length
                ? clientProfile.SubtitleProfiles
                : undefined;
            // What the TranscodingUrl produces: MPEG-TS over HLS, which cannot
            // carry a subtitle stream (Jellyfin's IsSubtitleEmbedSupported).
            const transcodeSubtitleContext: SubtitleDeliveryContext = {
                playMethod: 'Transcode',
                outputContainer: 'ts',
                subProtocol: 'hls',
            };

            let remuxParams: URLSearchParams | undefined;
            let supportsDirectPlay = true;
            let supportsDirectStream = true;
            const supportsTranscoding = requestBody?.EnableTranscoding !== false;

            if (clientProfile) {
                try {
                    const capabilities = evaluatePlaybackCapabilities(
                        resolvedStreams,
                        container,
                        clientProfile,
                        maxStreamingBitrate,
                        spec.totalBitrate,
                        selectedAudio,
                        isAudioOnly,
                        requestBody?.MaxAudioChannels,
                    );
                    supportsDirectPlay = capabilities.supportsDirectPlay;
                    supportsDirectStream = capabilities.supportsDirectStream;
                    remuxParams = capabilities.remuxParams;
                } catch (profileErr) {
                    logger.warn('Device profile evaluation failed, using HLS', {
                        error: String(profileErr),
                        stack: profileErr instanceof Error ? profileErr.stack : undefined,
                    });
                    supportsDirectPlay = false;
                    supportsDirectStream = false;
                }

                // A selected subtitle the client can neither read from the file
                // nor fetch as a sidecar has to be burned in, which rules out
                // direct play (Jellyfin: TranscodeReason.SubtitleCodecNotSupported)
                // — but only one our engine can burn in (embedded bitmap); for
                // anything else see resolveDeliverableSubtitle.
                if (selectedSubtitle && subtitleProfiles) {
                    const direct = resolveDeliverableSubtitle(selectedSubtitle, subtitleProfiles, {
                        playMethod: 'DirectPlay',
                        outputContainer: container,
                    });
                    if (direct && !allowsDirectPlay(direct.method)) {
                        supportsDirectPlay = false;
                        supportsDirectStream = false;
                    }
                    if (remuxParams && supportsDirectStream) {
                        // Progressive remux maps only video/audio (-sn). Like TS
                        // HLS, it must deliver subtitles externally or burn them in.
                        const remuxSubtitle = resolveDeliverableSubtitle(
                            selectedSubtitle,
                            subtitleProfiles,
                            transcodeSubtitleContext,
                        );
                        if (!remuxSubtitle || !['External', 'Drop'].includes(remuxSubtitle.method))
                            supportsDirectStream = false;
                    }
                }

                logger.debug('Playback capability evaluation', {
                    itemId,
                    fileId: spec.fileId,
                    container,
                    videoCodec: resolvedStreams.find((s) => s.stream_type === 'video')?.codec,
                    audioCodec: resolvedStreams.find((s) => s.stream_type === 'audio')?.codec,
                    supportsDirectPlay,
                    supportsDirectStream,
                    maxStreamingBitrate,
                    profileName: clientProfile.Name,
                });
            }

            if (requestBody?.EnableDirectPlay === false) {
                supportsDirectPlay = false;
                if (!remuxParams) supportsDirectStream = false;
            }
            // Web selects its HLS player for MKV; keep that path on the HLS master.
            if (isJellyfinWeb && ['mkv', 'matroska'].includes(container.toLowerCase())) {
                supportsDirectPlay = false;
                supportsDirectStream = false;
            }
            if (requestBody?.EnableDirectStream === false) supportsDirectStream = false;
            const useHls = !supportsDirectPlay && !supportsDirectStream && supportsTranscoding;
            if (!supportsDirectPlay && !supportsDirectStream && !useHls) continue;

            // After the existing decision is made, run shared compatibility check for observability
            try {
                const sharedMediaInfo = mediaInfoFromStreamRows(
                    resolvedStreams,
                    container,
                    spec.totalBitrate,
                );
                const sharedCaps = requestBody?.DeviceProfile
                    ? deviceCapsFromProfile(requestBody.DeviceProfile)
                    : undefined;
                if (sharedCaps) {
                    const sharedResult = checkCompatibility(sharedMediaInfo, sharedCaps);
                    const jellyfinDecision = supportsDirectPlay
                        ? 'direct'
                        : supportsDirectStream
                          ? 'remux'
                          : 'transcode';
                    const sharedDecision = sharedResult.recommended;
                    // Only log when decisions disagree on the extremes:
                    //   direct↔non-direct  (Jellyfin says play, shared says no)
                    //   transcode↔direct    (Jellyfin says transcode, shared says direct)
                    // We intentionally ignore remux↔audio_transcode divergences since
                    // those intermediate steps are expected to differ between the two
                    // systems (Jellyfin has no "audio_transcode" concept).
                    if (
                        (jellyfinDecision === 'direct' && sharedDecision !== 'direct') ||
                        (jellyfinDecision === 'transcode' && sharedDecision === 'direct')
                    ) {
                        logger.warn('Jellyfin/shared compatibility decision mismatch', {
                            itemId,
                            jellyfinDecision,
                            sharedDecision,
                            videoCodec: sharedMediaInfo.videoCodec,
                            container: sharedMediaInfo.container,
                            audioCodecs: sharedMediaInfo.audioCodecs,
                        });
                    }
                }
            } catch {
                // Non-critical observability — never block the response
            }

            const transcodingParams = new URLSearchParams({
                PlaySessionId: playSessionId,
                MediaSourceId: spec.fileId,
            });
            if (maxStreamingBitrate) {
                transcodingParams.set('MaxStreamingBitrate', String(maxStreamingBitrate));
            }
            // Pass start position from client (audio switch, resume)
            if (requestBody?.StartTimeTicks !== undefined && requestBody.StartTimeTicks > 0) {
                transcodingParams.set('StartTimeTicks', String(requestBody.StartTimeTicks));
            }
            // Our master produces TS, so prefer the client's TS HLS profile
            // over an fMP4-only codec list (the Web profile offers AV1 there).
            // The client's HLS transcoding profile — its codecs (when transcoding)
            // and its channel cap (always) go into the TranscodingUrl.
            const transProfile = clientProfile
                ? isAudioOnly
                    ? (clientProfile.TranscodingProfiles?.find(
                          (tp) => tp.Type === 'Audio' && tp.Protocol?.toLowerCase() === 'hls',
                      ) ??
                      clientProfile.TranscodingProfiles?.find(
                          (tp) => tp.Protocol?.toLowerCase() === 'hls',
                      ))
                    : (clientProfile.TranscodingProfiles?.find(
                          (tp) =>
                              tp.Type === 'Video' &&
                              tp.Protocol?.toLowerCase() === 'hls' &&
                              ['ts', 'mpegts'].includes(tp.Container.toLowerCase()),
                      ) ??
                      clientProfile.TranscodingProfiles?.find(
                          (tp) => tp.Type === 'Video' && tp.Protocol?.toLowerCase() === 'hls',
                      ))
                : undefined;

            // Audio track: Jellyfin's StreamInfo.ToUrl always names the track the
            // transcode maps, so the URL and DefaultAudioStreamIndex agree.
            if (!isAudioOnly && selectedAudio) {
                transcodingParams.set('AudioStreamIndex', String(selectedAudio.stream_index));
            } else if (requestedAudioIndex !== undefined && requestedAudioIndex >= 0) {
                transcodingParams.set('AudioStreamIndex', String(requestedAudioIndex));
            }

            // Subtitle: only a track that is not delivered as a sidecar goes into
            // the URL, with its method — `Encode` is what makes the HLS side burn
            // it in (StreamInfo.ToUrl: SubtitleStreamIndex + SubtitleMethod).
            if (subtitleProfiles) {
                if (selectedSubtitle) {
                    const delivery = resolveDeliverableSubtitle(
                        selectedSubtitle,
                        subtitleProfiles,
                        transcodeSubtitleContext,
                    );
                    if (delivery && delivery.method !== 'External') {
                        transcodingParams.set(
                            'SubtitleStreamIndex',
                            String(selectedSubtitle.Index),
                        );
                        transcodingParams.set('SubtitleMethod', delivery.method);
                    }
                }
            } else if (requestBody?.SubtitleStreamIndex !== undefined) {
                transcodingParams.set(
                    'SubtitleStreamIndex',
                    String(requestBody.SubtitleStreamIndex),
                );
            }

            // Channel cap: the transcoding profile's MaxAudioChannels (Jellyfin's
            // TranscodingMaxAudioChannels), tightened by a request MaxAudioChannels.
            const channelCaps = [
                parseChannels(transProfile?.MaxAudioChannels),
                parseChannels(requestBody?.MaxAudioChannels),
            ].filter((c): c is number => c !== undefined);
            if (channelCaps.length > 0) {
                channelCaps.push(MAX_MAX_AUDIO_CHANNELS);
                transcodingParams.set(
                    'TranscodingMaxAudioChannels',
                    String(Math.min(...channelCaps)),
                );
            }

            // Determine target codecs:
            // If direct play is supported, codec = source codec (copy)
            // If transcoding needed, use the first compatible codec from the device profile
            //
            // Never set VideoCodec for audio-only items — doing so causes the HLS
            // transcoder to output video frames (the cover art), which breaks
            // Android TV's and other audio-only players.
            const videoStream = isAudioOnly
                ? undefined
                : resolvedStreams.find((s) => s.stream_type === 'video');
            const audioStream = selectedAudio;

            if (supportsDirectPlay || supportsDirectStream) {
                // Source codecs are compatible — copy them
                if (videoStream?.codec) {
                    transcodingParams.set('VideoCodec', videoStream.codec);
                }
                if (audioStream?.codec) {
                    transcodingParams.set('AudioCodec', audioStream.codec);
                }
            } else if (clientProfile) {
                // Need to transcode — target codecs from the HLS TranscodingProfile
                if (!isAudioOnly) {
                    if (transProfile?.VideoCodec) {
                        transcodingParams.set(
                            'VideoCodec',
                            transProfile.VideoCodec.split(',')[0].trim(),
                        );
                    } else {
                        transcodingParams.set('VideoCodec', 'h264');
                    }
                }
                if (transProfile?.AudioCodec) {
                    transcodingParams.set(
                        'AudioCodec',
                        transProfile.AudioCodec.split(',')[0].trim(),
                    );
                } else {
                    transcodingParams.set('AudioCodec', 'aac');
                }
            } else {
                // No device profile — safe defaults
                if (videoStream?.codec) {
                    transcodingParams.set('VideoCodec', videoStream.codec);
                }
                if (audioStream?.codec) {
                    transcodingParams.set('AudioCodec', audioStream.codec);
                }
            }

            // Per-stream subtitle delivery (Jellyfin's SetDeviceSpecificSubtitleInfo),
            // decided for the way this source will actually play.
            if (subtitleProfiles) {
                const deliveryContext: SubtitleDeliveryContext = supportsDirectPlay
                    ? { playMethod: 'DirectPlay', outputContainer: container }
                    : transcodeSubtitleContext;
                for (const stream of mediaStreams) {
                    if (stream.Type !== 'Subtitle') continue;
                    const delivery = resolveDeliverableSubtitle(
                        stream,
                        subtitleProfiles,
                        deliveryContext,
                    );
                    // Nothing this server can deliver differently: leave the
                    // track as the serializer described it.
                    if (!delivery) continue;
                    stream.DeliveryMethod = delivery.method;
                    if (delivery.method !== 'External') {
                        // Jellyfin sets a DeliveryUrl for sidecars only.
                        delete stream.DeliveryUrl;
                    } else {
                        stream.DeliveryUrl = `/Videos/${resolvedItemId}/${spec.fileId}/Subtitles/${stream.Index}/0/Stream.${subtitleUrlExtension(delivery.format)}?api_key=${apiKey}`;
                    }
                }
            }

            const qualityLabel = deriveQualityLabel(spec.filePath);

            // Per-file token used as the MediaSource.Id so ExoPlayer constructs
            // /Videos/{token}/stream — stream route validates the token in the path
            // and resolves the real itemId + fileId without needing auth headers.
            const fileToken = await issueFileToken(
                resolvedItemId,
                spec.fileId,
                userId,
                mediaItem.runtime_seconds,
                {
                    mintedByAdmin,
                    playSessionId,
                    deviceId: event.locals.jfDevice?.deviceId ?? undefined,
                },
            );

            attachmentLists.push(
                mediaAttachmentsForSource(sql, {
                    itemId: resolvedItemId,
                    fileId: spec.fileId,
                    filePath: spec.filePath,
                    container,
                    subtitleCodecs: mediaStreams
                        .filter((s) => s.Type === 'Subtitle')
                        .map((s) => s.Codec),
                    apiKey,
                }),
            );
            const directParams =
                supportsDirectStream && !supportsDirectPlay && remuxParams
                    ? new URLSearchParams(remuxParams)
                    : new URLSearchParams({ static: 'true' });
            directParams.set('mediaSourceId', spec.fileId);
            directParams.set('playSessionId', playSessionId);
            directParams.set('tag', eTag);
            directParams.set('api_key', apiKey);
            if (remuxParams && requestBody?.StartTimeTicks)
                directParams.set('StartTimeTicks', String(requestBody.StartTimeTicks));
            mediaSources.push({
                Id: fileToken,
                Container: container,
                Protocol: 'File',
                Type: 'Default',
                Name: qualityLabel,
                Path: spec.filePath,
                ETag: eTag,
                Size: spec.fileSizeBytes ?? undefined,
                Bitrate: spec.totalBitrate ?? undefined,
                RunTimeTicks: spec.partRunTimeTicks,
                IsRemote: false,
                ReadAtNativeFramerate: false,
                IgnoreDts: false,
                IgnoreIndex: false,
                GenPtsInput: false,
                IsInfiniteStream: false,
                RequiresOpening: false,
                RequiresClosing: false,
                RequiresLooping: false,
                SupportsProbing: true,
                HasSegments: false,
                SupportsDirectPlay: supportsDirectPlay,
                SupportsDirectStream: supportsDirectStream,
                SupportsTranscoding: supportsTranscoding,
                DirectStreamUrl: `/${isAudioOnly ? 'Audio' : 'Videos'}/${fileToken}/stream?${directParams}`,
                // Transport metadata describes the selected path. Some clients
                // choose their HLS player solely from TranscodingSubProtocol.
                TranscodingUrl: useHls
                    ? `/Videos/${resolvedItemId}/master.m3u8?${transcodingParams.toString()}&api_key=${apiKey}`
                    : undefined,
                TranscodingContainer: useHls ? 'ts' : undefined,
                // Required by every supported Kotlin SDK, even for direct play.
                // 'http' is the safe direct-path value; 'hls' selects an HLS player.
                TranscodingSubProtocol: useHls ? 'hls' : 'http',
                MediaStreams: mediaStreams,
                // Fonts for client-side ASS rendering (Attachments route);
                // filled in from attachmentLists after the loop.
                MediaAttachments: [],
                // The track the TranscodingUrl maps (MediaInfoHelper sets it from
                // StreamInfo.AudioStreamIndex). It was omitted in 8b133cbff3 over an
                // Android TV stop/restart loop. jellyfin-androidtv's PlaybackController
                // takes DefaultAudioStreamIndex as the current track of a transcode
                // and switches (= restarts) only when its wanted track differs —
                // with the field null it reads -1 and always restarts once. The
                // switch is stable only if the restarted transcode carries the
                // asked-for track, which needs the query AudioStreamIndex that was
                // being dropped. URL and field now always name the same track.
                DefaultAudioStreamIndex: isAudioOnly ? undefined : selectedAudio?.stream_index,
                // Only a track that exists; -1 ("off") passes through.
                DefaultSubtitleStreamIndex:
                    selectedSubtitleIndex === -1 ? -1 : selectedSubtitle?.Index,
            });
        }

        const attachments = await Promise.all(attachmentLists);
        mediaSources.forEach((source, i) => {
            source.MediaAttachments = attachments[i] ?? [];
        });

        const response: JellyfinPlaybackInfoResponse = {
            PlaySessionId: playSessionId,
            MediaSources: mediaSources,
            ...(mediaSources.length === 0 ? { ErrorCode: 'NoCompatibleStream' } : {}),
        };

        armDetector(event, requestBody, playSessionId, resolvedItemId, response);
        return json(response);
    } catch (err) {
        logger.error('Failed to get playback info', undefined, {
            itemId,
            error: String(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
        return ApiResponses.error('Failed to get playback info');
    }
}

// GET defaults to mode: 'read'. POST sends a body (DeviceProfile / track
// selection) and is rejected by the read-method gate, so mark it 'write'.
// PlaybackInfo doesn't mutate persistent state, but the HTTP method is
// non-safe and a read-only PAT must not be able to provoke transcoding-side
// effects; this keeps the gate consistent.
export const GET: RequestHandler = withJellyfinAuth(handlePlaybackInfo, {
    pat: 'deny',
});
export const POST: RequestHandler = withJellyfinAuth(handlePlaybackInfo, {
    pat: 'deny',
    mode: 'write',
});
