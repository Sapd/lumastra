// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '../with-tx.js';

// ============================================================================
// Row / Insert interfaces
// ============================================================================

export interface MediaStreamRow {
    id: string;
    file_id: string;
    stream_type: 'audio' | 'video' | 'subtitle';
    stream_index: number;
    codec: string;
    codec_tag: string | null;
    profile: string | null;
    level: number | null;
    language: string | null;
    display_title: string | null;
    title: string | null;
    channels: number | null;
    channel_layout: string | null;
    sample_rate: number | null;
    width: number | null;
    height: number | null;
    bit_depth: number | null;
    video_range: string | null;
    video_range_type: string | null;
    color_space: string | null;
    aspect_ratio: string | null;
    average_frame_rate: number | null;
    is_anamorphic: boolean | null;
    is_external: boolean | null;
    is_text_subtitle: boolean | null;
    bitrate: number | null;
    is_default: boolean;
    is_forced: boolean;
    is_hearing_impaired: boolean;
    is_visual_impaired: boolean;
    has_closed_captions: boolean;
    dv_profile: number | null;
    dv_level: number | null;
    dv_bl_signal_compatibility_id: number | null;
    master_display: string | null;
    max_cll: string | null;
    pixel_format: string | null;
    ref_frames: number | null;
    color_primaries: string | null;
    color_transfer: string | null;
    created_at: Date;
}

export interface MediaStreamInsert {
    file_id: string;
    stream_type: 'audio' | 'video' | 'subtitle';
    stream_index: number;
    codec: string;
    codec_tag?: string | null;
    profile?: string | null;
    level?: number | null;
    language?: string | null;
    display_title?: string | null;
    title?: string | null;
    channels?: number | null;
    channel_layout?: string | null;
    sample_rate?: number | null;
    width?: number | null;
    height?: number | null;
    bit_depth?: number | null;
    video_range?: string | null;
    video_range_type?: string | null;
    color_space?: string | null;
    aspect_ratio?: string | null;
    average_frame_rate?: number | null;
    is_anamorphic?: boolean | null;
    is_external?: boolean | null;
    is_text_subtitle?: boolean | null;
    bitrate?: number | null;
    is_default: boolean;
    is_forced: boolean;
    is_hearing_impaired?: boolean;
    is_visual_impaired?: boolean;
    has_closed_captions?: boolean;
    dv_profile?: number | null;
    dv_level?: number | null;
    dv_bl_signal_compatibility_id?: number | null;
    master_display?: string | null;
    max_cll?: string | null;
    pixel_format?: string | null;
    ref_frames?: number | null;
    color_primaries?: string | null;
    color_transfer?: string | null;
}

// ============================================================================
// Query functions
// ============================================================================

/**
 * Replace all streams for a physical file (delete + insert).
 */
export async function replaceStreamsForFile(
    sql: postgres.Sql,
    fileId: string,
    streams: MediaStreamInsert[],
): Promise<void> {
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Source rows always precede dependent streams, including assessment invalidation.
        await tx`SELECT 1 FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE`;
        await tx`DELETE FROM media_streams WHERE file_id = ${fileId}`;

        if (streams.length === 0) return;

        const rows = streams.map((s) => ({
            file_id: fileId,
            stream_type: s.stream_type,
            stream_index: s.stream_index,
            codec: s.codec,
            codec_tag: s.codec_tag ?? null,
            profile: s.profile ?? null,
            level: s.level ?? null,
            language: s.language ?? null,
            display_title: s.display_title ?? null,
            title: s.title ?? null,
            channels: s.channels ?? null,
            channel_layout: s.channel_layout ?? null,
            sample_rate: s.sample_rate ?? null,
            width: s.width ?? null,
            height: s.height ?? null,
            bit_depth: s.bit_depth ?? null,
            video_range: s.video_range ?? null,
            video_range_type: s.video_range_type ?? null,
            color_space: s.color_space ?? null,
            aspect_ratio: s.aspect_ratio ?? null,
            average_frame_rate: s.average_frame_rate ?? null,
            is_anamorphic: s.is_anamorphic ?? null,
            is_external: s.is_external ?? null,
            is_text_subtitle: s.is_text_subtitle ?? null,
            bitrate: s.bitrate ?? null,
            is_default: s.is_default,
            is_forced: s.is_forced,
            is_hearing_impaired: s.is_hearing_impaired ?? false,
            is_visual_impaired: s.is_visual_impaired ?? false,
            has_closed_captions: s.has_closed_captions ?? false,
            dv_profile: s.dv_profile ?? null,
            dv_level: s.dv_level ?? null,
            dv_bl_signal_compatibility_id: s.dv_bl_signal_compatibility_id ?? null,
            master_display: s.master_display ?? null,
            max_cll: s.max_cll ?? null,
            pixel_format: s.pixel_format ?? null,
            ref_frames: s.ref_frames ?? null,
            color_primaries: s.color_primaries ?? null,
            color_transfer: s.color_transfer ?? null,
        }));

        await tx`INSERT INTO media_streams ${tx(rows, ...STREAM_COLUMNS)}`;
    });
}

const STREAM_COLUMNS = [
    'file_id',
    'stream_type',
    'stream_index',
    'codec',
    'codec_tag',
    'profile',
    'level',
    'language',
    'display_title',
    'title',
    'channels',
    'channel_layout',
    'sample_rate',
    'width',
    'height',
    'bit_depth',
    'video_range',
    'video_range_type',
    'color_space',
    'aspect_ratio',
    'average_frame_rate',
    'is_anamorphic',
    'is_external',
    'is_text_subtitle',
    'bitrate',
    'is_default',
    'is_forced',
    'is_hearing_impaired',
    'is_visual_impaired',
    'has_closed_captions',
    'dv_profile',
    'dv_level',
    'dv_bl_signal_compatibility_id',
    'master_display',
    'max_cll',
    'pixel_format',
    'ref_frames',
    'color_primaries',
    'color_transfer',
] as const;

/**
 * Get all streams for a media item, ordered by type and index.
 */
export async function getStreamsForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaStreamRow[]> {
    return await sql<MediaStreamRow[]>`
        SELECT ms.*
        FROM media_streams ms
        JOIN media_file_items mfi ON mfi.file_id = ms.file_id
        WHERE mfi.media_item_id = ${mediaItemId}
        ORDER BY ms.stream_type, ms.stream_index
    `;
}

/**
 * Get all streams for a specific file.
 * When mediaItemId is provided, verifies the file belongs to that item.
 */
export async function getStreamsForFile(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId?: string,
): Promise<MediaStreamRow[]> {
    if (mediaItemId) {
        return await sql<MediaStreamRow[]>`
            SELECT ms.*
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE ms.file_id = ${fileId}
              AND mfi.media_item_id = ${mediaItemId}
            ORDER BY ms.stream_type, ms.stream_index
        `;
    }
    return await sql<MediaStreamRow[]>`
        SELECT *
        FROM media_streams
        WHERE file_id = ${fileId}
        ORDER BY stream_type, stream_index
    `;
}

/**
 * Get audio streams for a media item.
 */
export async function getAudioStreamsForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<MediaStreamRow[]> {
    return await sql<MediaStreamRow[]>`
        SELECT ms.*
        FROM media_streams ms
        JOIN media_file_items mfi ON mfi.file_id = ms.file_id
        WHERE ms.stream_type = 'audio'
          AND mfi.media_item_id = ${mediaItemId}
        ORDER BY ms.stream_index
    `;
}
