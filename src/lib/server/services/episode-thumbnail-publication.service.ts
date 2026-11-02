// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { ownsEpisodeThumb } from '$lib/server/utils/episode-thumbnail-ownership.js';
import { buildPatterns } from '$lib/server/utils/image-scan-patterns.js';
import { config } from '$lib/server/config.js';
import { resolveExtractionSpan } from './video-frame-extractor.service.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { acquireMediaSegmentResolutionLocks } from '$lib/server/database/media-segment-resolution-lock.js';
import { lockAncestorChain } from '$lib/server/database/queries/media-files.queries.js';
import {
    analyzerFileGenerationSql,
    analyzerMediaGenerationSql,
    analyzerLiveAncestrySql,
} from '$lib/server/database/queries/media-segment-input.queries.js';
import {
    hasArtworkSuppressionForType,
    upsertLocalArtwork,
    type EpisodeThumbnailWorkRow,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { safeStatBigInt } from '$lib/server/utils/safe-fs.js';

interface OrdinaryThumbnailRepair {
    id: string;
    filePath: string;
    proofId: string;
    proofOwnerId: string;
    proofFileId: string;
    proofVideoPath: string;
    ownerVideoPaths: string[];
    proofVideoPaths: string[];
    ownerSeasonNumber: number | null;
    ownerEpisodeNumber: number | null;
    proofSeasonNumber: number | null;
    proofEpisodeNumber: number | null;
}

interface ThumbnailInput {
    fileGeneration: string;
    mediaGeneration: string;
    physicalIdentity: string;
    ordinaryRepairs: OrdinaryThumbnailRepair[];
    extractionSpan: { base: number; duration: number };
}

/** An ordinary shared path is provably misplaced only when another current
 * episode owns that sidecar under the canonical ownership rules. Arbitrary unique names are
 * outside this repair, as are groups with no authoritative sidecar owner.
 */
async function findOrdinaryWrongOwners(
    sql: postgres.Sql,
    row: EpisodeThumbnailWorkRow,
    observed?: OrdinaryThumbnailRepair,
): Promise<OrdinaryThumbnailRepair[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Internal maintenance ownership proof for one captured thumbnail association; no user-facing metadata.
    const proofs = await sql<OrdinaryThumbnailRepair[]>`
        SELECT own.id,own.file_path AS "filePath",proven.id AS "proofId",owner.id AS "proofOwnerId",
            mf.id AS "proofFileId",mf.file_path AS "proofVideoPath",
            ARRAY(SELECT own_file.file_path FROM media_file_items own_link
                JOIN media_files own_file ON own_file.id=own_link.file_id
                WHERE own_link.media_item_id=own.media_item_id AND NOT own_file.is_missing) AS "ownerVideoPaths",
            ARRAY(SELECT proof_file.file_path FROM media_file_items proof_link
                JOIN media_files proof_file ON proof_file.id=proof_link.file_id
                WHERE proof_link.media_item_id=owner.id AND NOT proof_file.is_missing) AS "proofVideoPaths",
            own_owner.season_number AS "ownerSeasonNumber", own_owner.episode_number AS "ownerEpisodeNumber",
            owner.season_number AS "proofSeasonNumber", owner.episode_number AS "proofEpisodeNumber"
        FROM image_candidates own
        JOIN media_items own_owner ON own_owner.id=own.media_item_id
        JOIN image_candidates proven ON proven.file_path=own.file_path AND proven.artwork_type='thumb'
            AND proven.selected AND proven.source='local' AND proven.media_item_id<>own.media_item_id
        JOIN media_items owner ON owner.id=proven.media_item_id AND owner.media_type='episode' AND owner.status<>'deleted'
        JOIN media_file_items other_link ON other_link.media_item_id=owner.id AND other_link.is_default
            AND other_link.start_offset_ms IS NULL AND other_link.end_offset_ms IS NULL
        JOIN media_files mf ON mf.id=other_link.file_id AND NOT mf.is_missing
        WHERE own.media_item_id=${row.episodeId} AND own.artwork_type='thumb'
            AND own.source='local' AND own.provider='local-folder' AND own.chosen_by='auto' AND NOT own.locked
            AND own.remote_url IS NULL AND other_link.file_id<>${row.fileId}::uuid
            AND (${observed === undefined} OR (
                own.id=${observed?.id ?? null}::uuid AND own.file_path=${observed?.filePath ?? null}
                AND proven.id=${observed?.proofId ?? null}::uuid AND owner.id=${observed?.proofOwnerId ?? null}::uuid
                AND mf.id=${observed?.proofFileId ?? null}::uuid AND mf.file_path=${observed?.proofVideoPath ?? null}))
        ORDER BY own.id,proven.id
        ${observed ? sql`FOR UPDATE OF own NOWAIT FOR SHARE OF proven,other_link,mf,own_owner,owner NOWAIT` : sql``}`;
    const repairs = new Map<string, OrdinaryThumbnailRepair>();
    for (const proof of proofs) {
        const patterns = buildPatterns(config.IMAGE_SYNC_LOCAL_PATTERNS).episode;
        const belongsToOwner = ownsEpisodeThumb(
            proof.filePath,
            proof.ownerVideoPaths,
            row.episodeId,
            {
                seasonNumber: proof.ownerSeasonNumber,
                episodeNumber: proof.ownerEpisodeNumber,
                patterns,
            },
        );
        if (
            !belongsToOwner &&
            ownsEpisodeThumb(proof.filePath, proof.proofVideoPaths, proof.proofOwnerId, {
                seasonNumber: proof.proofSeasonNumber,
                episodeNumber: proof.proofEpisodeNumber,
                patterns,
            }) &&
            !repairs.has(proof.id)
        ) {
            repairs.set(proof.id, proof);
        }
    }
    return [...repairs.values()];
}

async function physicalIdentity(path: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    try {
        const stat = await safeStatBigInt(path, 5000, signal);
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch {
        return null;
    }
}

/** Capture only the current playable source, never a protected artwork choice. */
export async function captureEpisodeThumbnailInput(
    sql: postgres.Sql,
    row: EpisodeThumbnailWorkRow,
    signal: AbortSignal,
): Promise<ThumbnailInput | null> {
    if (signal.aborted) return null;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Internal scheduled repair of one captured owner; returns only source fingerprints, never user-facing library metadata.
    const [input] = await sql<Pick<ThumbnailInput, 'fileGeneration' | 'mediaGeneration'>[]>`
        SELECT ${analyzerFileGenerationSql(sql)} AS "fileGeneration",
            ${analyzerMediaGenerationSql(sql, 'ep')} AS "mediaGeneration"
        FROM media_items ep
        JOIN media_file_items mfi ON mfi.media_item_id=ep.id AND mfi.is_default
        JOIN media_files mf ON mf.id=mfi.file_id
        WHERE ep.id=${row.episodeId} AND ep.media_type='episode'
          AND ${analyzerLiveAncestrySql(sql, 'ep')}
          AND mf.id=${row.fileId} AND mf.file_path=${row.videoPath}
          AND NOT mf.is_missing AND mf.duration_seconds=${row.durationSeconds}
          AND mfi.start_offset_ms IS NOT DISTINCT FROM ${row.startOffsetMs}::bigint
          AND mfi.end_offset_ms IS NOT DISTINCT FROM ${row.endOffsetMs}::bigint
          -- A stored window must fit the current probed source. Unbounded
          -- combined files still use the landed proportional-window resolver.
          AND ((mfi.start_offset_ms IS NULL AND mfi.end_offset_ms IS NULL)
            OR (mfi.start_offset_ms>=0 AND mfi.end_offset_ms>mfi.start_offset_ms
              AND mfi.end_offset_ms<=FLOOR(mf.duration_seconds*1000+0.5)::bigint))
          AND NOT EXISTS(SELECT 1 FROM image_candidates choice
              WHERE choice.media_item_id=ep.id AND choice.artwork_type='thumb' AND choice.selected
                AND (choice.locked OR choice.chosen_by<>'auto' OR choice.source<>'local'
                    OR choice.provider NOT IN ('local-folder','frame-extract','generated')))`;
    if (!input) return null;
    const ordinaryRepairs = await findOrdinaryWrongOwners(sql, row);
    const extractionSpan = (await resolveExtractionSpan(
        sql,
        row.episodeId,
        row.videoPath,
        Number(row.durationSeconds),
    )) ?? { base: 0, duration: Number(row.durationSeconds) };
    const physical = await physicalIdentity(row.videoPath, signal);
    return physical === null
        ? null
        : {
              ...input,
              physicalIdentity: physical,
              ordinaryRepairs,
              extractionSpan,
          };
}

class ThumbnailPublicationRejected extends Error {}

/** Publish and retire stale automatic associations only while their input is still current.
 * Files remain immutable. Ordinary election must select the replacement before it counts.
 */
export async function publishEpisodeThumbnail(
    sql: postgres.Sql,
    row: EpisodeThumbnailWorkRow,
    input: ThumbnailInput,
    outputPath: string,
    signal: AbortSignal,
    source: 'generated' | 'sidecar' = 'generated',
): Promise<boolean> {
    if (signal.aborted) return false;
    try {
        return await withTx(sql, async (raw) => {
            const tx = raw as unknown as postgres.Sql;
            // Source invalidation locks file -> resolution -> owner. Manual link
            // editing locks owner -> file, so maintenance must yield on contention
            // instead of waiting while holding the other side of that order.
            const [settings] = await tx<
                { timeout: string }[]
            >`SELECT current_setting('lock_timeout') AS timeout`;
            await tx`SELECT set_config('lock_timeout','100ms',true)`;
            // FOR UPDATE also fences new link inserts through their file FK.
            await tx`SELECT id FROM media_files WHERE file_path=${row.videoPath} ORDER BY id FOR UPDATE`;
            const [attachment] = await tx<
                { acquired: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(hashtext(${row.episodeId})) AS acquired`;
            if (!attachment.acquired) throw new ThumbnailPublicationRejected();
            await acquireMediaSegmentResolutionLocks(tx, [row.episodeId]);
            await lockAncestorChain(tx, [row.episodeId]);
            await tx`SELECT file_id FROM media_file_items WHERE media_item_id=${row.episodeId} FOR UPDATE`;
            // Proportional windows depend on every episode's default status and
            // ordering. Lock all existing links (including nondefault links that
            // could become default) and their owners before recapturing. Keep
            // these locks through publication; rechecking alone leaves a race.
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Internal publication fencing for all owners contributing to this captured physical file.
            await tx`SELECT mi.id FROM media_file_items mfi
                JOIN media_files mf ON mf.id=mfi.file_id
                JOIN media_items mi ON mi.id=mfi.media_item_id AND mi.media_type='episode'
                WHERE mf.file_path=${row.videoPath}
                ORDER BY mi.id FOR SHARE OF mi,mfi NOWAIT`;
            await tx`SELECT set_config('lock_timeout',${settings.timeout},true)`;
            if (await hasArtworkSuppressionForType(tx, row.episodeId, 'thumb')) return false;
            const output = await safeStatBigInt(outputPath, 5000, signal).catch(() => null);
            if (!output?.isFile() || output.size <= 0n) return false;
            const current = await captureEpisodeThumbnailInput(tx, row, signal);
            if (
                !current ||
                current.fileGeneration !== input.fileGeneration ||
                current.mediaGeneration !== input.mediaGeneration ||
                current.physicalIdentity !== input.physicalIdentity ||
                current.extractionSpan.base !== input.extractionSpan.base ||
                current.extractionSpan.duration !== input.extractionSpan.duration
            )
                return false;

            if (
                !(await upsertLocalArtwork(tx, {
                    mediaItemId: row.episodeId,
                    artworkType: 'thumb',
                    filePath: outputPath,
                    ...(source === 'generated' ? { sourceTag: 'generated:ffmpeg' } : {}),
                }))
            )
                return false;

            const candidates = await tx<{ id: string; file_path: string }[]>`
                SELECT id,file_path FROM image_candidates WHERE media_item_id=${row.episodeId}
                  AND artwork_type='thumb' AND source='local' AND provider='local-folder'
                  AND chosen_by='auto' AND NOT locked AND remote_url IS NULL`;
            for (const candidate of candidates) {
                let ordinaryWrong = false;
                const observed = input.ordinaryRepairs.find(
                    (repair) =>
                        repair.id === candidate.id && repair.filePath === candidate.file_path,
                );
                if (observed) {
                    const proofs = await findOrdinaryWrongOwners(tx, row, observed);
                    ordinaryWrong = proofs.length > 0;
                }
                if (ordinaryWrong) {
                    await tx`UPDATE image_candidates SET suppressed=true,selected=false WHERE id=${candidate.id}
                        AND chosen_by='auto' AND NOT locked AND provider='local-folder'`;
                }
            }
            await tx`SELECT reselect_image_candidates(${row.episodeId},'thumb')`;
            const [selected] = await tx<{ selected: boolean }[]>`
                SELECT EXISTS(SELECT 1 FROM image_candidates WHERE media_item_id=${row.episodeId}
                    AND artwork_type='thumb' AND selected AND file_path=${outputPath}
                    AND provider=${source === 'generated' ? 'frame-extract' : 'local-folder'} AND chosen_by='auto' AND NOT locked) AS selected`;
            if (
                signal.aborted ||
                !selected.selected ||
                (await physicalIdentity(row.videoPath, signal)) !== input.physicalIdentity
            )
                throw new ThumbnailPublicationRejected();
            return true;
        });
    } catch (error) {
        if (
            error instanceof ThumbnailPublicationRejected ||
            ['55P03', '40P01'].includes((error as { code?: string }).code ?? '')
        )
            return false;
        throw error;
    }
}
