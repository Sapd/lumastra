// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/play-sessions/index.ts
 *
 * GET /api/admin/play-sessions
 *
 * Returns all active play sessions with admin-only enrichment:
 * bandwidth, transcode progress, audio/subtitle tracks, radio/music metadata.
 * Optionally includes untracked Jellyfin sessions (sessions playing in Jellyfin
 * that could not be ingested — no user match or no media match).
 *
 * Auth: admin.
 * Surface: internal-only.
 * Response: { sessions: AdminPlaySession[], untrackedJellyfinSessions?: UntrackedJellyfinSession[] }
 * 503 dependency_unavailable when DB is down.
 */

import { sessionCarPlayContext } from '$lib/server/database/queries/play-session-client-context.queries.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getSessionReadModel } from '$lib/server/services/session-read-model.service.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries.js';
import { parseUserAgent } from '$lib/utils/user-agent.js';
import { getAllActiveSessionsWithMedia } from '$lib/server/database/queries/play-sessions.queries.js';
import { peekNowPlaying } from '$lib/server/services/radio-metadata/index.js';
import { resolveMusicSessionLiveInfo } from '$lib/server/services/music-session-live-info.js';
import { getAllActiveJobs } from '$lib/server/database/queries/transcode-jobs.queries.js';
import { features } from '$lib/server/config.js';
import { jellyfinPlaybackService } from '$lib/server/jellyfin/playback.service.js';
import { transformJellyfinSessionToStreamSession } from '$lib/server/transformers.js';
import { resolveJellyfinNamesToUserIds } from '$lib/server/database/queries/users.queries.js';
import { resolveSessionAdaptive } from '$lib/server/services/adaptive-playback-state.service.js';
import {
    AdminPlaySessionsResponseSchema,
    type UntrackedJellyfinSession,
} from '$lib/schemas/api-admin-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Fetch all active sessions via the unified read model
            const readModel = getSessionReadModel();
            const sessions = await readModel.getAllActive({
                admin: true,
                includeStale: false,
            });

            // For admin-only enrichment (bandwidth, transcode, media_streams),
            // we still need the full SessionRow data. Fall back to the detailed query.
            const dbSessions = await getAllActiveSessionsWithMedia(sql);
            const sessionBandwidth = await bandwidthTracker.getAggregatedSessionBandwidthMap();

            // Fetch active transcode jobs for enrichment
            const transcodeJobs = new Map<
                string,
                {
                    progressPercent: number;
                    segmentsReady: number;
                    totalSegments: number;
                }
            >();
            try {
                const { getFFmpegTranscodeService } =
                    await import('$lib/server/services/ffmpeg-transcode.service.js');
                const service = getFFmpegTranscodeService();
                const jobs = await service.getAllActiveJobsInfoMultiPod();
                for (const job of jobs) {
                    transcodeJobs.set(job.playSessionId, {
                        progressPercent: job.progressPercent,
                        segmentsReady: job.segmentsReady,
                        totalSegments: job.totalSegments,
                    });
                }
            } catch {
                // Transcode service may not be available — proceed without it
            }

            // Fetch music transcode job metadata for cache-state badge.
            type MusicTranscodeInfo = {
                transcode_mode: string;
                has_ffmpeg_pid: boolean;
            };
            const musicTranscodeBySession = new Map<string, MusicTranscodeInfo>();
            try {
                const allJobs = await getAllActiveJobs(sql);
                for (const job of allJobs) {
                    const cfg = job.config;
                    if (cfg?.type === 'music' && typeof cfg.transcode_mode === 'string') {
                        musicTranscodeBySession.set(job.play_session_id, {
                            transcode_mode: cfg.transcode_mode,
                            has_ffmpeg_pid: job.ffmpeg_pid !== null,
                        });
                    }
                }
            } catch {
                // Non-critical — proceed without music transcode metadata
            }

            // Batch-fetch audio/subtitle streams for all sessions with a file_id
            const fileIds = dbSessions
                .map((s) => s.file_id)
                .filter((id): id is string => id != null);
            const streamsByFile = new Map<string, MediaStreamRow[]>();
            if (fileIds.length > 0) {
                try {
                    const streams = await sql<MediaStreamRow[]>`
                        SELECT * FROM media_streams
                        WHERE file_id = ANY(${fileIds})
                          AND stream_type IN ('audio', 'subtitle')
                        ORDER BY stream_type, stream_index
                    `;
                    for (const stream of streams) {
                        let list = streamsByFile.get(stream.file_id);
                        if (!list) {
                            list = [];
                            streamsByFile.set(stream.file_id, list);
                        }
                        list.push(stream);
                    }
                } catch {
                    // Non-critical — proceed without track data
                }
            }

            // Build a map of session ID -> full enriched row for O(1) lookup
            const enrichedSessionsMap = new Map(dbSessions.map((s) => [s.id, s]));

            // Batch-read radio now-playing from Valkey cache for all radio sessions.
            const radioMediaIds = dbSessions
                .filter((s) => s.media_type === 'radio')
                .map((s) => s.media_id)
                .filter((id): id is string => id != null);
            const radioNowPlayingMap = new Map<
                string,
                Awaited<ReturnType<typeof peekNowPlaying>>
            >();
            if (radioMediaIds.length > 0) {
                const peeks = await Promise.allSettled(
                    radioMediaIds.map((id) => peekNowPlaying({ id, streamUrl: '' })),
                );
                for (let i = 0; i < radioMediaIds.length; i++) {
                    const result = peeks[i];
                    if (result.status === 'fulfilled') {
                        radioNowPlayingMap.set(radioMediaIds[i], result.value);
                    }
                }
            }

            // Next-track and crossfade extras for music sessions (Valkey, fed
            // by the music session heartbeat).
            const musicLiveInfo = await resolveMusicSessionLiveInfo(
                sql,
                dbSessions.filter((s) => s.media_type === 'track').map((s) => s.id),
            );

            // Adaptive-bitrate state per session (display-only, Valkey).
            const adaptiveBySession = await resolveSessionAdaptive(
                sessions.map((viewSession) => ({
                    sessionId: viewSession.sessionId,
                    username: viewSession.username,
                    mediaType: viewSession.mediaType,
                    mediaId: viewSession.mediaId,
                    deviceId:
                        enrichedSessionsMap.get(viewSession.sessionId)?.device_id ??
                        viewSession.device?.deviceId,
                })),
            );

            const sessionsList = sessions.map((viewSession) => {
                const enriched = enrichedSessionsMap.get(viewSession.sessionId);

                if (!enriched) {
                    // Fallback: minimal shape from the read-model view only
                    return {
                        __id: viewSession.sessionId,
                        username: viewSession.username,
                        title: viewSession.title ?? '',
                        clientname: viewSession.device?.client ?? 'Unknown',
                        clientVersion: viewSession.device?.version,
                        browsername: viewSession.device?.name
                            ? parseUserAgent(viewSession.device.name)
                            : (viewSession.device?.client ?? 'Unknown'),
                        user_agent_raw: viewSession.device?.name ?? undefined,
                        playIsPlaying: viewSession.isPlaying,
                        playCurrentTime: viewSession.positionMs / 1000,
                        playItemDuration: viewSession.runtimeMs
                            ? viewSession.runtimeMs / 1000
                            : undefined,
                        media_type: viewSession.mediaType || undefined,
                        series_id: viewSession.seriesId ?? undefined,
                        started_at: viewSession.startedAt.toISOString(),
                        media_id: viewSession.mediaId,
                        source: viewSession.source,
                        sourceSessionId: viewSession.sourceSessionId ?? undefined,
                        lastSeenAt: viewSession.lastSeenAt.toISOString(),
                        status: viewSession.isPlaying ? ('ACTIVE' as const) : ('PAUSED' as const),
                        lastHeartbeatAt: viewSession.lastHeartbeatAt.toISOString(),
                        isBuffering: viewSession.isBuffering,
                        nextTrack: musicLiveInfo.get(viewSession.sessionId)?.nextTrack,
                        crossfade: musicLiveInfo.get(viewSession.sessionId)?.crossfade,
                        music_transcode_mode:
                            musicTranscodeBySession.get(viewSession.sessionId)?.transcode_mode ??
                            undefined,
                        music_has_ffmpeg_pid:
                            musicTranscodeBySession.get(viewSession.sessionId)?.has_ffmpeg_pid ??
                            undefined,
                        adaptive: adaptiveBySession.get(viewSession.sessionId),
                    };
                }

                const transcode = transcodeJobs.get(enriched.id);
                const streams = enriched.file_id ? streamsByFile.get(enriched.file_id) : undefined;
                const audioTracks = streams
                    ?.filter((st) => st.stream_type === 'audio')
                    .map((st) => ({
                        index: st.stream_index,
                        language: st.language ?? undefined,
                        codec: st.codec ?? undefined,
                        channels: st.channels ?? undefined,
                        displayTitle: st.display_title ?? undefined,
                        isDefault: st.is_default,
                    }));
                const subtitleTracks = streams
                    ?.filter((st) => st.stream_type === 'subtitle')
                    .map((st) => ({
                        index: st.stream_index,
                        language: st.language ?? undefined,
                        codec: st.codec ?? undefined,
                        displayTitle: st.display_title ?? undefined,
                        isDefault: st.is_default,
                        isForced: st.is_forced,
                    }));

                // Radio now-playing from Valkey cache
                const radioSnap = enriched.media_id
                    ? radioNowPlayingMap.get(enriched.media_id)
                    : undefined;

                return {
                    __id: enriched.id,
                    username: enriched.owner_username,
                    title: enriched.media_title ?? '',
                    clientname: enriched.client_name ?? 'Unknown',
                    clientVersion: enriched.client_version ?? viewSession.device?.version,
                    browsername: enriched.user_agent
                        ? parseUserAgent(enriched.user_agent)
                        : (enriched.client_name ?? 'Unknown'),
                    user_agent_raw: enriched.user_agent ?? undefined,
                    playMethod: enriched.play_method,
                    playIsPlaying: enriched.status === 'ACTIVE',
                    playCurrentTime: Number(enriched.position_ms ?? 0) / 1000,
                    playItemDuration:
                        enriched.runtime_ms != null
                            ? Number(enriched.runtime_ms) / 1000
                            : undefined,
                    resolution: enriched.resolution ?? undefined,
                    bitrate_kbps: enriched.bitrate_kbps ?? undefined,
                    video_codec: enriched.video_codec ?? undefined,
                    audio_codec: enriched.audio_codec ?? undefined,
                    audio_language: enriched.audio_language ?? undefined,
                    subtitle_language: enriched.subtitle_language ?? undefined,
                    audio_stream_index: enriched.audio_stream_index ?? undefined,
                    subtitle_stream_index: enriched.subtitle_stream_index ?? undefined,
                    buffer_health_sec: enriched.buffer_health_sec ?? undefined,
                    media_type: enriched.media_type ?? undefined,
                    season_number: enriched.season_number ?? undefined,
                    episode_number: enriched.episode_number ?? undefined,
                    season_id: enriched.season_id ?? undefined,
                    season_title: enriched.season_title ?? undefined,
                    series_id: enriched.series_id ?? undefined,
                    series_title: enriched.series_title ?? undefined,
                    file_path: enriched.file_path ?? undefined,
                    file_id: enriched.file_id ?? undefined,
                    started_at: enriched.started_at.toISOString(),
                    ip_address: enriched.ip_address,
                    plan_mode: enriched.plan_mode ?? undefined,
                    plan_reasons: enriched.plan_reasons ?? undefined,
                    subtitle_method: enriched.subtitle_method ?? undefined,
                    transcode_codec: enriched.transcode_codec ?? undefined,
                    delivery_path: enriched.delivery_path ?? undefined,
                    media_id: enriched.media_id ?? undefined,
                    bandwidth_mbps: sessionBandwidth.get(enriched.id) ?? undefined,
                    audio_tracks: audioTracks?.length ? audioTracks : undefined,
                    subtitle_tracks: subtitleTracks?.length ? subtitleTracks : undefined,
                    transcode: transcode
                        ? {
                              progressPercent: transcode.progressPercent,
                              segmentsReady: transcode.segmentsReady,
                              totalSegments: transcode.totalSegments,
                          }
                        : undefined,
                    source: enriched.source,
                    sourceSessionId: enriched.source_session_id ?? undefined,
                    lastSeenAt: enriched.last_seen_at.toISOString(),
                    externalPayload: enriched.external_payload ?? undefined,
                    status: enriched.status as
                        'ACTIVE' | 'PAUSED' | 'CRASHED' | 'COMPLETED' | 'KILLED',
                    pausedAt: enriched.paused_at ? enriched.paused_at.toISOString() : undefined,
                    lastHeartbeatAt: enriched.last_heartbeat_at.toISOString(),
                    container: enriched.container ?? undefined,
                    deviceId: enriched.device_id,
                    // NULL (no client ever announced) and [] (announced an
                    // empty list) both collapse to undefined here: the two are
                    // a useful distinction in the column, but the admin UI acts
                    // on them identically and a `[]` on the wire would invite a
                    // reader to think otherwise.
                    isCarPlay: sessionCarPlayContext(enriched.external_payload),
                    clientFeatures: enriched.client_features?.length
                        ? enriched.client_features
                        : undefined,
                    planId: enriched.plan_id ?? undefined,
                    isBuffering: viewSession.isBuffering,
                    artistName: enriched.artist_name ?? undefined,
                    albumName: enriched.album_name ?? undefined,
                    albumId: enriched.album_id ?? undefined,
                    radioProgram: radioSnap?.show?.name ?? undefined,
                    radioDj: radioSnap?.dj?.name ?? undefined,
                    nowPlayingTrack: radioSnap?.track?.title ?? undefined,
                    nowPlayingArtist: radioSnap?.track?.artist ?? undefined,
                    nextTrack: musicLiveInfo.get(enriched.id)?.nextTrack,
                    crossfade: musicLiveInfo.get(enriched.id)?.crossfade,
                    music_transcode_mode:
                        musicTranscodeBySession.get(enriched.id)?.transcode_mode ?? undefined,
                    music_has_ffmpeg_pid:
                        musicTranscodeBySession.get(enriched.id)?.has_ffmpeg_pid ?? undefined,
                    adaptive: adaptiveBySession.get(enriched.id),
                };
            });

            // Compute untracked Jellyfin sessions
            const untrackedJellyfinSessions: UntrackedJellyfinSession[] = [];
            if (features.jellyfinSync) {
                try {
                    const rawJellyfinSessions = await jellyfinPlaybackService.getSessions();
                    const transformed =
                        transformJellyfinSessionToStreamSession(rawJellyfinSessions);

                    const trackedSourceIds = new Set<string>(
                        dbSessions
                            .filter((s) => s.source === 'jellyfin' && s.source_session_id != null)
                            .map((s) => s.source_session_id as string),
                    );

                    const candidateNames = [
                        ...new Set(
                            transformed
                                .map((s) => s.username?.toLowerCase())
                                .filter((u): u is string => !!u),
                        ),
                    ];
                    const resolvedUserIds =
                        candidateNames.length > 0
                            ? await resolveJellyfinNamesToUserIds(sql, candidateNames).catch(
                                  () => new Map(),
                              )
                            : new Map();

                    const jellyfinItemIds = [
                        ...new Set(
                            transformed.map((s) => s.jellyfinId).filter((id): id is string => !!id),
                        ),
                    ];
                    const resolvedItems = new Set<string>();
                    if (jellyfinItemIds.length > 0) {
                        const rows = await sql<{ external_id: string }[]>`
                            SELECT DISTINCT external_id FROM external_ids
                            WHERE provider = 'jellyfin'
                              AND external_id = ANY(${jellyfinItemIds})
                        `.catch(() => []);
                        for (const row of rows) resolvedItems.add(row.external_id);
                    }

                    for (const session of transformed) {
                        const sourceSessionId = session.playSessionId ?? session.__id;
                        if (!sourceSessionId || trackedSourceIds.has(sourceSessionId)) continue;

                        const hasUserMatch =
                            !!session.username &&
                            resolvedUserIds.has(session.username.toLowerCase());
                        const hasMediaMatch =
                            !!session.jellyfinId && resolvedItems.has(session.jellyfinId);

                        // Both resolved but still untracked is a transient ingestion-cycle
                        // gap (the sync poller hasn't picked it up yet), not something an
                        // admin needs to act on — don't misreport it as unresolved.
                        if (hasUserMatch && hasMediaMatch) continue;

                        const skipReason: UntrackedJellyfinSession['skipReason'] = !hasUserMatch
                            ? 'no_user_match'
                            : 'no_media_match';

                        untrackedJellyfinSessions.push({
                            jellyfinSessionId: session.__id,
                            username: session.username ?? 'Unknown',
                            title: session.title,
                            mediaType: session.mediaType ?? undefined,
                            clientname: session.clientname,
                            playIsPlaying: session.playIsPlaying !== false,
                            skipReason,
                        });
                    }
                } catch {
                    // Non-critical — omit untracked list rather than failing the whole endpoint
                }
            }

            return json(
                AdminPlaySessionsResponseSchema.parse({
                    sessions: sessionsList,
                    untrackedJellyfinSessions,
                }),
            );
        },
    },
});
