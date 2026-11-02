// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { safeStatBigInt } from '$lib/server/utils/safe-fs.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { acquireMediaSegmentResolutionLocks } from '$lib/server/database/media-segment-resolution-lock.js';
import { lockAncestorChain } from '$lib/server/database/queries/media-files.queries.js';
import {
    analyzerFileGenerationSql,
    analyzerMediaGenerationSql,
    analyzerLiveAncestrySql,
} from '$lib/server/database/queries/media-segment-input.queries.js';
import { upsertLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import { withArtworkChoice } from './artwork-choice.service.js';
import { resolveExtractionSpan } from './video-frame-extractor.service.js';

export interface ExplicitEpisodeThumbnailInput {
    episodeId: string;
    fileId: string;
    videoPath: string;
    selectedCandidateId: string | null;
    durationSeconds: number;
    fileGeneration: string;
    mediaGeneration: string;
    siblingGeneration: string;
    artworkGeneration: string;
    physicalIdentity: string;
    span: { base: number; duration: number };
}

export function explicitEpisodeThumbnailReviewToken(input: ExplicitEpisodeThumbnailInput): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

interface InputRow {
    fileId: string;
    videoPath: string;
    selectedCandidateId: string | null;
    durationSeconds: number;
    fileGeneration: string;
    mediaGeneration: string;
    siblingGeneration: string;
    artworkGeneration: string;
}

/** A complete observation of the source and the artwork slot an admin intends to replace. */
export async function captureExplicitEpisodeThumbnailInput(
    sql: postgres.Sql,
    episodeId: string,
    signal?: AbortSignal,
): Promise<ExplicitEpisodeThumbnailInput | null> {
    if (signal?.aborted) return null;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged extraction for one episode, with no user-facing catalog projection.
    const [row] = await sql<InputRow[]>`
        SELECT mf.id AS "fileId", mf.file_path AS "videoPath",
            (SELECT c.id FROM image_candidates c WHERE c.media_item_id=ep.id
                AND c.artwork_type='thumb' AND c.selected ORDER BY c.id LIMIT 1) AS "selectedCandidateId",
            mf.duration_seconds AS "durationSeconds",
            ${analyzerFileGenerationSql(sql)} AS "fileGeneration",
            ${analyzerMediaGenerationSql(sql, 'ep')} AS "mediaGeneration",
            (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(
                sibling.id, sibling.parent_id, sibling.episode_number,
                sibling.media_segment_generation, link.file_id, link.is_default,
                link.start_offset_ms, link.end_offset_ms
            ) ORDER BY sibling.id, link.file_id)::text, '[]'))
             FROM media_file_items link
             JOIN media_files sibling_file ON sibling_file.id=link.file_id
             JOIN media_items sibling ON sibling.id=link.media_item_id AND sibling.media_type='episode'
             WHERE sibling_file.file_path=mf.file_path) AS "siblingGeneration",
            md5(jsonb_build_array(
                (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.id, c.file_path, c.remote_url,
                    c.provider, c.provider_ref, c.selected, c.locked, c.chosen_by,
                    c.selection_order, c.updated_at) ORDER BY c.id), '[]'::jsonb)
                 FROM image_candidates c WHERE c.media_item_id=ep.id AND c.artwork_type='thumb'),
                (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.file_path), '[]'::jsonb)
                 FROM media_artwork_suppressions s WHERE s.media_item_id=ep.id AND s.artwork_type='thumb'),
                (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.provider, p.role), '[]'::jsonb)
                 FROM image_provider_suppressions p WHERE p.owner=ep.id::text AND p.role IN ('*','thumb')),
                ep.custom_thumb_url
            )::text) AS "artworkGeneration"
        FROM media_items ep
        JOIN media_file_items mfi ON mfi.media_item_id=ep.id AND mfi.is_default
        JOIN media_files mf ON mf.id=mfi.file_id
        WHERE ep.id=${episodeId} AND ep.media_type='episode'
          AND ${analyzerLiveAncestrySql(sql, 'ep')}
          AND NOT mf.is_missing AND mf.file_path IS NOT NULL
          AND mf.duration_seconds > 0
          AND ((mfi.start_offset_ms IS NULL AND mfi.end_offset_ms IS NULL)
            OR (mfi.start_offset_ms>=0 AND mfi.end_offset_ms>mfi.start_offset_ms
              AND mfi.end_offset_ms<=FLOOR(mf.duration_seconds*1000+0.5)::bigint))`;
    if (!row || signal?.aborted) return null;
    try {
        const stat = await safeStatBigInt(row.videoPath, 5000, signal);
        const span = (await resolveExtractionSpan(
            sql,
            episodeId,
            row.videoPath,
            Number(row.durationSeconds),
        )) ?? { base: 0, duration: Number(row.durationSeconds) };
        if (signal?.aborted) return null;
        return {
            ...row,
            episodeId,
            durationSeconds: Number(row.durationSeconds),
            physicalIdentity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
            span,
        };
    } catch {
        return null;
    }
}

function sameInput(a: ExplicitEpisodeThumbnailInput, b: ExplicitEpisodeThumbnailInput): boolean {
    return (
        a.episodeId === b.episodeId &&
        a.fileId === b.fileId &&
        a.videoPath === b.videoPath &&
        a.selectedCandidateId === b.selectedCandidateId &&
        a.durationSeconds === b.durationSeconds &&
        a.fileGeneration === b.fileGeneration &&
        a.mediaGeneration === b.mediaGeneration &&
        a.siblingGeneration === b.siblingGeneration &&
        a.artworkGeneration === b.artworkGeneration &&
        a.physicalIdentity === b.physicalIdentity &&
        a.span.base === b.span.base &&
        a.span.duration === b.span.duration
    );
}

export async function isExplicitEpisodeThumbnailInputCurrent(
    sql: postgres.Sql,
    input: ExplicitEpisodeThumbnailInput,
    signal?: AbortSignal,
): Promise<boolean> {
    const current = await captureExplicitEpisodeThumbnailInput(sql, input.episodeId, signal);
    return current !== null && sameInput(input, current);
}

class StaleExtraction extends Error {}

/** Hold source, resolution, ancestor and artwork-owner locks until selection commits. */
export async function publishExplicitEpisodeThumbnail(
    sql: postgres.Sql,
    input: ExplicitEpisodeThumbnailInput,
    outputPath: string,
    signal?: AbortSignal,
): Promise<boolean> {
    if (signal?.aborted) return false;
    try {
        return await withTx(sql, async (raw) => {
            const tx = raw as unknown as postgres.Sql;
            const [settings] = await tx<
                { timeout: string }[]
            >`SELECT current_setting('lock_timeout') AS timeout`;
            await tx`SELECT set_config('lock_timeout','100ms',true)`;
            await tx`SELECT id FROM media_files WHERE file_path=${input.videoPath} ORDER BY id FOR UPDATE`;
            const [attachment] = await tx<{ acquired: boolean }[]>`
                SELECT pg_try_advisory_xact_lock(hashtext(${input.episodeId})) AS acquired`;
            if (!attachment.acquired) throw new StaleExtraction();
            await acquireMediaSegmentResolutionLocks(tx, [input.episodeId]);
            await lockAncestorChain(tx, [input.episodeId]);
            await tx`SELECT file_id FROM media_file_items WHERE media_item_id=${input.episodeId} FOR UPDATE`;
            // Keep all contributors to a proportional span fixed. File-row locks
            // also exclude new links through the FK until this transaction ends.
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged publication fence for owners of one physical source.
            await tx`SELECT mi.id FROM media_file_items mfi
                JOIN media_files mf ON mf.id=mfi.file_id
                JOIN media_items mi ON mi.id=mfi.media_item_id AND mi.media_type='episode'
                WHERE mf.file_path=${input.videoPath}
                ORDER BY mi.id FOR SHARE OF mi,mfi NOWAIT`;
            await tx`SELECT set_config('lock_timeout',${settings.timeout},true)`;
            if (!(await isExplicitEpisodeThumbnailInputCurrent(tx, input, signal))) return false;
            if (signal?.aborted) return false;
            const output = await safeStatBigInt(outputPath, 5000, signal).catch(() => null);
            if (!output?.isFile() || output.size <= 0n) return false;
            const { value: wrote } = await withArtworkChoice(
                tx,
                input.episodeId,
                'admin',
                async (artworkTx) =>
                    upsertLocalArtwork(artworkTx, {
                        mediaItemId: input.episodeId,
                        artworkType: 'thumb',
                        filePath: outputPath,
                        sourceTag: 'generated:ffmpeg',
                        provider: 'frame-extract',
                        chosenBy: 'admin',
                    }),
            );
            if (!wrote || signal?.aborted) throw new StaleExtraction();
            const [selected] = await tx<{ selected: boolean }[]>`
                SELECT EXISTS(SELECT 1 FROM image_candidates WHERE media_item_id=${input.episodeId}
                    AND artwork_type='thumb' AND file_path=${outputPath} AND selected
                    AND chosen_by='admin' AND provider='frame-extract') AS selected`;
            // The filesystem is outside PostgreSQL's lock domain. Check once
            // more after registration and roll the transaction back if bytes
            // or inode changed during its short write phase.
            const stat = await safeStatBigInt(input.videoPath, 5000, signal).catch(() => null);
            const physical =
                stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
            if (signal?.aborted || !selected.selected || physical !== input.physicalIdentity)
                throw new StaleExtraction();
            return true;
        });
    } catch (error) {
        if (
            error instanceof StaleExtraction ||
            ['55P03', '40P01'].includes((error as { code?: string }).code ?? '')
        )
            return false;
        throw error;
    }
}
