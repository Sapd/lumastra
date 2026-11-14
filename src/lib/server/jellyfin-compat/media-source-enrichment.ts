// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media-Source Enrichment for Jellyfin Compat Browse/Search Responses
 *
 * Real Jellyfin's browse + search responses populate top-level Container /
 * Path / VideoType / HasSubtitles AND a MediaSources[] array containing one
 * entry per file (multi-version movies show up as multiple MediaSources, e.g.
 * 4K + 1080p). Without this shape, Infuse silently drops Movie/Episode hits
 * that look like "FileSystem" but have no source info.
 *
 * This helper consolidates what was previously inlined in five places
 * (/j/Items browse, /j/Items search, /j/Items idList, /j/Users/[id]/Items,
 * /j/Shows/[id]/Episodes) into one function. Multi-version support: where
 * an item has N media_files rows, the resulting MediaSources[] has N
 * entries; the first is Type:'Default' (Jellyfin's primary version flag)
 * and the rest are Type:'Grouping' (alternate versions).
 *
 * Multi-part movies (media_files.part_number 1, 2, …) are not versions: the item
 * lists only part 1 and carries PartCount; parts 2..N are items of their own
 * (multi-part.ts, /j/Videos/{id}/AdditionalParts).
 */
import type postgres from 'postgres';
import type { JellyfinBaseItemDto, JellyfinItemType, JellyfinMediaSourceInfo } from './types';
import { mapBrowseStreamRow } from './serializers/base-item';
import { deriveQualityLabel } from './media-container-utils';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { fileRunTimeTicks, partCountFor, partLayout, type PartFile } from './multi-part';

const CONTAINER_MAP: Record<string, string> = {
    mkv: 'mkv',
    mp4: 'mp4',
    avi: 'avi',
    ts: 'ts',
    m4v: 'mp4',
    webm: 'webm',
};

const PLAYABLE_TYPES: ReadonlySet<JellyfinItemType> = new Set([
    'Movie',
    'Episode',
    'Audio',
    'Video',
    'Trailer',
]);

interface FileRow {
    media_item_id: string;
    file_id: string;
    file_path: string | null;
    file_size_bytes: number | bigint | null;
    total_bitrate: number | null;
    created_at: Date | string;
    edition: string | null;
    part_number: number | null;
    duration_seconds: number | string | null;
}

type LayoutFile = FileRow & PartFile;

const asLayoutFile = (f: FileRow): LayoutFile => ({ ...f, id: f.file_id });

type StreamRow = Record<string, unknown>;

function inferContainer(filePath: string | null): string {
    if (!filePath) return 'mkv';
    // Use lastIndexOf so files with no dot (e.g. 'README') don't return the
    // whole basename as the extension.
    const dot = filePath.lastIndexOf('.');
    if (dot < 0) return 'mkv';
    const ext = filePath.slice(dot + 1).toLowerCase();
    return CONTAINER_MAP[ext] ?? 'mkv';
}

/**
 * 8-char ETag derived from the file UUID. Defensive padding so non-UUID
 * file_id values (shouldn't happen, but cheap) still produce a fixed-width
 * tag for client revalidation.
 */
function shortETag(fileId: string): string {
    return (fileId.replace(/-/g, '') + '00000000').slice(0, 8);
}

/**
 * In-place: drop playable items (Movie / Episode / Audio / Video) that
 * didn't gain MediaSources during enrichment. Real Jellyfin would mark
 * those items LocationType:'Virtual'; we don't have that data, and
 * emitting LocationType:'FileSystem' with no Container/Path/MediaSources
 * is a malformed shape that Infuse rejects — losing the whole response,
 * not just the bad item.
 *
 * Folder-type items (Series, Season, MusicAlbum, MusicArtist) are kept
 * regardless — they don't carry MediaSources by design.
 */
export function dropFilelessPlayables(items: JellyfinBaseItemDto[]): JellyfinBaseItemDto[] {
    return items.filter((i) => {
        if (!PLAYABLE_TYPES.has(i.Type)) return true;
        return (i.MediaSources?.length ?? 0) > 0;
    });
}

/**
 * Enrich serialized BaseItemDtos with file/stream-derived MediaSources.
 * Mutates `items` in place. No-op for items that have no files or whose
 * Type is not playable (Series, Season, MusicAlbum, etc. stay folder-shaped).
 */
export async function enrichItemsWithMediaSources(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
    apiKey: string,
): Promise<void> {
    const playable = items.filter((i) => PLAYABLE_TYPES.has(i.Type));
    // Defensive: non-UUID Ids would crash the ::uuid[] cast below and 500
    // the whole endpoint. In practice all serialized item IDs are UUIDs,
    // but a single bad row from a future migration could break enrichment
    // for every item in the response.
    const playableIds = [...new Set(playable.map((i) => i.Id).filter((id) => isUuid(id)))];
    if (playableIds.length === 0) return;

    // Fetch ALL files per item (not DISTINCT ON) so multi-version movies
    // surface every version. Same order as getFilesForMediaItem (Items/{id},
    // PlaybackInfo, AdditionalParts), so list and detail agree on the primary
    // (Type:'Default') and on a multi-part movie's parts; created_at (earliest
    // scan first) breaks ties.
    const fileRows = (await sql`
        SELECT mfi.media_item_id, mf.id as file_id, mf.file_path,
               mf.file_size_bytes, mf.total_bitrate, mf.created_at,
               mf.edition, mf.part_number, mf.duration_seconds
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mfi.media_item_id = ANY(${playableIds}::uuid[])
        ORDER BY mfi.media_item_id, mfi.sort_order, mf.part_number NULLS FIRST,
                 mf.created_at ASC, mf.id
    `) as unknown as FileRow[];

    if (fileRows.length === 0) return;

    const filesByItem = new Map<string, FileRow[]>();
    for (const row of fileRows) {
        const id = row.media_item_id;
        if (!filesByItem.has(id)) filesByItem.set(id, []);
        filesByItem.get(id)!.push(row);
    }

    const streamsByFile = await streamsForFiles(
        sql,
        fileRows.map((f) => f.file_id),
    );

    for (const item of playable) {
        const all = filesByItem.get(item.Id);
        if (!all || all.length === 0) continue;
        // Parts 2..N of a stacked movie are no versions: only part 1 is listed.
        const layout = partLayout(all.map(asLayoutFile));
        const files = layout.sources;
        item.PartCount = partCountFor(layout, files[0].id);
        applySources(
            item,
            files,
            streamsByFile,
            apiKey,
            item.Id,
            (id) => layout.partIndex(id) >= 0,
        );
    }
}

/**
 * Enrich the items of parts 2..N (multi-part.ts toPartItem) with their one
 * MediaSource each. `partItems[i].Id` is the part's media_files id; the stream
 * URLs name the owning movie, as every other /j MediaSource does.
 */
export async function enrichPartItemsWithMediaSources(
    sql: postgres.Sql,
    ownerItemId: string,
    partItems: JellyfinBaseItemDto[],
    apiKey: string,
): Promise<void> {
    if (partItems.length === 0) return;
    const ids = partItems.map((i) => i.Id);
    const fileRows = (await sql`
        SELECT mf.id as file_id, mf.file_path, mf.file_size_bytes, mf.total_bitrate,
               mf.created_at, mf.edition, mf.part_number, mf.duration_seconds
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id AND mfi.media_item_id = ${ownerItemId}
        WHERE mf.id = ANY(${ids}::uuid[])
    `) as unknown as FileRow[];
    const byId = new Map(fileRows.map((r) => [r.file_id, r]));
    const streamsByFile = await streamsForFiles(sql, ids);
    for (const item of partItems) {
        const f = byId.get(item.Id);
        if (f)
            applySources(item, [asLayoutFile(f)], streamsByFile, apiKey, ownerItemId, () => true);
    }
}

async function streamsForFiles(
    sql: postgres.Sql,
    fileIds: string[],
): Promise<Map<string, StreamRow[]>> {
    const streamRows = (await sql`
        SELECT file_id, stream_index, stream_type, codec, codec_tag, language, title,
               display_title, is_default, is_forced, is_external,
               width, height, bitrate, channels, sample_rate, channel_layout,
               is_text_subtitle, video_range, video_range_type,
               aspect_ratio, profile, level, bit_depth, is_anamorphic,
               average_frame_rate, color_space, color_primaries, color_transfer,
               pixel_format, ref_frames, is_hearing_impaired,
               dv_profile, dv_level, dv_bl_signal_compatibility_id
        FROM media_streams
        WHERE file_id = ANY(${fileIds}::uuid[])
        ORDER BY file_id, stream_type, stream_index
    `) as unknown as StreamRow[];

    const streamsByFile = new Map<string, StreamRow[]>();
    for (const s of streamRows) {
        const fid = s.file_id as string;
        if (!streamsByFile.has(fid)) streamsByFile.set(fid, []);
        streamsByFile.get(fid)!.push(s);
    }
    return streamsByFile;
}

function applySources(
    item: JellyfinBaseItemDto,
    files: LayoutFile[],
    streamsByFile: Map<string, StreamRow[]>,
    apiKey: string,
    urlItemId: string,
    isPart: (fileId: string) => boolean,
): void {
    // Top-level fields use the first (primary) file. Real Jellyfin does
    // the same — the top-level Container/Path/VideoType describes the
    // default playback target; the MediaSources[] array carries the rest.
    const primary = files[0];
    item.Container = inferContainer(primary.file_path);
    item.Path = primary.file_path ?? undefined;
    item.VideoType = 'VideoFile';
    // True if any version of this item has at least one subtitle stream.
    item.HasSubtitles = files.some((f) =>
        (streamsByFile.get(f.file_id) ?? []).some((s) => s.stream_type === 'subtitle'),
    );

    // URL components must be encoded — apiKey is hex today, but item.Id
    // and file_id come from DB columns and a future non-UUID format
    // (custom IDs, composite keys) would otherwise corrupt the query
    // string.
    const encodedItemId = encodeURIComponent(urlItemId);
    const encodedApiKey = encodeURIComponent(apiKey);

    item.MediaSources = files.map((f, idx): JellyfinMediaSourceInfo => {
        const container = inferContainer(f.file_path);
        const eTag = shortETag(f.file_id);
        const rawStreams = streamsByFile.get(f.file_id) ?? [];
        const mediaStreams = rawStreams.map((s) => mapBrowseStreamRow(s));
        const defaultAudioRow = rawStreams.find(
            (s) => s.stream_type === 'audio' && (s.is_default as boolean),
        );
        // stream_index 0 is valid (Jellyfin uses 0-indexed streams),
        // so `?? undefined` not `|| undefined`.
        const defaultAudioIdx =
            defaultAudioRow !== undefined ? (defaultAudioRow.stream_index as number) : undefined;
        const encodedFileId = encodeURIComponent(f.file_id);

        return {
            Id: f.file_id,
            // Real Jellyfin marks the first MediaSource as 'Default'
            // and any additional versions as 'Grouping'. Infuse uses
            // this to render a "Play 4K / Play 1080p" picker.
            Type: idx === 0 ? 'Default' : 'Grouping',
            Container: container,
            Protocol: 'File',
            // Quality label ('1080p', '4K HDR', etc.) lets Infuse show
            // distinguishable names in the version picker. Falls back
            // to the item title for files without a parseable quality.
            Name: f.file_path ? deriveQualityLabel(f.file_path) : item.Name,
            Path: f.file_path ?? undefined,
            ETag: eTag,
            IsRemote: false,
            // A part is its own file's length, not the movie's.
            RunTimeTicks:
                (isPart(f.file_id) ? fileRunTimeTicks(f) : undefined) ?? item.RunTimeTicks,
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
            // != null preserves legitimate 0 (zero-byte / unprocessed
            // files) instead of coercing them to undefined.
            Size: f.file_size_bytes != null ? Number(f.file_size_bytes) : undefined,
            Bitrate: f.total_bitrate != null ? Number(f.total_bitrate) : undefined,
            SupportsDirectPlay: true,
            SupportsDirectStream: true,
            SupportsTranscoding: true,
            DirectStreamUrl: `/Videos/${encodedItemId}/stream?static=true&mediaSourceId=${encodedFileId}&tag=${eTag}&api_key=${encodedApiKey}`,
            TranscodingUrl: `/Videos/${encodedItemId}/master.m3u8?MediaSourceId=${encodedFileId}&api_key=${encodedApiKey}`,
            TranscodingContainer: 'ts',
            TranscodingSubProtocol: 'hls',
            MediaStreams: mediaStreams,
            MediaAttachments: [],
            Formats: [],
            RequiredHttpHeaders: {},
            HasSegments: false,
            DefaultAudioStreamIndex: defaultAudioIdx,
        };
    });
}
