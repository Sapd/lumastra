// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serializeBaseItem,
    mapRowToMediaItem,
    streamRowToJellyfin,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { applyFolderUserData } from '$lib/server/proprietary/jellyfin-compat/folder-user-data';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import type {
    JellyfinMediaSourceInfo,
    JellyfinMediaStream,
} from '$lib/server/proprietary/jellyfin-compat/types';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    getPlaylistById,
    getPlaylistWatchProgress,
} from '$lib/server/database/queries/playlists.queries';
import {
    playlistIdToUuid,
    uuidToPlaylistId,
} from '$lib/server/proprietary/jellyfin-compat/playlist-id';
import { getUserRole } from '$lib/server/utils/playlist-utils';
import {
    containerFromPath,
    isAudioContainer,
    deriveQualityLabel,
} from '$lib/server/proprietary/jellyfin-compat/media-container-utils';
import { getJfToken, hasLiveTvPermission } from '$lib/server/proprietary/jellyfin-compat/utils';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '$lib/server/proprietary/jellyfin-compat/music-artists-enrichment';
import { enrichItemsWithRelatedMediaCounts } from '$lib/server/proprietary/jellyfin-compat/related-media';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import {
    addSourceDerivedFields,
    enrichItemsWithItemDetails,
} from '$lib/server/proprietary/jellyfin-compat/item-details-enrichment';
import {
    ALL_CREDIT_FIELDS,
    enrichItemsWithCredits,
} from '$lib/server/proprietary/jellyfin-compat/people-studios';
import { resolveNameItem } from '$lib/server/proprietary/jellyfin-compat/people-studios-handlers';
import {
    getFilesForMediaItem,
    getOwnerItemForFile,
} from '$lib/server/database/queries/media-files.queries';
import {
    getStreamsForFile,
    getStreamsForMediaItem,
} from '$lib/server/database/queries/media-streams.queries';
import {
    getItemDetail,
    getChaptersForItem,
    getTrickplayForItem,
    getLibraryGroupInfo,
} from '$lib/server/database/queries/jellyfin-item-detail.queries';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access';
import {
    serializeChannel,
    serializeProgram,
} from '$lib/server/proprietary/jellyfin-compat/serializers/livetv';
import { getProgramById } from '$lib/server/database/queries/livetv-programs.queries';
import { getFavoriteChannelIds } from '$lib/server/database/queries/livetv-channels.queries';
import {
    partCountFor,
    partLayout,
    toPartItem,
} from '$lib/server/proprietary/jellyfin-compat/multi-part';

const logger = Logger.for('JellyfinCompat:ItemDetail');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }
    // Playlist IDs: only UUID-encoded form is accepted
    const playlistIntId = uuidToPlaylistId(itemId);
    if (playlistIntId !== null) {
        // Playlist IDs are sequential integers behind a deterministic UUID
        // encoding, so they are trivially enumerable. Gate on the caller's role
        // (owner / accepted member / public) before returning any metadata, and
        // 404 (not 403) so a private playlist's existence isn't revealed — the
        // sibling list routes (/j/Items?ParentId, /j/Playlists/[id]/Items) do
        // the same; this detail branch previously had no gate.
        const { role: playlistRole } = await getUserRole(
            sql,
            playlistIntId,
            null,
            locals.user.userId,
        );
        if (!playlistRole) {
            return ApiResponses.notFound('Playlist not found');
        }
        const playlist = await getPlaylistById(sql, playlistIntId);
        if (!playlist) {
            return ApiResponses.notFound('Playlist not found');
        }
        const playlistUuid = playlistIdToUuid(Number(playlist.id));
        const [[countRow], progressRows] = await Promise.all([
            sql<[{ cnt: number }]>`
                SELECT COUNT(*)::int AS cnt FROM playlist_items WHERE playlist_id = ${playlistIntId}
            `,
            getPlaylistWatchProgress(sql, [playlistIntId], locals.user.userId),
        ]);
        const prog = progressRows[0];
        const total = prog?.total_items ?? 0;
        const watched = prog?.watched_items ?? 0;
        return json({
            Name: playlist.name as string,
            Id: playlistUuid,
            ServerId: JELLYFIN_SERVER_ID,
            Type: 'Playlist',
            MediaType: (playlist.playlist_type as string) === 'music' ? 'Audio' : 'Video',
            Overview: (playlist.description as string) ?? undefined,
            ChildCount: countRow?.cnt ?? 0,
            IsFolder: true,
            ImageTags: {},
            BackdropImageTags: [],
            UserData: {
                IsFavorite: false,
                PlaybackPositionTicks: 0,
                PlayedPercentage: total > 0 ? Math.round((watched / total) * 100) : 0,
                PlayCount: watched > 0 ? 1 : 0,
                Played: total > 0 && watched >= total,
                Key: playlistUuid,
                ItemId: playlistUuid,
            },
        });
    }

    if (!isUuid(itemId)) {
        return ApiResponses.notFound('Item not found');
    }
    const apiKey = getJfToken(locals as unknown as Record<string, unknown>);

    try {
        // Android TV calls GET /Items/{MediaSource.Id} when the user picks a version.
        // MediaSource.Id in our responses is the media_files UUID, not the media_items UUID.
        // Resolve file → owning media item so the rest of the handler works normally.
        const ownerItemId = await getOwnerItemForFile(sql, itemId);
        const resolvedItemId = ownerItemId ?? itemId;

        // Library access + age gate
        const allowed = await checkMediaAccess(sql, resolvedItemId, locals.user);
        if (!allowed) {
            // A cast member or studio from BaseItemDto.People / Studios
            // (clients open them with getItem(id)) lands here for an
            // age-limited user: the age gate denies every id without a rating.
            const nameItem = ownerItemId ? null : await resolveNameItem(sql, itemId, locals.user);
            if (nameItem) return json(nameItem);
            return ApiResponses.notFound('Item not found');
        }

        const row = await getItemDetail(sql, resolvedItemId, locals.user.userId);

        if (row?.media_type === 'tvchannel') {
            // Lineup gate of the Live TV routes: no hidden feed or hidden category.
            if (
                !hasLiveTvPermission(locals.user) ||
                !(await canStreamLiveTvChannel(locals, resolvedItemId))
            ) {
                return ApiResponses.notFound('Item not found');
            }

            const liveTvProvider = await getLiveTvProvider();
            const [tvChannel, favoriteChannelIds] = await Promise.all([
                liveTvProvider.getChannel(resolvedItemId),
                getFavoriteChannelIds(sql, locals.user.userId),
            ]);
            if (tvChannel) {
                tvChannel.currentProgram = await liveTvProvider.getCurrentProgram(resolvedItemId);
                return json(
                    serializeChannel(
                        tvChannel,
                        undefined,
                        favoriteChannelIds.includes(resolvedItemId),
                    ),
                );
            }
        }

        if (!row) {
            // Check if this ID is a library_group_id (CollectionFolder).
            // A denied group must be indistinguishable from a nonexistent
            // one, so the caller's denied-group set is resolved first and
            // handed to the lookup — see getLibraryGroupInfo's doc comment.
            const deniedGroups = await getDeniedLibraryGroups(
                sql,
                toLibraryAccessUser(locals.user),
            );
            const lib = await getLibraryGroupInfo(sql, itemId, deniedGroups);
            if (lib) {
                const MEDIA_TYPE_MAP: Record<string, string> = {
                    movie: 'movies',
                    tv: 'tvshows',
                    anime: 'tvshows',
                    music: 'music',
                    audiobook: 'books',
                    home_video: 'homevideos',
                    training: 'homevideos',
                    educational: 'homevideos',
                    personal: 'homevideos',
                };
                const pathSegments = lib.path.split('/').filter(Boolean);
                const name = pathSegments[pathSegments.length - 1] ?? 'Library';
                const collectionType = MEDIA_TYPE_MAP[lib.media_type] ?? 'movies';

                const [countRow] = await sql`
                    SELECT COUNT(DISTINCT mfi.media_item_id)::int as cnt
                    FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE mf.library_group_id = ${itemId}::uuid
                `;

                const childCount = (countRow?.cnt as number) ?? 0;
                return json({
                    Name: name,
                    Id: lib.library_group_id,
                    ServerId: JELLYFIN_SERVER_ID,
                    Type: 'CollectionFolder',
                    CollectionType: collectionType,
                    IsFolder: true,
                    MediaType: 'Unknown',
                    LocationType: 'FileSystem',
                    ChildCount: childCount,
                    RecursiveItemCount: childCount,
                    LocalTrailerCount: 0,
                    SpecialFeatureCount: 0,
                    PlayAccess: 'Full',
                    UserData: {
                        PlaybackPositionTicks: 0,
                        PlayedPercentage: 0,
                        PlayCount: 0,
                        IsFavorite: false,
                        Played: false,
                        Key: lib.library_group_id,
                        ItemId: lib.library_group_id,
                    },
                    // No ImageTags/BackdropImageTags: /j/Items/{itemId}/Images
                    // never serves the library mosaic (removed 2026-09-18 fix
                    // plan 4 task 6 review round 1, CRITICAL 1 — that route can
                    // never see locals.user and always falls through to the
                    // placeholder). Advertising a tag for art the route will
                    // never return sends the /j client that just fetched this
                    // item's detail on a wasted round-trip to fetch it.
                    ImageTags: {},
                    BackdropImageTags: [],
                });
            }
            // Live TV channel fallback — channels share UUIDs between
            // livetv_channels and media_items, but may not be found by
            // getItemDetail when media_items.status is not 'active'.
            // Android TV calls this endpoint for every channel focused in guide.
            const liveTvProvider = await getLiveTvProvider();
            const tvChannel = await liveTvProvider.getChannel(itemId);
            if (tvChannel) {
                if (
                    !hasLiveTvPermission(locals.user) ||
                    !(await canStreamLiveTvChannel(locals, itemId))
                ) {
                    return ApiResponses.notFound('Item not found');
                }

                const [currentProgram, favoriteChannelIds] = await Promise.all([
                    liveTvProvider.getCurrentProgram(itemId),
                    getFavoriteChannelIds(sql, locals.user.userId),
                ]);
                tvChannel.currentProgram = currentProgram;
                return json(
                    serializeChannel(tvChannel, undefined, favoriteChannelIds.includes(itemId)),
                );
            }

            // Program lookup — jellyfin-androidtv's refreshSelectedProgram fetches
            // /Items/{programId} for the focused EPG cell. Without this branch the
            // guide silently fails to populate program details on navigation.
            const programRow = await getProgramById(sql, itemId);
            if (programRow) {
                // A programme of a channel the viewer may not open is no item either.
                if (
                    !hasLiveTvPermission(locals.user) ||
                    !(await canStreamLiveTvChannel(locals, programRow.channel_id))
                ) {
                    return ApiResponses.notFound('Item not found');
                }

                const channel = await liveTvProvider.getChannel(programRow.channel_id);
                return json(
                    serializeProgram(
                        {
                            id: programRow.id,
                            channelId: programRow.channel_id,
                            title: programRow.title,
                            description: programRow.description ?? undefined,
                            startTime: programRow.start_time.toISOString(),
                            endTime: programRow.end_time.toISOString(),
                            epgId: programRow.epg_id ?? undefined,
                            genres: programRow.genres ?? undefined,
                            officialRating: programRow.official_rating ?? undefined,
                        },
                        channel?.name ?? '',
                        undefined,
                        Boolean(channel?.images.primary?.href),
                        channel?.category,
                    ),
                );
            }

            // A cast member or studio id (BaseItemDto.People / Studios).
            const nameItem = await resolveNameItem(sql, itemId, locals.user);
            if (nameItem) return json(nameItem);

            return ApiResponses.notFound('Item not found');
        }

        const runtimeSeconds = row.runtime_seconds;

        // Use the first file's path/container for top-level Container/Path fields
        // (clients that don't understand multi-source fall back to these)
        // `resolvedItemId`, never the raw `itemId`: for the version picker the
        // raw id is a FILE id, which owns no files — the item then came back
        // with an empty MediaSources and jellyfin-androidtv crashed on the
        // null source (NPE in PlaybackController.buildExoPlayerOptions,
        // prod 2026-10-02, "2001: A Space Odyssey" 2160p). The picked version
        // goes first: it is the source the client plays.
        // A multi-part movie lists part 1 only (+ PartCount); asked for by its own
        // id, part 2..N is an item with just its file (multi-part.ts).
        const layout = partLayout(await getFilesForMediaItem(sql, resolvedItemId));
        const partIndex = ownerItemId ? layout.partIndex(itemId) : -1;
        const partStack = partIndex > 0 ? layout.stackOf(itemId) : undefined;
        const allFiles = partStack ? [partStack[partIndex]] : layout.sources;
        if (ownerItemId) {
            const picked = allFiles.findIndex((f) => f.id === itemId);
            if (picked > 0) allFiles.unshift(...allFiles.splice(picked, 1));
        }
        const firstFile = allFiles[0];
        const fileContainer = firstFile ? containerFromPath(firstFile.file_path) : undefined;
        const filePath = firstFile?.file_path ?? undefined;

        const item = mapRowToMediaItem(row as unknown as Record<string, unknown>);
        item.runtime_seconds = runtimeSeconds;
        item.container = fileContainer;
        item.path = filePath;

        // Query chapters for this item
        const chapterRows = await getChaptersForItem(sql, resolvedItemId);
        if (chapterRows.length > 0) {
            item.chapters = chapterRows.map((c) => ({
                chapter_index: c.chapter_index,
                chapter_name: c.chapter_name,
                start_ticks: Number(c.start_ticks),
            }));
        }

        // Query trickplay params for this item
        const trickplayRows = await getTrickplayForItem(sql, resolvedItemId);
        if (trickplayRows.length > 0) {
            item.trickplay_params = trickplayRows.map((tp) => ({
                file_id: tp.file_id,
                width: tp.width,
                height: tp.height,
                tile_width: tp.tile_width,
                tile_height: tp.tile_height,
                thumbnail_count: tp.thumbnail_count,
                interval_ms: tp.interval_ms,
                bandwidth: tp.bandwidth,
            }));
        }

        await applyJellyfinContentLanguage(sql, locals.user.userId, [item]);
        const access = await buildJellyfinAccessContext(sql, locals.user);
        await applyFolderUserData(sql, [item], locals.user.userId, access.boundary);
        const serialized = serializeBaseItem(item);
        await enrichItemsWithProviderIds(sql, [serialized]);
        await enrichItemsWithMusicArtists(sql, [serialized]);
        await enrichItemsWithRelatedMediaCounts(sql, [serialized], locals.user);
        await enrichItemsWithImages(sql, [serialized]);
        await enrichItemsWithCredits(sql, [serialized], ALL_CREDIT_FIELDS);

        // When the request was for a file UUID (version picker), Android TV stores
        // the returned item.Id and uses it as the itemId in the next PlaybackInfo POST.
        // Override Id to the requested fileId so that POST /Items/{fileId}/PlaybackInfo
        // hits our file→owner resolution, which then sets impliedFileId and picks the
        // correct version without requiring MediaSourceId in the POST body.
        if (ownerItemId) {
            serialized.Id = itemId;
        }
        if (partStack) {
            Object.assign(serialized, toPartItem(serialized, partStack, partIndex));
        } else {
            serialized.PartCount = partCountFor(layout, allFiles[0]?.id);
        }

        // Build MediaSources: one per file for this item
        interface FileSourceSpec {
            fileId: string;
            filePath: string;
            ownerItemId: string;
        }

        const sourceSpecs: FileSourceSpec[] = allFiles.map((f) => ({
            fileId: f.id,
            filePath: f.file_path,
            ownerItemId: resolvedItemId,
        }));

        if (sourceSpecs.length > 0) {
            const mediaSources: JellyfinMediaSourceInfo[] = [];

            for (const spec of sourceSpecs) {
                const streamRows = await getStreamsForFile(sql, spec.fileId);
                // Fall back to item-level streams when no file-matched streams exist
                const resolvedStreams =
                    streamRows.length > 0
                        ? streamRows
                        : await getStreamsForMediaItem(sql, spec.ownerItemId);

                const mediaStreams: JellyfinMediaStream[] = resolvedStreams.map((s) =>
                    streamRowToJellyfin(s, resolvedItemId, apiKey, spec.fileId),
                );

                const defaultAudio = resolvedStreams.find(
                    (s) => s.stream_type === 'audio' && s.is_default,
                );
                const defaultSub = resolvedStreams.find(
                    (s) => s.stream_type === 'subtitle' && s.is_default,
                );
                const eTag = spec.fileId.slice(0, 8);
                const container = containerFromPath(spec.filePath);
                const qualityLabel = deriveQualityLabel(spec.filePath);

                mediaSources.push({
                    Id: spec.fileId,
                    Container: container,
                    Protocol: 'File',
                    Type: 'Default',
                    Name: qualityLabel,
                    Path: spec.filePath,
                    ETag: eTag,
                    IsRemote: false,
                    ReadAtNativeFramerate: false,
                    IgnoreDts: false,
                    IgnoreIndex: false,
                    GenPtsInput: false,
                    UseMostCompatibleTranscodingProfile: false,
                    IsInfiniteStream: false,
                    RequiresOpening: false,
                    RequiresClosing: false,
                    RequiresLooping: false,
                    SupportsProbing: true,
                    VideoType: 'VideoFile',
                    SupportsDirectPlay: true,
                    SupportsDirectStream: true,
                    SupportsTranscoding: true,
                    DirectStreamUrl: `/${isAudioContainer(container) ? 'Audio' : 'Videos'}/${resolvedItemId}/stream?static=true&mediaSourceId=${spec.fileId}&tag=${eTag}&api_key=${apiKey}`,
                    TranscodingUrl: `/Videos/${resolvedItemId}/master.m3u8?MediaSourceId=${spec.fileId}&api_key=${apiKey}`,
                    TranscodingContainer: 'ts',
                    TranscodingSubProtocol: 'hls',
                    MediaStreams: mediaStreams,
                    MediaAttachments: [],
                    Formats: [],
                    RequiredHttpHeaders: {},
                    HasSegments: false,
                    DefaultAudioStreamIndex: defaultAudio?.stream_index,
                    DefaultSubtitleStreamIndex: defaultSub?.stream_index,
                });
            }

            serialized.MediaSources = mediaSources;
        } else if (
            // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- serialized.Type is the Jellyfin PascalCase contract.
            serialized.Type !== 'Series' &&
            // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- serialized.Type is the Jellyfin PascalCase contract.
            serialized.Type !== 'Season' &&
            serialized.Type !== 'MusicAlbum' &&
            serialized.Type !== 'MusicArtist' &&
            serialized.Type !== 'CollectionFolder' &&
            serialized.Type !== 'BoxSet' &&
            serialized.Type !== 'Playlist'
        ) {
            // Playable items without files — Swiftfin disables play button if missing.
            // Folder-type items (Series/Season/MusicAlbum/etc.) must NOT include
            // MediaSources at all — Jellyfin omits the field entirely on those, and
            // Infuse fails to render the series detail page when it sees an empty
            // MediaSources array on a folder item.
            serialized.MediaSources = [];
        }

        // Detail is Jellyfin's full DtoOptions: every field, top-level
        // MediaStreams included (clients list audio/subtitle tracks from it).
        await enrichItemsWithItemDetails(sql, [serialized]);
        addSourceDerivedFields([serialized], { mediaStreams: true });

        return json(serialized);
    } catch (error) {
        logger.error('Item detail query failed', error as Error, { itemId });
        return ApiResponses.error('Failed to get item detail');
    }
});
