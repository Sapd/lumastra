// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Delta Ingest — trigger-only task.
 *
 * Upserts and removes a caller-supplied list of files WITHOUT walking the
 * library. Designed for push-delta events (inotify/FSEvents/S3-notifications)
 * that know exactly which paths changed.
 *
 * Processing order: removes FIRST, then upserts. This is what makes a
 * same-cycle rename (the native watcher delivers unlink-old +
 * add-new, coalesced into one batch) reclaim the original item instead of
 * duplicating it: the remove path soft-dismisses the old media_item and
 * snapshots its content hash (`media_items.dismissed_content_hash`, see
 * `file-rematch.queries.ts`) BEFORE the new file's upsert runs its
 * rename-reconnect-by-hash lookup. Processing upserts first would let the
 * new-file ingest run while the old item is still active — no dismissed
 * candidate exists yet, so the reclaim lookup misses and a brand-new
 * media_item is created, stranding ratings/watch-history/playlist rows on
 * the old (about-to-be-dismissed) UUID. Each file produces a per-file
 * outcome record plus a rollup summary.
 *
 * Concurrency note: `exclusiveWith`/`identityFor` provide delta-vs-delta dedup
 * for the same library path — two delta runs for the same `libraryPathId` never
 * overlap. Coexistence with `file-library-scan` is NOT via a shared mutex; the
 * scanner's stale-cleanup guard (`updated_at <= walkStartedAt`) makes the delta
 * a safe concurrent writer, exactly like the file watcher.
 *
 * PAYLOAD IS OUT-OF-BAND (fixes a payload-drop bug): `identityFor`/
 * `exclusiveWith` dedup on `libraryPathId` ALONE. Previously the upsert/remove
 * list traveled inside the deduped task `input`, so a second `startRun` for
 * the same path — with a COMPLETELY DIFFERENT file list — came back
 * `{ deduped: true }` and that payload was silently dropped (not queued, not
 * merged). Three independent callers (the `/api/v1/library/ingest` route,
 * upload finalize, upload ancillary) can race on the same path, so this was a
 * real gap, only masked by a later full library scan eventually catching the
 * dropped files.
 *
 * Fix: callers now push their payload onto a per-library-path Valkey LIST
 * FIRST (`enqueueDeltaPayload` in `file-delta-ingest-queue.ts`), THEN call
 * `startRun` with a payload-free input (just `{ libraryPathId }`, optionally
 * `eventId`). A deduped `startRun` is now harmless — the payload is already
 * durably queued for whichever run (new or already-active) drains it.
 * `execute()` below drains that queue in a loop until it's empty, coalescing
 * every payload pushed for this path into the single active run. Bonus: the
 * payload no longer counts against `startRun`'s 256 KB serialized-input cap.
 *
 * Residual window (documented, not fully closed — see
 * `enqueueDeltaPayload`'s doc comment for the matching note on the push
 * side): a payload pushed AFTER this run's final "queue is empty" check but
 * BEFORE the runner releases this run's `exclusiveWith` identity key
 * (`runner.ts` `releaseExclusivityKey`, called immediately after `execute()`
 * returns) sits on the queue until the next event/scan triggers a fresh run
 * for this path. That window is sub-millisecond in practice — strictly
 * better than the old design's guaranteed whole-payload drop — so it's
 * documented rather than closed with a more elaborate (and racy in its own
 * right) re-fire protocol.
 *
 * Backward compatibility: `upsert`/`remove` are still accepted directly on
 * the task input (defaulting to `[]`) and, if non-empty, are processed FIRST
 * — before the queue is drained — so an in-flight job enqueued by a
 * pre-deploy caller (or the still-legacy `file-reconcile` task, which enqueues
 * this task with an inline payload) keeps working unchanged across a deploy.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { sep } from 'node:path';
import { registry } from '../../registry.js';
import { getLibraryPathById } from '$lib/server/database/queries/library-paths.queries.js';
import {
    deleteStaleMediaFile,
    findMediaFilePathNfc,
    findRangeFilesSupersededBy,
} from '$lib/server/database/queries/media-files.queries.js';
import { refreshRecentlyAddedRecencyForItems } from '$lib/server/database/queries/browse.queries.js';
import { ingestSingleFile } from './media-sources/file-scanner.js';
import { findRangeFilesCoveringRemovedFile } from './media-sources/_helpers/file-scanner/multi-episode-links.js';
import {
    findUnlinkedSameSizeNames,
    takeSkippedAliases,
} from './media-sources/_helpers/file-scanner/removed-file-recheck.js';
import { resolveUnderRoot } from '$lib/server/utils/library-path-safety.js';
import { safeRealpath } from '$lib/server/utils/safe-fs.js';
import { requireClient } from '../../valkey-types.js';
import { recordReconcileSkips } from './file-reconcile-skips.js';
import {
    pendingListKey,
    processingListKey,
    recoverProcessing,
    type DeltaPayload,
} from './file-delta-ingest-queue.js';
import type { PluginContext as LegacyPluginContext } from '$lib/server/plugins/types/base-plugin.js';

const inputSchema = z.object({
    libraryPathId: z.string(),
    // Back-compat only — new callers push the payload via
    // enqueueDeltaPayload() and leave these at their [] default. See the
    // module doc above.
    upsert: z.array(z.string()).default([]),
    remove: z.array(z.string()).default([]),
    eventId: z.string().optional(),
});

type DeltaInput = z.infer<typeof inputSchema>;

type Outcome = 'upserted' | 'removed' | 'remove_no_match' | 'error' | 'skipped' | 'filtered';

interface FileResult {
    index: number;
    path: string;
    op: 'upsert' | 'remove';
    outcome: Outcome;
    mediaItemId?: string | null;
    reason?: string;
}

interface DeltaResult {
    requested: number;
    succeeded: number;
    softErrors: number;
    removedNoMatch: number;
    skipped: number;
    filtered: number;
    eventId?: string;
    /** Every distinct eventId seen across the legacy inline payload and every drained queue entry. */
    eventIds?: string[];
    /**
     * Number of upsert/remove batches folded into this run: 1 for the legacy
     * inline payload (if present) plus one per payload drained off the
     * Valkey queue. >1 means this run coalesced multiple racing callers.
     */
    batchesProcessed: number;
    message: string;
    results: FileResult[];
}

export const fileDeltaIngestTask = defineTask<DeltaInput, DeltaResult>({
    id: 'file-delta-ingest',
    purpose: 'library',
    name: 'File Delta Ingest',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Trigger-only: fired by push-delta file events (inotify/FSEvents/S3) via
    // startRun, never scheduled. Declaring this makes the boot trigger-coverage audit
    // classify it as 'manual-only' instead of flagging it as an orphan
    // (TASK_TRIGGER_INCONSISTENCY).
    manualOnly: true,

    resourceClass: 'ingest',

    // Delta-vs-delta dedup: two delta runs for the same library path never
    // overlap. Coexistence with file-library-scan is via the scanner's
    // stale-cleanup guard, not via a shared mutex.
    //
    // Dedup keys on libraryPathId ONLY — the payload itself lives out-of-band
    // in the Valkey queue (file-delta-ingest-queue.ts), not in this identity
    // formula's input. See the module doc above for why.
    identityFor: (input) => `path-${input.libraryPathId}`,
    scope: 'global',
    exclusiveWith: { scope: 'global', ttl: '30m' },

    quotas: { maxConcurrent: 4 },

    inputSchema,

    timeout: { hard: '25m', soft: '20m' },

    feedsInto: ['media-probe', 'trickplay-params-sync'],

    async execute(ctx) {
        const { logger, signal, sql } = ctx;

        const lp = await getLibraryPathById(sql, ctx.input.libraryPathId);
        if (!lp || !lp.enabled) {
            logger.warn('file-delta-ingest: library path not found or disabled', {
                libraryPathId: ctx.input.libraryPathId,
            });
            return {
                success: false,
                itemsProcessed: 0,
                result: {
                    requested: 0,
                    succeeded: 0,
                    softErrors: 0,
                    removedNoMatch: 0,
                    filtered: 0,
                    skipped: 0,
                    batchesProcessed: 0,
                    results: [],
                    message: 'library path not found or disabled',
                },
            };
        }

        // Resolve symlinks on the configured root once. Throws on
        // unmounted/missing root — surfaces as a permanent task failure.
        // This realRoot is used ONLY as a symlink-escape guard; the path
        // stored in media_files is always the lexical path under lp.path
        // (matching what walkDirectoryWithResult stores).
        let realRoot: string;
        try {
            realRoot = await safeRealpath(lp.path);
        } catch (e) {
            throw new Error(
                `file-delta-ingest: cannot resolve library root "${lp.path}": ${e instanceof Error ? e.message : String(e)}`,
                { cause: e },
            );
        }

        const results: FileResult[] = [];
        // Items that were linked to a removed file: their titles' recency needs a
        // refresh. Kept out of `results`, which is returned in the run output.
        const removedItemIds: string[] = [];
        let succeeded = 0;
        let softErrors = 0;
        let removedNoMatch = 0;
        let skipped = 0;
        let filtered = 0;
        let index = 0;
        let total = 0;
        let batchesProcessed = 0;
        const eventIds: string[] = [];
        // Files ingest deliberately left out of the library (no media_files row).
        // Handed to file-reconcile so it stops re-proposing them every cycle.
        const deliberateSkips: string[] = [];

        // Full ctx cast — mirrors file-scanner.ts startWatching. The SDK
        // TaskContext carries .sql, .logger, and every other LegacyPluginContext
        // field at runtime, so casting the whole ctx is strictly safer than a
        // 2-field stub that would silently miss fields added to the SDK later.
        const ingestCtx = ctx as unknown as LegacyPluginContext;

        /**
         * Process one upsert/remove batch, appending outcomes to the shared
         * accumulators above (removes before upserts, within this batch — see
         * the module doc for why this order matters for same-cycle renames).
         * Called once for the legacy inline payload (if any) and once per
         * payload drained off the Valkey queue, oldest first — see the
         * callers below.
         *
         * `total` grows every call — safe because ctx.reportProgress treats
         * `total` as a high-watermark (only ever increases; see progress.ts),
         * so a growing total as more queued payloads are discovered doesn't
         * fight the throttled reporter.
         */
        async function processPayload(payload: {
            upsert: string[];
            remove: string[];
        }): Promise<void> {
            total += payload.upsert.length + payload.remove.length;
            batchesProcessed++;
            // Files a removed file was standing in for: multi-episode files it
            // covered (the episode it held has no file now), and other names of
            // the same file (a hard link renamed over it, now unlinked). They are
            // ingested again once the upserts are done.
            const recheck = new Set<string>();
            const collectRecheck = async (
                removedPath: string,
                removedSizeBytes: number | undefined,
            ): Promise<void> => {
                try {
                    for (const p of await findRangeFilesSupersededBy(sql, removedPath, lp!.path)) {
                        recheck.add(p);
                    }
                    for (const p of await findRangeFilesCoveringRemovedFile(sql, removedPath)) {
                        recheck.add(p);
                    }
                    const skippedNames = takeSkippedAliases(removedPath);
                    if (removedSizeBytes !== undefined) {
                        for (const p of await findUnlinkedSameSizeNames(
                            sql,
                            removedPath,
                            removedSizeBytes,
                            skippedNames,
                        )) {
                            recheck.add(p);
                        }
                    }
                } catch (e) {
                    logger.warn('file-delta-ingest: superseded multi-episode lookup failed', {
                        path: removedPath,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            };

            // ── REMOVES FIRST ────────────────────────────────────────────────
            // Dismissing/deleting the old row before the new file's upsert
            // runs lets a same-cycle rename's upsert half find the
            // just-dismissed item via rename-reconnect-by-hash (see the
            // module doc above) instead of racing it and creating a
            // duplicate.
            for (const rel of payload.remove) {
                if (signal.aborted) {
                    results.push({ index, path: rel, op: 'remove', outcome: 'skipped' });
                    skipped++;
                    index++;
                    continue;
                }

                // lexAbs is the stored path — must match what the scanner wrote.
                // Non-null: `lp` was checked at function entry and is never reassigned.
                // M4 (fix plan 6, Task 7 fix round 2): REMOVE is deletion-only,
                // so a control character baked into a row written before the
                // F4 guard existed must still resolve here — otherwise that
                // row could never be retired through the delta API. Every
                // other containment check (`..`, absolute, `\`, symlink
                // escape below) still applies.
                const lexAbs = resolveUnderRoot(lp!.path, rel, { allowControlChars: true });
                if (!lexAbs) {
                    results.push({
                        index,
                        path: rel,
                        op: 'remove',
                        outcome: 'error',
                        reason: 'path escapes library root or is invalid',
                    });
                    softErrors++;
                    index++;
                    ctx.reportProgress(index, total);
                    continue;
                }

                try {
                    // Symlink-escape guard before deletion. ENOENT is not an
                    // escape — a deleted file can't have a live symlink. Other
                    // errors (EACCES, ELOOP) propagate to the outer catch.
                    try {
                        const real = await safeRealpath(lexAbs);
                        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
                            results.push({
                                index,
                                path: rel,
                                op: 'remove',
                                outcome: 'error',
                                reason: 'path escapes library root after symlink resolution',
                            });
                            softErrors++;
                            index++;
                            ctx.reportProgress(index, total);
                            continue;
                        }
                    } catch (err) {
                        const code =
                            err && typeof err === 'object' && 'code' in err
                                ? String((err as { code?: unknown }).code)
                                : undefined;
                        if (code !== 'ENOENT') throw err;
                        // ENOENT: file already removed from disk; proceed to DB delete.
                    }
                    // Fast path: try exact-match delete first (99% case — ASCII/already-NFC paths).
                    // Only fall back to the NFC normalisation lookup on a miss, which handles the
                    // NFC/NFD mismatch common on macOS (HFS+/APFS stores NFC, watcher emits NFD).
                    const exact = await deleteStaleMediaFile(sql, lexAbs);
                    if (exact.deleted) {
                        results.push({
                            index,
                            path: rel,
                            op: 'remove',
                            outcome: 'removed',
                        });
                        removedItemIds.push(...(exact.affectedItemIds ?? []));
                        succeeded++;
                        await collectRecheck(lexAbs, exact.removedSizeBytes);
                    } else {
                        const stored = await findMediaFilePathNfc(sql, lexAbs);
                        if (stored === null) {
                            results.push({
                                index,
                                path: rel,
                                op: 'remove',
                                outcome: 'remove_no_match',
                            });
                            removedNoMatch++;
                        } else {
                            const fallback = await deleteStaleMediaFile(sql, stored);
                            if (fallback.deleted) {
                                results.push({
                                    index,
                                    path: rel,
                                    op: 'remove',
                                    outcome: 'removed',
                                });
                                removedItemIds.push(...(fallback.affectedItemIds ?? []));
                                succeeded++;
                                await collectRecheck(stored, fallback.removedSizeBytes);
                            } else {
                                results.push({
                                    index,
                                    path: rel,
                                    op: 'remove',
                                    outcome: 'remove_no_match',
                                });
                                removedNoMatch++;
                            }
                        }
                    }
                } catch (e) {
                    results.push({
                        index,
                        path: rel,
                        op: 'remove',
                        outcome: 'error',
                        reason: e instanceof Error ? e.message : String(e),
                    });
                    softErrors++;
                }
                index++;
                ctx.reportProgress(index, total);
            }

            // ── UPSERTS LAST ─────────────────────────────────────────────────
            for (const rel of payload.upsert) {
                if (signal.aborted) {
                    results.push({ index, path: rel, op: 'upsert', outcome: 'skipped' });
                    skipped++;
                    index++;
                    continue;
                }

                // lexAbs is the stored path — matches what the scanner writes.
                // Non-null: `lp` was checked at function entry and is never reassigned.
                const lexAbs = resolveUnderRoot(lp!.path, rel);
                if (!lexAbs) {
                    results.push({
                        index,
                        path: rel,
                        op: 'upsert',
                        outcome: 'error',
                        reason: 'path escapes library root or is invalid',
                    });
                    softErrors++;
                    index++;
                    ctx.reportProgress(index, total);
                    continue;
                }

                try {
                    // Symlink-escape guard: resolve lexAbs to its real path and
                    // confirm it stays under realRoot. ENOENT is not an escape —
                    // a not-yet-visible file can't have a symlink. Other errors
                    // (EACCES, ELOOP) are re-thrown into the catch below.
                    try {
                        const real = await safeRealpath(lexAbs);
                        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
                            results.push({
                                index,
                                path: rel,
                                op: 'upsert',
                                outcome: 'error',
                                reason: 'path escapes library root after symlink resolution',
                            });
                            softErrors++;
                            index++;
                            ctx.reportProgress(index, total);
                            continue;
                        }
                    } catch (err) {
                        const code =
                            err && typeof err === 'object' && 'code' in err
                                ? String((err as { code?: unknown }).code)
                                : undefined;
                        if (code !== 'ENOENT') throw err;
                        // ENOENT: file not yet on disk; lexical guard already passed.
                    }
                    // NOTE: if this upsert's rename-reconnect-by-hash lookup
                    // fails to hash the file's head (transient read error),
                    // ingestSingleFile/processVideoFile|processAudioFile log
                    // it and fall through to normal new-item creation — it is
                    // not surfaced as a soft error here, since the file still
                    // gets ingested (just without reclaim).
                    const res = await ingestSingleFile(sql, lexAbs, lp!, ingestCtx);
                    if (res.status === 'skipped' && !res.mediaItemId) deliberateSkips.push(rel);
                    if (res.status === 'ingested' || res.status === 'skipped') {
                        results.push({
                            index,
                            path: rel,
                            op: 'upsert',
                            outcome: 'upserted',
                            mediaItemId: res.mediaItemId,
                        });
                        succeeded++;
                    } else if (res.status === 'filtered') {
                        results.push({
                            index,
                            path: rel,
                            op: 'upsert',
                            outcome: 'filtered',
                            mediaItemId: null,
                        });
                        filtered++;
                    } else {
                        results.push({
                            index,
                            path: rel,
                            op: 'upsert',
                            outcome: 'error',
                            mediaItemId: null,
                        });
                        softErrors++;
                    }
                } catch (e) {
                    results.push({
                        index,
                        path: rel,
                        op: 'upsert',
                        outcome: 'error',
                        reason: e instanceof Error ? e.message : String(e),
                    });
                    softErrors++;
                }
                index++;
                ctx.reportProgress(index, total);
            }

            // After the upserts: a replacement file for the episode (an upgrade
            // under a new name) is in place first, and the range file yields to it.
            for (const absPath of recheck) {
                if (signal.aborted) break;
                try {
                    const res = await ingestSingleFile(sql, absPath, lp!, ingestCtx);
                    logger.info(
                        'file-delta-ingest: re-ingested a file a removed file covered or was another name for',
                        {
                            path: absPath,
                            status: res.status,
                        },
                    );
                } catch (e) {
                    logger.warn(
                        'file-delta-ingest: re-ingesting a file a removed file covered failed',
                        {
                            path: absPath,
                            error: e instanceof Error ? e.message : String(e),
                        },
                    );
                }
            }
        }

        // ── 0. LEGACY INLINE PAYLOAD (back-compat) ──────────────────────────
        // A caller that hasn't migrated to enqueueDeltaPayload yet (or an
        // in-flight job enqueued by a pre-deploy worker) may still send
        // upsert/remove directly in the task input. Processed first, before
        // the queue, so ordering matches what a legacy-only caller would
        // have seen pre-fix.
        if (ctx.input.upsert.length > 0 || ctx.input.remove.length > 0) {
            if (ctx.input.eventId) eventIds.push(ctx.input.eventId);
            await processPayload({ upsert: ctx.input.upsert, remove: ctx.input.remove });
        }

        // ── 1. DRAIN THE VALKEY SIDE-CHANNEL QUEUE ──────────────────────────
        // See file-delta-ingest-queue.ts for the full design. Every migrated
        // caller enqueues its payload there and calls startRun with a
        // payload-free input; identityFor/exclusiveWith dedup a second
        // startRun for this path onto THIS run, and this loop drains
        // whatever landed on the queue — including payloads pushed by
        // callers whose startRun came back `{ deduped: true }` — until it's
        // empty, coalescing every racing caller into one run.
        {
            const client = requireClient();
            const libraryPathId = ctx.input.libraryPathId;
            const pendingKey = pendingListKey(libraryPathId);
            const processingKey = processingListKey(libraryPathId);

            // Crash-recovery sweep FIRST: anything still sitting on the
            // processing key is a leftover from a PREVIOUS run for this path
            // that was killed between claiming an entry (LMOVE) and acking it
            // (LREM). exclusiveWith guarantees only one run per path is ever
            // active, so this can only be a crash artifact, never a
            // concurrent claim — move it back onto the pending key before
            // draining so it can't hide from this run.
            await recoverProcessing(client, libraryPathId);

            // Defensive iteration cap, mirroring pending-write-drain's
            // bounded sweeps. If ever hit, the remainder safely waits on the
            // pending list for the next event/scan-triggered run — nothing
            // is lost, just deferred, same as the residual window documented
            // on enqueueDeltaPayload.
            const MAX_DRAIN_ITERATIONS = 10_000;
            for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
                if (signal.aborted) break;

                const raw = await client.customCommand([
                    'LMOVE',
                    pendingKey,
                    processingKey,
                    'RIGHT',
                    'LEFT',
                ]);
                if (raw === null || raw === undefined) break;
                const rawStr = String(raw);

                let payload: DeltaPayload;
                try {
                    payload = JSON.parse(rawStr) as DeltaPayload;
                } catch {
                    logger.warn('file-delta-ingest: malformed queued payload dropped', {
                        libraryPathId,
                        raw: rawStr,
                    });
                    await client.customCommand(['LREM', processingKey, '1', rawStr]);
                    continue;
                }

                if (payload.eventId) eventIds.push(payload.eventId);
                await processPayload({
                    upsert: payload.upsert ?? [],
                    remove: payload.remove ?? [],
                });

                // Ack only once the payload has been fully processed (every
                // per-file outcome recorded) — mirrors pending-write-drain's
                // claim/replay/ack ordering, so a crash mid-processing leaves
                // the entry on the processing key for the NEXT run's recovery
                // sweep instead of losing it.
                await client.customCommand(['LREM', processingKey, '1', rawStr]);
            }
        }

        // ── 2. REFRESH RECENTLY-ADDED RECENCY (best-effort) ─────────────────
        // Keeps media_items.first_file_at / season_debut_at fresh for the
        // browse 'titles'/'seasons' newness modes (see browse.queries.ts).
        // Never fails the run — a stale recency column self-heals on the next
        // scan/delta.
        try {
            // Titles touched by an upsert (new/changed file) or a removal (a title
            // can drop back to "no files", which resets its recency to NULL). Each
            // item id resolves to its top-level title and only those are
            // refreshed; an empty or unresolvable set is a no-op (see the helper).
            // The affected items of a removed file still exist (orphans are
            // soft-dismissed, not deleted), so their titles resolve.
            const touchedIds = [
                ...new Set([
                    ...results.flatMap((r) =>
                        r.op === 'upsert' && r.outcome === 'upserted' && r.mediaItemId
                            ? [r.mediaItemId]
                            : [],
                    ),
                    ...removedItemIds,
                ]),
            ];
            if (touchedIds.length > 0) {
                await refreshRecentlyAddedRecencyForItems(sql, touchedIds);
            }
        } catch (err) {
            logger.warn('file-delta-ingest: refreshRecentlyAddedRecency failed (non-fatal)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (deliberateSkips.length > 0) {
            await recordReconcileSkips(ctx.input.libraryPathId, deliberateSkips).catch(
                (err: unknown) => {
                    logger.warn('file-delta-ingest: recording reconcile skips failed (non-fatal)', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                },
            );
        }

        const requested = results.length;
        // success=true unless EVERY file errored. This is deliberate: a caller-supplied
        // explicit batch with a few soft errors must not become `failed` (which triggers
        // auto-retry / double-processing). The scan's 5% threshold guards huge enumerations;
        // delta batches are small and caller-controlled, so all-or-nothing is the right gate.
        // filtered/skipped/removed/remove_no_match are NOT errors.
        const allErrored = requested > 0 && softErrors === requested;

        // Build a human-readable summary, mirroring file-library-scan's messageParts style.
        const messageParts = [
            `${succeeded} applied, ${filtered} filtered, ${removedNoMatch} no-match, ${softErrors} error(s)`,
        ];
        if (batchesProcessed > 1) {
            messageParts.push(`${batchesProcessed} batches coalesced`);
        }
        if (softErrors > 0) {
            const errorPaths = results
                .filter((r) => r.outcome === 'error')
                .slice(0, 5)
                .map((r) => r.path);
            messageParts.push(`Failed: ${errorPaths.join('; ')}`);
            if (softErrors > 5) {
                messageParts.push(`...and ${softErrors - 5} more`);
            }
        }
        const message = messageParts.join(' — ');

        if (softErrors > 0) {
            const errorPaths = results
                .filter((r) => r.outcome === 'error')
                .slice(0, 5)
                .map((r) => r.path);
            logger.warn('file-delta-ingest completed with errors', {
                libraryPathId: ctx.input.libraryPathId,
                succeeded,
                filtered,
                removedNoMatch,
                softErrors,
                skipped,
                batchesProcessed,
                ...(eventIds.length > 0 ? { eventIds } : {}),
                failedPathsPreview: errorPaths,
            });
        }

        return {
            success: !allErrored,
            itemsProcessed: succeeded,
            result: {
                requested,
                succeeded,
                softErrors,
                removedNoMatch,
                skipped,
                filtered,
                batchesProcessed,
                // Back-compat single field: first eventId seen (legacy inline
                // input, or the first drained queue payload that carried one).
                ...(eventIds.length > 0 ? { eventId: eventIds[0], eventIds } : {}),
                message,
                results,
            },
        };
    },
});

registry.registerTask(fileDeltaIngestTask);
