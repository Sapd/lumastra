// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nightly rebuild of the per-genre sonic centroids behind the "New to You" rail.
 *
 * Unlike its siblings (`sonic-clustering`, `sonic-map-projection`) this task
 * spawns no Python sidecar — it is pure SQL, measured at ~600ms for the whole
 * job on a 23.8k-track library (380ms for ~100 centroids, 180ms for the corpus
 * mean). It exists as a task rather than a request-time compute because the
 * fully-inline path measures ~3s.
 *
 * No-ops when `features.sonicTaste` is off, or when no audio embeddings exist
 * (a deployment without the sonic-embedder sidecar). Both leave the table empty,
 * and an empty table makes the rail silently not render — never an error.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { features } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { getDistinctMusicGenres } from '$lib/server/database/queries/music.queries.js';
import { rebuildGenreCentroids } from '$lib/server/database/queries/music-genre-centroids.queries.js';
import { foldGenres, ELIGIBILITY } from '$lib/server/services/music/genre-ranker.service.js';

const inputSchema = z.object({}).passthrough();
type CentroidInput = z.infer<typeof inputSchema>;

interface CentroidResult {
    centroids: number;
    corpusTracks: number;
    eligibleGenres: number;
}

export const musicGenreCentroidsTask = defineTask<CentroidInput, CentroidResult>({
    id: 'music-genre-centroids',
    purpose: 'music-ai',
    name: 'Music Genre Sonic Centroids',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Daily is ample: centroids move only as the library grows, and the rail
    // holds its chosen genre for a week anyway.
    schedule: { every: '24h', runOnStartup: false },

    // 'maintenance', NOT 'analysis'. Copying sonic-clustering's class was wrong:
    // that task spawns a Python sidecar and runs for the better part of an hour,
    // whereas this is ~600ms of pure SQL. The Wave 8.5 shim maps 'analysis' onto
    // the physical `cpu` pool, which is where trickplay lives — observed on prod
    // with 2 active and 9 pending trickplay jobs ahead of it, a sub-second job
    // starved behind hours of video work. That is precisely the head-of-line
    // blocking the resource-class rubric warns about, and the rubric's answer
    // for a short periodic housekeeping job is 'maintenance'.
    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    // Generous against the measured ~600ms: a first run on a very large library
    // scans every audio embedding once.
    timeout: { hard: '10m', soft: '5m' },

    async execute(ctx) {
        const { sql: rawSql, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        if (!features.sonicTaste) {
            ctxLogger.info('sonicTaste feature is disabled — centroid rebuild is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { centroids: 0, corpusTracks: 0, eligibleGenres: 0 },
            };
        }

        try {
            // Unrestricted on purpose: centroids are a property of the audio,
            // not of any viewer. Access filtering happens at read time, where
            // candidate genres are intersected with the caller's own visible
            // set — see the migration's header for the reasoning and the
            // residual it accepts.
            const genreRows = await getDistinctMusicGenres(sql, {
                deniedGroupIds: null,
                ageRating: null,
            });

            // Same fold and the same floor the rail ranker uses, so the two can
            // never disagree about what a genre IS or which ones are big enough
            // to matter.
            const eligible = foldGenres(genreRows).filter(
                (g) =>
                    g.trackCount >= ELIGIBILITY.MIN_TRACKS &&
                    g.albumCount >= ELIGIBILITY.MIN_ALBUMS,
            );

            const { centroids, corpusTracks } = await rebuildGenreCentroids(
                sql,
                eligible.map((g) => ({
                    genreKey: g.key,
                    displayName: g.title,
                    variants: g.variants,
                })),
            );

            ctxLogger.info('Genre sonic centroids rebuilt', {
                centroids,
                corpusTracks,
                eligibleGenres: eligible.length,
            });

            return {
                success: true,
                itemsProcessed: centroids,
                result: { centroids, corpusTracks, eligibleGenres: eligible.length },
            };
        } catch (error) {
            // Throw rather than returning success:false — this system used to
            // record the latter as "completed", hiding real failures.
            throw new TaskError({
                kind: 'transient',
                message: `Genre centroid rebuild failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                cause: error instanceof Error ? error : undefined,
            });
        }
    },
});

// Self-register into the singleton registry. NOTE: this only runs if the module
// is imported — the file must also be listed in builtin/index.ts's coreModules,
// or the task silently does not exist.
registry.registerTask(musicGenreCentroidsTask);
