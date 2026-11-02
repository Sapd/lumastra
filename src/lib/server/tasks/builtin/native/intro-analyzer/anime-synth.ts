// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getAnimePreviewInputs } from '$lib/server/database/queries/media-segments.queries.js';
import {
    replaceCandidatesForMethod,
    type MediaSegmentCandidateInput,
} from '$lib/server/database/queries/media-segment-candidates.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import type postgres from 'postgres';
import type { Logger as SdkLogger } from '@sapd/lumastra-plugin-sdk';
import { acquireMediaSegmentResolutionLock } from './resolution-lock.js';
import type { EpisodeWithFile } from './types.js';

/** Options carrying the run's provenance onto every candidate this pass writes. */
export interface AnimeSynthOptions {
    /** Stable hash of the detector-relevant config, so rows can be attributed to a configuration. */
    configHash?: string | null;
    /** The analyzer's PROCESSING_VERSION at write time. */
    detectorVersion?: number;
    /** Reject detector work whose file or media generation changed mid-run. */
    validateInput?: (tx: postgres.Sql, episode: EpisodeWithFile) => Promise<boolean>;
}

export type AnimePreviewMaterializer = (
    tx: postgres.Sql,
    episode: EpisodeWithFile,
) => Promise<void>;

/**
 * For each episode in the season, if an Outro segment exists (from any
 * detection method) and there's at least 5s of content after it, emit a
 * synthetic Preview candidate covering the post-credits tail.
 *
 * ## Why this reads materialized segments but writes candidates
 *
 * The input is the RESOLVED Outro end (`getAnimePreviewInputs` reads
 * `media_segments`), because a Preview synthesised from a credits boundary the
 * resolver was about to overrule would be wrong by construction. So this pass
 * must run after materialization. Its own output, though, is evidence like any
 * other: it writes an `anime-synth` candidate and the caller re-resolves.
 *
 * That is also what preserves the old "chapter already wrote a real Preview →
 * skip" behaviour. It used to be a read-then-skip race against whatever had
 * written first; now it is ranking. `chapter-title` outranks `anime-synth`, so
 * an authored "Next episode" chapter wins on the merits and the synthesis sits
 * underneath it as the fallback it always was — visible in the candidates table
 * rather than silently never produced.
 *
 * Each episode is read, written and resolved under the same per-media lock. A
 * batch read followed by later writes would allow a concurrent manual override
 * to move the Outro between those phases and leave a stale Preview candidate.
 */
export async function synthesiseAnimePreviews(
    sql: postgres.Sql,
    logger: SdkLogger,
    episodes: EpisodeWithFile[],
    pluginId: string,
    materialize: AnimePreviewMaterializer,
    signal?: AbortSignal,
    options: AnimeSynthOptions = {},
): Promise<number> {
    if (episodes.length === 0) return 0;

    let synthesised = 0;
    // Every episode gets a write, not just the ones that produced something.
    // `replaceCandidatesForMethod` deletes unconditionally, and that is the
    // point: an episode whose Outro moved (or vanished) must have last run's
    // synthesised Preview retracted, or the resolver keeps materializing a
    // preview that starts at a boundary nothing believes in any more.
    for (const episode of episodes) {
        if (signal?.aborted) break;
        const duration = episode.durationSeconds;
        // Without a file-accurate runtime the resolver cannot safely judge the
        // candidate. Preserve prior evidence until probing makes the item usable.
        if (!duration || duration <= 0) continue;

        try {
            const written = await withTx(sql, async (tx) => {
                await acquireMediaSegmentResolutionLock(tx, episode.episodeId);
                if (options.validateInput && !(await options.validateInput(tx, episode))) return 0;
                const inputs = await getAnimePreviewInputs(tx, [episode.episodeId], pluginId, episode.fileId);
                const creditsEnd = inputs.find(
                    (row) => row.episodeId === episode.episodeId,
                )?.outroEndSec;
                const candidates: MediaSegmentCandidateInput[] =
                    typeof creditsEnd === 'number' && creditsEnd + 5 < duration
                        ? [
                              {
                                  type: 'Preview',
                                  startTime: creditsEnd,
                                  endTime: duration,
                                  confidence: 0.4,
                                  detectorVersion: options.detectorVersion,
                                  configHash: options.configHash ?? null,
                              },
                          ]
                        : [];

                await replaceCandidatesForMethod(tx, episode.episodeId, 'anime-synth', candidates);
                await materialize(tx, episode);
                return candidates.length;
            });
            synthesised += written;
        } catch (err) {
            logger.warn(`anime-preview synth failed for ${episode.episodeId}`, {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return synthesised;
}
