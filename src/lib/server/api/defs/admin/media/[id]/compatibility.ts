// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/compatibility.ts
 *
 * GET /api/admin/media/[id]/compatibility?caps=...
 *
 * Probes each file for a media item once, then runs the playback planner
 * against each browser profile (4 static + optional "own browser" from ?caps=).
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { files: FileCompatibility[] }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { probeMediaFile, containerFromExtension } from '$lib/server/utils/ffprobe.js';
import {
    parseBitDepth,
    selectDeliveryPath,
    buildServerEncodeCaps,
} from '$lib/server/services/info.service.js';
import { checkCompatibility } from '$lib/server/utils/media-compatibility.js';
import type { MediaInfo } from '$lib/server/utils/media-compatibility.js';
import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import { BROWSER_PROFILES } from '$lib/server/utils/browser-profiles.js';
import { parseCapsAuto } from '$lib/server/utils/info.utils.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { FileCompatibility, BrowserCompatibility } from '$lib/schemas/admin-types.js';

const logger = Logger.for('AdminCompatibility');

// ---------------------------------------------------------------------------
// Response schema  (mirrors FileCompatibility / BrowserCompatibility types)
// ---------------------------------------------------------------------------

const PathScopedSchema = z.object({
    directFile: z.object({
        videoCodecs: z.array(z.string()),
        audioCodecs: z.array(z.string()),
        containers: z.array(z.string()),
    }),
    nativeHls: z.object({
        videoCodecs: z.array(z.string()),
        audioCodecs: z.array(z.string()),
    }),
    mseHls: z.object({
        videoCodecs: z.array(z.string()),
        audioCodecs: z.array(z.string()),
    }),
});

const BrowserCompatibilitySchema = z.object({
    browser_id: z.string(),
    browser_label: z.string(),
    is_own_browser: z.boolean(),
    method: z.string(),
    delivery_path: z.string(),
    video_action: z.string(),
    audio_action: z.string(),
    target_video_codec: z.string().nullable(),
    target_audio_codec: z.string().nullable(),
    transcode_reasons: z.array(z.string()),
    profile: z.object({
        path_scoped: PathScopedSchema,
        hdr_formats: z.array(z.string()),
        audio_switching: z.boolean(),
        max_channels: z.number().int(),
    }),
    compatibility: z.object({
        video_compatible: z.boolean(),
        audio_compatible: z.boolean(),
        container_compatible: z.boolean(),
        needs_tonemapping: z.boolean(),
        needs_hls_for_audio: z.boolean(),
        incompatible_audio_codecs: z.array(z.string()),
    }),
});

const MediaInfoSchema = z.object({
    video_codec: z.string(),
    audio_codecs: z.array(z.string()),
    container: z.string(),
    hdr: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    bitrate: z.number().optional(),
    audio_channels: z.number().optional(),
    video_bit_depth: z.number().optional(),
});

const FileCompatibilitySchema = z.object({
    file_id: z.string(),
    file_path: z.string(),
    label: z.string().nullable(),
    media_info: MediaInfoSchema,
    browsers: z.array(BrowserCompatibilitySchema),
});

export const CompatibilityResponseSchema = z.object({
    files: z.array(FileCompatibilitySchema),
});

export type CompatibilityResponse = z.infer<typeof CompatibilityResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            caps: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const rawCaps = ctx.input?.query?.caps ?? null;
            const ownCaps = parseCapsAuto(rawCaps);

            const files = await getFilesForMediaItem(sql, internalId);
            const serverEncode = await buildServerEncodeCaps();

            const result: FileCompatibility[] = [];

            for (const file of files) {
                const pathInfo = await resolveMediaPath(
                    file.file_path,
                    { skipLocalAccessCheck: true },
                    sql,
                );
                if (!pathInfo?.isAccessible) {
                    logger.debug('Skipping file — path not accessible', {
                        fileId: file.id,
                        path: file.file_path,
                    });
                    continue;
                }

                const probe = await probeMediaFile(pathInfo.containerPath);
                if (!probe.success) {
                    logger.debug('Skipping file — probe failed', {
                        fileId: file.id,
                        path: pathInfo.containerPath,
                    });
                    continue;
                }

                const maxAudioChannels = probe.audioStreams.reduce(
                    (max, a) => Math.max(max, a.channels ?? 0),
                    0,
                );

                const mediaInfo: MediaInfo = {
                    videoCodec: probe.video?.codec ?? '',
                    videoBitDepth: parseBitDepth(probe.video?.pixelFormat),
                    videoProfile: probe.video?.profile ?? undefined,
                    videoLevel: probe.video?.level ?? undefined,
                    width: probe.video?.width ?? undefined,
                    height: probe.video?.height ?? undefined,
                    bitrate: probe.formatBitrate ?? probe.video?.bitrate ?? undefined,
                    audioCodecs: probe.audioStreams.map((a) => a.codec).filter(Boolean),
                    audioTrackCount: probe.audioStreams.length,
                    audioChannels: maxAudioChannels > 0 ? maxAudioChannels : undefined,
                    container:
                        containerFromExtension(pathInfo.containerPath) ?? probe.container ?? '',
                    hdr: probe.video?.hdr ?? 'sdr',
                };

                const profiles = [...BROWSER_PROFILES.map((p) => ({ ...p, isOwnBrowser: false }))];
                if (ownCaps?.pathScoped) {
                    profiles.push({
                        id: 'own',
                        name: 'Your Browser',
                        pathScoped: ownCaps.pathScoped,
                        deviceCaps: ownCaps.deviceCaps,
                        isOwnBrowser: true,
                    });
                }

                const browsers: BrowserCompatibility[] = [];

                for (const profile of profiles) {
                    const multiAudio = mediaInfo.audioTrackCount > 1;
                    const canSwitchAudio = profile.deviceCaps.canSwitchAudioInDirectPlay ?? false;
                    const deliveryPath = selectDeliveryPath(
                        mediaInfo,
                        profile.pathScoped,
                        canSwitchAudio,
                        multiAudio,
                    );

                    const { plan } = await playbackPlanner.createPlan({
                        intent: 'play',
                        fileId: file.id,
                        mediaInfo,
                        caps: profile.deviceCaps,
                        serverEncode,
                        deliveryPath,
                        enableHdrPreservation: config.ENABLE_HDR10_PRESERVATION,
                    });

                    const compat = checkCompatibility(mediaInfo, profile.deviceCaps);

                    const browserEntry: BrowserCompatibility = {
                        browser_id: profile.id,
                        browser_label: profile.name,
                        is_own_browser: profile.isOwnBrowser,
                        method: plan.method,
                        delivery_path: plan.delivery_path,
                        video_action: plan.video_action,
                        audio_action: plan.audio_action,
                        target_video_codec: plan.target_video_codec,
                        target_audio_codec: plan.target_audio_codec,
                        transcode_reasons: plan.transcode_reasons,
                        profile: {
                            path_scoped: {
                                directFile: {
                                    videoCodecs: profile.pathScoped.directFile.videoCodecs,
                                    audioCodecs: profile.pathScoped.directFile.audioCodecs,
                                    containers: profile.pathScoped.directFile.containers,
                                },
                                nativeHls: {
                                    videoCodecs: profile.pathScoped.nativeHls.videoCodecs,
                                    audioCodecs: profile.pathScoped.nativeHls.audioCodecs,
                                },
                                mseHls: {
                                    videoCodecs: profile.pathScoped.mseHls.videoCodecs,
                                    audioCodecs: profile.pathScoped.mseHls.audioCodecs,
                                },
                            },
                            hdr_formats: [...(profile.deviceCaps.hdrFormats ?? new Set<string>())],
                            audio_switching: canSwitchAudio,
                            max_channels: profile.deviceCaps.maxAudioChannels ?? 2,
                        },
                        compatibility: {
                            video_compatible: compat.videoCompatible,
                            audio_compatible: compat.audioCompatible,
                            container_compatible: compat.containerCompatible,
                            needs_tonemapping: compat.needsTonemapping,
                            needs_hls_for_audio: compat.needsHlsForAudio,
                            incompatible_audio_codecs: compat.incompatibleAudioCodecs,
                        },
                    };

                    browsers.push(browserEntry);
                }

                const fileEntry: FileCompatibility = {
                    file_id: file.id,
                    file_path: file.file_path,
                    label: file.label ?? null,
                    media_info: {
                        video_codec: mediaInfo.videoCodec,
                        audio_codecs: mediaInfo.audioCodecs,
                        container: mediaInfo.container,
                        hdr: mediaInfo.hdr ?? 'sdr',
                        width: mediaInfo.width,
                        height: mediaInfo.height,
                        bitrate: mediaInfo.bitrate,
                        audio_channels: mediaInfo.audioChannels,
                        video_bit_depth: mediaInfo.videoBitDepth,
                    },
                    browsers,
                };

                result.push(fileEntry);
            }

            return json(CompatibilityResponseSchema.parse({ files: result }));
        },
    },
});
