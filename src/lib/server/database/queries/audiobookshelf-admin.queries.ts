// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read models for the AudiobookShelf admin settings section.
 *
 * Integration-level state that does not belong on a page about library sources:
 * how the last sync went, and which users have a minted upstream credential.
 */

import type postgres from 'postgres';
import { AUDIOBOOKSHELF_PLUGIN_ID } from '$lib/server/services/audiobookshelf-credentials.service.js';

/** Task id that drives the reconcile sweep. */
export const AUDIOBOOKSHELF_SYNC_TASK_ID = 'audiobookshelf-sync';

/** Counters the sweep reports, as stored in `task_history.result`. */
export interface AudiobookshelfSyncCounters {
    added: number;
    updated: number;
    dismissed: number;
    unmatched: number;
    skipped: number;
    errors: string[];
}

export interface AudiobookshelfSyncRun {
    runId: string;
    state: string;
    startedAt: Date;
    completedAt: Date | null;
    durationMs: number | null;
    counters: AudiobookshelfSyncCounters | null;
    /** Top-level run error, distinct from the sweep's per-item error strings. */
    errorMessage: string | null;
}

interface SyncRunRow {
    id: string;
    state: string;
    started_at: Date;
    completed_at: Date | null;
    duration_ms: number | null;
    result: unknown;
    error: unknown;
}

function toInt(value: unknown): number {
    // Postgres NUMERIC/JSONB numbers can arrive as strings; a bare `as number`
    // yields "12" and every arithmetic use silently concatenates.
    const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Extract the sweep counters from a `task_history.result` value.
 *
 * **`task_history.result` holds the whole `TaskResult` WRAPPER, not the task's
 * own payload.** `runner.ts` writes the value `execute()` returned verbatim
 * (`writeTerminalToPostgres(runId, 'completed', result, …)` where `result` is
 * typed `TaskResult<unknown>`), so the stored JSONB is
 *
 *     { success, itemsProcessed, result: { added, updated, dismissed, … } }
 *
 * and the counters are one level down under `result`. The corroborating evidence
 * is `lane-data.ts`, which reads `result->>'itemsProcessed'` at the TOP level —
 * a field that only exists on the wrapper.
 *
 * Reading the top level for `added` instead returns `undefined` for every field,
 * so the "no counters" branch fires on EVERY successful run and the admin panel
 * permanently reports "this run reported no counters". That is the exact
 * failure class this panel exists to catch, which is why the nesting is spelled
 * out here rather than left to a reader of the SQL.
 *
 * A run that died before the sweep returned genuinely has no counters. That must
 * stay distinguishable from a clean no-op sync — zeros would render as "ran fine,
 * nothing to do" — so it returns null rather than a zeroed object.
 */
function toCounters(taskResult: unknown): AudiobookshelfSyncCounters | null {
    if (typeof taskResult !== 'object' || taskResult === null) return null;

    const payload = (taskResult as { result?: unknown }).result;
    if (typeof payload !== 'object' || payload === null) return null;

    const r = payload as Record<string, unknown>;
    const hasAny = ['added', 'updated', 'dismissed', 'unmatched', 'skipped'].some(
        (k) => r[k] !== undefined,
    );
    if (!hasAny) return null;

    return {
        added: toInt(r.added),
        updated: toInt(r.updated),
        dismissed: toInt(r.dismissed),
        unmatched: toInt(r.unmatched),
        skipped: toInt(r.skipped),
        errors: Array.isArray(r.errors) ? r.errors.map((e) => String(e)) : [],
    };
}

function toErrorMessage(error: unknown): string | null {
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string') return message;
    }
    return null;
}

/**
 * The most recent sync runs, newest first.
 *
 * Ordered by `started_at` rather than `completed_at` so an in-flight run (whose
 * `completed_at` is NULL) sorts to the top instead of vanishing — "is it running
 * right now?" is the first question an operator asks.
 */
export async function getRecentAudiobookshelfSyncRuns(
    sql: postgres.Sql,
    limit = 10,
): Promise<AudiobookshelfSyncRun[]> {
    const rows = await sql<SyncRunRow[]>`
        SELECT id, state, started_at, completed_at, duration_ms, result, error
        FROM task_history
        WHERE task_id = ${AUDIOBOOKSHELF_SYNC_TASK_ID}
        ORDER BY started_at DESC
        LIMIT ${limit}
    `;

    return rows.map((row) => ({
        runId: row.id,
        state: row.state,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms === null ? null : toInt(row.duration_ms),
        counters: toCounters(row.result),
        errorMessage: toErrorMessage(row.error),
    }));
}

/**
 * When the sync task last STARTED, or null if it never has.
 *
 * The dynamic scheduler consults a task's loader on every sweep (~1/minute, and
 * measured at ~2/minute in practice), and the per-row `bucket` does NOT suppress
 * repeat fires within a window — measured: 12 fire attempts in 5m20s, all
 * carrying the same `dyn-sched:…:<bucket>` idempotency key. So a loader that
 * emits an entry whenever a library exists runs the sweep every sweep tick, which
 * for this source means re-paging the operator's ENTIRE AudiobookShelf library
 * every ~30 seconds instead of once per configured interval.
 *
 * The loader therefore has to decide due-ness itself, from state. This mirrors
 * the `livetv-tasks` dynamic-schedule exemplar, which returns only the sources
 * whose `last_refresh_at` is older than their interval.
 *
 * Uses `started_at`, not `completed_at`, so an in-flight run also suppresses the
 * next fire — otherwise a sweep slower than the sweep tick would pile up behind
 * itself.
 */
export async function getLastAudiobookshelfSyncStartedAt(sql: postgres.Sql): Promise<Date | null> {
    const [row] = await sql<{ started_at: Date | null }[]>`
        SELECT MAX(started_at) AS started_at
        FROM task_history
        WHERE task_id = ${AUDIOBOOKSHELF_SYNC_TASK_ID}
    `;
    return row?.started_at ?? null;
}

export interface AudiobookshelfLinkedUser {
    userId: string;
    username: string;
    /** Jellyfin username when set — the name the connector actually matches on. */
    jellyfinUsername: string | null;
    mintedAt: Date | null;
    /**
     * `MAX(last_accessed_at)`, which for this plugin is almost always NULL and is
     * therefore NOT rendered by the admin panel.
     *
     * Only the AUDITED secret getters write `last_accessed_at`. The AudiobookShelf
     * connector reads keys via `getUserRaw`, which skips the audit deliberately —
     * it runs in a per-cycle loop over every linked user, so auditing would burn
     * an audit row per user per sync cycle (see the rationale in
     * `tasks/secrets.ts`). Surfacing this as a "Last used" column stated something
     * false — that an actively-used key was unused — so the column was removed
     * rather than the field. Kept here because it is real data and becomes
     * meaningful the moment any audited path reads these credentials.
     */
    lastUsedAt: Date | null;
    /** True when the key id was stored too, i.e. the key can be revoked upstream. */
    revocable: boolean;
}

interface LinkedUserRow {
    user_id: string;
    username: string;
    jellyfin_username: string | null;
    minted_at: Date | null;
    last_used_at: Date | null;
    has_key_id: boolean;
}

/**
 * Users with a minted AudiobookShelf API key.
 *
 * `revocable` reports whether the key's upstream ID was stored alongside the key
 * itself. Without it, unlinking can only drop the local row — the upstream key
 * stays live and has to be revoked by hand in AudiobookShelf — so the operator
 * needs to see the difference BEFORE clicking revoke, not in a log afterwards.
 *
 * Aggregated per user because the credential is two rows (`api_key` and
 * `api_key_id`); listing rows directly would show every linked user twice.
 */
export async function getAudiobookshelfLinkedUsers(
    sql: postgres.Sql,
): Promise<AudiobookshelfLinkedUser[]> {
    const rows = await sql<LinkedUserRow[]>`
        SELECT
            u.id                                                        AS user_id,
            u.username                                                  AS username,
            u.jellyfin_username                                         AS jellyfin_username,
            MIN(c.created_at)                                           AS minted_at,
            MAX(c.last_accessed_at)                                     AS last_used_at,
            BOOL_OR(c.key = 'api_key_id')                               AS has_key_id
        FROM plugin_user_credentials c
        JOIN users u ON u.id = c.user_id
        WHERE c.plugin_id = ${AUDIOBOOKSHELF_PLUGIN_ID}
          AND c.key IN ('api_key', 'api_key_id')
        GROUP BY u.id, u.username, u.jellyfin_username
        ORDER BY LOWER(COALESCE(u.jellyfin_username, u.username))
    `;

    return rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        jellyfinUsername: row.jellyfin_username,
        mintedAt: row.minted_at,
        lastUsedAt: row.last_used_at,
        revocable: row.has_key_id,
    }));
}
