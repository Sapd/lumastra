// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Sync Engine
 *
 * Provider-agnostic orchestrator for all registered watch-sync providers
 * (SDK `WatchSyncDefinition`). Handles push (Lumastra → provider) and pull
 * (provider → Lumastra) cycles, building a fresh `PluginContext` per
 * provider operation so each plugin invocation honours the engine's
 * abort signal end-to-end.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import type {
    PluginContext,
    ResumePositionItem,
    WatchSyncDefinition,
    WatchSyncPushResult,
    WatchSyncResolveItem,
    WatchStateChange,
} from '@sapd/lumastra-plugin-sdk';
import { registry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { watchStateEvents } from './watch-state-events.service.js';
import { getTaskDb } from '../database/connection.js';
import { Logger } from '../utils/logger.js';
import { applyAutoCompleteFromProgress } from '../utils/watch-constants.js';
import { appendEventAndRebuild, computeStateFromEvents } from './watch-state-rebuilder.service.js';
import type { EventSource } from '../database/queries/user-media-events.queries.js';
import {
    getUnpushedLumastraItems,
    getSourceSnapshotsForMedia,
    getEventsSinceLastSnapshot,
    markEventsPushed,
    markEventsPushedBatch,
    type UnpushedItem,
    type SourceSnapshot,
} from '../database/queries/user-media-events.queries.js';
import {
    shouldEmitSourceUnwatch,
    shouldEmitSourceWatch,
    decideSourceProgressEvent,
} from './watch-sync-source-gate.js';
import { listPreferences } from '../database/queries/watch-sync-preferences.queries.js';
import { batchGetStates } from '../database/queries/user-media-state.queries.js';
import type { UserMediaStateRow } from '../database/queries/user-media-state.queries.js';
import { isMovie, isEpisode } from '../utils/media-types.js';
import {
    getLaterCombinedFileEpisodes,
    resolvePulledItems,
    type CombinedFileSibling,
} from './watch-sync-resolution.js';
import {
    pendingRowFromPullItem,
    eventSourceForProvider,
    importedWatchEventIds,
    type PendingResolutionInsert,
} from './watch-sync-pending.js';
import { upsertPendingResolution } from '../database/queries/watch-state-pending.queries.js';
import {
    recordSyncActivity,
    type SyncActivityInsert,
} from '../database/queries/watch-sync-activity.queries.js';
import { drainPendingResolution } from './watch-sync-pending-drain.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    resolveJellyfinNamesToUserIds,
    resolveUsernamesToUsers,
} from '../database/queries/users.queries.js';
import { foldUsername } from '$lib/shared/username-fold.js';

import { getJellyfinPairingStatus } from './jellyfin-pairing-status.service.js';
import { createCatalogService } from './catalog.service.js';
import {
    deferSyncDelivery,
    getAcknowledgedJellyfinUnwatches,
} from '../database/queries/watch-sync-delivery.queries.js';

const logger = Logger.for('WatchSyncEngine');

// Native Jellyfin sync owns file pairings; other providers keep their resolver contract.
async function refreshFilePairings(
    plugin: WatchSyncDefinition,
    sql: postgres.Sql,
    signal?: AbortSignal,
    incomingIds: readonly string[] = [],
): Promise<void> {
    if (plugin.id !== 'jellyfin-watch-sync') return;
    const { refreshJellyfinFilePairings } = await import('./jellyfin-file-pairing.service.js');
    await refreshJellyfinFilePairings(sql, signal, incomingIds, { fetch: false });
}

/** One (user, media) row of the progress-only push queue. */
interface DrainableProgressItem {
    user_id: string;
    media_id: string;
}

/** Only explicit per-item acknowledgements may consume progress events. */
export function selectDrainableProgressItems<T extends DrainableProgressItem>(args: {
    progressOnly: T[];
    positionResult: WatchSyncPushResult | null;
    positionThrew: boolean;
    attemptedKeys: ReadonlySet<string>;
}): T[] {
    const { progressOnly, positionResult, positionThrew, attemptedKeys } = args;
    if (positionThrew || !positionResult) return [];
    const acceptedKeys = new Set(
        [...positionResult.successful, ...(positionResult.drainedAsSkipped ?? [])].map(
            (e) => `${e.username}:${e.mediaId}`,
        ),
    );
    return progressOnly.filter((item) => {
        const key = `${item.user_id}:${item.media_id}`;
        return attemptedKeys.has(key) && acceptedKeys.has(key);
    });
}
/**
 * Best-effort activity recorder. A logging failure must NEVER abort a push
 * run — the feed is diagnostic, not part of the sync contract. No-ops on an
 * empty batch; swallows and logs any insert error.
 */
async function safeRecordActivity(sql: postgres.Sql, rows: SyncActivityInsert[]): Promise<void> {
    if (rows.length === 0) return;
    try {
        await recordSyncActivity(sql, rows);
    } catch (err) {
        logger.warn('Failed to record sync activity (non-fatal)', {
            count: rows.length,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Max number of (user, media) upserts processed per transaction during a
 * provider pull. A heavy-watching user can produce hundreds-to-thousands of
 * deduped items in one cycle; wrapping the entire batch in a single
 * `withTx()` held one task-pool connection open for tens of seconds, and
 * concurrent sync tasks exhausted the 7-connection task pool (SQL-C6).
 *
 * Reads of current state are batched ONCE outside the transaction (a single
 * `batchGetStates`), so each per-chunk transaction only performs the writes
 * (`appendEventAndRebuild`). Items are independent across media_ids after the
 * dedupe above, so chunking never splits a logically-atomic write — a
 * partial-failure simply leaves the cursor un-advanced and re-imports next
 * cycle (idempotent on `source_event_id`).
 */
const PULL_UPSERT_CHUNK_SIZE = 100;

// =============================================================================
// Result Types
// =============================================================================

export interface PushResult {
    providerId: string;
    processed: number;
    succeeded: number;
    skipped: number;
    failed: number;
    /** The provider was unavailable; this is not a failure. */
    skippedUnavailable: boolean;
    errors: string[];
    /** Current unpaired Jellyfin titles, deduplicated across users and retained changes. */
    notPaired?: number;
    /** End-to-end push duration for this provider, in milliseconds. */
    durationMs: number;
}

/**
 * Incremental progress callback for a per-user push/pull run (manual
 * Import/Export in the admin UI, Task 7). Fired at page/batch
 * granularity — not per individual item — since neither loop tracks a
 * reliable upfront total.
 */
export type WatchSyncProgressReporter = (p: {
    processed: number;
    total?: number;
    currentItem?: string;
}) => void;

export interface ArbitrationLoss {
    userId: string;
    mediaId: string;
    reason: string;
}

export interface PullResult {
    provider: string;
    /** The provider returned a pull result; false leaves its account metadata unknown. */
    pulled: boolean;
    movies: { imported: number; skipped: number };
    episodes: { imported: number; skipped: number; seriesResolved: number };
    resumeItems: { imported: number; skipped: number };
    totalFromProvider: number;
    totalResolved: number;
    totalUpserted: number;
    /** Resolved upstream watched verdicts overruled by local arbitration. */
    totalLostArbitration?: number;
    /** Bounded diagnostic sample; totalLostArbitration counts every loss. */
    arbitrationLosses?: ArbitrationLoss[];
    totalSkippedNoMatch: number;
    /** Unresolved items buffered into watch_state_pending_resolution this cycle. */
    totalBuffered: number;
    /** Current unpaired Jellyfin titles, deduplicated across users and the durable buffer. */
    notPaired?: number;
    /** Provider users that have no matching Lumastra account. Logged once per run. */
    usersSkippedNoLumastraAccount: number;
    /** Provider usernames behind `usersSkippedNoLumastraAccount` (for the admin notice). */
    skippedNoLumastraAccountNames?: string[];
    /** The provider was unavailable; this is not a failure. */
    skippedUnavailable: boolean;
    errors: string[];
    durationMs: number;
}

// =============================================================================
// Engine
// =============================================================================

class WatchSyncEngine {
    /**
     * Push cycle: Lumastra-originated watch state → external providers.
     *
     * Restored in M2-B around event sourcing. A "dirty" (user, media) pair
     * is one with at least one lumastra-* event (`lumastra-player` or
     * `lumastra-user-mark`) that has not yet been pushed to the target
     * provider. The cycle pushes the **current state** for each pair (one
     * call), then marks every backing event as pushed for that provider on
     * success.
     *
     * Important: we don't push events; we push state. Jellyfin, Plex, etc.
     * have no event-log API — they have per-(user, item) is_watched and
     * resume setters. The events serve only as the dirty signal.
     */
    async runPush(
        providerId?: string,
        signal?: AbortSignal,
        providedSql?: postgres.Sql | null,
    ): Promise<PushResult[]> {
        const plugins = this.getTargetPlugins(providerId).filter(
            (p) => typeof p.pushWatchState === 'function',
        );
        const results: PushResult[] = [];

        for (const plugin of plugins) {
            if (signal?.aborted) break;
            try {
                const result = await this.pushForProvider(plugin, signal, providedSql);
                if (plugin.id === 'jellyfin-watch-sync' && !result.skippedUnavailable) {
                    const sql = providedSql ?? getTaskDb();
                    if (sql) {
                        try {
                            const status = await getJellyfinPairingStatus(sql);
                            // Same total as the admin banner: path candidates without a link
                            // plus titles with no file or ID evidence on the other side.
                            result.notPaired = status.count + (status.oneSided ?? 0);
                        } catch (error) {
                            result.errors.push(
                                `Jellyfin pairing status could not be loaded: ${String(error)}`,
                            );
                        }
                    }
                }
                results.push(result);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(
                    `Push cycle failed for provider ${plugin.id}`,
                    err instanceof Error ? err : new Error(msg),
                );
                results.push({
                    providerId: plugin.id,
                    processed: 0,
                    succeeded: 0,
                    skipped: 0,
                    failed: 0,
                    skippedUnavailable: false,
                    errors: [msg],
                    durationMs: 0,
                });
            }
        }

        return results;
    }

    /**
     * Run pull cycle for all enabled watch-sync providers, or a specific one.
     */
    async runPull(
        providerId?: string,
        signal?: AbortSignal,
        providedSql?: postgres.Sql | null,
    ): Promise<PullResult[]> {
        const plugins = this.getTargetPlugins(providerId);
        const results: PullResult[] = [];

        for (const plugin of plugins) {
            if (signal?.aborted) break;
            if (!plugin.pullWatchState) {
                continue;
            }

            try {
                const result = await this.pullForProvider(plugin, signal, providedSql);
                if (plugin.id === 'jellyfin-watch-sync' && result.pulled) {
                    const sql = providedSql ?? getTaskDb();
                    if (sql) {
                        try {
                            const status = await getJellyfinPairingStatus(sql);
                            // Same total as the admin banner: path candidates without a link
                            // plus titles with no file or ID evidence on the other side.
                            result.notPaired = status.count + (status.oneSided ?? 0);
                        } catch (error) {
                            result.errors.push(
                                `Jellyfin pairing status could not be loaded: ${String(error)}`,
                            );
                        }
                    }
                }
                results.push(result);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(
                    `Pull cycle failed for provider ${plugin.id}`,
                    err instanceof Error ? err : undefined,
                );
                results.push({
                    provider: plugin.id,
                    pulled: false,
                    movies: { imported: 0, skipped: 0 },
                    episodes: { imported: 0, skipped: 0, seriesResolved: 0 },
                    resumeItems: { imported: 0, skipped: 0 },
                    totalFromProvider: 0,
                    totalResolved: 0,
                    totalUpserted: 0,
                    totalSkippedNoMatch: 0,
                    totalBuffered: 0,
                    usersSkippedNoLumastraAccount: 0,
                    skippedUnavailable: false,
                    errors: [msg],
                    durationMs: 0,
                });
            }
        }

        return results;
    }

    /**
     * Manual per-user push (admin/user-triggered "Export", Task 7).
     * Thin wrapper over the same push loop `runPush` drives, scoped to
     * exactly one user with NO watermark floor — an explicit export
     * intentionally re-syncs that user's entire current state regardless
     * of what the scheduled cycle already pushed. Re-queuing the user's
     * events (so they're visible to `getUnpushedLumastraItems` again) is
     * the CALLER's job, not this method's.
     *
     * Resolves the plugin the same way `runPush`/`runPull` do —
     * `provider` is matched against `WatchSyncDefinition.id`, not
     * `providerName`.
     */
    async runPushForUser(
        userId: string,
        provider: string,
        reporter: WatchSyncProgressReporter,
    ): Promise<void> {
        const plugin = this.getTargetPlugins(provider)[0];
        if (!plugin) {
            throw new Error(
                `runPushForUser: no watch-sync plugin registered for provider "${provider}"`,
            );
        }
        if (typeof plugin.pushWatchState !== 'function') {
            return;
        }

        await this.pushForProvider(plugin, undefined, undefined, {
            userScopes: [{ userId, since: null }],
            onProgress: reporter,
        });
    }

    /**
     * Manual per-user pull (admin/user-triggered "Import", Task 7). Thin
     * wrapper over the same pull loop `runPull` drives, restricted to
     * exactly one user regardless of link status or direction preference.
     * Resetting that user's pull cursor beforehand (so the plugin does a
     * full historical pull rather than an incremental one) is the
     * CALLER's job, not this method's.
     */
    async runPullForUser(
        userId: string,
        provider: string,
        reporter: WatchSyncProgressReporter,
    ): Promise<void> {
        const plugin = this.getTargetPlugins(provider)[0];
        if (!plugin) {
            throw new Error(
                `runPullForUser: no watch-sync plugin registered for provider "${provider}"`,
            );
        }
        if (typeof plugin.pullWatchState !== 'function') {
            return;
        }

        await this.pullForProvider(plugin, undefined, undefined, {
            onlyUserIds: [userId],
            onProgress: reporter,
        });
    }

    // =========================================================================
    // Private: Push
    // =========================================================================

    /**
     * Push current state for every (user, media) pair with un-pushed
     * lumastra-* events to one provider.
     *
     * Algorithm:
     *   1. Skip cleanly if `pushWatchState` is not implemented or the
     *      provider is unavailable (`skippedUnavailable = true`, not an
     *      error — admin UI distinguishes these).
     *   2. Loop in pages of `PAGE_SIZE`. Each page:
     *        a. Read un-pushed (user, media) pairs ordered oldest-pending
     *           first so a stale backlog item doesn't starve.
     *        b. Hydrate their current state via `batchGetStates`,
     *           grouped per user.
     *        c. Look up media metadata in one batch (media_type + tmdb +
     *           imdb + season/episode + series_tmdb_id) so the plugin
     *           has everything `resolveIds` needs.
     *        d. Resolve internal UUID → provider ID via the plugin.
     *        e. Build `WatchStateChange[]`. Drop pairs with no resolution
     *           or no state (impossible in steady state, but guard
     *           anyway) — count them as skipped.
     *        f. Hand the batch to `pushWatchState`. The plugin returns
     *           `successful` as (user, media) pairs; we mark every
     *           backing event for those pairs as pushed for this
     *           provider in one DB round-trip per (user, media) pair.
     *   3. Stop when a page returns < `PAGE_SIZE` items (or `signal` fires).
     *      The next cycle picks up new dirty rows automatically.
     */
    private async pushForProvider(
        plugin: WatchSyncDefinition,
        signal?: AbortSignal,
        providedSql?: postgres.Sql | null,
        overrides?: {
            /**
             * Explicit scope for a manual per-user Export (Task 7,
             * `runPushForUser`). When supplied, the linked-users
             * gate below is skipped entirely — an explicit
             * admin/user-triggered export always pushes for that one
             * user, watermark-free, regardless of link status or
             * direction preference.
             */
            userScopes?: Array<{ userId: string; since: Date | null; playbackOnly?: boolean }>;
            onProgress?: WatchSyncProgressReporter;
        },
    ): Promise<PushResult> {
        const startTime = Date.now();
        const result: PushResult = {
            providerId: plugin.id,
            processed: 0,
            succeeded: 0,
            skipped: 0,
            failed: 0,
            skippedUnavailable: false,
            errors: [],
            durationMs: 0,
        };

        if (!plugin.pushWatchState) {
            result.durationMs = Date.now() - startTime;
            return result;
        }

        const sql = providedSql ?? getTaskDb();
        if (!sql) {
            // Match the pull-side semantics: DB unavailable is a transient
            // skip, not a per-provider failure. The admin endpoint still
            // surfaces the error string so operators see "this happened",
            // but the plugin-level result is flagged for the UI to render
            // as a skip rather than a red toast.
            result.skippedUnavailable = true;
            result.errors.push('Database unavailable — push skipped');
            result.durationMs = Date.now() - startTime;
            return result;
        }

        // Build ONE PluginContext for the entire push cycle for this provider.
        // The ctx is cheap (lightweight refs only — sql, logger, http, cache,
        // signal, settings/secrets closures) and the engine's abort signal
        // threads through every plugin call via this single instance. The
        // legacy `WatchSyncPlugin` shape passed no ctx at all; the new SDK
        // requires one per call but doesn't require a fresh one per call.
        const ctx = buildPluginContext(plugin.id, { signal });

        const available = await plugin.isAvailable(ctx);
        if (!available) {
            // S8 parity with pull: unavailable is not a failure. The admin
            // UI surfaces skippedUnavailable so operators don't see false
            // alarms when, say, Jellyfin is restarting.
            result.skippedUnavailable = true;
            result.durationMs = Date.now() - startTime;
            logger.info(`pushForProvider: provider ${plugin.id} unavailable — skipping`);
            return result;
        }

        await refreshFilePairings(plugin, sql, signal);
        const providerName = plugin.providerName.toLowerCase();

        // -----------------------------------------------------------------
        // Linked-users gate + direction enforcement (Task 6).
        //
        // `overrides.userScopes` (manual per-user Export, `runPushForUser`)
        // bypasses this entirely — an explicit admin/user action always
        // pushes for that one user, watermark-free.
        //
        // Otherwise: providers that track their own linked accounts
        // (Trakt, MAL) report which Lumastra users have actually linked
        // them via `listLinkedUsers`. `null`/absent means the provider has
        // no such concept (Jellyfin is Lumastra-native) — no gating, exact
        // pre-existing behaviour. When linked users ARE reported, the
        // push queue is scoped to only those users AND only when their
        // sync direction allows push ('both' or 'push'), each floored at
        // their own push watermark (`since`) so pre-link history never
        // leaks into the queue — this is the core backlog fix.
        // -----------------------------------------------------------------
        let userScopes = overrides?.userScopes;
        // Users whose import also runs. Only for them may a push defer to a newer
        // upstream position: a push-only user never imports it, so deferring would
        // lose the local one. Manual per-user export (overrides) never defers.
        let importingUsers: ReadonlySet<string> | undefined;
        if (userScopes === undefined) {
            try {
                const linked = plugin.listLinkedUsers ? await plugin.listLinkedUsers(ctx) : null;
                if (linked !== null && linked !== undefined) {
                    // Dedupe: the JOIN this scope feeds is not deduped itself —
                    // a duplicate userId would duplicate every matching row.
                    const dedupedLinked = Array.from(new Set(linked));
                    const prefs = await listPreferences(sql, providerName, dedupedLinked);
                    importingUsers = new Set(
                        dedupedLinked.filter((u) => (prefs.get(u)?.direction ?? 'both') === 'both'),
                    );
                    userScopes = dedupedLinked
                        .filter((u) => {
                            const direction = prefs.get(u)?.direction ?? 'both';
                            return (
                                providerName === 'audiobookshelf' ||
                                direction === 'both' ||
                                direction === 'push'
                            );
                        })
                        .map((u) => {
                            // Retrying the listener's own playback is part of
                            // playing a book, just like live session sync. A
                            // pull-only preference still suppresses watch-state
                            // exports, but must not strand outage progress.
                            if (
                                providerName === 'audiobookshelf' &&
                                prefs.get(u)?.direction === 'pull'
                            )
                                return {
                                    userId: u,
                                    since: prefs.get(u)?.pushWatermark ?? null,
                                    playbackOnly: true,
                                };
                            return { userId: u, since: prefs.get(u)?.pushWatermark ?? null };
                        });

                    if (userScopes.length === 0) {
                        // No linked user is push-eligible this cycle — nothing
                        // to page through. Mirrors the `!plugin.pushWatchState`
                        // early-return above.
                        result.durationMs = Date.now() - startTime;
                        return result;
                    }
                }
            } catch (err) {
                // A transient failure of listLinkedUsers/listPreferences must
                // not abort the entire provider cycle — and must NOT be
                // treated as "no gating" either, since that would push ALL
                // users instead of just the linked/eligible ones (worse than
                // skipping). Log and skip this provider's cycle; the next
                // scheduled run retries.
                logger.warn(
                    'pushForProvider: linked-users/preferences gate failed; skipping cycle',
                    {
                        providerId: plugin.id,
                        error: String(err),
                    },
                );
                result.durationMs = Date.now() - startTime;
                return result;
            }
        }

        // Page size keeps each iteration's working set bounded — a huge
        // backlog still drains in linear time but no single tick reads
        // megabytes of UUIDs into memory.
        const PAGE_SIZE = 200;

        const examinedKeys = new Set<string>();
        while (!signal?.aborted) {
            const items = (
                await getUnpushedLumastraItems.all(sql, {
                    provider: providerName,
                    limit: PAGE_SIZE,
                    userScopes,
                    excludeKeys: [...examinedKeys],
                    respectBackoff: true,
                })
            ).filter((item) => !examinedKeys.has(`${item.user_id}:${item.media_id}`));
            if (items.length === 0) break;
            for (const item of items) examinedKeys.add(`${item.user_id}:${item.media_id}`);

            try {
                const { forwardProgress } = await this.pushPage(
                    sql,
                    plugin,
                    ctx,
                    providerName,
                    items,
                    result,
                    signal,
                    importingUsers,
                );

                // Retained pairs are excluded only for this run. This allows
                // later pages through even if the oldest page is entirely
                // unpaired or failed, without retrying it in a tight loop.
                if (!forwardProgress) {
                    logger.warn(
                        'pushForProvider: no progress made in page; retaining events and continuing past examined pairs',
                        {
                            providerId: plugin.id,
                            pageSize: items.length,
                            errors: result.errors.slice(-5),
                        },
                    );
                }

                // Report page-granularity progress for manual per-user
                // runs (Export, Task 7). Only fired once real forward
                // progress was made this page — matches the guard above.
                overrides?.onProgress?.({ processed: result.processed });
            } catch (err) {
                // Page-level failure (e.g. plugin threw mid-page). Log,
                // record the error, and stop — those events stay
                // un-pushed and the next cycle retries them. Counters
                // already reflect any partial work that committed before
                // the throw because pushPage accumulates into `result`
                // directly.
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(
                    `pushForProvider page failed for ${providerName}`,
                    err instanceof Error ? err : new Error(msg),
                );
                result.errors.push(msg);
                break;
            }

            // Last page — break out without another empty round-trip.
            if (items.length < PAGE_SIZE) break;
        }

        result.durationMs = Date.now() - startTime;
        logger.info(`Push complete for ${providerName}`, {
            processed: result.processed,
            succeeded: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
            errorCount: result.errors.length,
            durationMs: result.durationMs,
        });
        return result;
    }

    /**
     * Push one page of un-pushed items. Pulled out of `pushForProvider` so
     * the outer loop only handles paging concerns and the inner method
     * owns the per-page DB I/O + plugin call.
     *
     * Progress-only queues use pushResumePosition; decisive queues use
     * pushWatchState. Both hydrate state and resolve provider IDs first.
     * Only explicit acceptance or a reasoned terminal refusal consumes an
     * event; unavailable metadata, mappings and transport failures remain queued.
     */
    private async pushPage(
        sql: postgres.Sql,
        plugin: WatchSyncDefinition,
        ctx: PluginContext,
        providerName: string,
        items: UnpushedItem[],
        result: PushResult,
        signal?: AbortSignal,
        importingUsers?: ReadonlySet<string>,
    ): Promise<{
        /**
         * True iff at least one item had its backing events marked
         * pushed during this page (success OR terminal drain). Used for
         * diagnostics; per-run exclusions prevent retry loops even when
         * every item on this page is held for the next run.
         */
        forwardProgress: boolean;
    }> {
        // Counters accumulate directly into the outer `result` so a mid-page
        // throw (plugin error, query error) preserves the work that committed
        // before the throw. Lifting the counters into a local pageResult and
        // copying on success would hide acknowledgements already persisted
        // to pushed_to_providers.
        let forwardProgress = false;

        // Per-item activity rows accumulated across every push outcome branch
        // in this page and flushed best-effort before each return. Recording is
        // diagnostic — never allowed to abort the push run.
        const activity: SyncActivityInsert[] = [];

        // -----------------------------------------------------------------
        // 0. Split position-only queues from items that
        //    have a decisive un-pushed lumastra event the plugin should
        //    react to. Without this, a queue of plain progress events
        //    against a (user, media) whose current state is is_watched=false
        //    would fire DELETE /PlayedItems on the remote and overwrite
        //    a legitimate Jellyfin-side watched flag.
        // -----------------------------------------------------------------
        let progressOnly = items.filter((i) => i.latest_decisive_event_type === null);
        let toPush = items.filter((i) => i.latest_decisive_event_type !== null);

        // -----------------------------------------------------------------
        // 1. Hydrate state per user. batchGetStates is keyed by (user,
        //    mediaIds[]) so we group locally.
        // -----------------------------------------------------------------
        const byUser = new Map<UserId, UnpushedItem[]>();
        for (const item of items) {
            const existing = byUser.get(item.user_id) ?? [];
            existing.push(item);
            byUser.set(item.user_id, existing);
        }

        const stateMap = new Map<string, UserMediaStateRow>();
        for (const [userId, userItems] of byUser) {
            const states = await batchGetStates.all(sql, {
                userId,
                mediaIds: userItems.map((i) => i.media_id),
            });
            for (const state of states) {
                stateMap.set(`${state.user_id}:${state.media_id}`, state);
            }
        }

        // -----------------------------------------------------------------
        // 2. Bulk-look-up media metadata for resolveIds. Joining external_ids
        //    inside the same SELECT collapses three round-trips (movies,
        //    series, episodes) into one and produces aggregated TMDB +
        //    IMDB rows per media. Each row may produce multiple external_id
        //    matches; we coalesce by media_id.
        // -----------------------------------------------------------------
        const mediaIds = Array.from(new Set(items.map((i) => i.media_id)));
        type MediaMetaRow = {
            id: string;
            media_type: string;
            season_number: number | null;
            episode_number: number | null;
            parent_id: string | null;
            tmdb_id: string | null;
            imdb_id: string | null;
            cached_provider_id: string | null;
            series_tmdb_id: string | null;
            title: string | null;
            series_title: string | null;
            runtime_seconds: number | null;
        };
        const metaRows = await sql<MediaMetaRow[]>`
            WITH base AS (
                SELECT
                    mi.id,
                    mi.media_type,
                    mi.season_number,
                    mi.episode_number,
                    mi.parent_id,
                    mi.title,
                    mi.runtime_seconds
                FROM media_items mi
                WHERE mi.id = ANY(${mediaIds}::uuid[])
            )
            SELECT
                base.id,
                base.media_type,
                base.season_number,
                base.episode_number,
                base.parent_id,
                base.title,
                base.runtime_seconds,
                MAX(CASE WHEN ei.provider = 'tmdb' THEN ei.external_id END) AS tmdb_id,
                MAX(CASE WHEN ei.provider = 'imdb' THEN ei.external_id END) AS imdb_id,
                MAX(CASE WHEN ei.provider = ${providerName} THEN ei.external_id END) AS cached_provider_id,
                MAX(CASE WHEN ei_series.provider = 'tmdb' THEN ei_series.external_id END) AS series_tmdb_id,
                series.title AS series_title
            FROM base
            LEFT JOIN external_ids ei
                ON ei.media_id = base.id
                AND ei.provider IN ('tmdb', 'imdb', ${providerName})
            LEFT JOIN media_items season
                ON base.media_type = 'episode'
                AND season.id = base.parent_id
            LEFT JOIN media_items series
                ON base.media_type = 'episode'
                AND series.id = season.parent_id
            LEFT JOIN external_ids ei_series
                ON ei_series.media_id = series.id
                AND ei_series.provider = 'tmdb'
            GROUP BY
                base.id, base.media_type, base.season_number,
                base.episode_number, base.parent_id, base.title, base.runtime_seconds, series.title
        `;
        const metaMap = new Map(metaRows.map((r) => [r.id, r]));
        // Native providers have a finite watch-target vocabulary. Drain the
        // other media types once, without resolving or contacting the provider.
        const supports = (mediaId: string): boolean => {
            const type = metaMap.get(mediaId)?.media_type;
            if (!type) return true;
            if (providerName === 'audiobookshelf') return type === 'audiobook';
            if (providerName === 'jellyfin') return isMovie(type) || isEpisode(type);
            return true;
        };
        for (const item of items.filter((item) => !supports(item.media_id))) {
            await markEventsPushed(sql, {
                userId: item.user_id,
                provider: providerName,
                eventIds: item.event_ids,
            });
            result.processed++;
            result.skipped++;
            forwardProgress = true;
        }
        progressOnly = progressOnly.filter((item) => supports(item.media_id));
        toPush = toPush.filter((item) => supports(item.media_id));
        const retryablePair = (mediaId: string): boolean =>
            providerName === 'jellyfin' &&
            (isMovie(metaMap.get(mediaId)?.media_type) ||
                isEpisode(metaMap.get(mediaId)?.media_type));

        // -----------------------------------------------------------------
        // 3. Resolve internal UUIDs → provider IDs.
        //
        // Fast path: when external_ids already has a (media, provider)
        // mapping (because a prior pull cycle imported the item or a
        // CatalogService writer cached it), use that directly. This both
        // saves a plugin round-trip AND sidesteps a known issue with
        // Jellyfin's `AnyProviderIdEquals` filter — observed on the
        // current prod version it returns the entire library unfiltered,
        // so plugin.resolveMovieOrSeries silently picks the alphabetically
        // first item and the engine pushes Played=true onto the wrong
        // movie. The cached path is correct by construction.
        //
        // Slow path: items without a cached provider id (a fresh lumastra-
        // user-mark on something never synced from Jellyfin) still go
        // through plugin.resolveIds. Missing mappings remain queued; per-run
        // exclusions let later pages proceed without consuming those events.
        // -----------------------------------------------------------------
        const providerIdMap = new Map<string, string>();
        const resolveItems: WatchSyncResolveItem[] = [];
        for (const mediaId of mediaIds) {
            const meta = metaMap.get(mediaId);
            if (!meta || !supports(mediaId)) continue;
            if (meta.cached_provider_id) {
                providerIdMap.set(mediaId, meta.cached_provider_id);
                continue;
            }
            resolveItems.push({
                mediaId,
                mediaType: meta.media_type,
                tmdbId: meta.tmdb_id,
                imdbId: meta.imdb_id,
                seasonNumber: meta.season_number ?? undefined,
                episodeNumber: meta.episode_number ?? undefined,
                seriesTmdbId: meta.series_tmdb_id ?? undefined,
                title: meta.title ?? undefined,
            });
        }
        if (resolveItems.length > 0) {
            const resolved = await plugin.resolveIds(ctx, resolveItems);
            for (const r of resolved) {
                if (plugin.id === 'jellyfin-watch-sync') {
                    const meta = metaMap.get(r.mediaId);
                    const mediaType = isMovie(meta?.media_type)
                        ? 'movie'
                        : isEpisode(meta?.media_type)
                          ? 'episode'
                          : undefined;
                    if (mediaType) {
                        // Match the pull resolver's cache write-back. Otherwise
                        // an acknowledged metadata-based push is still counted
                        // as unpaired, and later progress must resolve it again.
                        const written = await createCatalogService(sql, {
                            skipLifecycleHooks: true,
                        }).upsertExternalId(r.mediaId, {
                            provider: providerName,
                            id: r.providerId,
                            mediaType,
                            source: 'watch-sync',
                        });
                        if (!written)
                            throw new Error(
                                `Jellyfin pairing could not be cached for ${r.mediaId}; retained for retry`,
                            );
                    }
                }
                providerIdMap.set(r.mediaId, r.providerId);
            }
        }

        // Position-only updates resolve IDs exactly like decisive updates, but
        // never call PlayedItems: a heartbeat must not change the Played flag.
        const resumeItems: ResumePositionItem[] = [];
        // Newest upstream stop this install already imported, per user and item.
        // Upstream newer than that is news the import has not seen yet.
        const importedAt = new Map<string, string>();
        const importSource = eventSourceForProvider(providerName);
        const guarded = progressOnly.filter((i) => importingUsers?.has(i.user_id));
        if (guarded.length > 0 && importSource) {
            const rows = await sql<Array<{ user_id: string; media_id: string; at: Date }>>`
                SELECT user_id, media_id, MAX(occurred_at) AS at
                FROM user_media_events
                WHERE source = ${importSource} AND repudiated_at IS NULL
                  AND media_id = ANY(${guarded.map((i) => i.media_id)}::uuid[])
                  AND user_id = ANY(${[...new Set(guarded.map((i) => i.user_id))]}::uuid[])
                GROUP BY user_id, media_id
            `;
            for (const row of rows)
                importedAt.set(`${row.user_id}:${row.media_id}`, new Date(row.at).toISOString());
        }
        // A hold for newer upstream news is offered once. The import may never write
        // an event that moves importedAt (a title Lumastra holds as watched, a
        // position within the tolerance), so the retry must write unconditionally.
        const retried = new Set<string>();
        if (guarded.length > 0) {
            const attempts = await sql<Array<{ user_id: string; media_id: string }>>`
                SELECT DISTINCT user_id, media_id FROM user_media_events
                WHERE id = ANY(${guarded.flatMap((i) => i.event_ids)}::uuid[])
                  AND COALESCE((sync_delivery -> ${providerName} ->> 'attempts')::int, 0) > 0
            `;
            for (const row of attempts) retried.add(`${row.user_id}:${row.media_id}`);
        }
        const skipReasons = new Map<string, string>();
        const benignDrains = new Set<string>();
        for (const item of progressOnly) {
            const key = `${item.user_id}:${item.media_id}`;
            const state = stateMap.get(key);
            const providerId = providerIdMap.get(item.media_id);
            const catalogRuntimeSeconds = metaMap.get(item.media_id)?.runtime_seconds;
            const runtimeMs =
                state?.runtime_ms ??
                (catalogRuntimeSeconds ? catalogRuntimeSeconds * 1000 : undefined);
            if (!state) skipReasons.set(key, 'derived state unavailable; retained for retry');
            else if (!providerId) {
                skipReasons.set(
                    key,
                    retryablePair(item.media_id)
                        ? 'no provider id; retained for retry'
                        : 'no provider id (gave up)',
                );
                if (!retryablePair(item.media_id)) benignDrains.add(key);
            } else if (!plugin.pushResumePosition) {
                skipReasons.set(key, 'provider does not support resume positions');
                benignDrains.add(key);
            } else
                resumeItems.push({
                    providerId,
                    mediaId: item.media_id,
                    username: item.user_id,
                    resumePositionMs: state.resume_position_ms,
                    ...(state.last_event_at &&
                    importingUsers?.has(item.user_id) &&
                    // Only items whose failed attempts are counted (deferSyncDelivery)
                    // can be held: for any other the hold would never expire.
                    retryablePair(item.media_id) &&
                    !retried.has(key)
                        ? {
                              eventAt: new Date(state.last_event_at).toISOString(),
                              importedAt: importedAt.get(key) ?? null,
                          }
                        : {}),
                    ...(runtimeMs && runtimeMs > 0 ? { runtimeMs } : {}),
                });
        }
        let positionResult: WatchSyncPushResult | null = null;
        let positionThrew = false;
        let positionError: string | undefined;
        if (resumeItems.length > 0 && plugin.pushResumePosition) {
            try {
                positionResult =
                    (await plugin.pushResumePosition(ctx, resumeItems, signal)) ?? null;
            } catch (err) {
                positionThrew = true;
                positionError = err instanceof Error ? err.message : String(err);
            }
        }
        const attemptedKeys = new Set(resumeItems.map((i) => `${i.username}:${i.mediaId}`));
        const drainable = selectDrainableProgressItems({
            progressOnly,
            positionResult,
            positionThrew,
            attemptedKeys,
        });
        drainable.push(
            ...progressOnly.filter((item) => benignDrains.has(`${item.user_id}:${item.media_id}`)),
        );
        if (drainable.length > 0) {
            await markEventsPushedBatch(sql, {
                provider: providerName,
                groups: drainable.map((i) => ({ userId: i.user_id, eventIds: i.event_ids })),
            });
            forwardProgress = true;
        }
        const successful = new Set(
            positionResult?.successful.map((i) => `${i.username}:${i.mediaId}`),
        );
        const terminal = new Set(
            positionResult?.drainedAsSkipped?.map((i) => `${i.username}:${i.mediaId}`),
        );
        const failures = new Map(
            positionResult?.failedItems?.map((i) => [`${i.username}:${i.mediaId}`, i.error]),
        );
        const holds = new Set(
            positionResult?.failedItems
                ?.filter((i) => i.deferred)
                .map((i) => `${i.username}:${i.mediaId}`),
        );
        for (const item of progressOnly) {
            const key = `${item.user_id}:${item.media_id}`;
            result.processed++;
            const succeeded = successful.has(key);
            const skipped = skipReasons.has(key) || terminal.has(key) || benignDrains.has(key);
            const held = holds.has(key);
            const unpaired =
                held ||
                (providerName === 'jellyfin' &&
                    skipReasons.get(key) === 'no provider id; retained for retry');
            let reason =
                skipReasons.get(key) ??
                failures.get(key) ??
                positionError ??
                (terminal.has(key)
                    ? 'provider terminally refused resume position'
                    : 'provider did not acknowledge resume position; retained for retry');
            const benign = benignDrains.has(key) || (terminal.has(key) && !failures.has(key));
            let report = true;
            if (succeeded) {
                result.succeeded++;
            } else {
                if (
                    (retryablePair(item.media_id) || providerName === 'audiobookshelf') &&
                    !terminal.has(key) &&
                    !benign
                ) {
                    const deferred = await deferSyncDelivery(
                        sql,
                        providerName,
                        item.user_id,
                        item.event_ids,
                        reason,
                        !unpaired,
                    );
                    report = deferred.firstReport;
                    reason = deferred.description;
                }
                if (skipped || !report) result.skipped++;
                else result.failed++;
                if (!unpaired && !benign && report)
                    result.errors.push(`${item.user_id}/${item.media_id}: ${reason}`);
            }
            const meta = metaMap.get(item.media_id);
            activity.push({
                userId: item.user_id,
                provider: providerName,
                direction: 'push',
                outcome: succeeded ? 'success' : unpaired || benign ? 'skipped' : 'failed',
                terminal: terminal.has(key) || benignDrains.has(key),
                mediaId: item.media_id,
                title: meta?.title ?? null,
                seriesTitle: meta?.series_title ?? null,
                seasonNumber: meta?.season_number ?? null,
                episodeNumber: meta?.episode_number ?? null,
                mediaType: meta?.media_type ?? null,
                eventKind: 'progress',
                error: succeeded ? null : reason,
            });
        }
        if (toPush.length === 0) {
            await safeRecordActivity(sql, activity);
            return { forwardProgress };
        }

        // -----------------------------------------------------------------
        // 4. Build the push batch. Items without state (no derived row
        //    materialised yet) are skipped transiently — the next cycle
        //    retries once the rebuilder catches up.
        //
        //    Missing Jellyfin movie/episode IDs remain retryable with backoff.
        //    Other providers terminally drain unresolved IDs once.
        // -----------------------------------------------------------------
        const changes: WatchStateChange[] = [];
        const eventIdsByMediaUser = new Map<string, string[]>();
        for (const item of toPush) {
            const key = `${item.user_id}:${item.media_id}`;
            const state = stateMap.get(key);
            const providerId = providerIdMap.get(item.media_id);
            if (!state) {
                result.errors.push(`${key}: derived state unavailable; retained for retry`);
                result.skipped++;
                result.processed++;
                continue;
            }
            if (!providerId) {
                result.skipped++;
                result.processed++;
                const retain = retryablePair(item.media_id);
                let reason = 'no provider id (gave up)';
                if (retain) {
                    reason = (
                        await deferSyncDelivery(
                            sql,
                            providerName,
                            item.user_id,
                            item.event_ids,
                            'no provider id; retained for retry',
                            false,
                        )
                    ).description;
                } else {
                    await markEventsPushed(sql, {
                        userId: item.user_id,
                        provider: providerName,
                        eventIds: item.event_ids,
                    });
                    forwardProgress = true;
                }
                const meta = metaMap.get(item.media_id);
                activity.push({
                    userId: item.user_id,
                    provider: providerName,
                    direction: 'push',
                    outcome: 'skipped',
                    terminal: !retain,
                    mediaId: item.media_id,
                    title: meta?.title ?? null,
                    seriesTitle: meta?.series_title ?? null,
                    seasonNumber: meta?.season_number ?? null,
                    episodeNumber: meta?.episode_number ?? null,
                    mediaType: meta?.media_type ?? null,
                    eventKind: state.is_watched ? 'watched' : 'unwatched',
                    error: reason,
                });
                continue;
            }
            // A Jellyfin item that spans a combined file is ONE played flag for all its
            // episodes, and the pull spreads it forward. Pushing the first episode's mark
            // alone would mark the later ones watched; its unmark would unplay them. Hold
            // the event (not drained, not an error) until the later episodes agree.
            if (providerName === 'jellyfin' && retryablePair(item.media_id)) {
                const [later] = await sql<Array<{ total: number; watched: number }>>`
                    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE s.is_watched)::int AS watched
                    FROM media_file_items own
                    JOIN media_items own_ep ON own_ep.id = own.media_item_id
                    JOIN media_file_items sib ON sib.file_id = own.file_id AND sib.is_default
                        AND sib.media_item_id <> own.media_item_id
                    JOIN media_items sib_ep ON sib_ep.id = sib.media_item_id
                        AND sib_ep.media_type = 'episode' AND sib_ep.status = 'active'
                        AND sib_ep.parent_id = own_ep.parent_id
                        AND sib_ep.episode_number > own_ep.episode_number
                    LEFT JOIN user_media_state s
                        ON s.user_id = ${item.user_id}::uuid AND s.media_id = sib_ep.id
                    WHERE own.media_item_id = ${item.media_id}::uuid AND own.is_default
                `;
                if (later && later.total > 0) {
                    const agrees = state.is_watched
                        ? later.watched === later.total
                        : later.watched === 0;
                    if (!agrees) {
                        result.skipped++;
                        result.processed++;
                        const meta = metaMap.get(item.media_id);
                        activity.push({
                            userId: item.user_id,
                            provider: providerName,
                            direction: 'push',
                            outcome: 'skipped',
                            terminal: false,
                            mediaId: item.media_id,
                            title: meta?.title ?? null,
                            seriesTitle: meta?.series_title ?? null,
                            seasonNumber: meta?.season_number ?? null,
                            episodeNumber: meta?.episode_number ?? null,
                            mediaType: meta?.media_type ?? null,
                            eventKind: state.is_watched ? 'watched' : 'unwatched',
                            error: 'waiting for the other episodes of the shared file',
                        });
                        continue;
                    }
                }
            }
            changes.push({
                occurredAt: item.latest_decisive_event_at
                    ? new Date(item.latest_decisive_event_at).toISOString()
                    : undefined,
                providerId,
                mediaId: item.media_id,
                username: item.user_id,
                isWatched: state.is_watched,
                resumePositionMs: state.resume_position_ms,
                runtimeMs: state.runtime_ms ?? 0,
                watchCount: state.watch_count,
            });
            eventIdsByMediaUser.set(key, item.event_ids);
        }

        if (changes.length === 0) {
            await safeRecordActivity(sql, activity);
            return { forwardProgress };
        }

        // -----------------------------------------------------------------
        // 5. Hand the batch to the plugin. pushWatchState is required by
        //    the type so the optional check above is just for stale
        //    plugin objects on test paths.
        // -----------------------------------------------------------------
        if (!plugin.pushWatchState) return { forwardProgress };
        // Flush the already-committed unresolvable-drain rows (step 4) BEFORE
        // handing off to the plugin. Their markEventsPushed is already durable,
        // so if pushWatchState throws (propagating to the per-page catch) these
        // rows would otherwise be lost. Post-plugin rows accumulate in the same
        // now-empty array and flush at the existing end-of-page flush.
        await safeRecordActivity(sql, activity);
        activity.length = 0;
        let pushResult: WatchSyncPushResult;
        try {
            pushResult = await plugin.pushWatchState(ctx, changes, signal);
        } catch (error) {
            signal?.throwIfAborted();
            const reason = error instanceof Error ? error.message : String(error);
            pushResult = {
                succeeded: 0,
                failed: changes.length,
                skipped: 0,
                staleIds: [],
                errors: [reason],
                successful: [],
                drainedAsSkipped: [],
                failedItems: changes.map((c) => ({
                    username: c.username,
                    mediaId: c.mediaId,
                    error: reason,
                    terminal: false,
                })),
            };
        }

        // -----------------------------------------------------------------
        // 6. Mark events as pushed for each successful (user, media)
        //    pair AND each terminally-drained pair. The plugin distinguishes
        //    transient (`failed`) from terminal (`drainedAsSkipped`) failures
        //    — we mark the latter as pushed so a stale row stops blocking
        //    newer items. Transient failures stay un-pushed and the next
        //    cycle retries them.
        //
        //    The keying is on (user, media) — not media alone — because a
        //    shared library can have two users dirty on the same internal
        //    UUID, and the plugin can succeed for one user while failing
        //    for the other. Keying on the pair ensures we only mark the
        //    events of users the plugin actually finished for.
        //    `markEventsPushed` also scopes by user_id as defense-in-depth.
        // -----------------------------------------------------------------
        const successfulSet = new Set(
            pushResult.successful.map((s) => `${s.username}:${s.mediaId}`),
        );
        const drainedSet = new Set(
            (pushResult.drainedAsSkipped ?? []).map((s) => `${s.username}:${s.mediaId}`),
        );
        const failedMap = new Map(
            (pushResult.failedItems ?? []).map((f) => [`${f.username}:${f.mediaId}`, f]),
        );
        for (const change of changes) {
            const key = `${change.username}:${change.mediaId}`;
            const eventIds = eventIdsByMediaUser.get(key);
            result.processed++;
            const meta = metaMap.get(change.mediaId);
            const kind = change.isWatched ? 'watched' : 'unwatched';
            if (successfulSet.has(key) && eventIds) {
                await markEventsPushed(sql, {
                    // change.username carries the user_media_events.user_id UUID
                    // (the SDK field name is kept; see WatchStateChange below).
                    userId: toUserId(change.username),
                    provider: providerName,
                    eventIds,
                    acknowledged: true,
                });
                result.succeeded++;
                forwardProgress = true;
                activity.push({
                    userId: change.username,
                    provider: providerName,
                    direction: 'push',
                    outcome: 'success',
                    mediaId: change.mediaId,
                    title: meta?.title ?? null,
                    seriesTitle: meta?.series_title ?? null,
                    seasonNumber: meta?.season_number ?? null,
                    episodeNumber: meta?.episode_number ?? null,
                    mediaType: meta?.media_type ?? null,
                    eventKind: kind,
                });
            } else if (drainedSet.has(key) && eventIds) {
                // Terminal failure — drain so the row stops returning.
                await markEventsPushed(sql, {
                    userId: toUserId(change.username),
                    provider: providerName,
                    eventIds,
                });
                result.skipped++;
                forwardProgress = true;
                // Terminal skips must still appear in the task result. A
                // provider's per-item error supplies its specific refusal reason.
                const f = failedMap.get(key);
                if (f) {
                    result.errors.push(`${key}: ${f.error}`);
                }
                if (f) {
                    activity.push({
                        userId: change.username,
                        provider: providerName,
                        direction: 'push',
                        outcome: 'failed',
                        terminal: true,
                        mediaId: change.mediaId,
                        title: meta?.title ?? null,
                        seriesTitle: meta?.series_title ?? null,
                        seasonNumber: meta?.season_number ?? null,
                        episodeNumber: meta?.episode_number ?? null,
                        mediaType: meta?.media_type ?? null,
                        eventKind: kind,
                        error: f.error,
                    });
                }
            } else {
                // Keep undelivered events queued until their next attempt is due.
                const f = failedMap.get(key);
                let reason =
                    f?.error ?? pushResult.errors[0] ?? 'provider did not acknowledge watch state';
                let report = true;
                if (retryablePair(change.mediaId) && eventIds) {
                    const deferred = await deferSyncDelivery(
                        sql,
                        providerName,
                        change.username,
                        eventIds,
                        reason,
                    );
                    report = deferred.firstReport;
                    reason = deferred.description;
                }
                if (report) {
                    result.failed++;
                    if (providerName === 'jellyfin') result.errors.push(`${key}: ${reason}`);
                } else result.skipped++;
                activity.push({
                    userId: change.username,
                    provider: providerName,
                    direction: 'push',
                    outcome: 'failed',
                    terminal: f?.terminal ?? false,
                    mediaId: change.mediaId,
                    title: meta?.title ?? null,
                    seriesTitle: meta?.series_title ?? null,
                    seasonNumber: meta?.season_number ?? null,
                    episodeNumber: meta?.episode_number ?? null,
                    mediaType: meta?.media_type ?? null,
                    eventKind: kind,
                    error: reason,
                });
            }
        }

        if (providerName !== 'jellyfin' && pushResult.errors.length > 0) {
            // Cap to avoid blowing up the response payload on a bad cycle.
            result.errors.push(...pushResult.errors.slice(0, 10));
        }

        await safeRecordActivity(sql, activity);
        return { forwardProgress };
    }

    // =========================================================================
    // Private: Pull
    // =========================================================================

    private async pullForProvider(
        plugin: WatchSyncDefinition,
        signal?: AbortSignal,
        providedSql?: postgres.Sql | null,
        overrides?: {
            /**
             * Explicit scope for a manual per-user Import (Task 7,
             * `runPullForUser`). When supplied, the linked-users +
             * direction gate below is skipped entirely — an explicit
             * admin/user-triggered import always pulls for that one
             * user. Cursor reset for that user is the CALLER's job,
             * not this method's.
             */
            onlyUserIds?: string[];
            onProgress?: WatchSyncProgressReporter;
        },
    ): Promise<PullResult> {
        const startTime = Date.now();
        const providerName = plugin.providerName.toLowerCase();

        const result: PullResult = {
            provider: plugin.id,
            pulled: false,
            movies: { imported: 0, skipped: 0 },
            episodes: { imported: 0, skipped: 0, seriesResolved: 0 },
            resumeItems: { imported: 0, skipped: 0 },
            totalFromProvider: 0,
            totalResolved: 0,
            totalUpserted: 0,
            totalSkippedNoMatch: 0,
            totalBuffered: 0,
            usersSkippedNoLumastraAccount: 0,
            skippedUnavailable: false,
            errors: [],
            durationMs: 0,
        };

        if (!plugin.pullWatchState) {
            result.durationMs = Date.now() - startTime;
            return result;
        }

        const sql = providedSql ?? getTaskDb();
        if (!sql) {
            result.errors.push('Database unavailable');
            result.durationMs = Date.now() - startTime;
            return result;
        }

        // One PluginContext for the whole pull cycle for this provider — same
        // shape and reasoning as `pushForProvider`. The signal is threaded so
        // long-running paginations abort promptly when the scheduler cancels.
        const ctx = buildPluginContext(plugin.id, { signal });

        const available = await plugin.isAvailable(ctx);
        if (!available) {
            // See S8: unavailable is not a failure. The admin UI surfaces
            // skippedUnavailable separately so operators don't see false alarms.
            result.skippedUnavailable = true;
            logger.info(`pullForProvider: provider ${plugin.id} unavailable — skipping`);
            result.durationMs = Date.now() - startTime;
            return result;
        }

        await refreshFilePairings(plugin, sql, signal);

        // -----------------------------------------------------------------
        // Linked-users gate + direction enforcement (Task 6) — pull side.
        //
        // `overrides.onlyUserIds` (manual per-user Import, `runPullForUser`)
        // bypasses this entirely — an explicit admin/user action always
        // pulls for that one user.
        //
        // Otherwise: use the provider's pull audience when it has one, falling
        // back to its linked push audience. `listPullUsers` lets a provider
        // import through an operator-scoped read without broadening outbound
        // push or provisioning a per-user credential. null/absent ⇒ no gating
        // (Jellyfin — pull applies to every resolvable user, unchanged).
        // -----------------------------------------------------------------
        let pullOnlyUserIds = overrides?.onlyUserIds;
        if (pullOnlyUserIds === undefined) {
            try {
                const listPullUsers = plugin.listPullUsers ?? plugin.listLinkedUsers;
                const linked = listPullUsers ? await listPullUsers(ctx) : null;
                if (linked !== null && linked !== undefined) {
                    const dedupedLinked = Array.from(new Set(linked));
                    const prefs = await listPreferences(sql, providerName, dedupedLinked);
                    pullOnlyUserIds = dedupedLinked.filter((u) => {
                        const direction = prefs.get(u)?.direction ?? 'both';
                        return direction === 'both' || direction === 'pull';
                    });
                }
            } catch (err) {
                // Same reasoning as the push-side gate: a transient failure
                // here must not abort the whole pull cycle, and must NOT
                // silently fall back to "pull everyone" — skip this
                // provider's pull cycle gracefully and retry next run.
                logger.warn(
                    'pullForProvider: linked-users/preferences gate failed; skipping cycle',
                    {
                        providerId: plugin.id,
                        error: String(err),
                    },
                );
                result.durationMs = Date.now() - startTime;
                return result;
            }
        }

        // Drain the pending-resolution buffer FIRST: items watched on the
        // provider before their media was ingested were parked in
        // watch_state_pending_resolution (rather than dropped). Re-resolve them
        // against the now-larger catalog before the live pull. Best-effort — a
        // drain failure must not abort the live pull.
        try {
            await drainPendingResolution(providerName, {
                sql,
                signal,
                onlyUserIds: pullOnlyUserIds,
            });
        } catch (err) {
            logger.warn('Pending-resolution drain failed; continuing with live pull', {
                provider: providerName,
                error: String(err),
            });
        }

        // Load per-user cursors so the plugin can short-circuit pagination at
        // the newest LastPlayedDate we've already imported. Missing rows /
        // missing columns / NULL cursor → entry absent from the map → plugin
        // does a full pull for that user.
        //
        // postgres.js deserialises `timestamptz` columns to JavaScript Date
        // objects regardless of the typed-query annotation. The plugin
        // compares cursor values against Jellyfin's `LastPlayedDate` strings
        // ('2026-04-25T08:40:27.607Z'), and `string > Date` coerces both to
        // numbers for `>` — `Number('2026-...')` is NaN so the comparison
        // is always false. Normalise to ISO string here so the plugin's
        // string-vs-string comparison works as designed.
        // `cursors` is handed to the PLUGIN, which looks entries up by its own
        // provider identity key — Jellyfin does
        // `cursors.get(providerUsername.toLowerCase())`. But this table is keyed by
        // `user_id`, the Lumastra UUID (that is what logPullRun writes below). Keying
        // the delivered map by UUID therefore missed on every lookup, `since` came
        // back null, and the plugin took its full-pull branch EVERY cycle.
        //
        // Measured on prod before the fix: 2201 movies + 164160 episodes re-imported
        // per run, ~166k rows every 15 minutes across 35 users — 5,179,127 upserts in
        // 12h to carry 33 rows that had actually changed, and long enough to start
        // timing out mid-fetch. The cursor column was being written and advanced
        // correctly the whole time; only the key space of the delivered map was wrong.
        //
        // So read into a UUID-keyed map here and re-key it to provider identity keys
        // once `providerToUserId` exists (a few lines down — it is built after this
        // block and is the same key space the plugin uses).
        const cursorsByUserId = new Map<string, string>();
        try {
            const cursorRows = await sql<
                Array<{
                    user_id: string;
                    last_played_cursor: Date | string | null;
                }>
            >`
                SELECT user_id, last_played_cursor
                FROM watch_state_pull_log
                WHERE provider = ${providerName}
                  AND last_played_cursor IS NOT NULL
            `;
            for (const row of cursorRows) {
                const raw = row.last_played_cursor;
                if (!raw) continue;
                const iso = raw instanceof Date ? raw.toISOString() : String(raw);
                cursorsByUserId.set(String(row.user_id), iso);
            }
        } catch (err) {
            // Cursor read failure → fall back to full pull. Log so operators
            // see the regression but don't break the cycle.
            logger.warn('Pull cursor read failed; falling back to full pull', {
                error: String(err),
                provider: providerName,
            });
        }

        // Pre-resolve the set of canonical Lumastra identity keys so the plugin
        // can skip provider accounts with no Lumastra match BEFORE fetching their
        // (potentially huge) watch history. Items from unmatched provider users
        // are discarded below anyway; without this pre-filter a multi-user
        // provider (e.g. a shared Jellyfin) fetches every account's full history
        // every cycle, which starves the pull on a busy server (e.g. during the
        // initial full-library import). On failure we pass `undefined` so the
        // plugin falls back to pulling all users rather than dropping everyone.
        let knownUsernames: Set<string> | undefined;
        // For Jellyfin we match on the (possibly overridden) Jellyfin login name and
        // translate it back to the Lumastra username; default same-name keeps this a
        // no-op for existing setups. Other providers keep the direct username match.
        const isJellyfinProvider = providerName.includes('jellyfin');
        const providerUsernameKey = (username: string): string =>
            isJellyfinProvider ? username.toLowerCase() : foldUsername(username);
        let providerToLumastra: Map<string, string> | undefined;
        // Provider identity key → stable users.id UUID. Jellyfin uses its
        // override-aware login map; other providers use the canonical Lumastra
        // username. Provider users with no Lumastra account simply have no entry
        // and are skipped (orphan policy).
        let providerToUserId: Map<string, UserId> | undefined;
        try {
            const { getJellyfinUsernameMap } = await import('../database/queries/users.queries.js');
            if (isJellyfinProvider) {
                const rows = await getJellyfinUsernameMap(sql);
                providerToLumastra = new Map(
                    // jellyfin_name is COALESCE(jellyfin_username, username) so it's
                    // never null in production; `?? r.username` keeps this robust to
                    // a missing field (same-name fallback).
                    rows.map((r) => [
                        (r.jellyfin_name ?? r.username).toLowerCase(),
                        r.username.toLowerCase(),
                    ]),
                );
                // Resolve the same provider-name keys to UUIDs (override-honoring).
                providerToUserId = await resolveJellyfinNamesToUserIds(sql);
                // The provider sends Jellyfin login names, so the known set is the set
                // of Jellyfin names — taken from the COLLISION-SAFE map, not from
                // providerToLumastra above. Two reasons, and both are silent when wrong:
                //
                //  1. resolveJellyfinNamesToUserIds drops names claimed by more than
                //     one Lumastra user (fail-closed, so nobody's history is
                //     cross-attributed). Sourcing the fetch set from the raw map put
                //     those users back: every cycle pulled their ENTIRE history, then
                //     dropped every item at attribution, and — having imported nothing
                //     — never advanced a cursor, so the next cycle pulled it all again.
                //  2. The two maps case-fold in different languages: this file uses
                //     JS toLowerCase(), the resolver uses Postgres LOWER(). They agree
                //     on ASCII and disagree on the dotted/dotless-I class, so such a
                //     user would be fetched under one key and looked up under another.
                //
                // Using one key space for both makes the fetch set and the attribution
                // set the same set by construction.
                knownUsernames = new Set(providerToUserId.keys());
            } else {
                // Non-Jellyfin providers match the canonical Lumastra username,
                // never the optional Jellyfin login override. The resolver also
                // drops Unicode/case-fold collisions so one upstream account
                // cannot be attributed to two local users.
                const usersByName = await resolveUsernamesToUsers(sql);
                providerToUserId = new Map([...usersByName].map(([name, user]) => [name, user.id]));
                providerToLumastra = new Map(
                    [...usersByName].map(([name, user]) => [name, user.username]),
                );
                // Per-user plugins (MAL, Trakt) key their credential store by the
                // Lumastra user UUID and have no separate provider login name, so
                // they emit that UUID as `providerUsername`. Index each UUID to
                // itself so the resolver below matches whether a plugin emits a
                // Lumastra username OR its UUID. Without this, every pulled item
                // is dropped as "no matching Lumastra account" (values() are the
                // UserId UUIDs; keys() otherwise hold only usernames).
                for (const uid of new Set(providerToUserId.values())) {
                    providerToUserId.set(String(uid).toLowerCase(), uid);
                }
                knownUsernames = new Set(providerToUserId.keys());
            }
        } catch (err) {
            logger.warn('Pull user pre-filter unavailable; pulling all provider users', {
                error: String(err),
                provider: providerName,
            });
        }

        // Re-key the cursors into the PROVIDER's identity key space (see the long
        // note where cursorsByUserId is filled). `providerToUserId` maps provider
        // key -> Lumastra UUID and is exactly what the plugin looks up with, so
        // inverting it lines the two sides up. If it is unavailable (the catch
        // above), the map stays empty and every user does a full pull — the same
        // conservative behaviour as before, just no longer the DEFAULT.
        const cursors = new Map<string, string>();
        if (providerToUserId) {
            for (const [providerKey, userId] of providerToUserId) {
                const iso = cursorsByUserId.get(String(userId));
                if (iso) cursors.set(providerKey, iso);
            }
        }
        if (cursorsByUserId.size > 0 && cursors.size === 0) {
            // Loud, because this is precisely the silent failure being fixed: cursors
            // exist in the table but none survived translation, so every user is about
            // to be pulled in full.
            logger.warn(
                'Pull cursors could not be mapped to provider identity keys — full pull for all users',
                { provider: providerName, storedCursors: cursorsByUserId.size },
            );
        }

        // Thread the signal into the plugin's HTTP layer so long-running
        // fetches abort promptly when the scheduler sends a cancel (S2).
        // Plugins that don't opt in still terminate normally.
        const pullResult = await plugin.pullWatchState(ctx, {
            signal,
            cursors,
            // Set on success (possibly empty → the plugin skips everyone, which
            // is correct when there are no Lumastra users); undefined only when
            // the lookup itself failed, so the plugin falls back to pulling all
            // users rather than silently syncing nothing on a transient error.
            knownUsernames,
            // undefined ⇒ no restriction (Jellyfin / no linked-users concept).
            // Non-undefined (possibly empty) ⇒ plugin restricts its fetch to
            // exactly this set — see gate above / runPullForUser override.
            onlyUserIds: pullOnlyUserIds,
            onProgress: overrides?.onProgress
                ? (p) =>
                      overrides.onProgress?.({
                          processed: p.processed,
                          total: p.total,
                          currentItem: p.currentUser,
                      })
                : undefined,
        });
        result.pulled = true;

        if (pullResult.errors.length > 0) {
            result.errors.push(...pullResult.errors);
        }

        if (plugin.id === 'jellyfin-watch-sync') {
            const known = await resolvePulledItems(sql, providerName, pullResult.items);
            const unresolved = pullResult.items
                .filter((item) => !known.resolved.has(item.providerId))
                .map((item) => item.providerId);
            if (unresolved.length > 0) await refreshFilePairings(plugin, sql, signal, unresolved);
        }
        result.totalFromProvider = pullResult.items.length;

        // Plugin's per-user cursor outputs. Persisted only for users whose
        // batches succeed (see logPullRun call site below) so a partial-
        // failure user retries from the previous cursor next cycle.
        const newCursors = pullResult.newCursors ?? new Map<string, string>();

        // Group items by providerUsername, then resolve to Lumastra username
        const byProviderUsername = new Map<string, typeof pullResult.items>();
        for (const item of pullResult.items) {
            const existing = byProviderUsername.get(item.providerUsername) ?? [];
            existing.push(item);
            byProviderUsername.set(item.providerUsername, existing);
        }

        // Filter out provider accounts with no matching Lumastra user — a
        // Jellyfin-only account would otherwise trigger an FK violation inside
        // batchUpsertFromProviderSync (the whole user's batch would abort
        // silently). Reuse the username set resolved once above (also handed to
        // the plugin's pre-fetch filter) rather than issuing a second query. If
        // it couldn't be resolved (knownUsernames undefined), treat as empty so
        // unmatched users are dropped rather than risking a bad upsert. We drop
        // the user's items, bump a counter, and log INFO (not ERROR) once/run.
        const knownUsernameSet = knownUsernames ?? new Set<string>();
        // Two places can skip an unmatched account: the plugin (before fetching
        // its history, reported in pullResult.skippedUsernames — Jellyfin does
        // this, so such an account has no items at all) and the item filter
        // below. Count both into one de-duplicated list so the number matches.
        const skippedByKey = new Map<string, string>();
        for (const providerUsername of pullResult.skippedUsernames ?? []) {
            skippedByKey.set(providerUsernameKey(providerUsername), providerUsername);
        }
        for (const providerUsername of [...byProviderUsername.keys()]) {
            if (!knownUsernameSet.has(providerUsernameKey(providerUsername))) {
                skippedByKey.set(providerUsernameKey(providerUsername), providerUsername);
                byProviderUsername.delete(providerUsername);
            }
        }
        const skippedUsernames = [...skippedByKey.values()];
        if (skippedUsernames.length > 0) {
            result.usersSkippedNoLumastraAccount = skippedUsernames.length;
            result.skippedNoLumastraAccountNames = skippedUsernames;
            logger.info(
                `pullForProvider(${plugin.id}): skipped ${skippedUsernames.length} provider user(s) with no matching Lumastra account`,
                { skippedSample: skippedUsernames.slice(0, 5) },
            );
        }

        // Validate the providerName→EventSource mapping ONCE before any
        // per-user transactions run. A misconfigured plugin name would
        // otherwise throw mid-loop after earlier users had committed,
        // leaving the pull half-applied. Resolve once here so the
        // per-user loop can read the validated source without
        // re-validating per iteration. Shared with the pending-resolution
        // drain (eventSourceForProvider) so the two paths can't diverge.
        const eventSource = eventSourceForProvider(providerName);
        // Only enforce the mapping when there's actual work to do.
        // Skipping cleanly on no-resolvable-users keeps test fixtures
        // and edge cases (provider returns nothing) from tripping the
        // check unnecessarily.
        if (byProviderUsername.size > 0 && !eventSource) {
            throw new Error(
                `pullForProvider: providerName "${providerName}" does not map to a known EventSource. ` +
                    'Add a mapping in watch-sync-engine.service.ts before proceeding.',
            );
        }

        // Inside the loop `eventSource` is guaranteed non-null because the
        // pre-loop validation throws when byProviderUsername.size > 0 and
        // the mapping is missing. Narrow once for the appendEventAndRebuild
        // calls below.
        const validatedEventSource = eventSource as EventSource;

        // Per-item skipped activity accumulated across all users this pull, then
        // flushed ONCE after the user loop (best-effort; never aborts the pull).
        // Method-scoped so a single insert covers every user's unresolved items.
        const pullActivity: SyncActivityInsert[] = [];

        const failedImports: string[] = [];
        for (const [providerUsername, items] of byProviderUsername) {
            if (signal?.aborted) {
                logger.info(
                    `pullForProvider(${plugin.id}): abort fired mid-user, stopping further users`,
                );
                break;
            }
            // Translate the provider (Jellyfin) login name back to the Lumastra
            // username via the COALESCE(jellyfin_username, username) map; falls back
            // to a direct match for non-Jellyfin providers and same-name setups.
            const lumastraUsername: string =
                providerToLumastra?.get(providerUsernameKey(providerUsername)) ??
                providerUsernameKey(providerUsername);

            // Resolve the provider login name → stable users.id UUID. Data writes
            // key by this UUID (mig 16.46.0). A provider account with no Lumastra
            // user maps to nothing → SKIP its items (orphan policy: never invent a
            // sentinel/NULL UUID). knownUsername pre-filter above already drops most
            // unmapped users; this is the authoritative guard at the write boundary.
            const lumastraUserId = providerToUserId?.get(providerUsernameKey(providerUsername));
            if (!lumastraUserId) {
                logger.info(
                    `pullForProvider(${plugin.id}): no Lumastra user for provider account, skipping`,
                    { providerUsername },
                );
                continue;
            }

            type UpsertItem = {
                mediaId: string;
                isWatched: boolean;
                resumePositionMs: number;
                runtimeMs: number;
                watchCount: number;
                lastWatchedAt: Date | null;
                firstWatchedAt: Date | null;
                title: string | null;
                seriesTitle: string | null;
                seasonNumber: number | null;
                episodeNumber: number | null;
                mediaType: string;
                /**
                 * Carried through from the pull item so the event-append loop
                 * below can leave the stored position untouched.
                 *
                 * Deliberately NOT `isActiveSession`: that flag means the
                 * opposite (Jellyfin sets it to say "this live row IS the
                 * freshest truth" and relies on the progress event landing).
                 */
                freezePosition: boolean;
            };

            // Multi-strategy resolution (TMDB id → provider-id cache → episode
            // drill-down) is shared with the pending-resolution drain via
            // resolvePulledItems so the two paths can never diverge. It returns a
            // providerId → internal media UUID map plus the episode-drill-down
            // count for the metric below.
            const { resolved: resolvedByProviderId, seriesResolved } = await resolvePulledItems(
                sql,
                providerName,
                items,
            );
            result.episodes.seriesResolved += seriesResolved;

            const upsertItems: UpsertItem[] = [];
            // Unresolved items (media not ingested yet) are buffered here and
            // upserted into watch_state_pending_resolution after the loop, so the
            // watch state isn't lost when the media is imported later (the pull
            // cursor would otherwise advance past it forever).
            const pendingToBuffer: PendingResolutionInsert[] = [];
            // Per-user counters feed watch_state_pull_log for admin visibility (S9).
            let userSkippedNoMatch = 0;
            let userResolved = 0;
            // Cap per-item auto-complete logs per user pull — first full
            // sync from a new provider can flip many historical rows.
            const AUTOCOMPLETE_LOG_LIMIT = 10;
            // Logged only after the local states are read (below): an item
            // already watched here is not being completed by this pull. Jellyfin
            // keeps reporting a >90% resume on items it never marked played, so
            // logging at decision time repeated the same ~40 lines every 5 min
            // on prod, forever.
            const autoCompleted: Array<Record<string, unknown> & { mediaId: string }> = [];

            for (const item of items) {
                // Resolution is computed once by resolvePulledItems above and
                // looked up here by providerId. internalMediaId (plugin pre-
                // resolved, e.g. MAL) is honoured inside the resolver.
                const internalId = resolvedByProviderId.get(item.providerId);

                if (!internalId) {
                    result.totalSkippedNoMatch++;
                    userSkippedNoMatch++;
                    // Buffer the unresolved item instead of dropping it: the
                    // media may be ingested later, and the pull cursor will
                    // advance past this play date, so without the buffer the
                    // watch state would be lost forever. The drain re-resolves
                    // the buffer once the matching media_item exists.
                    pendingToBuffer.push(
                        pendingRowFromPullItem(item, lumastraUserId, providerName),
                    );
                    // Record a per-item skipped activity row so the feed shows
                    // WHY the item didn't land (no library match yet). Buffered,
                    // not lost — the drain re-resolves it once the media exists.
                    pullActivity.push({
                        userId: lumastraUserId,
                        provider: providerName,
                        direction: 'pull',
                        outcome: 'skipped',
                        mediaId: null,
                        title: item.title ?? null,
                        seasonNumber: item.seasonNumber ?? null,
                        episodeNumber: item.episodeNumber ?? null,
                        mediaType: item.mediaType ?? null,
                        eventKind: item.isWatched ? 'watched' : 'unwatched',
                        externalRef: `${providerName}:${item.providerId}`,
                        error: 'no library match',
                    });
                    logger.debug('Pull: unresolved item buffered for later resolution', {
                        provider: providerName,
                        providerId: item.providerId,
                        mediaType: item.mediaType,
                        title: item.title,
                        tmdbId: item.tmdbId,
                        seriesTmdbId: item.seriesTmdbId,
                    });
                    // Track per-type skips
                    if (isMovie(item.mediaType)) {
                        result.movies.skipped++;
                    } else if (isEpisode(item.mediaType)) {
                        result.episodes.skipped++;
                    } else {
                        result.resumeItems.skipped++;
                    }
                    continue;
                }

                result.totalResolved++;
                userResolved++;

                // Auto-complete the Infuse/Jellyfin sync-gap case: provider
                // reports isWatched=false but progress is past the runtime-
                // aware completion threshold. Normalize locally so CW / Next
                // Up don't keep stale near-end items forever.
                const normalized = item.isActiveSession
                    ? {
                          item: {
                              isWatched: item.isWatched,
                              resumePositionMs: item.resumePositionMs,
                              runtimeMs: item.runtimeMs,
                          },
                          triggered: false,
                          ratio: item.runtimeMs > 0 ? item.resumePositionMs / item.runtimeMs : null,
                          threshold: null,
                      }
                    : applyAutoCompleteFromProgress(
                          {
                              isWatched: item.isWatched,
                              resumePositionMs: item.resumePositionMs,
                              runtimeMs: item.runtimeMs,
                          },
                          item.mediaType,
                      );
                if (normalized.triggered) {
                    autoCompleted.push({
                        provider: providerName,
                        username: lumastraUsername,
                        mediaId: internalId,
                        providerIsWatched: item.isWatched,
                        resumeMs: item.resumePositionMs,
                        runtimeMs: item.runtimeMs,
                        ratio: normalized.ratio,
                        threshold: normalized.threshold,
                    });
                }

                upsertItems.push({
                    mediaId: internalId,
                    isWatched: normalized.item.isWatched,
                    resumePositionMs: normalized.item.resumePositionMs,
                    runtimeMs: item.runtimeMs,
                    watchCount: item.watchCount,
                    lastWatchedAt: item.lastWatchedAt ?? null,
                    firstWatchedAt: item.firstWatchedAt ?? item.lastWatchedAt ?? null,
                    title: item.title ?? null,
                    seriesTitle: item.seriesTitle ?? null,
                    seasonNumber: item.seasonNumber ?? null,
                    episodeNumber: item.episodeNumber ?? null,
                    mediaType: item.mediaType,
                    freezePosition: item.freezePosition === true,
                });
            }

            // A combined multi-episode file is one provider item, resolved to its
            // first episode; a watched mark covers the later episodes on the file
            // too. An episode the provider reported itself keeps its own row.
            // Judged on each episode's FINAL row: the write below keeps the last
            // occurrence per mediaId (resume list after played list). Only an
            // explicit provider Played spreads: an auto-complete was judged
            // against the whole file's runtime, not each episode's window.
            const providerPlayed = new Set(
                items
                    .filter((i) => i.isWatched)
                    .map((i) => resolvedByProviderId.get(i.providerId))
                    .filter((id): id is string => id !== undefined),
            );
            const finalByMediaId = new Map(upsertItems.map((u) => [u.mediaId, u]));
            const watchedEpisodes = [...finalByMediaId.values()].filter(
                (u) => u.isWatched && isEpisode(u.mediaType) && providerPlayed.has(u.mediaId),
            );
            // A failed lookup holds the cursor (as a failed buffer write does), so
            // the next cycle re-pulls the window instead of losing the marks.
            let siblingLookupFailed = false;
            if (watchedEpisodes.length > 0) {
                const siblingsByEpisode = await getLaterCombinedFileEpisodes(
                    sql,
                    watchedEpisodes.map((u) => u.mediaId),
                ).catch((err: unknown) => {
                    siblingLookupFailed = true;
                    logger.warn('Pull: combined-file sibling lookup failed, holding the cursor', {
                        error: String(err),
                        provider: providerName,
                    });
                    return new Map<string, CombinedFileSibling[]>();
                });
                const reported = new Set(upsertItems.map((u) => u.mediaId));
                for (const u of watchedEpisodes) {
                    for (const sibling of siblingsByEpisode.get(u.mediaId) ?? []) {
                        if (reported.has(sibling.mediaId)) continue;
                        reported.add(sibling.mediaId);
                        upsertItems.push({
                            ...u,
                            mediaId: sibling.mediaId,
                            resumePositionMs: 0,
                            runtimeMs: sibling.runtimeMs ?? 0,
                            title: null,
                            episodeNumber: null,
                            freezePosition: true,
                        });
                    }
                }
            }

            // Backfill canonical series/season/episode from the LIBRARY for
            // resolved episodes, so the activity feed shows "Series · SxEy"
            // uniformly across providers. Provider pull items are inconsistent
            // (Trakt puts the show title in `title` with no seriesTitle; MAL is
            // series-level; only Jellyfin sets seriesTitle) — but every resolved
            // item carries a library media_id, which is the source of truth.
            // Only touches the activity-display fields; state application below
            // uses isWatched/resumePosition, not these.
            const episodeMediaIds = upsertItems
                .filter((u) => isEpisode(u.mediaType))
                .map((u) => u.mediaId);
            if (episodeMediaIds.length > 0) {
                const libMeta = await sql<
                    {
                        media_id: string;
                        series_title: string | null;
                        season_number: number | null;
                        episode_number: number | null;
                    }[]
                >`
                    SELECT ep.id AS media_id, series.title AS series_title,
                           ep.season_number, ep.episode_number
                    FROM media_items ep
                    LEFT JOIN media_items season ON season.id = ep.parent_id
                    LEFT JOIN media_items series ON series.id = season.parent_id
                    WHERE ep.id = ANY(${episodeMediaIds}::uuid[])
                `.catch((err: unknown) => {
                    logger.warn('Pull: library series/episode enrichment failed (non-fatal)', {
                        error: String(err),
                        provider: providerName,
                    });
                    return [] as {
                        media_id: string;
                        series_title: string | null;
                        season_number: number | null;
                        episode_number: number | null;
                    }[];
                });
                const libById = new Map(libMeta.map((r) => [r.media_id, r]));
                for (const u of upsertItems) {
                    const m = libById.get(u.mediaId);
                    if (!m) continue;
                    u.seriesTitle = m.series_title ?? u.seriesTitle;
                    u.seasonNumber = m.season_number ?? u.seasonNumber;
                    u.episodeNumber = m.episode_number ?? u.episodeNumber;
                }
            }

            // Flush this user's unresolved items into the pending buffer before
            // the early-continue below — they must be persisted even when the
            // user had no resolvable items this cycle.
            // When the buffer write fails we MUST NOT advance the cursor below —
            // otherwise the next incremental pull skips past these unbuffered
            // items' play dates and the watch state is lost forever (the exact
            // bug the buffer exists to prevent). Holding the cursor makes the
            // next cycle re-pull the same window and try buffering again.
            let pendingBufferFailed = false;
            if (pendingToBuffer.length > 0) {
                try {
                    const buffered = await upsertPendingResolution(sql, pendingToBuffer);
                    result.totalBuffered += buffered;
                } catch (err) {
                    pendingBufferFailed = true;
                    logger.warn('Failed to buffer unresolved pull items', {
                        provider: providerName,
                        count: pendingToBuffer.length,
                        error: String(err),
                    });
                }
            }

            // Nothing resolved this cycle → skip the write + logPullRun block,
            // which means the cursor is NOT advanced for this user. That is the
            // correct outcome whether or not buffering succeeded: if it failed
            // (pendingBufferFailed), holding the cursor lets the next cycle
            // re-pull and re-buffer; if it succeeded, the items are safely
            // buffered and re-pulling them is a harmless idempotent upsert. Keep
            // this invariant in mind before moving logPullRun out of this guard.
            if (upsertItems.length === 0) continue;

            // Deduplicate by mediaId — same item can appear in both played and resume lists.
            // Keep the last occurrence (resume data is more recent and has position).
            const deduped = new Map(upsertItems.map((item) => [item.mediaId, item]));
            const dedupedItems = [...deduped.values()];

            try {
                const now = new Date().toISOString();

                // Read all current states ONCE, outside any transaction
                // (SQL-C6). The per-item decision below (emit / skip an event)
                // depends only on the item's own prior state, and each
                // media_id appears exactly once after the dedupe above, so the
                // read does not need to observe writes from earlier items in
                // this batch. `appendEventAndRebuild` recomputes derived state
                // from the event log inside the write transaction regardless.
                const currentStates = new Map<string, UserMediaStateRow>();
                // This provider's OWN last-reported snapshot per media — the
                // baseline the progress/mark_unwatched gates below compare
                // against instead of the derived `currentStates` above. See
                // `watch-sync-source-gate.ts` for why: `currentStates` is
                // arbitrated across every source and can permanently diverge
                // from what any one source keeps reporting, which used to
                // re-append the same progress/mark_unwatched event every pull
                // cycle forever (confirmed in prod).
                const sourceSnapshots = new Map<string, SourceSnapshot>();
                for (let i = 0; i < dedupedItems.length; i += PULL_UPSERT_CHUNK_SIZE) {
                    const idChunk = dedupedItems
                        .slice(i, i + PULL_UPSERT_CHUNK_SIZE)
                        .map((it) => it.mediaId);
                    const rows = await batchGetStates.all(sql, {
                        userId: lumastraUserId,
                        mediaIds: idChunk,
                    });
                    for (const row of rows) {
                        currentStates.set(row.media_id, row);
                    }
                    const snapshotRows = await getSourceSnapshotsForMedia(sql, {
                        userId: lumastraUserId,
                        mediaIds: idChunk,
                        source: validatedEventSource,
                    });
                    for (const row of snapshotRows) {
                        sourceSnapshots.set(row.media_id, row);
                    }
                }

                const acknowledgedUnwatches =
                    providerName === 'jellyfin'
                        ? await getAcknowledgedJellyfinUnwatches(
                              sql,
                              lumastraUserId,
                              dedupedItems.map((item) => item.mediaId),
                          )
                        : new Map<string, string>();

                const newlyCompleted = autoCompleted.filter((entry) =>
                    shouldEmitSourceWatch(
                        currentStates.get(entry.mediaId)?.is_watched === true,
                        sourceSnapshots.get(entry.mediaId)?.last_decisive_event_type ?? null,
                    ),
                );
                for (const entry of newlyCompleted.slice(0, AUTOCOMPLETE_LOG_LIMIT)) {
                    logger.info('Provider sync: auto-completing stale resume', entry);
                }
                if (newlyCompleted.length > 0) {
                    logger.info('Provider sync: auto-complete summary', {
                        provider: providerName,
                        username: lumastraUsername,
                        autoCompleteCount: newlyCompleted.length,
                        totalItems: upsertItems.length,
                    });
                }

                // Chunk the writes so no single transaction holds a task-pool
                // connection open for the whole (potentially huge) batch.
                for (
                    let offset = 0;
                    offset < dedupedItems.length;
                    offset += PULL_UPSERT_CHUNK_SIZE
                ) {
                    const chunk = dedupedItems.slice(offset, offset + PULL_UPSERT_CHUNK_SIZE);
                    // Per-chunk success activity: populated INSIDE the tx callback
                    // but recorded AFTER the tx commits (below). A rolled-back
                    // chunk records nothing; a later chunk's failure keeps the
                    // rows of earlier committed chunks. Only appended when an
                    // event was actually written (a real state change).
                    const changedInChunk: SyncActivityInsert[] = [];
                    await withTx(sql, async (rawTxSql) => {
                        const txSql = rawTxSql as unknown as postgres.Sql;
                        for (const upsertItem of chunk) {
                            const currentState = currentStates.get(upsertItem.mediaId) ?? null;
                            // Set only where an event is genuinely appended below,
                            // mirroring the existing state-change guards exactly.
                            let eventKind: string | null = null;

                            if (upsertItem.isWatched) {
                                if (
                                    shouldEmitSourceWatch(
                                        currentState?.is_watched === true,
                                        sourceSnapshots.get(upsertItem.mediaId)
                                            ?.last_decisive_event_type ?? null,
                                    ) ||
                                    upsertItem.watchCount > 1 ||
                                    (currentState?.is_watched !== true &&
                                        upsertItem.lastWatchedAt !== null &&
                                        acknowledgedUnwatches.has(upsertItem.mediaId) &&
                                        upsertItem.lastWatchedAt.getTime() >
                                            Date.parse(
                                                acknowledgedUnwatches.get(upsertItem.mediaId)!,
                                            ))
                                ) {
                                    for (const eventId of importedWatchEventIds(
                                        upsertItem.watchCount,
                                        upsertItem.lastWatchedAt,
                                    )) {
                                        const inserted = await appendEventAndRebuild(txSql, {
                                            user_id: lumastraUserId,
                                            media_id: upsertItem.mediaId,
                                            event_type: 'mark_watched',
                                            source: validatedEventSource,
                                            position_ms: null,
                                            runtime_ms:
                                                upsertItem.runtimeMs > 0
                                                    ? upsertItem.runtimeMs
                                                    : null,
                                            source_event_id: eventId,
                                            session_id: null,
                                            event_seq: null,
                                            occurred_at:
                                                upsertItem.lastWatchedAt?.toISOString() ?? now,
                                            ...(acknowledgedUnwatches.has(upsertItem.mediaId) &&
                                            !upsertItem.lastWatchedAt
                                                ? {
                                                      occurred_at: acknowledgedUnwatches.get(
                                                          upsertItem.mediaId,
                                                      )!,
                                                  }
                                                : {}),
                                        });
                                        if (inserted) eventKind = 'watched';
                                    }
                                }
                            } else {
                                // Baseline for BOTH gates below: THIS source's
                                // own last-reported snapshot, not Lumastra's
                                // derived `currentState`. `currentState` is
                                // arbitrated across every source (and the
                                // rebuilder's own transforms — e.g. a watched
                                // item always derives resume_position_ms=0
                                // regardless of what any one source last
                                // said), so it can permanently diverge from
                                // what one particular source keeps reporting.
                                // Comparing against a value that never
                                // converges re-appends the same event every
                                // pull cycle forever — confirmed in prod
                                // (1455 + 687 redundant progress rows for two
                                // stuck episodes). A source's value trivially
                                // converges with its own last value instead.
                                // See watch-sync-source-gate.ts for the full
                                // writeup.
                                const sourceSnapshot =
                                    sourceSnapshots.get(upsertItem.mediaId) ?? null;

                                // mark_unwatched: requires BOTH (1) Lumastra
                                // currently considers the item watched (else
                                // there's nothing to unwatch — guards against
                                // a spurious first-pull unwatch on an item
                                // that was never watched) AND (2) this source
                                // has not already reported "not watched"
                                // (convergence — without this, a higher-
                                // priority source pinning currentState.
                                // is_watched=true forever would re-fire this
                                // every single cycle).
                                const emitUnwatch = shouldEmitSourceUnwatch(
                                    currentState?.is_watched === true,
                                    sourceSnapshot?.last_decisive_event_type ?? null,
                                );
                                if (emitUnwatch) {
                                    await appendEventAndRebuild(txSql, {
                                        user_id: lumastraUserId,
                                        media_id: upsertItem.mediaId,
                                        event_type: 'mark_unwatched',
                                        source: validatedEventSource,
                                        position_ms: null,
                                        runtime_ms:
                                            upsertItem.runtimeMs > 0 ? upsertItem.runtimeMs : null,
                                        source_event_id: null,
                                        session_id: null,
                                        event_seq: null,
                                        occurred_at: upsertItem.lastWatchedAt?.toISOString() ?? now,
                                    });
                                    eventKind = 'unwatched';
                                }

                                // Only emit a progress event when the position
                                // ACTUALLY CHANGED relative to this source's
                                // own last report. Jellyfin's resume list
                                // returns every in-progress item every cycle
                                // whether the user touched it or not —
                                // without this gate the pull writes a fresh
                                // progress event per cycle for every resume
                                // row, jamming `last_event_at = NOW()` on all
                                // of them and making the CW row's "paused N
                                // min ago" meaningless (every item shows the
                                // time since the last pull).
                                //
                                // Tolerance: 1000ms because Jellyfin's tick
                                // precision can drift across reconnects / DST
                                // transitions and we don't want spurious 1ms
                                // diffs to flap.
                                //
                                // `treatAsWatched` never re-opens an item
                                // Lumastra still considers watched as
                                // in-progress from a stale resume position —
                                // UNLESS this same cycle just flipped it to
                                // unwatched above (a genuine transition, not
                                // an already-converged "stuck watched" item),
                                // matching the mark_watched branch's own
                                // "emit exactly once" behavior.
                                const POSITION_DIFF_TOLERANCE_MS = 1000;
                                const treatAsWatched =
                                    currentState?.is_watched === true && !emitUnwatch;
                                const progressDecision = decideSourceProgressEvent(
                                    upsertItem.resumePositionMs,
                                    sourceSnapshot?.last_progress_position_ms ?? 0,
                                    treatAsWatched,
                                    POSITION_DIFF_TOLERANCE_MS,
                                );
                                // Position freeze: the provider told us another
                                // device is authoritative for this item's
                                // position right now, so a pull contributes no
                                // progress event and the stored position stands.
                                //
                                // Suppressing the event (rather than clamping to
                                // forward-only) is deliberate: the upstream
                                // value is a stale persisted checkpoint, so even
                                // a forward one is behind the device actually
                                // playing. Scoped to position only — the
                                // decisive branches above still apply, because
                                // "finished" is a fact the provider may assert
                                // mid-session and is what audiobook re-listen
                                // counts derive from.
                                //
                                // NOT keyed on `isActiveSession`: that flag
                                // means the opposite (see the SDK docs on both),
                                // and Jellyfin sets it on every live row.
                                // Providers that never set `freezePosition` are
                                // unaffected: optional, defaults false.
                                if (progressDecision.emit && upsertItem.freezePosition) {
                                    logger.debug(
                                        'Pull: position frozen — another device is authoritative',
                                        {
                                            provider: providerName,
                                            username: lumastraUsername,
                                            mediaId: upsertItem.mediaId,
                                            reportedPositionMs: upsertItem.resumePositionMs,
                                        },
                                    );
                                }
                                if (progressDecision.emit && !upsertItem.freezePosition) {
                                    await appendEventAndRebuild(txSql, {
                                        user_id: lumastraUserId,
                                        media_id: upsertItem.mediaId,
                                        event_type: 'progress',
                                        source: validatedEventSource,
                                        position_ms: progressDecision.positionMs,
                                        runtime_ms:
                                            upsertItem.runtimeMs > 0 ? upsertItem.runtimeMs : null,
                                        source_event_id: null,
                                        session_id: null,
                                        // Coarse engagement signal: external sources
                                        // don't emit per-session telemetry, but the
                                        // resume position itself is a meaningful
                                        // floor — to reach minute X the user
                                        // committed at least to seeking there. The
                                        // rebuilder treats this as a low-confidence
                                        // engagement input so jellyfin-sourced rows
                                        // can participate in age-tiered CW filters.
                                        event_seq: null,
                                        session_elapsed_ms:
                                            progressDecision.positionMs > 0
                                                ? progressDecision.positionMs
                                                : null,
                                        // Use Jellyfin's UserData.LastPlayedDate as
                                        // the event timestamp so last_event_at
                                        // reflects real activity, not pull cycles.
                                        // Without this every CW row claims it was
                                        // touched at the most recent pull and
                                        // age-based filtering is impossible.
                                        occurred_at: upsertItem.lastWatchedAt?.toISOString() ?? now,
                                    });
                                    eventKind = 'progress';
                                }
                            }

                            // Record a success row ONLY when an event was actually
                            // appended (real state change). Resolved-but-unchanged
                            // items produce no row.
                            if (eventKind) {
                                changedInChunk.push({
                                    userId: lumastraUserId,
                                    provider: providerName,
                                    direction: 'pull',
                                    outcome: 'success',
                                    mediaId: upsertItem.mediaId,
                                    title: upsertItem.title,
                                    seriesTitle: upsertItem.seriesTitle,
                                    seasonNumber: upsertItem.seasonNumber ?? null,
                                    episodeNumber: upsertItem.episodeNumber ?? null,
                                    mediaType: upsertItem.mediaType,
                                    eventKind,
                                });
                            }
                        }
                    });
                    // Only committed writes may wake readers. Notify per chunk so
                    // a later failed/aborted chunk cannot hide earlier commits.
                    if (changedInChunk.length > 0) {
                        watchStateEvents.emit(lumastraUserId, {
                            type: 'watch_state_set_changed',
                            mediaId: chunk[0].mediaId,
                            reason: 'sync_import',
                        });
                    }
                    // Read the committed verdict, including on an unchanged
                    // second pull whose source gate correctly emitted no event.
                    // An imported event/count does not mean its watched bit won.
                    const committed = await batchGetStates.all(sql, {
                        userId: lumastraUserId,
                        mediaIds: chunk.map((i) => i.mediaId),
                    });
                    const committedById = new Map(committed.map((i) => [i.media_id, i]));
                    for (const item of chunk) {
                        const state = committedById.get(item.mediaId);
                        if (!state || state.is_watched === item.isWatched) continue;
                        const events = await getEventsSinceLastSnapshot.all(sql, {
                            userId: lumastraUserId,
                            mediaId: item.mediaId,
                        });
                        const verdict = computeStateFromEvents(events);
                        const reason = `Upstream ${validatedEventSource} watched=${item.isWatched} lost arbitration to ${verdict?.is_watched_source ?? 'local state'} (source priority; local watched=${state.is_watched})`;
                        result.totalLostArbitration = (result.totalLostArbitration ?? 0) + 1;
                        result.arbitrationLosses ??= [];
                        if (result.arbitrationLosses.length < 100)
                            result.arbitrationLosses.push({
                                userId: lumastraUserId,
                                mediaId: item.mediaId,
                                reason,
                            });
                        const activity = changedInChunk.find((i) => i.mediaId === item.mediaId);
                        if (activity) {
                            activity.outcome = 'skipped';
                            activity.error = reason;
                        }
                    }
                    await safeRecordActivity(sql, changedInChunk);
                }
                // Track per-type imports for successfully upserted items.
                // Must match the resolution lookup on the first pass — Strategy 1
                // (TMDB) was previously omitted here, undercounting movies (S5).
                // Dedupe by resolved internalId so two source items pointing
                // at the same Lumastra UUID (e.g. an admin override mapping
                // multiple MAL entries to one episode) don't double-count.
                // Mirrors the dedupedItems behavior used for the actual upserts.
                const countedIds = new Set<string>();
                for (const item of items) {
                    const internalId = resolvedByProviderId.get(item.providerId);
                    if (!internalId) continue;
                    if (countedIds.has(internalId)) continue;
                    countedIds.add(internalId);
                    if (isMovie(item.mediaType)) {
                        result.movies.imported++;
                    } else if (isEpisode(item.mediaType)) {
                        result.episodes.imported++;
                    } else {
                        result.resumeItems.imported++;
                    }
                }
                result.totalUpserted += dedupedItems.length;
                // Log a successful per-user pull (S9) — admin UI uses this for
                // "last pulled at" per user. Does NOT fire on upsert failure
                // so the timestamp remains honest.
                //
                // Cursor advances here too: only after the upsert succeeds. A
                // partial-failure user keeps the old cursor and re-imports the
                // same window next cycle; idempotency on `source_event_id`
                // collapses duplicates in the event log. Likewise, if buffering
                // the unresolved items failed, hold the cursor (null) so those
                // items are re-pulled and re-buffered next cycle rather than
                // skipped forever.
                await this.logPullRun(sql, lumastraUserId, providerName, {
                    resolved: userResolved,
                    skipped: userSkippedNoMatch,
                    errors: 0,
                    cursor:
                        pendingBufferFailed || siblingLookupFailed
                            ? null
                            : (newCursors.get(providerUsername) ?? null),
                });
                if (pendingBufferFailed || siblingLookupFailed)
                    failedImports.push(providerUsername);
            } catch (err) {
                failedImports.push(providerUsername);
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(
                    `Pull upsert failed for user=${lumastraUsername}`,
                    err instanceof Error ? err : new Error(msg),
                    {
                        itemCount: upsertItems.length,
                        sampleMediaIds: upsertItems.slice(0, 3).map((i) => i.mediaId),
                    },
                );
                result.errors.push(`user=${lumastraUsername}: ${msg}`);
                // Upsert failed, so these resolved items weren't actually imported
                result.totalResolved -= upsertItems.length;
                result.totalSkippedNoMatch += upsertItems.length;
                // Record the failure so admin UI surfaces it.
                await this.logPullRun(sql, lumastraUserId, providerName, {
                    resolved: 0,
                    skipped: userSkippedNoMatch,
                    errors: upsertItems.length,
                });
            }
        }

        if (failedImports.length > 0 && plugin.pullImportFailed) {
            try {
                await plugin.pullImportFailed(ctx, failedImports);
            } catch (err) {
                logger.warn('pullImportFailed hook threw (non-fatal)', { error: String(err) });
            }
        }

        // Flush all accumulated skipped-item rows once, after the user loop
        // (best-effort; a logging failure must not fail the pull).
        await safeRecordActivity(sql, pullActivity);

        result.durationMs = Date.now() - startTime;

        logger.info(`Pull complete for ${providerName}`, {
            totalFromProvider: result.totalFromProvider,
            resolved: result.totalResolved,
            upserted: result.totalUpserted,
            skippedNoMatch: result.totalSkippedNoMatch,
            movies: result.movies,
            episodes: result.episodes,
            errors: result.errors.length > 0 ? result.errors.slice(0, 5) : undefined,
            durationMs: result.durationMs,
        });

        return result;
    }

    // =========================================================================
    // Private: Helpers
    // =========================================================================

    /**
     * Record a successful pull run for a (user, provider) pair.
     *
     * UPSERTs the single watch_state_pull_log row for that pair — the table is
     * one row per (user_id, provider), not one per run, because the write is
     * `ON CONFLICT (user_id, provider) DO UPDATE`. It is a latest-state record, not
     * a history: the admin UI reads it for per-user "last pulled" timestamps and the
     * most recent pull's stats. (This comment said "one row per run" for a long
     * time, which makes the reader look for an ORDER BY that no reader needs.)
     * Never throws; log failures are non-fatal to the pull cycle itself (S9).
     */
    private async logPullRun(
        sql: postgres.Sql,
        userId: UserId,
        provider: string,
        stats: {
            resolved: number;
            skipped: number;
            errors: number;
            /**
             * Newest LastPlayedDate observed for this user this cycle. NULL
             * keeps the existing cursor unchanged — used on the failure
             * path so a partial-failure user retries from the prior cursor
             * next cycle. Only present on success path.
             */
            cursor?: string | null;
        },
    ): Promise<void> {
        const cursor = stats.cursor ?? null;
        await sql`
            INSERT INTO watch_state_pull_log
                (user_id, provider, last_pulled_at, resolved_count, skipped_count, error_count, last_played_cursor)
            VALUES (
                ${userId}, ${provider}, NOW(),
                ${stats.resolved}, ${stats.skipped}, ${stats.errors},
                ${cursor}
            )
            ON CONFLICT (user_id, provider) DO UPDATE SET
                last_pulled_at = NOW(),
                resolved_count = EXCLUDED.resolved_count,
                skipped_count = EXCLUDED.skipped_count,
                error_count = EXCLUDED.error_count,
                -- Only advance the cursor when EXCLUDED carries a non-NULL
                -- value (the success path). Failure-path log writes pass
                -- NULL and we keep the existing cursor so the next cycle
                -- re-imports the same window.
                last_played_cursor = COALESCE(EXCLUDED.last_played_cursor, watch_state_pull_log.last_played_cursor)
        `.catch((err: unknown) =>
            logger.warn('Failed to write watch_state_pull_log', {
                error: String(err),
                userId,
                provider,
            }),
        );
    }

    /**
     * Return the list of watch-sync plugins to target.
     * If providerId is supplied, returns only that plugin; otherwise all
     * registered ones.
     *
     * NOTE on "enabled": the legacy `WatchSyncPlugin` carried a per-plugin
     * `isEnabled()` boolean (env-var gate or feature flag). The new SDK has
     * no such field — feature gating is the plugin's own responsibility and
     * is expected to surface through `isAvailable(ctx)`. The engine's
     * existing per-cycle `isAvailable` check (inside `pushForProvider` /
     * `pullForProvider`) sets `skippedUnavailable=true` when the gate is
     * off, which preserves the original "show skipped, not failed" admin UI
     * behaviour without a separate enable flag.
     */
    private getTargetPlugins(providerId?: string): WatchSyncDefinition[] {
        const all = registry.getAllWatchSyncs();

        if (providerId) {
            return all.filter((p) => p.id === providerId);
        }

        return all;
    }
}

export const watchSyncEngine = new WatchSyncEngine();
