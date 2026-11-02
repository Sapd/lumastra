// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/renditions.ts
 *
 * GET  /api/v1/media/{id}/renditions — selectable offline-download qualities
 * POST /api/v1/media/{id}/renditions — request one, returns 202 + a poll target
 *
 * Complements `/media/{id}/download`, which serves the untouched original. That
 * route is only useful to a device that can direct play the source; this one
 * exists for everything else — a 4K HEVC/TrueHD remux on a phone — by producing
 * a universally-decodable MP4 the device can actually play offline.
 *
 * Renditions are shared, not per-user: the artifact for (file, rung, audio track)
 * is byte-identical regardless of who asked, so two users requesting the same
 * quality share one encode and one cached file. Access is therefore re-checked
 * per request rather than baked into the artifact.
 *
 * A source with no audio stream at all — silent cinema — has no audio track to
 * key on. Those encode video-only (`-an`) and carry a null audio index, which
 * dedupes like any other key via the table's NULLS NOT DISTINCT constraint.
 *
 * `media:read` scope, same as the original-file download — a user who may play a
 * title may take it offline. Library/age gate applies, 404 on denial (never 403)
 * to avoid leaking existence.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { config } from '$lib/server/config.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { probeMediaFile } from '$lib/server/utils/ffprobe.js';
import {
    RenditionListResponseSchema,
    RenditionSchema,
} from '$lib/schemas/api-download-responses.js';
import {
    estimateRenditionBytes,
    rungsForSourceHeight,
    getDownloadRung,
} from '$lib/shared/download-rungs.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index.js';
import {
    listRenditionsForFile,
    prepareQueueDepth,
    type DownloadRenditionRow,
} from '$lib/server/database/queries/download-renditions.queries.js';
import { requestRendition } from '$lib/server/services/download-rendition/service.js';
import { renditionToWire } from '$lib/server/services/download-rendition/wire.js';
import {
    admitAndHoldPrepareSlot,
    mayAttemptPrepare,
    pendingPrepareSlots,
    prepareSlotMember,
    releasePrepareSlot,
} from '$lib/server/services/download-rendition/prepare-cap.js';

const RenditionQuery = z.object({
    /** Which version/edition. Defaults to the item's default file. */
    fileId: z.string().optional(),
    /**
     * Absolute ffmpeg stream index of the audio track to resolve status against.
     * Defaults to the source's default track — or to no audio at all when the
     * source has no audio stream. Use the `absoluteIndex` value from
     * the play-session start envelope — NOT the display index.
     */
    audioIndex: z.coerce.number().int().nonnegative().optional(),
});

const RenditionCreateBody = z.object({
    rung: z.string().min(1).describe('Rung id from GET /media/{id}/renditions'),
    fileId: z.string().optional(),
    audioIndex: z.number().int().nonnegative().optional(),
    /**
     * Lane name when this request comes from an AUTOMATIC pool rather than a
     * person. Optional on purpose: existing clients never send it, so they are
     * never throttled by pool pressure and this change is purely additive to a
     * shipped, playback-adjacent path. Pool requests are subject to a per-user
     * pending-prepare cap and to server-wide queue backpressure, either of
     * which yields 503 + Retry-After. Open string.
     */
    pool: z.string().min(1).optional(),
});

/**
 * Resolve just the file id, with none of `resolveSource`'s I/O. Lets the
 * per-user prepare cap reject an over-cap pool request BEFORE paying for a
 * `probeMediaFile()` — spending an ffprobe over a multi-GB file on a request
 * that was always going to be refused is exactly the load the cap exists to
 * avoid (see `renditions.pool.test.ts`'s equivalent assertion for the global
 * backpressure check, which already runs before any probe).
 */
async function resolveFileId(
    sql: ReturnType<typeof getDb>,
    itemId: string,
    fileId: string | undefined,
): Promise<string | null> {
    if (!sql) return null;
    let selection = await resolvePlaybackSelection(sql, itemId, { fileId });
    if (fileId && selection.files.length === 0) {
        selection = await resolvePlaybackSelection(sql, itemId);
    }
    const file = selection.files.find((f) => f.id === selection.fileId);
    return file?.file_path ? file.id : null;
}

/**
 * Resolve the file, its on-disk path and the probe facts the ladder needs.
 * Returns null when there is nothing playable to render — the caller turns that
 * into a 404, matching every other per-item media route.
 */
async function resolveSource(
    sql: ReturnType<typeof getDb>,
    itemId: string,
    fileId: string | undefined,
) {
    if (!sql) return null;
    let selection = await resolvePlaybackSelection(sql, itemId, { fileId });
    if (fileId && selection.files.length === 0) {
        selection = await resolvePlaybackSelection(sql, itemId);
    }
    const file = selection.files.find((f) => f.id === selection.fileId);
    if (!file?.file_path) return null;

    const pathInfo = await resolveMediaPath(file.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) return null;

    const probe = await probeMediaFile(pathInfo.containerPath);
    if (!probe.success) return null;

    const defaultAudio =
        probe.audioStreams.find((a) => a.isDefault) ?? probe.audioStreams[0] ?? null;

    return {
        fileId: file.id,
        containerPath: pathInfo.containerPath,
        durationMs: probe.duration ? Math.round(probe.duration * 1000) : null,
        height: probe.video?.height ?? null,
        isHdr: (probe.video?.hdr ?? 'sdr') !== 'sdr',
        // `null`, never 0. Inventing an index for an audioless file is what let
        // GET advertise a rung POST would refuse forever: the invented 0 was
        // then validated against an empty audioIndexes array, a check that can
        // never pass.
        defaultAudioIndex: defaultAudio?.absoluteIndex ?? null,
        audioIndexes: probe.audioStreams.map((a) => a.absoluteIndex),
    };
}

/**
 * Ceiling on interactive (non-pool) rendition preparations per user.
 *
 * Sized so a person can queue a season's worth by hand and never notice it,
 * while a script cannot. Deliberately generous: refusing a real human here is
 * a worse outcome than a large-but-bounded queue, which the encode workers
 * drain on their own.
 */
const RENDITION_POST_RATE_LIMIT = 60;
const RENDITION_POST_RATE_WINDOW_SECONDS = 60;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },

    request: {
        query: RenditionQuery,
        queryMethods: ['GET'],
        body: RenditionCreateBody,
    },

    docs: {
        GET: {
            tags: ['Media'],
            summary: 'List offline-download qualities',
            stability: 'stable',
            auth: 'bearer',
            query: RenditionQuery,
            description:
                'Selectable download qualities for a title, each with an estimated size so a client ' +
                'can show "720p - ~1.4 GB" before committing, and the current state of any rendition ' +
                'already built for that quality. Never offers a rung above the source height.',
            responses: {
                200: {
                    schema: RenditionListResponseSchema,
                    description: 'Offered qualities with per-rung status',
                },
                401: 'Authentication required',
                404: 'Media not found, no accessible file, or the feature is disabled',
                503: 'Database unavailable',
            },
        },
        POST: {
            tags: ['Media'],
            summary: 'Request an offline-download rendition',
            stability: 'stable',
            auth: 'bearer',
            body: RenditionCreateBody,
            description:
                'Start (or join) an encode for one quality + audio track, or video-only when the ' +
                'source has no audio stream. Idempotent: requesting a ' +
                'rendition that already exists returns its current state instead of starting a second ' +
                'encode, and requesting a failed one retries it. Poll `GET /renditions/{id}` for ' +
                'progress; the download URL appears when status becomes `ready`. ' +
                'A request carrying `pool` is treated as automatic: it is subject to a per-user ' +
                'pending-prepare cap and to server-wide queue backpressure, either of which ' +
                'returns 503 with Retry-After. Requests without `pool` are never throttled this ' +
                'way. NOTE: polling GET /renditions/{id} does NOT advance a queued rendition — ' +
                're-POST here after the advertised prepareRePostSeconds to make it restart.',
            responses: {
                202: {
                    schema: RenditionSchema,
                    description: 'Rendition accepted — poll for progress',
                },
                200: {
                    schema: RenditionSchema,
                    description: 'Rendition already built and ready to download',
                },
                401: 'Authentication required',
                404: 'Media not found, no accessible file, or the feature is disabled',
                422: 'Unknown rung, or an explicitly requested audio track that does not exist in the source',
                503: 'Database unavailable, or the encode queue is saturated for an automatic pool request (Retry-After)',
            },
        },
    },

    handlers: {
        GET: async (event) => {
            // 404 rather than 403 when disabled — same convention the original
            // file download uses, so a probing client cannot tell a disabled
            // feature from an absent item.
            if (!config.FEATURE_DOWNLOAD_RENDITIONS) {
                return ApiProblem.notFound('Media item not found');
            }

            const id = event.params.id ?? '';
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!(await checkMediaAccess(sql, id, event.locals.user))) {
                return ApiProblem.notFound('Media item not found');
            }

            const query = RenditionQuery.parse(
                Object.fromEntries(event.url.searchParams.entries()),
            );
            const source = await resolveSource(sql, id, query.fileId);
            if (!source) return ApiProblem.notFound('Media item not found');

            // Brand at the boundary: the wire contract is the ABSOLUTE stream
            // index, and the branded type is what stops it being compared against
            // an audio-relative one further in.
            const explicit =
                query.audioIndex !== undefined ? asAbsoluteStreamIndex(query.audioIndex) : null;
            // Same validation POST already applies. Without it an index the
            // source has no track for simply matches nothing below, so every
            // rung comes back `absent` — a 200 that reads as "this title has
            // no downloads available" when the real answer is "you asked for
            // a track that does not exist". Only an EXPLICIT index is checked:
            // resolving to null because the film is silent is not an error.
            if (explicit !== null && !source.audioIndexes.includes(explicit)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'audioIndex',
                        message: `No audio track at absolute index ${explicit}`,
                    },
                ]);
            }
            const audioIndex = explicit ?? source.defaultAudioIndex;
            const hasAudio = source.audioIndexes.length > 0;
            const existing = await listRenditionsForFile(sql, source.fileId);
            const byRung = new Map<string, DownloadRenditionRow>();
            for (const row of existing) {
                // `null === null` is true, so a video-only row matches a
                // video-only listing. Deliberate — do not "fix" this into a
                // Number() coercion, which would make null match index 0.
                if (row.audio_index === audioIndex) byRung.set(row.rung_id, row);
            }

            return typedJson(RenditionListResponseSchema, {
                fileId: source.fileId,
                durationMs: source.durationMs,
                sourceHeight: source.height,
                audioIndex,
                rungs: rungsForSourceHeight(source.height).map((rung) => {
                    const row = byRung.get(rung.id);
                    return {
                        id: rung.id,
                        label: rung.label,
                        height: rung.height,
                        videoBitrate: rung.videoBitrate,
                        // A silent source gets no audio budget, and the estimate
                        // must agree — it is what a metered user budgets against.
                        audioBitrate: hasAudio ? rung.audioBitrate : 0,
                        estimatedSizeBytes: estimateRenditionBytes(
                            rung,
                            source.durationMs,
                            hasAudio,
                        ),
                        status: row?.status ?? ('absent' as const),
                        renditionId: row?.id,
                        progressPct: row ? row.progress_pct : undefined,
                        sizeBytes:
                            row?.status === 'ready' && row.size_bytes
                                ? Number(row.size_bytes)
                                : undefined,
                    };
                }),
            });
        },

        POST: async (event, ctx) => {
            if (!config.FEATURE_DOWNLOAD_RENDITIONS) {
                return ApiProblem.notFound('Media item not found');
            }

            const id = event.params.id ?? '';
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!(await checkMediaAccess(sql, id, event.locals.user))) {
                return ApiProblem.notFound('Media item not found');
            }

            const body = ctx.input?.body;
            if (!body) {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'Request body is required' },
                ]);
            }
            if (!getDownloadRung(body.rung)) {
                return ApiProblem.validationFailed([
                    { field: 'rung', message: `Unknown rung '${body.rung}'` },
                ]);
            }

            const isPoolRequest = body.pool !== undefined;
            const retryAfter = config.DOWNLOAD_RENDITION_STALE_SECONDS + 5;

            // A human tapping Download is always admitted — that is the
            // deliberate asymmetry the pool-gated checks below encode, and it
            // is kept. What it must not also mean is UNMETERED: omitting
            // `pool` skipped the per-user cap AND the global backpressure,
            // and no rate limit existed anywhere on this route, so one
            // authenticated caller could queue unbounded encodes just by
            // leaving the field out.
            //
            // A rate limit rather than a concurrency cap, so a person tapping
            // Download on a handful of titles is never refused; only a
            // scripted rate is.
            if (!isPoolRequest) {
                const limit = await checkRateLimit(
                    `renditions:post:${event.locals.user!.userId}`,
                    RENDITION_POST_RATE_LIMIT,
                    RENDITION_POST_RATE_WINDOW_SECONDS,
                );
                if (!limit.allowed) {
                    return ApiProblem.rateLimited(
                        Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000)),
                        { error: 'Too many download preparations; slow down' },
                    );
                }
            }

            if (isPoolRequest) {
                // Global backpressure. A human tapping Download is always
                // admitted; only unattended sweeps back off.
                const depth = await prepareQueueDepth(sql, config.DOWNLOAD_RENDITION_STALE_SECONDS);
                const ceiling =
                    Math.max(1, config.DOWNLOAD_RENDITION_MAX_CONCURRENT) *
                    Math.max(1, config.SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR);
                if (depth >= ceiling) {
                    // 503, not 429: a capacity constraint, not a request-rate
                    // violation. Matches the convention the byte path uses and
                    // the state the client already keeps for it.
                    return ApiProblem.dependencyUnavailable(
                        'Encode queue is saturated; retry later',
                        { retryAfter },
                    );
                }
            }

            // Per-user cap PRE-CHECK, ahead of the probe below. When the pool
            // is already at cap and holds no slot for this exact file+rung
            // under any audio index, the full check after the probe cannot
            // admit it either — so there is no reason to pay for a
            // `probeMediaFile()` over a multi-GB file first. This can only
            // produce a false "maybe"; `admitAndHoldPrepareSlot` below is
            // still the final, exact-member authority.
            if (isPoolRequest) {
                const preFileId = await resolveFileId(sql, id, body.fileId);
                if (preFileId) {
                    const pendingSlots = await pendingPrepareSlots(event.locals.user!.userId);
                    if (
                        !mayAttemptPrepare(
                            pendingSlots,
                            preFileId,
                            body.rung,
                            config.SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER,
                        )
                    ) {
                        return ApiProblem.dependencyUnavailable(
                            'Too many pending downloads being prepared for this user',
                            { retryAfter },
                        );
                    }
                }
            }

            const source = await resolveSource(sql, id, body.fileId);
            if (!source) return ApiProblem.notFound('Media item not found');

            const explicit =
                body.audioIndex !== undefined ? asAbsoluteStreamIndex(body.audioIndex) : null;
            // Validate against the source's real streams: an arbitrary index
            // would otherwise reach `-map 0:N` and fail deep inside ffmpeg,
            // surfacing to the user as a mysterious failed encode minutes later.
            //
            // An OMITTED index on an audioless source resolves to null and
            // encodes video-only — that is not an error, it is the whole fix.
            // Asking explicitly for a track the file does not have still is one.
            if (explicit !== null && !source.audioIndexes.includes(explicit)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'audioIndex',
                        message: `No audio track at absolute index ${explicit}`,
                    },
                ]);
            }
            const audioIndex = explicit ?? source.defaultAudioIndex;

            // Same reasoning as the audio check above, and the same filter GET
            // applies: `rungsForSourceHeight` is what the listing offers, so a
            // rung taller than the source is one this endpoint never advertised.
            // Accepting it did not fail — it succeeded, spending CPU-minutes and
            // gigabytes upscaling a 480p source to 1080p and handing the caller
            // a worse file than the original. GET and POST have to agree on what
            // exists, or the listing is only advisory.
            if (!rungsForSourceHeight(source.height).some((r) => r.id === body.rung)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'rung',
                        message:
                            `Rung '${body.rung}' is not available for this source ` +
                            `(${source.height}p); renditions are never upscaled`,
                    },
                ]);
            }

            const slotMember = prepareSlotMember(source.fileId, body.rung, audioIndex);
            const userId = event.locals.user!.userId;
            // Admission and the write that enforces it happen in ONE atomic
            // Valkey round trip. Deciding from a separately-read snapshot (as
            // the pre-check above does, deliberately, as an optimisation)
            // and only writing afterward is exactly the gap that let N
            // concurrent pool POSTs from one user all observe the same
            // pre-write state and all pass — see admitAndHoldPrepareSlot's
            // docstring.
            if (isPoolRequest) {
                const admitted = await admitAndHoldPrepareSlot(
                    userId,
                    slotMember,
                    config.SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER,
                );
                if (!admitted) {
                    return ApiProblem.dependencyUnavailable(
                        'Too many pending downloads being prepared for this user',
                        { retryAfter },
                    );
                }
            }

            const row = await requestRendition({
                sql,
                fileId: source.fileId,
                mediaItemId: id,
                rungId: body.rung,
                audioIndex,
                inputPath: source.containerPath,
                durationMs: source.durationMs,
                isHdr: source.isHdr,
            });

            if (isPoolRequest) {
                // A terminal row occupies no slot: release what the atomic
                // admission above already held. Anything else stays held —
                // its TTL is the backstop for a client that stops asking.
                if (row.status === 'ready' || row.status === 'failed') {
                    await releasePrepareSlot(userId, slotMember);
                }
            }

            return typedJson(RenditionSchema, renditionToWire(row, ctx.surface), {
                status: row.status === 'ready' ? 200 : 202,
            });
        },
    },
});
