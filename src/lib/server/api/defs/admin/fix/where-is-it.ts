// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/where-is-it — "I added a film. Where is it?"
 *
 * GET /api/admin/fix/where-is-it?q=… → WhereIsIt.
 * Auth: admin. Errors: problem+json.
 *
 * ## Searched by NAME, unlike every other explainer here
 *
 * The rest of this surface takes a media UUID. That works when the item exists
 * and is useless in the case people actually report — the file was copied to
 * disk and never appeared, so there is no UUID to paste. The only identifier the
 * operator has is what they called it, so that is the input.
 *
 * ## Files and items are searched INDEPENDENTLY
 *
 * This is the design, not an optimisation. The valuable answer is nearly always
 * a MISMATCH between the two: a file on disk with no library item, an item with
 * no file, a file linked to an item that was never identified. A search rooted
 * in `media_items` cannot see the file that never became an item — which is
 * precisely the case being investigated. So both tables are searched and the
 * results unioned by item id, with file-only matches kept as their own entries.
 *
 * ## The output is the first step that did not happen
 *
 * Ingest is a sequence: on disk → probed → linked → identified → visible →
 * stages. Reporting "not found" would leave the operator where they started;
 * reporting "the file is on disk and was probed, but no library item was ever
 * created from it" ends the investigation. `stoppedAt` is computed here rather
 * than in the page so the two cannot disagree about where the chain broke.
 *
 * ## Quarantine is checked separately
 *
 * A quarantined provider payload is neither a file nor a library row, so it
 * appears in neither search — and "the sync rejected it" is a complete answer.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { getSchedulerState } from '$lib/server/tasks/scheduler-state.js';
import {
    deriveScannerRunStatus,
    getRecentScannerRuns,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { buildLikePattern } from '$lib/server/database/queries/builders/search-filter.builder.js';
import type {
    WhereIsIt,
    TraceMatch,
    TraceStep,
    TraceStage,
    WhereIsItUnreadable,
} from '$lib/components/admin/fix/where-is-it.schema.js';

const logger = Logger.for('AdminFixWhereIsIt');

/** The task that walks library paths — its state answers "has the scan even run?". */
const SCAN_TASK_ID = 'file-library-scan';

/** Evidence, not a search engine. A name that matches 200 things was mistyped. */
const MAX_MATCHES = 12;

/** Rows fetched per anchor before the union is capped. */
const PER_ANCHOR_LIMIT = 25;

/** Recent scanner runs read to find the last one that actually finished. */
const RECENT_RUNS = 5;

/** Types that hold no file of their own: their files hang off their children. */
const CONTAINER_TYPES = new Set(['tv', 'series', 'season', 'album', 'artist']);

/** Stage statuses that mean "this stage is done with the item". */
const STAGE_DONE = new Set(['completed', 'skipped_permanent']);

/** Order of the chain, so "the first break" can be compared across files. */
const STEP_ORDER: TraceStep['step'][] = [
    'file-on-disk',
    'file-probed',
    'linked-to-item',
    'item-identified',
    'item-visible',
    'stages-processed',
];

/** Lower is worse: where in the chain a match stopped; a complete chain ranks last. */
function stopRank(m: TraceMatch): number {
    if (m.stoppedAt === null) return STEP_ORDER.length;
    const i = STEP_ORDER.indexOf(m.stoppedAt as TraceStep['step']);
    return i === -1 ? STEP_ORDER.length : i;
}

interface ItemRow {
    id: string;
    title: string;
    media_type: string;
    has_files: boolean | null;
    external_count: number;
    provider_list: string | null;
}

interface FileRow {
    file_id: string;
    file_path: string;
    file_size_bytes: string | null;
    is_missing: boolean;
    probed_at: Date | null;
    container_format: string | null;
    media_item_id: string | null;
    item_title: string | null;
    item_media_type: string | null;
    item_has_files: boolean | null;
    item_status: string | null;
    external_count: number;
}

/**
 * One step. `code` + `params` are what the page renders in the user's
 * language; `detail` is the same sentence in English (fallback for one
 * release, and for logs).
 */
function step(
    s: TraceStep['step'],
    status: TraceStep['status'],
    code: string,
    params: Record<string, string | number>,
    detail: string,
): TraceStep {
    return { step: s, status, code, params, detail };
}

/** Bytes → something an operator can compare against what they copied. */
function humanSize(bytes: number | null): string {
    if (bytes === null) return 'unknown size';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            // Two characters minimum: a single letter matches most of a library
            // and the result would be noise wearing the shape of an answer.
            q: z.string().trim().min(2).max(200),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const { q } = ctx.input!.query;
            // Escaped: `%` and `_` in a filename are literal characters, not
            // wildcards — `__` must not match the whole library.
            const like = buildLikePattern(q);

            // A side read that failed is reported, never folded into the
            // answer: a failed scheduler read is not "scanning is off", and a
            // failed quarantine read is not "nothing was rejected".
            const unreadable: WhereIsItUnreadable[] = [];
            function failed<T>(what: WhereIsItUnreadable, fallback: T) {
                return (err: unknown): T => {
                    logger.warn(`${what} unreadable for trace`, {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    unreadable.push(what);
                    return fallback;
                };
            }

            const [items, files, quarantine, schedule, runs] = await Promise.all([
                // Anchor 1: library items whose title matches.
                sql<ItemRow[]>`
                    SELECT mi.id, mi.title, mi.media_type, mi.has_files,
                           COUNT(ei.id)::int AS external_count,
                           string_agg(DISTINCT ei.provider, ', ') AS provider_list
                      FROM media_items mi
                      LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file'
                     WHERE mi.title ILIKE ${like}
                       AND mi.status = 'active'
                     GROUP BY mi.id, mi.title, mi.media_type, mi.has_files
                     ORDER BY mi.title
                     LIMIT ${PER_ANCHOR_LIMIT}
                `,
                // Anchor 2: files whose PATH matches, with whatever item they
                // reached — LEFT JOIN on purpose, because the file that never
                // became an item is the case this endpoint exists for.
                sql<FileRow[]>`
                    SELECT mf.id AS file_id, mf.file_path, mf.file_size_bytes::text,
                           mf.is_missing, mf.probed_at, mf.container_format,
                           mi.id AS media_item_id, mi.title AS item_title,
                           mi.media_type AS item_media_type, mi.has_files AS item_has_files,
                           mi.status AS item_status,
                           (SELECT COUNT(*)::int FROM external_ids e WHERE e.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
                               AS external_count
                      FROM media_files mf
                      LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
                      LEFT JOIN media_items mi ON mi.id = mfi.media_item_id
                     WHERE mf.file_path ILIKE ${like}
                     ORDER BY mf.file_path
                     LIMIT ${PER_ANCHOR_LIMIT}
                `,
                sql<
                    {
                        provider: string;
                        external_id: string;
                        media_type: string;
                        reason: string;
                        created_at: Date;
                    }[]
                >`
                    SELECT provider, external_id, media_type, reason, created_at
                      FROM sync_quarantine
                     WHERE resolved_at IS NULL
                       AND payload::text ILIKE ${like}
                     ORDER BY created_at DESC
                     LIMIT 10
                `.catch(failed('quarantine', [])),
                getSchedulerState(sql, SCAN_TASK_ID).catch(failed('schedule', null)),
                getRecentScannerRuns(sql, RECENT_RUNS).catch(failed('runs', null)),
            ]);

            // Title-anchored items whose own files did not match the query
            // (a release-name filename, a localised title). Their files are
            // looked up by item, so the chain reports the real disk facts
            // instead of "no file on disk matches this name".
            const fileItemIds = new Set(
                files.map((f) => f.media_item_id).filter((v): v is string => v !== null),
            );
            const itemOnlyIds = items.map((i) => i.id).filter((id) => !fileItemIds.has(id));
            const itemFiles =
                itemOnlyIds.length === 0
                    ? []
                    : await sql<FileRow[]>`
                          SELECT mf.id AS file_id, mf.file_path, mf.file_size_bytes::text,
                                 mf.is_missing, mf.probed_at, mf.container_format,
                                 mi.id AS media_item_id, mi.title AS item_title,
                                 mi.media_type AS item_media_type,
                                 mi.has_files AS item_has_files, mi.status AS item_status,
                                 (SELECT COUNT(*)::int FROM external_ids e WHERE e.media_id = mi.id AND source IS DISTINCT FROM 'watch-sync-file')
                                     AS external_count
                            FROM media_file_items mfi
                            JOIN media_files mf ON mf.id = mfi.file_id
                            JOIN media_items mi ON mi.id = mfi.media_item_id
                           WHERE mfi.media_item_id = ANY(${sql.array(itemOnlyIds)}::uuid[])
                           ORDER BY mf.file_path
                           LIMIT ${PER_ANCHOR_LIMIT * 4}
                      `.catch(failed('item-files', [] as FileRow[]));

            // Union by item id. A file row that reached an item supersedes the
            // item-anchored row for the same id, because it carries the disk
            // facts the item row cannot.
            const byItem = new Map<string, TraceMatch>();
            const fileOnly: TraceMatch[] = [];

            const stageRows = new Map<string, TraceStage[]>();
            const itemIds = [
                ...new Set([
                    ...items.map((i) => i.id),
                    ...files.map((f) => f.media_item_id).filter((v): v is string => v !== null),
                ]),
            ];
            if (itemIds.length > 0) {
                const stages = await sql<
                    {
                        media_item_id: string;
                        stage_id: string;
                        status: string;
                        attempt: number;
                        last_error: { message?: string } | null;
                    }[]
                >`
                    SELECT media_item_id::text, stage_id, status, attempt, last_error
                      FROM media_item_stage_state
                     WHERE media_item_id = ANY(${sql.array(itemIds)}::uuid[])
                     ORDER BY stage_id
                `.catch(failed('stages', []));
                for (const r of stages) {
                    const list = stageRows.get(r.media_item_id) ?? [];
                    list.push({
                        stageId: r.stage_id,
                        status: r.status,
                        attempt: r.attempt,
                        lastError:
                            typeof r.last_error?.message === 'string'
                                ? r.last_error.message.slice(0, 200)
                                : null,
                    });
                    stageRows.set(r.media_item_id, list);
                }
            }

            /** Build the chain for one candidate, stopping detail at the first break. */
            function buildSteps(input: {
                hasFile: boolean;
                filePath: string | null;
                fileSize: number | null;
                fileMissing: boolean;
                probedAt: Date | null;
                container: string | null;
                itemId: string | null;
                itemMediaType: string | null;
                itemHasFiles: boolean | null;
                itemStatus: string | null;
                externalCount: number;
            }): { steps: TraceStep[]; stoppedAt: string | null } {
                const steps: TraceStep[] = [];

                if (!input.hasFile && input.itemId && unreadable.includes('item-files')) {
                    steps.push(
                        step(
                            'file-on-disk',
                            'unknown',
                            'file-unreadable',
                            {},
                            'The files of this entry could not be read, so whether one is on ' +
                                'disk is not known.',
                        ),
                    );
                } else if (
                    !input.hasFile &&
                    input.itemId &&
                    CONTAINER_TYPES.has(input.itemMediaType ?? '')
                ) {
                    steps.push(
                        step(
                            'file-on-disk',
                            'unknown',
                            'file-container',
                            {},
                            'This entry groups other entries (episodes or tracks) and holds no ' +
                                'file itself. Search for one of its episodes or tracks to trace a file.',
                        ),
                    );
                } else if (!input.hasFile && input.itemId) {
                    steps.push(
                        step(
                            'file-on-disk',
                            'blocked',
                            'file-none-linked',
                            {},
                            'This library entry has no file linked to it.',
                        ),
                    );
                } else if (input.hasFile) {
                    steps.push(
                        input.fileMissing
                            ? step(
                                  'file-on-disk',
                                  'blocked',
                                  'file-missing',
                                  { path: input.filePath ?? '' },
                                  `A file row exists at ${input.filePath}, but the scanner has ` +
                                      `marked it MISSING — it was there once and is not now.`,
                              )
                            : step(
                                  'file-on-disk',
                                  'ok',
                                  'file-present',
                                  { path: input.filePath ?? '', bytes: input.fileSize ?? -1 },
                                  `${input.filePath} (${humanSize(input.fileSize)})`,
                              ),
                    );
                } else {
                    steps.push(
                        step(
                            'file-on-disk',
                            'blocked',
                            'file-no-match',
                            {},
                            'No file on disk matches this name. Either it is not in a scanned ' +
                                'library path, or the scan has not reached it yet.',
                        ),
                    );
                }

                if (input.hasFile) {
                    steps.push(
                        input.probedAt
                            ? step(
                                  'file-probed',
                                  'ok',
                                  'probed',
                                  {
                                      at: new Date(input.probedAt).toISOString(),
                                      container: input.container ?? '',
                                  },
                                  `Read on ${new Date(input.probedAt).toLocaleDateString()}` +
                                      (input.container ? ` — ${input.container}` : ''),
                              )
                            : step(
                                  'file-probed',
                                  'blocked',
                                  'not-probed',
                                  {},
                                  'The file was found but never probed, so its streams and ' +
                                      'duration are unknown.',
                              ),
                    );
                }

                steps.push(
                    input.itemId
                        ? step(
                              'linked-to-item',
                              'ok',
                              'linked',
                              {},
                              'A library entry exists for this file.',
                          )
                        : step(
                              'linked-to-item',
                              'blocked',
                              input.hasFile ? 'file-not-linked' : 'no-entry',
                              {},
                              input.hasFile
                                  ? 'The file exists but no library entry was ever created from ' +
                                        'it. This is the usual reason a copied file never appears.'
                                  : 'No library entry with this name.',
                          ),
                );

                if (input.itemId) {
                    const hidden = input.itemStatus !== null && input.itemStatus !== 'active';
                    steps.push(
                        input.externalCount > 0
                            ? step(
                                  'item-identified',
                                  'ok',
                                  'identified',
                                  {},
                                  'Matched to provider metadata.',
                              )
                            : step(
                                  'item-identified',
                                  'blocked',
                                  'not-identified',
                                  {},
                                  'The entry exists but carries no provider id — it was never ' +
                                      'matched, so it has no artwork or metadata and can be hard ' +
                                      'to find.',
                              ),
                    );
                    steps.push(
                        hidden
                            ? step(
                                  'item-visible',
                                  'blocked',
                                  'entry-status',
                                  { status: input.itemStatus ?? '' },
                                  `The entry's status is "${input.itemStatus}", so library ` +
                                      'surfaces do not show it.',
                              )
                            : CONTAINER_TYPES.has(input.itemMediaType ?? '') && !input.hasFile
                              ? step(
                                    'item-visible',
                                    input.itemHasFiles === true ? 'ok' : 'unknown',
                                    input.itemHasFiles === true ? 'visible' : 'container-visible',
                                    {},
                                    input.itemHasFiles === true
                                        ? 'Flagged as present in the library.'
                                        : 'Shown when at least one of its episodes or tracks has a file.',
                                )
                              : input.itemHasFiles === true
                                ? step(
                                      'item-visible',
                                      'ok',
                                      'visible',
                                      {},
                                      'Flagged as present in the library.',
                                  )
                                : step(
                                      'item-visible',
                                      'blocked',
                                      'not-visible',
                                      {},
                                      'The entry is not flagged as having files, so library surfaces ' +
                                          'will not show it even though a file row exists.',
                                  ),
                    );
                    const st = stageRows.get(input.itemId) ?? [];
                    const gaveUp = st.filter((x) => x.status === 'failed_permanent');
                    const done = st.filter((x) => STAGE_DONE.has(x.status)).length;
                    steps.push(
                        unreadable.includes('stages')
                            ? step(
                                  'stages-processed',
                                  'unknown',
                                  'stages-unreadable',
                                  {},
                                  'The pipeline state of this entry could not be read.',
                              )
                            : st.length === 0
                              ? step(
                                    'stages-processed',
                                    'unknown',
                                    'stages-none',
                                    {},
                                    'No pipeline rows for this entry — nothing has been queued ' +
                                        'for it, which is itself worth investigating.',
                                )
                              : gaveUp.length > 0
                                ? step(
                                      'stages-processed',
                                      'blocked',
                                      'stages-gave-up',
                                      {
                                          count: gaveUp.length,
                                          total: st.length,
                                          stages: gaveUp.map((x) => x.stageId).join(', '),
                                      },
                                      `${gaveUp.length} of ${st.length} stages gave up: ` +
                                          gaveUp.map((x) => x.stageId).join(', ') +
                                          '. They will not retry on their own.',
                                  )
                                : done < st.length
                                  ? step(
                                        'stages-processed',
                                        'unknown',
                                        'stages-pending',
                                        { done, total: st.length },
                                        `${done} of ${st.length} stages done; the rest are ` +
                                            'still queued, running or retrying.',
                                    )
                                  : step(
                                        'stages-processed',
                                        'ok',
                                        'stages-done',
                                        { total: st.length },
                                        `All ${st.length} stages done.`,
                                    ),
                    );
                }

                const blocked = steps.find((x) => x.status === 'blocked');
                return { steps, stoppedAt: blocked?.step ?? null };
            }

            for (const f of [...files, ...itemFiles]) {
                const size = f.file_size_bytes === null ? null : Number(f.file_size_bytes);
                const built = buildSteps({
                    hasFile: true,
                    filePath: f.file_path,
                    fileSize: size,
                    fileMissing: f.is_missing,
                    probedAt: f.probed_at,
                    container: f.container_format,
                    itemId: f.media_item_id,
                    itemMediaType: f.item_media_type,
                    itemHasFiles: f.item_has_files,
                    itemStatus: f.item_status,
                    externalCount: f.external_count ?? 0,
                });
                const match: TraceMatch = {
                    mediaItemId: f.media_item_id,
                    title: f.item_title ?? f.file_path.split('/').pop() ?? f.file_path,
                    mediaType: f.item_media_type,
                    filePath: f.file_path,
                    fileSizeBytes: size,
                    fileMissing: f.is_missing,
                    steps: built.steps,
                    stoppedAt: built.stoppedAt,
                    stages: f.media_item_id ? (stageRows.get(f.media_item_id) ?? []) : [],
                };
                if (f.media_item_id) {
                    // An item with several files (versions, parts) is as far
                    // along as its WORST file: a healthy sibling must not hide
                    // the copy that is missing or was never read.
                    const prev = byItem.get(f.media_item_id);
                    if (!prev || stopRank(match) < stopRank(prev))
                        byItem.set(f.media_item_id, match);
                } else fileOnly.push(match);
            }

            for (const i of items) {
                if (byItem.has(i.id)) continue; // the file-anchored row is richer
                const built = buildSteps({
                    hasFile: false,
                    filePath: null,
                    fileSize: null,
                    fileMissing: false,
                    probedAt: null,
                    container: null,
                    itemId: i.id,
                    itemMediaType: i.media_type,
                    itemHasFiles: i.has_files,
                    itemStatus: 'active',
                    externalCount: i.external_count ?? 0,
                });
                byItem.set(i.id, {
                    mediaItemId: i.id,
                    title: i.title,
                    mediaType: i.media_type,
                    filePath: null,
                    fileSizeBytes: null,
                    fileMissing: false,
                    steps: built.steps,
                    stoppedAt: built.stoppedAt,
                    stages: stageRows.get(i.id) ?? [],
                });
            }

            // Broken chains first — a working item is not why anyone opened this page.
            const all = [...fileOnly, ...byItem.values()].sort((a, b) => {
                const aBroken = a.stoppedAt === null ? 1 : 0;
                const bBroken = b.stoppedAt === null ? 1 : 0;
                return aBroken - bBroken || a.title.localeCompare(b.title);
            });

            const payload: WhereIsIt = {
                generatedAt: new Date().toISOString(),
                query: q,
                matches: all.slice(0, MAX_MATCHES),
                // An anchor that hit its own cap may have dropped matches the
                // union never saw, so that counts as truncated too.
                truncated:
                    all.length > MAX_MATCHES ||
                    items.length >= PER_ANCHOR_LIMIT ||
                    files.length >= PER_ANCHOR_LIMIT,
                quarantined: quarantine.map((r) => ({
                    provider: r.provider,
                    externalId: r.external_id,
                    mediaType: r.media_type,
                    reason: r.reason,
                    createdAt: new Date(r.created_at).toISOString(),
                })),
                // The newest run that FINISHED: an in-flight run has no
                // completion, and an abandoned one carries a sentinel stamp.
                lastScanCompletedAt: (() => {
                    const done = runs?.find(
                        (r) => r.completed_at !== null && deriveScannerRunStatus(r) === 'completed',
                    );
                    return done?.completed_at ? new Date(done.completed_at).toISOString() : null;
                })(),
                // Null when it could not be determined. No scheduler row is not
                // "off": a fresh install has none until the worker first starts.
                scanEnabled:
                    config.DISABLE_FILE_LIBRARY_SCAN === true
                        ? false
                        : unreadable.includes('schedule')
                          ? null
                          : schedule
                            ? !schedule.paused
                            : null,
                unreadable,
            };

            return json(payload);
        },
    },
});
