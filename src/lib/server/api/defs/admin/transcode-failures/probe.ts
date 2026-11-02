// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/transcode-failures/probe.ts
 *
 * POST /api/v1/admin/transcode-failures/:id/probe
 *
 * Lazily captures `ffmpeg -i <file>` stderr for one failure-event row and caches
 * it on the row (`probe_dump` / `probed_at`) — runs only when someone opens a
 * detail view, so failures nobody looks at cost nothing and a retry storm never
 * spawns a probe per attempt. The dump (stream layout, dispositions, side data
 * like Dolby Vision configuration records and HDR metadata) is the single most
 * useful artifact a maintainer without database access can be handed, so it
 * feeds straight into `formatFailureReport`'s GitHub bug report.
 *
 * A failing probe (no linked file, unmounted volume, deleted file, timeout)
 * NEVER surfaces as an error — the detail view falls back to the row's stored
 * `source` metadata, which is decision-time truth anyway.
 *
 * Auth: admin.
 * Surface: mounted on BOTH v1 and internal — see ../index.ts's mirror route
 * for why the internal mount exists (the browser admin UI cannot authenticate
 * against /api/v1 at all).
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { FFmpegError, spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getFailureEventById,
    getFailureEventFilePath,
    saveProbeDump,
    sanitizeProbeDump,
} from '$lib/server/database/queries/transcode-failure-events.queries.js';
import { TranscodeProbeResponseSchema } from '$lib/schemas/api-transcode-failures.js';

const logger = Logger.for('AdminTranscodeFailureProbe');

/** Bounded so a stalled read on an unmounted volume can't pile up probes. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Run `ffmpeg -i <file>` with no output and pull the "Input #0, ..." block out
 * of stderr.
 *
 * `ffmpeg -i` with no output writes its report to STDERR and exits NON-ZERO by
 * design — `spawnFFmpegSafely` therefore REJECTS on the success path here, so
 * the "Input #0" report has to be read out of the rejected `FFmpegError`'s
 * `stderr`, not out of a resolved result. A genuine failure (missing binary,
 * timeout, killed, deleted file) still yields no "Input #0" marker and falls
 * through to null — this function never throws.
 */
async function probeSource(filePath: string): Promise<string | null> {
    let stderr = '';
    try {
        const result = await spawnFFmpegSafely({
            args: ['-hide_banner', '-i', filePath],
            libraryInput: filePath,
            timeout: PROBE_TIMEOUT_MS,
            context: { purpose: 'failure-report-probe' },
        });
        stderr = result.stderr;
    } catch (err) {
        if (err instanceof FFmpegError) stderr = err.stderr;
    }
    const start = stderr.indexOf('Input #0');
    return start === -1 ? null : stderr.slice(start);
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        // transcode_failure_events.id is a bigint: anything else would 500 in
        // Postgres instead of a 422 here.
        params: z.object({ id: z.string().regex(/^\d{1,18}$/) }),
    },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Admin'],
            summary: 'Lazily probe and cache the ffmpeg -i source dump for one failure event',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the cached dump when already probed. Otherwise probes once ' +
                '(bounded 10s timeout) and caches the result on the row. Never errors on a ' +
                'failed probe — returns `probeDump: null` instead.',
            responses: {
                200: {
                    schema: TranscodeProbeResponseSchema,
                    description: 'The ffmpeg -i source dump, or null when unavailable',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Failure event not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id } = ctx.input!.params!;
            const row = await getFailureEventById(sql, id);
            if (!row) return ApiProblem.notFound('Failure event not found');

            // No dedup between this check and the write below — two concurrent
            // first-opens of the SAME row could both spawn a probe. Left unguarded:
            // admin-only, bounded by PROBE_TIMEOUT_MS, and the brief's retry-storm
            // concern is about many DIFFERENT rows, not two views of one.
            if (row.probed_at) {
                return json(TranscodeProbeResponseSchema.parse({ probeDump: row.probe_dump }));
            }

            if (!row.file_id) {
                return json(TranscodeProbeResponseSchema.parse({ probeDump: null }));
            }

            const providerPath = await getFailureEventFilePath(sql, row.file_id);
            const resolved = providerPath
                ? await resolveMediaPath(providerPath, { skipLocalAccessCheck: true }, sql)
                : null;

            const rawProbeDump = resolved?.isAccessible
                ? await probeSource(resolved.containerPath)
                : null;

            // Sanitize ONCE and reuse the same string for both the write and the
            // response — `saveProbeDump` redacts internally too, but a caller must
            // never observe the pre-redaction value on the first (uncached) probe,
            // same as `stderr_tail` is never served unredacted.
            const probeDump = rawProbeDump ? sanitizeProbeDump(rawProbeDump) : null;

            // Cache the attempt even when it produced nothing (deleted file, unmounted
            // volume, timeout, no "Input #0" in the output) — otherwise a null result is
            // never cached and every later detail view re-spawns ffmpeg for this row.
            // Best-effort: the dump above is already computed, so a write failure here
            // must not discard it or 500 the handler.
            try {
                await saveProbeDump(sql, id, probeDump);
            } catch (err) {
                logger.error('Failed to cache probe dump', err as Error, { id });
            }

            return json(TranscodeProbeResponseSchema.parse({ probeDump }));
        },
    },
});
