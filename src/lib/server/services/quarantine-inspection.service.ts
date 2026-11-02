// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type {
    QuarantineInspectionEntry,
    QuarantineInspectionResponse,
} from '$lib/schemas/api-admin-responses.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { config } from '$lib/server/config.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getQuarantineCurrentSubject,
    lockQuarantineCurrentSubject,
    getQuarantineSnapshot,
    listQuarantineInspectionSnapshots,
    archiveQuarantineSnapshot,
    hideQuarantineGroupSnapshot,
    restoreQuarantineDispositionBatch,
    type QuarantineSnapshot,
} from '$lib/server/database/queries/sync-quarantine.queries.js';

function fields(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
function text(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

async function project(
    sql: postgres.Sql,
    entry: QuarantineSnapshot,
): Promise<QuarantineInspectionEntry> {
    const { current, evidence } = await getQuarantineCurrentSubject(sql, entry);
    const payload = fields(entry.payload);
    const historicalSeriesId =
        entry.expectedSeriesId ??
        (typeof payload['seriesMediaId'] === 'string' && UUID_RE.test(payload['seriesMediaId'])
            ? payload['seriesMediaId'].toLowerCase()
            : null);
    return {
        id: entry.id,
        fingerprint: createHash('sha256')
            .update(JSON.stringify([entry.rowVersion, entry.rowImage, evidence]))
            .digest('hex'),
        provider: entry.provider,
        externalId: entry.externalId,
        mediaType: entry.mediaType,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
        expectedSeriesId: entry.expectedSeriesId,
        parentTmdbId: entry.parentTmdbId,
        historicalSeriesId,
        proposedTitle: text(payload['proposedTitle']),
        proposedTmdbEpisodeId: text(payload['matchedTmdbEpisodeId']),
        payload: entry.payload,
        current,
        subjectState: !current
            ? 'unavailable'
            : historicalSeriesId && current.seriesId !== historicalSeriesId
              ? 'moved'
              : 'current',
    };
}

export async function inspectQuarantineGroup(
    sql: postgres.Sql,
    group: string,
    opts: { after?: string; limit?: number } = {},
): Promise<QuarantineInspectionResponse> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 25));
    const { entries, total } = await listQuarantineInspectionSnapshots(sql, group, {
        after: opts.after,
        limit: limit + 1,
    });
    const page = entries.slice(0, limit);
    return {
        items: await Promise.all(page.map((e) => project(sql, e))),
        total,
        ...(entries.length > limit ? { continuation: page[page.length - 1].id } : {}),
    };
}

/** The client submits only an opaque fingerprint, never a row image. A revival
 * gets a new xmin even if its historical payload happens to be identical. */
export async function dismissReviewedQuarantine(
    sql: postgres.Sql,
    id: string,
    fingerprint: string,
    actor: string,
): Promise<boolean> {
    try {
        return await withTx(sql, async (tx) => {
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            const initial = await getQuarantineSnapshot(tx, id);
            if (!initial || initial.resolvedAt !== null) return false;
            const subject = await getQuarantineCurrentSubject(tx, initial);
            // Match reconciliation's media-before-warning lock order.
            if (subject.current) await lockQuarantineCurrentSubject(tx, subject.current.id);
            await tx`SELECT id FROM sync_quarantine WHERE id = ${id} FOR UPDATE NOWAIT`;
            const entry = await getQuarantineSnapshot(tx, id);
            if (!entry || entry.resolvedAt !== null) return false;
            const current = await project(tx, entry);
            if (current.fingerprint !== fingerprint) return false;
            const batchId = randomUUID();
            if (!(await archiveQuarantineSnapshot(tx, entry, actor, 'hidden', 'dismissed', batchId)))
                return false;
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'hide_quarantine_warning',
                target: id,
                outcome: 'ok',
                detail: { batchId },
            });
            return true;
        });
    } catch (error) {
        if ((error as { code?: string } | null)?.code === '55P03') return false;
        throw error;
    }
}

export async function hideQuarantineGroup(
    sql: postgres.Sql,
    group: string,
    fingerprint: string,
    actor: string,
): Promise<{ resolved: number; batchId: string } | null> {
    const batchId = randomUUID();
    try {
        return await withTx(sql, async (tx) => {
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            const result = await hideQuarantineGroupSnapshot(
                tx,
                group,
                fingerprint,
                actor,
                batchId,
            );
            if (result.resolved === 0 || result.resolved !== result.expected)
                throw new Error('stale-hide');
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor,
                action: 'hide_quarantine_group',
                target: batchId,
                outcome: 'ok',
                detail: { group, resolved: result.resolved },
            });
            return { resolved: result.resolved, batchId };
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'stale-hide') return null;
        if ((error as { code?: string } | null)?.code === '55P03') return null;
        throw error;
    }
}

/** Restores warning visibility only. Existing media, bindings and identity blocks stay as they are. */
export async function showQuarantineWarningsAgain(
    sql: postgres.Sql,
    batchId: string,
    actor: string,
    after?: string,
): Promise<{ restored: number; changed: number; continuation?: string }> {
    return withTx(sql, async (tx) => {
        await tx`SELECT set_config('lock_timeout', '10s', true)`;
        const result = await restoreQuarantineDispositionBatch(tx, batchId, after);
        await insertAdminAuditEvent(tx, {
            instanceId: config.INSTANCE_ID,
            actor,
            action: 'restore_quarantine_warnings',
            target: batchId,
            outcome: 'ok',
            detail: { ...result, after: after ?? null },
        });
        return result;
    });
}
