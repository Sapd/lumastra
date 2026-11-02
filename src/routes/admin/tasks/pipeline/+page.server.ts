// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection.js';
import {
    loadIngestMap,
    loadIngestMapSummaryBuckets,
    loadStageActivity,
    loadIngestPipelineSummary,
    loadStuckItems,
    loadDeadLetterItems,
    loadErrorGroups,
} from '$lib/server/database/queries/ingest-map.queries.js';
import { listScanIssues } from '$lib/server/database/queries/media-files.queries.js';
import { cacheGet, cacheSet } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { serializeStuckItem } from './stuck-item-serializer.js';

const log = Logger.for('AdminIngestPage');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 500;

// Cache the heavy 8-query bundle. The dashboard hydrates an SSE feed on
// mount that streams subsequent stage_state changes in real time, so a
// modest staleness on the initial paint is invisible to the operator
// once the feed connects. Without the cache, loadIngestMap alone takes
// ~4 s on the preprod 2 M-row media_item_stage_state table because its
// correlated EXISTS subquery falls to a Seq Scan + 440 k index probes.
//
// Bumped versioning suffix (v1) so a schema/format change can break the
// cache without a TTL wait.
// Bumped versioning suffix (v2) so a schema/format change can break the
// cache without a TTL wait. Increment when changing the response shape.
// Bumped to v3 (admin-ia redesign, step:pipeline): pipelineSummary gained
// `reidentifyItems` — a stale v2 cache entry would silently render the new
// "needs re-identification" chip as 0/hidden until the 60 s TTL expired.
// Bumped to v4 so cached stuck-item snapshots include the selected reason.
const PAGE_CACHE_KEY = 'admin:ingest:page:v4';
// 60 s matches the page's SSE-driven refresh cadence: the client opens an
// SSE feed on hydrate that streams subsequent stage_state changes in
// real time, so the initial-paint payload can be a minute stale without
// the operator noticing. Previous 10 s value was burned through by a
// single cold load (the 8-query bundle takes 5–30 s under Postgres
// parallel-worker contention), defeating the cache for repeat visits.
const PAGE_CACHE_TTL_SECONDS = 60;

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    // Cache the serialized initial payload. Read on every request; on hit
    // skip the 8-query bundle entirely. On miss compute + populate. Cache
    // failures are silently bypassed (cacheGet returns null on Valkey
    // outage), so the page still renders even with Valkey down.
    try {
        const cached = await cacheGet(PAGE_CACHE_KEY);
        if (cached) {
            // Cast through `unknown` because the JSON round-trip drops the
            // Date instances written below (they're serialized to ISO
            // strings on cache-write and stay strings on cache-read).
            // The page consumer already accepts string-shaped dates from
            // the live path; the structural shape is otherwise identical.
            return {
                initial: JSON.parse(cached) as unknown as Awaited<
                    ReturnType<PageServerLoad>
                > extends infer R
                    ? R extends { initial: infer I }
                        ? I
                        : never
                    : never,
            };
        }
    } catch (err) {
        log.warn('admin/tasks/pipeline cache read failed; falling through to live query', {
            err: err instanceof Error ? err.message : String(err),
        });
    }

    const sql = getDb();
    if (!sql) {
        return {
            initial: {
                items: [],
                summaryBuckets: [],
                scanIssues: [],
                stageActivity: [],
                queueDepths: [],
                queueDepthsError: null,
                pipelineSummary: null,
                stuckItems: [],
                deadLetter: [],
                errorGroups: [],
                window: {
                    since: new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString(),
                    until: new Date().toISOString(),
                },
                total: 0,
                truncated: false,
            },
        };
    }

    // Per-resource-class queue depth — used by the metro station tooltip
    // to communicate "this station has N items pending and the worker
    // pool serving it has M items ahead in the same queue". Best-effort:
    // failure to read returns an empty array, the tooltip omits the
    // section. The orchestrator import is lazy so test environments that
    // don't boot the orchestrator can still render the page.
    const queueDepthsPromise: Promise<{
        depths: {
            resourceClass: string;
            active: number;
            waiting: number;
            concurrencyCap: number;
            paused: boolean;
        }[];
        error: string | null;
    }> = (async () => {
        try {
            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            const [depths, caps] = await Promise.all([
                orchestrator.getQueueDepths(),
                Promise.resolve(orchestrator.getConcurrencyCaps()),
            ]);
            return {
                depths: Object.entries(depths).map(([cls, info]) => ({
                    resourceClass: cls,
                    active: info.active,
                    waiting: info.waiting,
                    concurrencyCap: caps[cls as keyof typeof caps] ?? 0,
                    paused: info.paused,
                })),
                error: null,
            };
        } catch (err) {
            // Surface the error to the UI alongside an empty depths array
            // so MetroLine can show "queue info unavailable" rather than
            // silently hiding the section (which looks identical to
            // "no contention" — the bug class an operator can't diagnose
            // without tailing logs).
            const msg = err instanceof Error ? err.message : String(err);
            log.warn('Failed to read queue depths for IngestMap tooltip', {
                err: msg,
            });
            return { depths: [], error: msg };
        }
    })();

    const [
        items,
        summaryBuckets,
        scanIssues,
        stageActivity,
        pipelineSummary,
        stuckItems,
        deadLetter,
        errorGroups,
        queueDepths,
    ] = await Promise.all([
        loadIngestMap(sql, {
            windowSinceMs: DEFAULT_WINDOW_MS,
            limit: DEFAULT_LIMIT,
        }),
        loadIngestMapSummaryBuckets(sql, { windowSinceMs: DEFAULT_WINDOW_MS }),
        listScanIssues(sql),
        loadStageActivity(sql),
        loadIngestPipelineSummary(sql),
        loadStuckItems(sql, 20),
        loadDeadLetterItems(sql, 20),
        loadErrorGroups(sql, 20),
        queueDepthsPromise,
    ]);

    const until = new Date();
    const since = new Date(until.getTime() - DEFAULT_WINDOW_MS);

    const result = {
        initial: {
            items: items.map((item) => ({
                media_item_id: item.media_item_id,
                media_type: item.media_type,
                title: item.title,
                series_title: item.series_title,
                season_number: item.season_number,
                episode_number: item.episode_number,
                created_at:
                    item.created_at instanceof Date
                        ? item.created_at.toISOString()
                        : new Date(item.created_at).toISOString(),
                stages: item.stages.map((s) => ({
                    stage_id: s.stage_id,
                    status: s.status,
                    processing_version: s.processing_version,
                    attempt: s.attempt,
                    last_error: s.last_error,
                    updated_at:
                        s.updated_at instanceof Date
                            ? s.updated_at.toISOString()
                            : new Date(s.updated_at).toISOString(),
                    skipped_reason: s.skipped_reason,
                    next_eligible_at:
                        s.next_eligible_at instanceof Date
                            ? s.next_eligible_at.toISOString()
                            : s.next_eligible_at
                              ? new Date(s.next_eligible_at).toISOString()
                              : null,
                })),
            })),
            summaryBuckets,
            scanIssues: scanIssues.map((s) => ({
                file_path: s.file_path,
                library_group_id: s.library_group_id,
                issues: s.issues,
                created_at:
                    s.created_at instanceof Date
                        ? s.created_at.toISOString()
                        : new Date(s.created_at).toISOString(),
                updated_at:
                    s.updated_at instanceof Date
                        ? s.updated_at.toISOString()
                        : new Date(s.updated_at).toISOString(),
            })),
            stageActivity: stageActivity.map((s) => ({
                stage_id: s.stage_id,
                last_completed_at:
                    s.last_completed_at instanceof Date
                        ? s.last_completed_at.toISOString()
                        : s.last_completed_at
                          ? new Date(s.last_completed_at).toISOString()
                          : null,
                completed_5m: s.completed_5m,
                running: s.running,
                failed_1h: s.failed_1h,
            })),
            queueDepths: queueDepths.depths,
            queueDepthsError: queueDepths.error,
            pipelineSummary,
            stuckItems: stuckItems.map(serializeStuckItem),
            deadLetter: deadLetter.map((row) => ({
                media_item_id: row.media_item_id,
                title: row.title,
                series_title: row.series_title,
                season_number: row.season_number,
                episode_number: row.episode_number,
                media_type: row.media_type,
                stage_id: row.stage_id,
                attempt: row.attempt,
                last_error: row.last_error,
                dead_since:
                    row.dead_since instanceof Date
                        ? row.dead_since.toISOString()
                        : new Date(row.dead_since).toISOString(),
                dead_age_sec: row.dead_age_sec,
            })),
            errorGroups: errorGroups.map((row) => ({
                stage_id: row.stage_id,
                fingerprint: row.fingerprint,
                sample_message: row.sample_message,
                error_code: row.error_code,
                count: row.count,
                first_seen:
                    row.first_seen instanceof Date
                        ? row.first_seen.toISOString()
                        : new Date(row.first_seen).toISOString(),
                last_seen:
                    row.last_seen instanceof Date
                        ? row.last_seen.toISOString()
                        : new Date(row.last_seen).toISOString(),
            })),
            window: {
                since: since.toISOString(),
                until: until.toISOString(),
            },
            total: items.length,
            truncated: items.length === DEFAULT_LIMIT,
        },
    };

    // Populate cache asynchronously — never block the render on the write. A
    // transient queue-depth read failure is not cached: replaying "queue info
    // unavailable" to every visitor for the whole TTL would outlive the blip.
    if (result.initial.queueDepthsError === null) {
        void cacheSet(PAGE_CACHE_KEY, JSON.stringify(result.initial), PAGE_CACHE_TTL_SECONDS).catch(
            (err: unknown) => {
                log.warn(
                    'admin/tasks/pipeline cache write failed (non-fatal)',
                    err instanceof Error ? err : new Error(String(err)),
                );
            },
        );
    }

    return result;
};
