// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playability probe: what POST /play-sessions would decide for a title with the
 * given capabilities, without starting anything.
 *
 * No play_sessions row, no playback grant, no stored plan and no watch history:
 * the work is `buildPlaybackStartInfo` (the same function a video start calls,
 * fed by the same `startDecisionInputs`) in read-only mode, projected to the
 * public camelCase shape.
 */

import type { Sql } from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { PlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
import type { LumastraInfoResponse, LumastraVersion } from '$lib/schemas/api-playback-responses.js';
import type {
    PlayabilityResponse,
    PlayabilitySubtitleTrack,
} from '$lib/schemas/api-playability.js';
import { resolvePlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
import { ASS_CODECS } from '$lib/components/player/subtitle-utils.js';
import { getExternalSubtitlesForFile } from '$lib/server/database/queries/external-subtitles.queries.js';
import { getMediaItemById } from '$lib/server/database/queries/catalog-operations.queries.js';
import { buildPlaybackStartInfo } from './info.service.js';
import { recommendedStreamIndexes, startDecisionInputs } from './playback-start-inputs.js';
import { buildTimelineDelivery, subtitleDeliveryMethod } from './playback-timeline.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlayabilityService');

/** Item kinds that have file versions to probe; the same set POST /play-sessions plays as video. */
const VIDEO_MEDIA_TYPES = ['movie', 'episode', 'video'];

export interface ProbePlayabilityParams {
    sql: Sql;
    userId: UserId;
    mediaId: string;
    fileId?: string;
    capabilities?: PlaybackCapabilities;
    surface: ApiSurface;
    /** Policy key (users.username): the account's `allowed_play_methods` is applied like a start. */
    username?: string;
}

export type ProbePlayabilityResult =
    { ok: true; data: PlayabilityResponse } | { ok: false; status: number; message: string };

type MethodKey = keyof LumastraVersion['play_methods'];

function subtitleTracks(
    mediaId: string,
    version: LumastraVersion,
    sidecars: Awaited<ReturnType<typeof getExternalSubtitlesForFile>>,
    surface: ApiSurface,
    formats: readonly string[],
): PlayabilitySubtitleTrack[] {
    const embeddedByIndex = new Map(version.tracks.subtitles.map((t) => [t.index, t]));
    return buildTimelineDelivery(
        mediaId,
        version.id,
        version.tracks.subtitles,
        sidecars,
        surface,
    ).subtitles.map((descriptor) => {
        const codec = descriptor.codec.toLowerCase();
        const format =
            descriptor.format === 'bitmap'
                ? ('bitmap' as const)
                : ASS_CODECS.includes(codec)
                  ? ('ass' as const)
                  : ('text' as const);
        const embedded = descriptor.kind === 'embedded';
        return {
            id: descriptor.id,
            index: descriptor.index,
            absoluteIndex: descriptor.index,
            codec: descriptor.codec,
            language: descriptor.language,
            title: descriptor.title ?? null,
            default: descriptor.default,
            forced: descriptor.forced,
            format,
            source: embedded ? ('embedded' as const) : ('sidecar' as const),
            method: subtitleDeliveryMethod(
                descriptor,
                embeddedByIndex.get(descriptor.index)?.method,
                formats,
            ),
        };
    });
}

function recommendedTracks(
    info: Pick<LumastraInfoResponse, 'tracks' | 'recommended_tracks' | 'active_file_id'>,
    _versions: PlayabilityResponse['versions'],
): PlayabilityResponse['recommended'] {
    const indexes = recommendedStreamIndexes(info);
    const reason = info.recommended_tracks?.reason;
    if (!indexes || !reason) return undefined;
    return {
        ...indexes,
        subtitleId: indexes.subtitleId,
        reason,
    };
}

/**
 * The account's `allowed_play_methods`, applied as a start would. Returns
 * undefined when it cannot be read (the probe then does not evaluate it).
 * Stream limits and IP rules are not evaluated: they depend on other sessions.
 */
async function loadMethodPolicy(
    sql: Sql,
    username: string | undefined,
): Promise<((method: string) => boolean) | undefined> {
    if (!username) return undefined;
    try {
        const { getEffectivePolicy, checkPlayMethodAllowed } =
            await import('./play-sessions.service.js');
        const policy = await getEffectivePolicy(sql, username);
        return (method) => checkPlayMethodAllowed(policy, method) === null;
    } catch (error) {
        logger.warn('Could not read the stream policy; play-method policy not evaluated', {
            error,
        });
        return undefined;
    }
}

export async function probePlayability(
    params: ProbePlayabilityParams,
): Promise<ProbePlayabilityResult> {
    const { sql, mediaId, fileId } = params;

    const media = await getMediaItemById(sql, mediaId);
    if (!media) return { ok: false, status: 404, message: 'Media not found' };
    if (!VIDEO_MEDIA_TYPES.includes(String(media.media_type))) {
        return {
            ok: false,
            status: 422,
            message: 'Only movies, episodes and videos have file versions to probe',
        };
    }

    const decisionInputs = startDecisionInputs(params.capabilities);
    const result = await buildPlaybackStartInfo({
        sql,
        userId: params.userId,
        internalId: mediaId,
        fileId,
        ...decisionInputs,
        surface: params.surface,
        readOnlyProbe: true,
    });
    if (!result.ok) {
        // "No version could be read" is a storage problem, not a server bug: 503.
        return result.status === 500 ? { ...result, status: 503 } : result;
    }
    const info = result.data;
    const formats = resolvePlaybackCapabilities(params.capabilities).subtitleFormats;
    const policy = await loadMethodPolicy(sql, params.username);

    const versions: PlayabilityResponse['versions'] = [];
    for (const version of info.versions) {
        const sidecars = await getExternalSubtitlesForFile(sql, version.id).catch(
            (error: unknown) => {
                logger.warn('Could not read sidecar subtitles; listing embedded tracks only', {
                    mediaId,
                    fileId: version.id,
                    error,
                });
                return [];
            },
        );
        const video = version.tracks.video;
        const methodAllowed = policy ? policy(version.recommended) : true;
        versions.push({
            fileId: version.id,
            label: version.label,
            isDefault: version.is_default,
            playable: version.playable && methodAllowed,
            blockedBy: [
                ...(version.playable ? [] : (['transcoding_unavailable'] as const)),
                ...(methodAllowed ? [] : (['play_method_not_allowed'] as const)),
            ],
            playMethod: version.recommended,
            availableMethods: (
                Object.entries(version.play_methods) as [MethodKey, { available: boolean }][]
            )
                .filter(([, method]) => method.available)
                .map(([name]) => name),
            reasons: version.transcode_reasons,
            reasonCodes: version.transcode_reason_codes ?? [],
            outputHdr: version.output_hdr,
            hlsAudioMode: version.hls_audio_mode,
            durationMs: version.duration_ms != null ? Math.round(version.duration_ms) : null,
            sizeBytes: version.size_bytes,
            tracks: {
                video: video
                    ? {
                          codec: video.codec,
                          width: video.width,
                          height: video.height,
                          container: video.container,
                          hdr: video.hdr,
                          bitrate: video.bitrate,
                          fps: video.fps,
                          dvProfile: video.dv_profile,
                          dvBlCompatId: video.dv_bl_compat_id,
                      }
                    : null,
                audio: version.tracks.audio.map((a) => ({
                    index: a.index,
                    absoluteIndex: a.absoluteIndex,
                    codec: a.codec,
                    channels: a.channels,
                    language: a.language,
                    title: a.title,
                    default: a.default,
                })),
                subtitles: subtitleTracks(mediaId, version, sidecars, params.surface, formats),
            },
        });
    }
    // Files that could not be read are still versions of the title: report them
    // as unplayable rather than letting them vanish from the list.
    for (const unreadable of result.unreadableVersions) {
        versions.push({
            fileId: unreadable.id,
            label: unreadable.label,
            isDefault: unreadable.is_default,
            playable: false,
            blockedBy: [unreadable.reason],
            availableMethods: [],
            reasons: [],
            reasonCodes: [],
            durationMs: null,
            sizeBytes: unreadable.size_bytes,
            tracks: { video: null, audio: [], subtitles: [] },
        });
    }

    return {
        ok: true,
        data: {
            mediaId,
            activeFileId: info.active_file_id,
            resumePositionMs: Math.max(0, Math.round(info.resume_position_ms ?? 0)),
            isWatched: info.is_watched ?? false,
            hlsAudioMode: info.hls_audio_mode,
            recommended: recommendedTracks(info, versions),
            versions,
        },
    };
}
