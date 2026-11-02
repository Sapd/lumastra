// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';

/**
 * POST /api/music/alchemy/brew
 *
 * Brew a ranked track list from seed IDs + scalar knobs (energy, tempo, obscurity).
 *
 * Internal BFF — dashboard only, not published on the v1 external surface.
 *
 * Gating:
 *   - features.musicAlchemy must be true (feature off → 404 not_found)
 *   - User must be authenticated
 *
 * Body: BrewRequest (seedIds, avoidIds, energy, tempo, obscurity, limit)
 * Response: bare object { tracks, totalDurationMs?, moodAnchors, meta? }
 *           Tracks carry images{} hrefs — no flat coverArtUrl.
 * DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { moodToColor } from '$lib/utils/mood-palette.js';
import {
    BrewRequestSchema,
    type BrewResponse,
    type MoodIslandAnchor,
} from '$lib/schemas/music-alchemy.js';
import type { MusicTrack } from '$lib/schemas/music.js';
import {
    getBrewCandidates,
    getBrewSeedRows,
    computeSeedCentroid,
    rankBrewCandidates,
    buildMoodIslandAnchors,
    getBrewSeedEmbeddings,
    parsePgVectorText,
    computeEmbeddingCentroid,
    getBrewCandidatesBySonic,
    rankBrewCandidatesBySonic,
    getSonicMoodGroupCounts,
    buildSonicMoodIslandAnchors,
    type BrewCandidateRow,
    type RawMoodIsland,
} from '$lib/server/database/queries/music-alchemy.queries.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';

const logger = Logger.for('AlchemyBrewDef');

// =============================================================================
// Row → MusicTrack transformer with images{} hrefs (no coverArtUrl)
// =============================================================================

function rowToMusicTrack(row: BrewCandidateRow, images: ImageSet): MusicTrack {
    return toMusicTrack(row, images);
}

// =============================================================================
// Endpoint definition
// =============================================================================

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'musicAlchemy', then: { kind: 'user' } },
    visibility: 'internal',
    request: { body: BrewRequestSchema },

    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            // body is pre-validated by mount() via request.body schema above.
            const body = ctx.input!.body;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const accessCtx = await buildSearchAccessContext(sql, user);
            // Single source of truth for this request's access boundary. Passed
            // as ONE value to every query below — the previous code spread
            // `deniedGroupIds` / `ageRating` field-by-field into four call sites,
            // which is exactly the drop-an-argument failure mode the boundary
            // type exists to remove.
            const access = searchAccessBoundary(accessCtx);

            const energy = body.energy ?? 0.5;
            const tempo = body.tempo ?? 0.5;
            const obscurity = body.obscurity ?? 0.5;
            const limit = body.limit ?? 20;

            logger.debug('brew request', {
                username: user.username,
                seeds: body.seedIds.length,
                avoids: body.avoidIds.length,
                energy,
                tempo,
                obscurity,
                limit,
            });

            // ── Sonic-swap: attempt MSCLAP centroid ranking ──────────────────
            //
            // Seed embeddings are resolved within the caller's own access
            // boundary, matching every other lookup in this handler — a seed
            // outside the user's library/age scope is silently excluded rather
            // than steering the centroid or leaking its existence via
            // `allSeedsHaveEmbeddings`.
            const seedEmbeddingRows = await getBrewSeedEmbeddings(sql, body.seedIds, access);
            const allSeedsHaveEmbeddings =
                body.seedIds.length > 0 && seedEmbeddingRows.length === body.seedIds.length;

            let topCandidates: BrewCandidateRow[] = [];
            let candidatePoolForAnchors: BrewCandidateRow[] = [];
            let sonicMode = false;
            let sonicMoodAnchors: RawMoodIsland[] = [];

            if (allSeedsHaveEmbeddings) {
                // ── Sonic path ──────────────────────────────────────────────
                const vectors = seedEmbeddingRows
                    .map((r) => parsePgVectorText(r.embedding_text))
                    .filter((v): v is number[] => v !== null);

                const centroidVec = computeEmbeddingCentroid(vectors);

                if (centroidVec !== null) {
                    sonicMode = true;
                    const centroidLiteral = `[${centroidVec.join(',')}]`;

                    const sonicCandidates = await getBrewCandidatesBySonic(
                        sql,
                        {
                            seedIds: body.seedIds,
                            avoidIds: body.avoidIds,
                            access,
                            limit,
                        },
                        centroidLiteral,
                    );

                    const rankedSonic = rankBrewCandidatesBySonic(
                        sonicCandidates,
                        { obscurity },
                        limit,
                    );
                    topCandidates = rankedSonic;
                    candidatePoolForAnchors = sonicCandidates;

                    const sonicMoodGroups = await getSonicMoodGroupCounts(
                        sql,
                        sonicCandidates.map((c) => c.id),
                        {
                            kind: 'preFiltered',
                            reason: 'ids come from getBrewCandidatesBySonic, already library- and age-scoped by `access`',
                        },
                    );
                    sonicMoodAnchors = buildSonicMoodIslandAnchors(sonicMoodGroups);

                    logger.debug('brew sonic mode', {
                        username: user.username,
                        seedsWithEmbeddings: seedEmbeddingRows.length,
                        sonicCandidatesCount: sonicCandidates.length,
                        sonicMoodGroups: sonicMoodGroups.length,
                        sonicMoodAnchors: sonicMoodAnchors.length,
                    });
                } else {
                    sonicMode = false;
                }
            }

            if (!sonicMode) {
                // ── Scalar fallback path ────────────────────────────────────
                const [seedRows, candidatePool] = await Promise.all([
                    getBrewSeedRows(sql, body.seedIds, access),
                    getBrewCandidates(sql, {
                        seedIds: body.seedIds,
                        avoidIds: body.avoidIds,
                        access,
                    }),
                ]);

                const centroid = computeSeedCentroid(seedRows);
                topCandidates = rankBrewCandidates(
                    candidatePool,
                    centroid,
                    { energy, tempo, obscurity },
                    limit,
                );
                candidatePoolForAnchors = candidatePool;
            }

            // Build MusicTrack list with images{} hrefs (no coverArtUrl)
            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                topCandidates.map((row) => ({ id: row.id, mediaType: 'track' })),
            );
            const tracks: MusicTrack[] = topCandidates.map((row) =>
                rowToMusicTrack(row, imageSets.get(row.id) ?? {}),
            );

            let totalDurationMs: number | undefined;
            if (tracks.length > 0) {
                const durations = tracks.map((t) => t.durationMs);
                if (
                    durations.every((d): d is number => typeof d === 'number' && Number.isFinite(d))
                ) {
                    totalDurationMs = durations.reduce((sum, d) => sum + d, 0);
                }
            }

            const useSonicAnchors = sonicMoodAnchors.length > 0;
            const rawAnchors: RawMoodIsland[] = useSonicAnchors
                ? sonicMoodAnchors
                : buildMoodIslandAnchors(candidatePoolForAnchors);
            const moodAnchors: MoodIslandAnchor[] = rawAnchors.map((a) => ({
                label: a.label,
                x: a.x,
                y: a.y,
                size: a.size,
                color: moodToColor(a.label),
            }));

            const acousticDataComplete = tracks.every((t) => t.audioFeatures !== undefined);

            logger.debug('brew result', {
                username: user.username,
                candidatePoolSize: candidatePoolForAnchors.length,
                resultCount: tracks.length,
                anchorCount: moodAnchors.length,
                anchorSource: useSonicAnchors ? 'sonic' : 'acoustic',
                acousticDataComplete,
                sonicMode,
            });

            const response: BrewResponse = {
                tracks,
                totalDurationMs,
                moodAnchors,
                meta: {
                    candidatePoolSize: candidatePoolForAnchors.length,
                    acousticDataComplete,
                },
            };

            return json(response);
        },
    },
});
