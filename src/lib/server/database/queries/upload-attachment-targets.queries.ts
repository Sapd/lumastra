// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { join, basename } from 'node:path';
import type { UploadAttachmentTargets } from '$lib/schemas/api-upload-responses.js';
import type { UploadSessionRow } from './upload-sessions.queries.js';

/** Resolve the exact finalized file inside the session's library, never a title guess. */
export async function resolveUploadAttachmentTargets(
    sql: postgres.Sql,
    session: UploadSessionRow,
    libraryRoot: string,
): Promise<UploadAttachmentTargets> {
    if (session.status === 'failed' || session.status === 'aborted')
        return { status: 'failed', targets: [] };
    if (session.status !== 'queued') return { status: 'pending', targets: [] };
    const path =
        session.final_path ??
        join(libraryRoot, session.destination_folder, basename(session.filename));
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Admin upload owner resolved by the caller; exact session file and library path only.
    const targets = await sql<
        { id: string; title: string; seasonNumber?: number; episodeNumber?: number }[]
    >`
        SELECT DISTINCT mi.id,COALESCE(mi.title,${session.filename}) AS title,
            mi.season_number AS "seasonNumber",mi.episode_number AS "episodeNumber"
        FROM media_files mf JOIN library_paths lp ON lp.id=${session.library_path_id}
            AND mf.library_group_id=lp.library_group_id
        JOIN media_file_items mfi ON mfi.file_id=mf.id
        JOIN media_items mi ON mi.id=mfi.media_item_id
        WHERE mf.file_path=${path}
            AND NOT mf.is_missing AND mi.status<>'deleted'
        ORDER BY mi.id`;
    const normalized = targets.map((target) => ({
        ...target,
        seasonNumber: target.seasonNumber ?? undefined,
        episodeNumber: target.episodeNumber ?? undefined,
    }));
    const explicit = normalized.find((target) => target.id === session.media_item_id)?.id;
    const targetId = session.media_item_id
        ? explicit
        : normalized.length === 1
          ? normalized[0].id
          : undefined;
    return {
        status: targetId ? 'ready' : normalized.length ? 'ambiguous' : 'pending',
        targets: normalized,
        targetId,
    };
}
