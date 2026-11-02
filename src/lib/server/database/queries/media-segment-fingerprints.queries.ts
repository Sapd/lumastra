// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { analyzableVideoFileSql, analyzerStageEvidenceSql } from './media-segment-input.queries.js';
import { ANALYZER_ACOUSTIC_VERSION } from '$lib/server/tasks/builtin/native/intro-analyzer/settings.js';

/** Retain all windows until the entire cohort has durable acoustic coverage. */
export async function pruneCompletedSeasonFingerprints(
    sql: postgres.Sql,
    seasonIds?: readonly string[],
): Promise<void> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged cleanup of local derived checkpoints, never a user-facing media query.
    await sql`
        WITH seasons AS MATERIALIZED (
            SELECT DISTINCT owner.parent_id AS id
            FROM media_segment_fingerprints f JOIN media_items owner ON owner.id=f.media_id
            WHERE owner.media_type='episode' AND owner.parent_id IS NOT NULL
              ${seasonIds ? sql`AND owner.parent_id=ANY(${[...seasonIds]}::uuid[])` : sql``}
        ), closed AS MATERIALIZED (
            SELECT s.id FROM seasons s WHERE NOT EXISTS (
                SELECT 1 FROM media_items ep WHERE ep.parent_id=s.id
                  AND ep.media_type='episode' AND ep.status<>'deleted'
                  AND EXISTS (SELECT 1 FROM media_file_items mfi JOIN media_files mf ON mf.id=mfi.file_id
                              WHERE mfi.media_item_id=ep.id AND ${analyzableVideoFileSql(sql)})
                  AND NOT EXISTS (
                      SELECT 1 FROM media_item_stage_state miss
                      WHERE miss.media_item_id=ep.id AND miss.stage_id='lumastra-intro-analyzer:acoustic'
                        AND miss.processing_version>=${ANALYZER_ACOUSTIC_VERSION}
                        AND miss.status IN ('completed','skipped_permanent')
                        AND ${analyzerStageEvidenceSql(sql)}
                  )
            )
        )
        DELETE FROM media_segment_fingerprints f USING media_items ep, closed s
        WHERE f.media_id=ep.id AND ep.parent_id=s.id
    `;
}

export interface FingerprintIdentity {
    mediaId: string;
    pass: 'intro' | 'credits';
    inputIdentity: string;
    physicalIdentity: string;
    processingVersion: number;
    startSec: number;
    endSec: number;
}

export async function loadFingerprint(
    sql: postgres.Sql,
    key: FingerprintIdentity,
): Promise<Uint32Array | null> {
    const [row] = await sql<{ points: Buffer }[]>`
        SELECT points FROM media_segment_fingerprints
        WHERE media_id=${key.mediaId}::uuid AND pass=${key.pass}
          AND input_identity=${key.inputIdentity} AND physical_identity=${key.physicalIdentity}
          AND processing_version=${key.processingVersion}
          AND start_sec=${key.startSec} AND end_sec=${key.endSec}
    `;
    if (!row) return null;
    const points = new Uint32Array(row.points.length / 4);
    for (let i = 0; i < points.length; i++) points[i] = row.points.readUInt32LE(i * 4);
    return points;
}

export async function saveFingerprint(
    sql: postgres.Sql,
    key: FingerprintIdentity,
    points: Uint32Array,
): Promise<void> {
    const bytes = Buffer.alloc(points.length * 4);
    for (let i = 0; i < points.length; i++) bytes.writeUInt32LE(points[i], i * 4);
    // Replace the previous input's checkpoint, never accumulate a history of bytes.
    await sql`
        INSERT INTO media_segment_fingerprints
            (media_id,pass,input_identity,physical_identity,processing_version,start_sec,end_sec,points)
        VALUES (${key.mediaId}::uuid,${key.pass},${key.inputIdentity},${key.physicalIdentity},
                ${key.processingVersion},${key.startSec},${key.endSec},${bytes})
        ON CONFLICT(media_id,pass) DO UPDATE SET
            input_identity=EXCLUDED.input_identity,physical_identity=EXCLUDED.physical_identity,
            processing_version=EXCLUDED.processing_version,start_sec=EXCLUDED.start_sec,
            end_sec=EXCLUDED.end_sec,points=EXCLUDED.points
    `;
}
