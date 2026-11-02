// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Continue Watching audit page — live server-side invariant checker.
 *
 * Reads all CW-eligible rows across users (is_watched=false + resume > 0),
 * runs the row invariants defined in row-audit/continue-watching.audit.ts,
 * and returns per-user summaries plus detailed violating items. Lets
 * operators diagnose drift (stale near-end rows, phantom scrubs, etc.)
 * without having to squint at screenshots.
 */

import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';
import { getDb } from '$lib/server/database/connection.js';
import { toUserId } from '$lib/shared/user-id';
import {
    getCwAuditRows,
    getNextUpFromDb,
    type NextUpRow,
} from '$lib/server/database/queries/watch-state.queries.js';
import {
    detectBulkMarkWindowsAllUsers,
    type BulkMarkWindow,
} from '$lib/server/database/queries/user-media-events.queries.js';
import {
    CW_INVARIANTS,
    detectPhantomShadows,
    type CWAuditItem,
    type CWCrossRefItem,
} from '$lib/server/utils/row-audit/continue-watching.audit.js';
import {
    runInvariants,
    summarizeAudit,
    type AuditResult,
    type AuditSummary,
} from '$lib/server/utils/row-audit/types.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('CWAuditPage');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_ROW_LIMIT = 10_000;

export interface PerUserAudit {
    userId: string;
    summary: AuditSummary;
    phantomShadowCount: number;
    violating: Array<{
        mediaId: string;
        title: string;
        mediaType: string;
        resumePositionMs: number;
        runtimeMs: number | null;
        ratio: number | null;
        updatedAt: string;
        violations: string[];
        isPhantomShadow: boolean;
    }>;
}

export interface PageData {
    overallSummary: AuditSummary;
    totalPhantomShadows: number;
    perUser: PerUserAudit[];
    sampleSize: number;
    /** True when getCwAuditRows hit its LIMIT and more rows exist uncounted. */
    truncated: boolean;
    rowLimit: number;
    generatedAt: string;
    /** Suspicious bulk-mark windows detected across all users. Empty when none. */
    bulkMarkWindows: BulkMarkWindow[];
}

export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        redirect(303, appPath('/'));
    }
    requireDevTools();

    const sql = getDb();
    if (!sql) {
        return {
            overallSummary: {
                total: 0,
                healthy: 0,
                violating: 0,
                byInvariant: {},
            },
            totalPhantomShadows: 0,
            perUser: [],
            sampleSize: 0,
            truncated: false,
            rowLimit: AUDIT_ROW_LIMIT,
            generatedAt: new Date().toISOString(),
            bulkMarkWindows: [],
        } satisfies PageData;
    }

    const [rows, bulkMarkWindows] = await Promise.all([
        getCwAuditRows.all(sql, { limit: AUDIT_ROW_LIMIT }),
        detectBulkMarkWindowsAllUsers.all(sql, {
            windowMs: 10_000,
            minEventCount: 50,
        }),
    ]);

    // Group by user
    const rowsByUser = new Map<string, typeof rows>();
    for (const row of rows) {
        const arr = rowsByUser.get(row.user_id) ?? [];
        arr.push(row);
        rowsByUser.set(row.user_id, arr);
    }

    const substantialRatio = (config.CONTINUE_WATCHING_SUBSTANTIAL_PERCENT ?? 20) / 100;
    const phantomStalenessMs = (config.CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS ?? 3) * DAY_MS;

    // Pre-fetch Next Up for every user in parallel — avoids the serial
    // N+1 pattern when the deployment has many active users.
    const userIds = Array.from(rowsByUser.keys());
    const nuFetches = await Promise.all(
        userIds.map(async (uid): Promise<[string, NextUpRow[]]> => {
            try {
                const rows = await getNextUpFromDb.all(sql, {
                    userId: toUserId(uid),
                    limit: 200,
                    // Audit view: bypass the production age filter so admins
                    // see the full unfiltered set the resolver would have to
                    // dedupe against.
                    maxAgeDays: 0,
                });
                return [uid, rows];
            } catch (err) {
                logger.warn('Audit: next-up fetch failed', {
                    userId: uid,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [uid, []];
            }
        }),
    );
    const nuByUser = new Map(nuFetches);

    const perUser: PerUserAudit[] = [];
    const overallSummary: AuditSummary = {
        total: 0,
        healthy: 0,
        violating: 0,
        byInvariant: {},
    };
    let totalPhantomShadows = 0;

    for (const [userId, userRows] of rowsByUser) {
        // Run per-row invariants.
        const auditItems: CWAuditItem[] = userRows.map((r) => ({
            media_id: r.media_id,
            media_type: r.media_type,
            resume_position_ms: r.resume_position_ms,
            runtime_ms: r.runtime_ms,
            is_watched: r.is_watched,
            updated_at: r.last_event_at,
        }));
        const results: AuditResult<CWAuditItem>[] = runInvariants(auditItems, CW_INVARIANTS);
        const summary = summarizeAudit(results);

        // Cross-ref: detect phantom shadows vs this user's Next Up.
        let phantomIds = new Set<string>();
        {
            const nuRows = nuByUser.get(userId) ?? [];
            const nuBySeries = new Map<string, { season_number: number; episode_number: number }>();
            for (const nu of nuRows) {
                if (nu.series_id) {
                    nuBySeries.set(nu.series_id, {
                        season_number: nu.season_number,
                        episode_number: nu.episode_number,
                    });
                }
            }
            const crossRefItems: CWCrossRefItem[] = userRows.map((r) => ({
                media_id: r.media_id,
                media_type: r.media_type,
                resume_position_ms: r.resume_position_ms,
                runtime_ms: r.runtime_ms,
                is_watched: r.is_watched,
                updated_at: r.last_event_at,
                series_id: r.series_id,
                season_number: r.season_number,
                episode_number: r.episode_number,
            }));
            const phantoms = detectPhantomShadows(crossRefItems, {
                nextUpBySeries: nuBySeries,
                substantialRatio,
                phantomStalenessMs,
            });
            phantomIds = new Set(phantoms.map((p) => p.media_id));
        }

        const violatingRows = results
            .map((result, i) => ({ result, row: userRows[i] }))
            .filter(
                ({ result, row }) => result.violations.length > 0 || phantomIds.has(row.media_id),
            )
            .map(({ result, row }) => ({
                mediaId: row.media_id,
                title: row.title,
                mediaType: row.media_type,
                resumePositionMs: row.resume_position_ms,
                runtimeMs: row.runtime_ms,
                ratio:
                    row.runtime_ms && row.runtime_ms > 0
                        ? row.resume_position_ms / row.runtime_ms
                        : null,
                updatedAt: row.last_event_at,
                violations: result.violations.map((v) => v.invariantId),
                isPhantomShadow: phantomIds.has(row.media_id),
            }));

        perUser.push({
            userId,
            summary,
            phantomShadowCount: phantomIds.size,
            violating: violatingRows,
        });

        totalPhantomShadows += phantomIds.size;

        overallSummary.total += summary.total;
        overallSummary.healthy += summary.healthy;
        overallSummary.violating += summary.violating;
        for (const [id, n] of Object.entries(summary.byInvariant)) {
            overallSummary.byInvariant[id] = (overallSummary.byInvariant[id] ?? 0) + n;
        }
    }

    // Sort users by severity (most violations first) for operator convenience.
    perUser.sort(
        (a, b) =>
            b.summary.violating +
            b.phantomShadowCount -
            (a.summary.violating + a.phantomShadowCount),
    );

    return {
        overallSummary,
        totalPhantomShadows,
        perUser,
        sampleSize: rows.length,
        truncated: rows.length >= AUDIT_ROW_LIMIT,
        rowLimit: AUDIT_ROW_LIMIT,
        generatedAt: new Date().toISOString(),
        bulkMarkWindows,
    } satisfies PageData;
};
