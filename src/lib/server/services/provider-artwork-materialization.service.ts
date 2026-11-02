// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Thumbnail Materialization Service
 *
 * Populates local Lumastra episode-thumbnail artwork (`image_candidates` rows,
 * artwork_type='thumb') for episodes that don't have one yet, walking a
 * config-ordered priority (ffmpeg frame extraction vs provider `still_path`)
 * and storing the result through the normal media image storage path so future
 * requests are served from `image_candidates` rather than a live provider call.
 *
 * Driven by the `episode-thumbnail-backfill` scheduled task.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import type { ImageProxyService } from '$lib/server/services/image-proxy/service.js';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import type { ImageResponse } from '$lib/server/services/image-proxy/types.js';
import { storeMediaImage } from './media-image-storage.service.js';
import {
    extractPosterForItem,
    type SingleExtractionResult,
} from './video-frame-extractor.service.js';
import { config } from '$lib/server/config.js';

const logger = Logger.for('ProviderArtworkMaterialization');

const DEFAULT_LIMIT = 100;
type EpisodeThumbnailStrategy = 'video' | 'provider';

export interface MaterializeProviderArtworkOptions {
    limit?: number;
    onProgress?: (processed: number, total: number, currentTitle?: string) => void;
}

export interface EpisodeThumbnailCandidate {
    id: string;
    title: string;
    /** Only whole-file local art exists for a bounded episode; extract its window. */
    needsWindowExtraction?: boolean;
}

export interface MaterializeEpisodeThumbnailResult {
    candidates: number;
    attemptedProvider: number;
    storedProvider: number;
    attemptedExtraction: number;
    extracted: number;
    skipped: number;
    errors: number;
}

interface MaterializeEpisodeThumbnailDeps {
    candidates?: EpisodeThumbnailCandidate[];
    imageService?: Pick<ImageProxyService, 'getImageByCatalogId'>;
    storeImage?: typeof storeMediaImage;
    extractFrame?: typeof extractPosterForItem;
    shouldForceVideoExtraction?: typeof shouldForceVideoExtractionForEpisodeThumb;
}

function getEpisodeThumbnailPriority(): EpisodeThumbnailStrategy[] {
    return config.EPISODE_THUMBNAIL_PREFERENCE === 'generated'
        ? ['video', 'provider']
        : ['provider', 'video'];
}

async function shouldForceVideoExtractionForEpisodeThumb(
    sql: postgres.Sql,
    candidate: EpisodeThumbnailCandidate,
): Promise<boolean> {
    if (candidate.needsWindowExtraction) return true;
    const rows = await sql<{ remote_url: string | null }[]>`
        SELECT remote_url
        FROM image_candidates
        WHERE media_item_id = ${candidate.id}
          AND artwork_type = 'thumb'
          AND source = 'local' AND NOT suppressed
        LIMIT 1
    `;

    return rows[0]?.remote_url?.startsWith('provider:') ?? false;
}

export async function findEpisodeThumbnailCandidates(
    sql: postgres.Sql,
    options: MaterializeProviderArtworkOptions = {},
): Promise<EpisodeThumbnailCandidate[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;

    return sql<EpisodeThumbnailCandidate[]>`
        SELECT ep.id, ep.title,
            EXISTS (SELECT 1 FROM image_candidates c WHERE c.media_item_id=ep.id
                AND c.artwork_type='thumb' AND c.source='local' AND NOT c.suppressed
                AND is_bounded_episode_file_thumb(ep.id,c.file_path)) AS "needsWindowExtraction"
        FROM media_items ep
        WHERE ep.status = 'active'
          AND ep.media_type = 'episode'
          AND ep.has_files = true
          AND NOT EXISTS (
              SELECT 1 FROM image_candidates c WHERE c.media_item_id=ep.id
                AND c.artwork_type='thumb' AND c.selected AND (c.chosen_by IN ('admin','user') OR c.locked)
          )
          AND NOT EXISTS (
              SELECT 1 FROM image_candidates ma
              WHERE ma.media_item_id = ep.id
                AND ma.artwork_type = 'thumb'
                AND ma.source = 'local' AND NOT ma.suppressed
                AND NOT is_bounded_episode_file_thumb(ep.id,ma.file_path)
          )
          AND (
              EXISTS (
                  SELECT 1
                  FROM media_items season
                  JOIN media_items series ON series.id = season.parent_id
                  JOIN external_ids tmdb_series
                    ON tmdb_series.media_id = series.id
                   AND tmdb_series.provider = 'tmdb'
                  WHERE season.id = ep.parent_id
                    AND season.media_type = 'season'
                    AND series.media_type = 'tv'
              )
              OR EXISTS (
                  SELECT 1 FROM media_file_items mfi
                  WHERE mfi.media_item_id = ep.id
              )
          )
        ORDER BY ep.created_at DESC
        LIMIT ${limit}
    `;
}

export async function materializeMissingEpisodeThumbnails(
    sql: postgres.Sql,
    options: MaterializeProviderArtworkOptions = {},
    deps: MaterializeEpisodeThumbnailDeps = {},
): Promise<MaterializeEpisodeThumbnailResult> {
    const candidates = deps.candidates ?? (await findEpisodeThumbnailCandidates(sql, options));
    const imageService = deps.imageService ?? getImageProxyService(sql);
    const storeImage = deps.storeImage ?? storeMediaImage;
    const extractFrame = deps.extractFrame ?? extractPosterForItem;
    const shouldForceVideoExtraction =
        deps.shouldForceVideoExtraction ?? shouldForceVideoExtractionForEpisodeThumb;
    const priority = getEpisodeThumbnailPriority();

    const result: MaterializeEpisodeThumbnailResult = {
        candidates: candidates.length,
        attemptedProvider: 0,
        storedProvider: 0,
        attemptedExtraction: 0,
        extracted: 0,
        skipped: 0,
        errors: 0,
    };

    let processed = 0;
    for (const candidate of candidates) {
        processed++;
        options.onProgress?.(processed, candidates.length, candidate.title);

        let completed = false;
        let hadError = false;

        try {
            // Fetching a provider image here can resolve the existing sidecar.
            // Only extract this window; failures must stay eligible for a retry,
            // rather than materializing the whole-file sidecar under a new path.
            const candidatePriority = candidate.needsWindowExtraction
                ? (['video'] as const)
                : priority;
            for (const strategy of candidatePriority) {
                if (strategy === 'video') {
                    if (!config.IMAGE_SYNC_AUTO_VIDEO_EXTRACTION) continue;

                    result.attemptedExtraction++;
                    const force = await shouldForceVideoExtraction(sql, candidate);
                    const extraction = await extractFrame(sql, {
                        mediaItemId: candidate.id,
                        artworkType: 'thumb',
                        ...(force ? { force: true } : {}),
                    });

                    if (extraction.extracted) {
                        result.extracted++;
                        completed = true;
                        break;
                    }

                    if (extraction.reason === 'already_exists') {
                        result.skipped++;
                        completed = true;
                        break;
                    }

                    if (extraction.reason === 'no_video_file') {
                        continue;
                    }

                    hadError = true;
                    result.errors++;
                    logger.warn('Failed to extract episode thumbnail', {
                        mediaItemId: candidate.id,
                        title: candidate.title,
                        reason: extraction.reason,
                    });
                    continue;
                }

                result.attemptedProvider++;
                const image = await imageService.getImageByCatalogId(candidate.id, 'still', {
                    size: 'full',
                });

                if (!image) continue;

                await storeImage(sql, candidate.id, 'thumb', {
                    type: 'file',
                    buffer: image.buffer,
                    contentType: image.contentType,
                    sourceTag: `provider:${image.provenance?.provider ?? 'unknown'}`,
                    provider: image.provenance?.provider,
                    providerRef: image.provenance?.providerRef,
                });
                result.storedProvider++;
                completed = true;
                break;
            }
        } catch (err) {
            hadError = true;
            result.errors++;
            logger.warn('Failed to materialize episode thumbnail', {
                mediaItemId: candidate.id,
                title: candidate.title,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (!completed && !hadError) {
            result.skipped++;
        }
    }

    logger.info('Episode thumbnail materialization complete', result);
    return result;
}

export type { ImageResponse };
export type { SingleExtractionResult };
