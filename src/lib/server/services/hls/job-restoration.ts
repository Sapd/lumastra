// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from 'path';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import { isShuttingDown, shuttingDownResponse } from '$lib/server/lifecycle/web-shutdown.js';

import type { PersistedJobMetadata } from '../transcode-job-persistence.service.js';
import type { TranscodeJob } from '../transcoding/types.js';
import {
    getSegmentFilename,
    isPathInsideDirectory,
    parseSegmentPath,
} from '../../utils/hls-segment-utils.js';
import { buildExplicitStreamDiagnosticHeaders } from './stream-diagnostics.js';
import { SESSION_SEGMENT_CACHE_CONTROL } from './segment-action-executor.js';
import {
    buildBoundItemIds,
    isBoundToItem,
    normalizeItemId,
    truncateForLog,
} from './job-item-binding.js';
import { isOutputMarkerPath, outputMarkerNamesItem, readOutputMarker } from './output-marker.js';

export interface HlsJobPersistenceAdapter {
    getJob(playSessionId: string): Promise<PersistedJobMetadata | null>;
    updateStatus(
        playSessionId: string,
        status: string,
        errorMessage?: string,
        canRestore?: boolean,
        ownerPodName?: string | null,
    ): Promise<void>;
    updateLastAccessed(playSessionId: string): Promise<void>;
    /** `expectedItemId`: the row's `item_id` as validated above — the claim
     *  fails if another process replaced the row for another item since. */
    claimJobForRestoration(
        playSessionId: string,
        podName: string,
        expectedItemId?: string,
    ): Promise<boolean>;
    /** Flip pod_name to this pod when the recorded owner has gone stale, so the
     *  disk-serve path stops re-arming the "owner is still serving" defer. */
    takeOverStaleJob(playSessionId: string, podName: string): Promise<boolean>;
}

export interface HlsRestoreTranscodeAdapter {
    getJobByPlaySession(playSessionId: string): TranscodeJob | undefined;
    restoreJob(
        metadata: PersistedJobMetadata,
        options?: {
            segmentPresentOnDisk?: boolean;
            requiredSegmentIndex?: number;
            previousOwnerMayStillWrite?: boolean;
            /**
             * Background restore started at claim time, before the client
             * has run out of pre-generated segments. The service resumes at
             * the first segment the client will need next (the one after the
             * last segment on disk, or the requested one if later).
             */
            prewarm?: boolean;
        },
    ): Promise<TranscodeJob>;
}

export interface RestoreHlsJobIfMissingOptions {
    job: TranscodeJob | undefined;
    /** Raw URL item id (pre-canonicalization). Used for logging AND, together
     *  with `internalId`, as one of the two spellings a persisted job's
     *  `item_id` is allowed to match (fix plan 6, C1 — see
     *  `job-item-binding.ts`). Was log-only before that fix. */
    itemId: string;
    /** Resolved internal `media_items.id` for this request (`undefined` when
     *  the route's id-resolution middleware couldn't resolve one, e.g. an
     *  unknown-but-valid UUID on `/api/v1`). Required for the C1 job->item
     *  binding check below to admit anything — missing/empty fails closed. */
    internalId?: string;
    /** Mount label for the binding-rejection warn log only (`'api'`, `'j'`,
     *  `'showcase'`, …) — never behavior-affecting. */
    mount?: string;
    playSessionId: string;
    /** Authenticated requester. When set, a row whose `config.username` is
     *  someone else is refused (404). Unset only on the showcase mount. */
    username?: string;
    segmentPath: string;
    corsHeaders: Record<string, string>;
    contentTypes: Record<string, string>;
    currentPodName: string;
    restoreWaitTimeoutMs: number;
    restorePollIntervalMs: number;
    jobPersistence: HlsJobPersistenceAdapter;
    transcodeService: HlsRestoreTranscodeAdapter;
    accessFile: (filePath: string) => Promise<void>;
    readFile: (filePath: string) => Promise<Buffer>;
    trackHlsSegment: (bytes: number) => void;
    sleep?: (ms: number) => Promise<void>;
    logInfo: (message: string, metadata: Record<string, unknown>) => void;
    logWarn: (message: string, metadata: Record<string, unknown>) => void;
    logError: (
        message: string,
        error: Error | undefined,
        metadata: Record<string, unknown>,
    ) => void;
}

export interface RestoreHlsJobIfMissingResult {
    job?: TranscodeJob;
    response?: Response;
}

// How long the owning pod may go without serving a segment before a peer that keeps
// receiving this session's requests is allowed to claim + restore it. Below this, the
// owner is assumed to still be serving and misrouted requests just retry. MUST stay in
// sync with the same-named allowance in claimJobForRestoration (transcode-jobs.queries.ts).
const OWNER_SERVING_STALE_MS = 15_000;

/**
 * Sessions this pod took over from a peer whose row was still active. A takeover
 * that only serves existing files restores nothing, yet flips pod_name to this
 * pod; the NEXT request (a missing segment) then sees an own row and would
 * respawn into the old producer's directory while that pod may still be
 * writing. The memory outlives the single request that noticed the peer.
 */
const PEER_WRITE_MEMORY_MS = 10 * 60_000;
const takenOverFromPeer = new Map<string, number>();

function rememberPeerTakeover(playSessionId: string): void {
    const now = Date.now();
    for (const [id, at] of takenOverFromPeer) {
        if (now - at > PEER_WRITE_MEMORY_MS) takenOverFromPeer.delete(id);
    }
    takenOverFromPeer.set(playSessionId.toLowerCase(), now);
}

function peerMayStillWrite(playSessionId: string): boolean {
    const at = takenOverFromPeer.get(playSessionId.toLowerCase());
    return at !== undefined && Date.now() - at <= PEER_WRITE_MEMORY_MS;
}

/** Test seam: forget every remembered takeover. */
export function resetPeerTakeoverMemoryForTests(): void {
    takenOverFromPeer.clear();
    prewarmInFlight.clear();
    prewarmFailedAt.clear();
}

/**
 * Background restores in flight, one per session (single-flight). A claimed
 * session is served from disk while its FFmpeg job is brought back here, so the
 * restore is finished before the client reaches the end of the old output
 * instead of starting only once a segment is missing (prod 2026-11-01: the
 * restore began at the first missing segment, at the persisted position, and a
 * forward seek followed — a 12-15 s frozen frame).
 */
const prewarmInFlight = new Map<string, Promise<void>>();
/** A failed prewarm is not retried on every segment request. */
const prewarmFailedAt = new Map<string, number>();
const PREWARM_RETRY_AFTER_MS = 10_000;

function prunePrewarmBackoff(): void {
    const now = Date.now();
    for (const [id, at] of prewarmFailedAt) {
        if (now - at >= PREWARM_RETRY_AFTER_MS) prewarmFailedAt.delete(id);
    }
}

/** Test seam: resolves when every background restore has finished. */
export async function settlePrewarmForTests(): Promise<void> {
    while (prewarmInFlight.size > 0) {
        await Promise.allSettled([...prewarmInFlight.values()]);
    }
}

/**
 * Fire-and-forget restore of the session's FFmpeg job on this pod.
 *
 * Idempotent and single-flight: one attempt per session at a time here
 * (`restoreJob` additionally serialises on the session start lock and returns
 * a resident job untouched). Cross-pod, the existing ownership claim decides:
 * `claimJobForRestoration` only wins for a row that is unowned, ours, stopped
 * or whose owner has gone stale, and stamps `pod_name`/`last_accessed_at`, so
 * a peer that is still serving never has its session restored from under it.
 */
function startPrewarmRestore(
    options: RestoreHlsJobIfMissingOptions,
    metadata: PersistedJobMetadata,
    requiredSegmentIndex: number | undefined,
    previousOwnerMayStillWrite: boolean,
): void {
    const key = options.playSessionId.toLowerCase();
    if (prewarmInFlight.has(key)) return;
    const failedAt = prewarmFailedAt.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < PREWARM_RETRY_AFTER_MS) return;
    if (isShuttingDown()) return;
    prunePrewarmBackoff();

    const run = (async () => {
        // Re-checked: another request may have restored the job meanwhile.
        if (options.transcodeService.getJobByPlaySession(options.playSessionId)) return;
        const claimed = await options.jobPersistence.claimJobForRestoration(
            options.playSessionId,
            options.currentPodName,
            metadata.item_id,
        );
        if (!claimed) {
            // Not claimable now (a peer is serving it): do not repeat the claim
            // UPDATE on every segment request.
            prewarmFailedAt.set(key, Date.now());
            options.logInfo('Prewarm skipped: session not claimable by this pod', {
                playSessionId: options.playSessionId,
                thisPodName: options.currentPodName,
            });
            return;
        }
        if (isShuttingDown()) return;
        options.logInfo('Prewarming FFmpeg job for claimed session', {
            playSessionId: options.playSessionId,
            requestedSegment: requiredSegmentIndex,
        });
        const job = await options.transcodeService.restoreJob(metadata, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex,
            previousOwnerMayStillWrite: previousOwnerMayStillWrite || peerMayStillWrite(key),
            prewarm: true,
        });
        takenOverFromPeer.delete(key);
        prewarmFailedAt.delete(key);
        options.logInfo('Prewarmed FFmpeg job restored', {
            playSessionId: options.playSessionId,
            jobId: job.id,
            segmentOffset: job.segmentOffset,
        });
    })()
        .catch((error: unknown) => {
            if (error instanceof ShutdownInterruptedError) return;
            prewarmFailedAt.set(key, Date.now());
            // Not marked 'error': the disk-serve path still works, and the
            // foreground restore (segment missing) remains the fallback.
            options.logWarn('Prewarm restore failed — falling back to restore on demand', {
                playSessionId: options.playSessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        })
        .finally(() => {
            prewarmInFlight.delete(key);
        });
    prewarmInFlight.set(key, run);
}

export async function restoreHlsJobIfMissing(
    options: RestoreHlsJobIfMissingOptions,
): Promise<RestoreHlsJobIfMissingResult> {
    if (options.job) {
        return { job: options.job };
    }
    if (isShuttingDown()) return restorationShutdownResult(options);

    options.logInfo('Job not in memory, checking database', {
        playSessionId: options.playSessionId,
        itemId: options.itemId,
        requestedPath: options.segmentPath,
    });

    let metadata: PersistedJobMetadata | null;
    try {
        metadata = await options.jobPersistence.getJob(options.playSessionId);
    } catch (error) {
        if (error instanceof ShutdownInterruptedError) return restorationShutdownResult(options);
        options.logError('Failed to query database for job', error as Error, {
            playSessionId: options.playSessionId,
            itemId: options.itemId,
        });
        return {
            response: new Response('Database error', {
                status: 503,
                headers: options.corsHeaders,
            }),
        };
    }

    if (!metadata) {
        options.logWarn('Session not found in memory or database', {
            playSessionId: options.playSessionId,
            itemId: options.itemId,
        });
        return {
            response: new Response('Session expired', {
                status: 410,
                headers: {
                    ...options.corsHeaders,
                    ...buildExplicitStreamDiagnosticHeaders('session-expired'),
                },
            }),
        };
    }

    // The row must belong to the requester. The segment handler's
    // `verifyPlaySessionOwnership` reads `play_sessions`, and a `/j`
    // PlaySessionId has no row there (it passes as "row absent"), so the
    // transcode row's own owner is the only check that covers it. Before any
    // takeover, disk-serve or respawn, same as the item binding below.
    if (options.username !== undefined) {
        const rowOwner = (metadata.config as { username?: unknown } | null)?.username;
        if (rowOwner !== options.username) {
            options.logWarn('Persisted job belongs to another user — rejecting restore', {
                playSessionId: truncateForLog(options.playSessionId),
                mount: options.mount,
            });
            return {
                response: new Response('Not found', {
                    status: 404,
                    headers: options.corsHeaders,
                }),
            };
        }
    }

    // C1 (fix plan 6): the persisted row must belong to the SAME item this
    // request's auth gate checked, or a foreign PlaySessionId could take over,
    // disk-serve, and respawn another user's job. Checked immediately after
    // the row is loaded — before the stale-owner takeover below (which writes
    // pod_name), before the disk-serve, and before restoreJob respawns FFmpeg.
    // Also rejects an audiobook remux row (`config.type` set): those share
    // this table but are never legitimately served by the HLS segment
    // handler, and their `output_dir` is a named pipe, not a directory of
    // segments — see `services/transcode-job-persistence.service.ts`'s
    // `recordAudiobookRemuxJob`.
    const bound = buildBoundItemIds(options.internalId, options.itemId);
    const audiobookConfigType = (metadata.config as { type?: unknown } | null)?.type;
    const isAudiobookRow =
        typeof audiobookConfigType === 'string' && audiobookConfigType.length > 0;
    if (isAudiobookRow || !isBoundToItem(metadata.item_id, bound)) {
        options.logWarn('Persisted job does not belong to the requested item — rejecting restore', {
            playSessionId: truncateForLog(options.playSessionId),
            metadataItemId: truncateForLog(metadata.item_id),
            requestItemId: truncateForLog(options.itemId),
            internalId: truncateForLog(options.internalId),
            isAudiobookRow,
            mount: options.mount,
        });
        return {
            response: new Response('Not found', {
                status: 404,
                headers: options.corsHeaders,
            }),
        };
    }

    // D-HLS-2 (security runtime pass 2026-09-26, fix (c)): the check above
    // only binds `metadata.item_id`. `restoreJob` below respawns FFmpeg from
    // `metadata.config` — i.e. from `config.itemId`, not `item_id` — so a row
    // whose two id fields disagree (D-HLS-1: historically, a cross-process or
    // case-variant start collision left `upsertJob`'s `ON CONFLICT` in a
    // half-updated state with `item_id=X`, `config.itemId=Y` — `upsertJob`
    // now fully replaces the row on an item mismatch instead, commit
    // 3a7f042c2, so this should no longer occur in practice) previously
    // passed the check above whenever it was gated on X, then took over the
    // row (writing `pod_name`) and respawned Y's FFmpeg — only to be refused
    // afterwards by the `post-restore-foreign-item` backstop in
    // lumastra-segment-handler.ts (kept here, unchanged, as the second line
    // of defence). Binding on `config.itemId` too, and failing closed on any
    // disagreement, denies a foreign item's FFmpeg the chance to even start,
    // instead of respawning it and only then refusing the bytes — and stays
    // as a backstop against any OTHER way a row could end up self-
    // inconsistent (a legacy row from before 3a7f042c2, or a future bug),
    // not just the one D-HLS-1 shape that motivated it.
    //
    // Preview/cache-artifact sessions cannot reach this path at all: their
    // PlaySessionId is never a UUID (`preview-<item>-<millis>` or the
    // shared `preview-cache-<hash>` artifact id), and
    // `TranscodeJobPersistenceService`'s `isPersistable()` refuses to persist
    // ANY non-UUID PlaySessionId (dashed or /j-dashless are the only shapes) — so no row is ever written for one, and
    // `getJob` above returns null long before this check runs. Ruling
    // S-C1a's preview-cache M:N mismatch is therefore a resident-job (in-
    // memory) concern the segment handler's own binding check already
    // covers, never a restore-from-DB one.
    //
    // A legacy row whose `config` predates `itemId` being recorded (or is
    // otherwise malformed) has no way to prove self-consistency, so it is
    // refused too — fail closed, same as any other binding rejection here.
    // The client simply starts a fresh session on the resulting 404, exactly
    // as it would for a genuinely expired one.
    const rawConfigItemId =
        metadata.config && typeof metadata.config === 'object'
            ? (metadata.config as { itemId?: unknown }).itemId
            : undefined;
    const configItemId =
        typeof rawConfigItemId === 'string' && rawConfigItemId.length > 0
            ? rawConfigItemId
            : undefined;
    const isSelfInconsistentRow =
        !configItemId ||
        normalizeItemId(configItemId) !== normalizeItemId(metadata.item_id) ||
        !isBoundToItem(configItemId, bound);
    if (isSelfInconsistentRow) {
        options.logWarn(
            'Persisted job row is self-inconsistent (item_id disagrees with config.itemId) — rejecting restore',
            {
                playSessionId: truncateForLog(options.playSessionId),
                metadataItemId: truncateForLog(metadata.item_id),
                configItemId: truncateForLog(configItemId),
                requestItemId: truncateForLog(options.itemId),
                internalId: truncateForLog(options.internalId),
                reason: 'row-self-inconsistent',
                mount: options.mount,
            },
        );
        return {
            response: new Response('Not found', {
                status: 404,
                headers: options.corsHeaders,
            }),
        };
    }

    options.logInfo('Found job in database', {
        playSessionId: options.playSessionId,
        status: metadata.status,
        age: Date.now() - metadata.created_at.getTime(),
        outputDir: metadata.output_dir,
        podName: metadata.pod_name,
    });

    // A session's segments should consistently reach the pod that owns its transcode
    // (sticky routing). A NON-owner pod normally defers (503) so the client retries onto
    // the owner. But after a rolling recreate a session's owner can end up NOT being its
    // sticky-hash target — it was restored on a peer while the target was mid-restart —
    // and then every retry lands here while the owner never receives them: an infinite
    // 503 loop that halts playback. So defer ONLY while the owner is actively serving
    // (fresh last_accessed_at, which it stamps on every segment it serves). Once the
    // owner has clearly stopped serving this session — dead pod, or the client's requests
    // now reach us instead of it — the row goes stale and we fall through to claim it
    // here. claimJobForRestoration only wins on a stale row and stamps
    // last_accessed_at = NOW(), so two racing pods can't both steal it.
    // Set when we take the session over from a peer whose row is still active.
    // "Stopped serving" only means its last_accessed_at went stale: the pod
    // may be alive with its FFmpeg still writing into the shared output_dir
    // (prod 2026-10-15: a rolling restart moved the client to web-1 while
    // web-0's copy job kept writing for another 2 s). restoreJob must not
    // respawn into that directory.
    let previousOwnerMayStillWrite = false;
    if (
        isActiveStatus(metadata.status) &&
        metadata.pod_name &&
        metadata.pod_name !== options.currentPodName
    ) {
        const ownerIdleMs = Date.now() - metadata.last_accessed_at.getTime();
        if (ownerIdleMs < OWNER_SERVING_STALE_MS) {
            options.logInfo(
                'Job is active on another pod (recently serving), client should retry',
                {
                    playSessionId: options.playSessionId,
                    activePod: metadata.pod_name,
                    currentPod: options.currentPodName,
                    status: metadata.status,
                    ownerIdleMs,
                },
            );
            return {
                response: new Response('Session active on another pod, please retry', {
                    status: 503,
                    headers: {
                        ...options.corsHeaders,
                        'Retry-After': '2',
                    },
                }),
            };
        }
        previousOwnerMayStillWrite = true;
        options.logWarn('Owner pod stopped serving this session — claiming it here', {
            playSessionId: options.playSessionId,
            staleOwner: metadata.pod_name,
            currentPod: options.currentPodName,
            ownerIdleMs,
        });
        // Take ownership NOW, before the disk-serve below. That path calls
        // updateLastAccessed(), which refreshes the same last_accessed_at this
        // staleness check reads — so without flipping pod_name first, every
        // segment we serve makes the dead owner look alive again and the next
        // request 503s for another 15s. Playback would crawl at ~1 segment per
        // 15s (segments are 4-6s) and the buffer would drain anyway, and the
        // claim further down is never reached while the segments exist on disk.
        const tookOver = await options.jobPersistence.takeOverStaleJob(
            options.playSessionId,
            options.currentPodName,
        );
        if (tookOver) {
            metadata.pod_name = options.currentPodName;
            rememberPeerTakeover(options.playSessionId);
        }
        // If a racing peer won the takeover it is now the live owner and will
        // serve; fall through regardless — the disk-serve is read-only and the
        // restore path below re-checks ownership via claimJobForRestoration.
    }

    const normalizedPath = path.normalize(options.segmentPath);
    if (!isSafeNormalizedPath(normalizedPath)) {
        options.logWarn('Path traversal attempt blocked', {
            playSessionId: options.playSessionId,
            path: options.segmentPath,
        });
        return {
            response: new Response('Invalid path', {
                status: 400,
                headers: options.corsHeaders,
            }),
        };
    }

    const fullSegmentPath = path.join(metadata.output_dir, normalizedPath);
    if (!isPathInsideDirectory(fullSegmentPath, metadata.output_dir)) {
        options.logWarn('Path escapes output directory', {
            playSessionId: options.playSessionId,
            requestedPath: normalizedPath,
            outputDir: metadata.output_dir,
        });
        return {
            response: new Response('Invalid path', {
                status: 400,
                headers: options.corsHeaders,
            }),
        };
    }

    // Remembered, not re-checked: it decides whether the restore below has to
    // rerun FFmpeg. Present-but-unreadable (transient IO) means the output is
    // already there and a respawn would rewrite it under a live client; genuinely
    // missing means only FFmpeg can produce it.
    //
    // Present is not enough, though: the output must be the row's item's
    // (HLS re-measure 2026-09-27 §6.3). output_dir is per session, so after a
    // cross-pod item switch the pod that lost the session can still hold the
    // OLD item's segments at exactly this path. Unproven output is treated as
    // absent — restoreJob then wipes it before adopting or respawning.
    const gopSegment =
        metadata.config.gopSegments === true ? parseSegmentPath(normalizedPath) : null;
    const physicalIndex = gopSegment
        ? gopSegment.segmentIndex - (metadata.segment_offset ?? 0)
        : undefined;
    const persistedFilePath = gopSegment
        ? path.join(
              metadata.output_dir,
              gopSegment.streamDir,
              getSegmentFilename(physicalIndex!, path.extname(normalizedPath).slice(1)),
          )
        : fullSegmentPath;
    // Adoption must inspect the translated file too: public entry N need not
    // have a physical file N, even when the finished output contains N-offset.
    const segmentPresentOnDisk =
        (physicalIndex === undefined || physicalIndex >= 0) &&
        (await fileExists(persistedFilePath, options.accessFile)) &&
        (await outputBelongsToRowItem(options, metadata));
    // GOP output is private producer state: playlists begin at this
    // generation's offset and physical segment N is public entry N + offset.
    // Restore the job so the normal handler synthesizes the absolute playlist
    // and translates public entry numbers before reading any media bytes.
    if (segmentPresentOnDisk && metadata.config.gopSegments !== true) {
        if (metadata.status !== 'error' && metadata.can_restore && !isShuttingDown()) {
            startPrewarmRestore(
                options,
                metadata,
                parseSegmentPath(normalizedPath)?.segmentIndex,
                previousOwnerMayStillWrite,
            );
        }
        const response = await servePersistedSegmentIfPossible(
            options,
            metadata,
            normalizedPath,
            fullSegmentPath,
        );
        if (response) return { response };
    }

    const preRestoreResponse = validateRestorableMetadata(options, metadata);
    if (preRestoreResponse) return { response: preRestoreResponse };

    if (isShuttingDown()) return restorationShutdownResult(options);

    options.logInfo('Segments not found, restarting FFmpeg job', {
        playSessionId: options.playSessionId,
        mode: metadata.mode,
        segmentOffset: metadata.segment_offset,
    });

    try {
        const claimed = await options.jobPersistence.claimJobForRestoration(
            options.playSessionId,
            options.currentPodName,
            metadata.item_id,
        );

        if (!claimed) {
            options.logInfo('Job restoration already in progress on another pod', {
                playSessionId: options.playSessionId,
                thisPodName: options.currentPodName,
            });
            return {
                response: new Response('Job being restored by another pod, please retry', {
                    status: 503,
                    headers: {
                        ...options.corsHeaders,
                        'Retry-After': '5',
                    },
                }),
            };
        }

        // Null for a playlist or init-segment request, which carries no position
        // to resume at — those fall back to the persisted offset.
        if (isShuttingDown()) return restorationShutdownResult(options);
        const requiredSegmentIndex = parseSegmentPath(normalizedPath)?.segmentIndex;

        const job = await options.transcodeService.restoreJob(metadata, {
            segmentPresentOnDisk,
            requiredSegmentIndex,
            previousOwnerMayStillWrite:
                previousOwnerMayStillWrite || peerMayStillWrite(options.playSessionId),
        });
        // The restored job writes a directory of its own; the old producer is
        // no longer in its way.
        takenOverFromPeer.delete(options.playSessionId.toLowerCase());
        // The requested public filename is not the physical GOP filename.
        // Let the handler wait for the translated file (and fail closed if
        // the assembler cannot reproduce the grid), rather than waiting here
        // for a different entry or timing out on a filename that never exists.
        if (job.config?.gopSegments === true) return { job };
        // A copy-mode restore that resumed at the requested segment writes that
        // segment as file 0 of its own generation (public index minus offset), so
        // the public file name this loop would poll never appears. The handler
        // translates the name and waits for the right file (prod 2026-11-01:
        // segment_00690.m4s, 30 s timeout while the job had produced 26 segments).
        if (job.transcodeDecisionResult?.videoAction === 'copy' && job.segmentOffset > 0) {
            return { job };
        }
        const segmentFilePath = path.join(job.outputDir, normalizedPath);
        const segmentWait = await waitForRestoredSegment(segmentFilePath, options, job);

        if (!segmentWait.ready) {
            // A seek can promote another generation while we wait in the
            // restored directory. The pod ownership guard cannot fence that
            // same-pod replacement: this timeout belongs to the old producer,
            // not the session now being served by the newer one.
            const currentJob = options.transcodeService.getJobByPlaySession(options.playSessionId);
            if (
                currentJob &&
                currentJob.generationIndex > job.generationIndex &&
                isActiveStatus(currentJob.status)
            ) {
                options.logInfo('Ignoring segment timeout from superseded FFmpeg generation', {
                    playSessionId: options.playSessionId,
                    segment: normalizedPath,
                    restoredGeneration: job.generationIndex,
                    currentGeneration: currentJob.generationIndex,
                });
            } else {
                options.logError('Segment not ready after FFmpeg restart', undefined, {
                    playSessionId: options.playSessionId,
                    segment: normalizedPath,
                    timeoutMs: options.restoreWaitTimeoutMs,
                });
                await markRestorationError(options, 'Segment timeout after FFmpeg restart');
            }
            return {
                response: new Response('Segment not ready after restart', {
                    status: 503,
                    headers: {
                        ...options.corsHeaders,
                        ...buildExplicitStreamDiagnosticHeaders('upstream-timeout'),
                    },
                }),
            };
        }

        options.logInfo('Segment ready after FFmpeg restart', {
            playSessionId: options.playSessionId,
            segment: normalizedPath,
            waitMs: segmentWait.waitMs,
        });
        return { job };
    } catch (error) {
        if (error instanceof ShutdownInterruptedError) return restorationShutdownResult(options);
        options.logError('Failed to restore transcode job', error as Error, {
            playSessionId: options.playSessionId,
            metadata,
        });
        await markRestorationError(options, `Restoration failed: ${(error as Error).message}`);
        return {
            response: new Response('Failed to restore session', {
                status: 500,
                headers: {
                    ...options.corsHeaders,
                    ...buildExplicitStreamDiagnosticHeaders('transcoder-start-failed'),
                },
            }),
        };
    }
}

function restorationShutdownResult(
    options: RestoreHlsJobIfMissingOptions,
): RestoreHlsJobIfMissingResult {
    options.logInfo('Deferring HLS restoration during shutdown', {
        playSessionId: options.playSessionId,
    });
    const response = shuttingDownResponse();
    for (const [name, value] of Object.entries(options.corsHeaders)) {
        response.headers.set(name, value);
    }
    return { response };
}

function isActiveStatus(status: string): boolean {
    return status === 'running' || status === 'ready' || status === 'starting';
}

async function outputBelongsToRowItem(
    options: RestoreHlsJobIfMissingOptions,
    metadata: PersistedJobMetadata,
): Promise<boolean> {
    const marker = await readOutputMarker(metadata.output_dir, options.readFile);
    if (outputMarkerNamesItem(marker, metadata.item_id)) return true;
    options.logWarn("On-disk output is not this row's item — not serving it", {
        playSessionId: truncateForLog(options.playSessionId),
        rowItemId: truncateForLog(metadata.item_id),
        markerItemId: truncateForLog(marker?.itemId),
        markerPod: marker?.podName,
        outputDir: metadata.output_dir,
    });
    return false;
}

function isSafeNormalizedPath(normalizedPath: string): boolean {
    return (
        !isOutputMarkerPath(normalizedPath) &&
        !normalizedPath.includes('..') &&
        !normalizedPath.includes('\0') &&
        normalizedPath !== '.' &&
        normalizedPath !== ''
    );
}

async function fileExists(
    filePath: string,
    accessFile: (filePath: string) => Promise<void>,
): Promise<boolean> {
    try {
        await accessFile(filePath);
        return true;
    } catch {
        return false;
    }
}

async function servePersistedSegmentIfPossible(
    options: RestoreHlsJobIfMissingOptions,
    metadata: PersistedJobMetadata,
    normalizedPath: string,
    fullSegmentPath: string,
): Promise<Response | undefined> {
    options.logInfo('Serving from pre-generated segments', {
        playSessionId: options.playSessionId,
        segment: normalizedPath,
        outputDir: metadata.output_dir,
    });

    try {
        const fileBuffer = await options.readFile(fullSegmentPath);
        const fileSize = fileBuffer.length;
        await options.jobPersistence.updateLastAccessed(options.playSessionId);
        options.trackHlsSegment(fileSize);

        const ext = path.extname(fullSegmentPath);
        const contentType = options.contentTypes[ext] || 'application/octet-stream';

        return new Response(fileBuffer as unknown as ArrayBuffer, {
            status: 200,
            headers: {
                ...options.corsHeaders,
                'Content-Type': contentType,
                'Content-Length': fileSize.toString(),
                'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
            },
        });
    } catch (error) {
        options.logError('Failed to read segment from disk', error as Error, {
            playSessionId: options.playSessionId,
            segment: normalizedPath,
            path: fullSegmentPath,
        });
        return undefined;
    }
}

function validateRestorableMetadata(
    options: RestoreHlsJobIfMissingOptions,
    metadata: PersistedJobMetadata,
): Response | undefined {
    if (metadata.status === 'error') {
        options.logWarn('Job is in error state, cannot restore', {
            playSessionId: options.playSessionId,
            errorMessage: metadata.error_message,
        });
        return new Response('Transcode job failed', {
            status: 500,
            headers: {
                ...options.corsHeaders,
                ...buildExplicitStreamDiagnosticHeaders('transcoder-start-failed'),
            },
        });
    }

    if (!metadata.can_restore) {
        options.logInfo('Job marked as non-restorable (admin/client stop)', {
            playSessionId: options.playSessionId,
            status: metadata.status,
        });
        // Flag this 410 as terminal so the client distinguishes an admin/client
        // stop (do NOT auto-reconnect) from a plain "session expired" restart.
        const stoppedHeaders = new Headers(options.corsHeaders);
        stoppedHeaders.set('X-Lumastra-Session-Terminal', 'true');
        for (const [name, value] of Object.entries(
            buildExplicitStreamDiagnosticHeaders('session-expired'),
        )) {
            stoppedHeaders.set(name, value);
        }
        return new Response('Session was stopped', {
            status: 410,
            headers: stoppedHeaders,
        });
    }

    return undefined;
}

async function waitForRestoredSegment(
    segmentFilePath: string,
    options: RestoreHlsJobIfMissingOptions,
    job: TranscodeJob,
): Promise<{ ready: boolean; waitMs: number }> {
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startTime = Date.now();

    while (Date.now() - startTime < options.restoreWaitTimeoutMs) {
        if (job.shutdownKillRequested && job.killRequested) throw new ShutdownInterruptedError();
        if (await fileExists(segmentFilePath, options.accessFile)) {
            return { ready: true, waitMs: Date.now() - startTime };
        }
        await sleep(options.restorePollIntervalMs);
    }

    return { ready: false, waitMs: Date.now() - startTime };
}

async function markRestorationError(
    options: RestoreHlsJobIfMissingOptions,
    errorMessage: string,
): Promise<void> {
    try {
        // D-HLS-1 follow-up: guarded on `currentPodName` — by this point
        // `claimJobForRestoration` has already set `pod_name` to THIS pod, so
        // the guard is a no-op for the normal case and only refuses if a
        // newer process's `upsertJob` full-replace re-took the row (a
        // different item) while this restore attempt was in flight.
        await options.jobPersistence.updateStatus(
            options.playSessionId,
            'error',
            errorMessage,
            undefined,
            options.currentPodName,
        );
    } catch (dbError) {
        options.logWarn('Failed to update job status to error', {
            playSessionId: options.playSessionId,
            error: String(dbError),
        });
    }
}
