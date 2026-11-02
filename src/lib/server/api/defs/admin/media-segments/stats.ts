// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media-segments/stats.ts
 *
 * GET /api/admin/media-segments/stats
 *
 * Segment-detector monitoring (plan §4 Phase 5.4): the segment-duration
 * distribution BUCKETED BY METHOD, a per-method percentile summary, the
 * `config_hash` cohorts the stored evidence was produced under, and the size of
 * the blackframe-fingerprint repair backlog.
 *
 * Why this endpoint exists at all: 26 % of stored Outros were longer than 90 s
 * for months and nobody could see it, because every detector wrote the same
 * anonymous row and no panel ever plotted the distribution. A per-method p90
 * would have named the culprit on day one.
 *
 * Query params:
 *   type          — segment type to profile (default Outro)
 *   bucketSeconds — histogram bar width in seconds (default 15, max 300)
 *   minLength     — repair-backlog threshold in seconds (default 90)
 *
 * Auth:    admin
 * Surface: internal
 *
 * Response: { type, bucketSeconds, histogram, summary, configCohorts, repairBacklog }
 * 503 dependency_unavailable when the database is down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    DEFAULT_SEGMENT_HISTOGRAM_BUCKET_SECONDS,
    getCandidateConfigCohorts,
    getSegmentDurationHistogramByMethod,
    getSegmentDurationSummaryByMethod,
} from '$lib/server/database/queries/media-segment-stats.queries.js';
import {
    countSuspectOutros,
    getSuspectLengthHistogram,
} from '$lib/server/database/queries/media-segment-repair.queries.js';

const SEGMENT_TYPES = ['Intro', 'Outro', 'Preview', 'Recap', 'Commercial'] as const;

const StatsQuerySchema = z.object({
    type: z.enum(SEGMENT_TYPES).default('Outro'),
    bucketSeconds: z.coerce
        .number()
        .int()
        .min(1)
        .max(300)
        .default(DEFAULT_SEGMENT_HISTOGRAM_BUCKET_SECONDS),
    minLength: z.coerce.number().min(1).max(3600).default(90),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { query: StatsQuerySchema },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { type, bucketSeconds, minLength } = ctx.input!.query!;

            // Sequential rather than Promise.all: this is an operator screen
            // nobody polls, and four concurrent analytical scans over the
            // candidate table would contend with a live analyzer drain for
            // pool connections to save a few hundred milliseconds nobody is
            // waiting on.
            const histogram = await getSegmentDurationHistogramByMethod(sql, {
                type,
                bucketSeconds,
            });
            const summary = await getSegmentDurationSummaryByMethod(sql, { type });
            const configCohorts = await getCandidateConfigCohorts(sql);

            // The repair backlog is reported only for Outro: the blackframe
            // fingerprint is tail-anchored by construction and means nothing
            // for any other type.
            let repairBacklog = null;
            if (type === 'Outro') {
                const lengths = await getSuspectLengthHistogram(sql, {
                    minLengthSeconds: minLength,
                });
                repairBacklog = {
                    minLengthSeconds: minLength,
                    items: await countSuspectOutros(sql, {
                        minLengthSeconds: minLength,
                    }),
                    // The repair query names this exact-duration value after its
                    // domain meaning. The admin API exposes every histogram edge
                    // consistently as `bucketStart`.
                    lengths: lengths.map(({ lengthSeconds, items }) => ({
                        bucketStart: lengthSeconds,
                        items,
                    })),
                };
            }

            return json({
                type,
                bucketSeconds,
                histogram,
                summary,
                configCohorts: configCohorts.map((cohort) => ({
                    configHash: cohort.configHash,
                    detectorVersion: cohort.detectorVersion,
                    items: cohort.items,
                    methods: cohort.methods,
                    oldest: cohort.oldest instanceof Date ? cohort.oldest.toISOString() : null,
                    newest: cohort.newest instanceof Date ? cohort.newest.toISOString() : null,
                })),
                repairBacklog,
            });
        },
    },
});
