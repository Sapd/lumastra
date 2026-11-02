// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The file an audio request will actually be served from, and what it holds —
 * shared by `/Audio/{itemId}/universal` and `/Audio/{itemId}/stream.{container}`
 * so the direct-play decision judges the same file `handleStreamFile` then
 * serves (the route pins it with `mediaSourceId=<file id>`).
 */

import type postgres from 'postgres';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries';
import { getStreamsForFile } from '$lib/server/database/queries/media-streams.queries';
import type { MediaFileRow } from '$lib/server/database/queries/media-files.queries';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { containerFromPath } from './media-container-utils';
import { validatePlayToken } from './play-token';
import type { UniversalAudioSource } from './universal-audio';

/** The file `mediaSourceId` names (a media_files id or PlaybackInfo's file token), else the default. */
export async function pickAudioFile(
    sql: postgres.Sql,
    itemId: string,
    mediaSourceId: string | null,
): Promise<MediaFileRow | null> {
    let fileId: string | undefined;
    if (mediaSourceId) {
        fileId = isUuid(mediaSourceId)
            ? normalizeUuid(mediaSourceId)
            : ((await validatePlayToken(mediaSourceId))?.fileId ?? undefined);
    }
    let selection = await resolvePlaybackSelection(sql, itemId, { fileId });
    // A source id of another item (stale client cache) falls back to the default.
    if (fileId && selection.files.length === 0) {
        selection = await resolvePlaybackSelection(sql, itemId);
    }
    return selection.files.find((f) => f.id === selection.fileId) ?? null;
}

/** Container (from the extension), default audio stream's codec and limits, file bitrate. */
export async function describeAudioSource(
    sql: postgres.Sql,
    file: MediaFileRow,
): Promise<UniversalAudioSource> {
    const audio = (await getStreamsForFile(sql, file.id))
        .filter((s) => s.stream_type === 'audio' && !s.is_external)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default))[0];
    return {
        container: containerFromPath(file.file_path),
        codec: audio?.codec ?? null,
        bitrate:
            file.total_bitrate !== null ? Number(file.total_bitrate) : (audio?.bitrate ?? null),
        sampleRate: audio?.sample_rate ?? null,
        channels: audio?.channels ?? null,
        bitDepth: audio?.bit_depth ?? null,
    };
}
