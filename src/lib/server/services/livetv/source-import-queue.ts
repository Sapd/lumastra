// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import * as m from '$lib/paraglide/messages.js';
import {
    updateRefreshStatus,
    updateEpgRefreshStatus,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LiveTvSourceQueue');
interface QueuedImport {
    taskIds?: { m3u?: string; epg?: string };
    importError?: string;
}

/** Deduplicate active imports. Failed enqueue remains visible and retryable by saving again. */
export async function queueSourceImport(
    sql: postgres.Sql,
    sourceId: string,
    task: 'import-m3u' | 'import-epg' | 'refresh-m3u',
    by: string,
): Promise<QueuedImport> {
    // Lazy: a static import pulls the whole task system into every importer.
    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
    try {
        let run = await orchestrator.startRun(
            task,
            { sourceId },
            {
                trigger: {
                    kind: 'manual',
                    by,
                    sourceRoute: `admin/livetv/sources (save: ${sourceId})`,
                },
                idempotencyKey: `manual_${task}_${sourceId}`,
            },
        );
        if (run.deduped) {
            // The existing run may already have fetched the old URL. A durable,
            // separately identified run waits for its source lock, then loads the
            // latest settings. Return THIS id so the UI follows the new work.
            const requestId = randomUUID();
            run = await orchestrator.startRun(
                task,
                { sourceId, requestId },
                {
                    trigger: {
                        kind: 'manual',
                        by,
                        sourceRoute: 'admin/livetv/sources (follow-up)',
                    },
                    idempotencyKey: `manual_${task}_${sourceId}_${requestId}`,
                },
            );
        }
        return { taskIds: task === 'import-epg' ? { epg: run.runId } : { m3u: run.runId } };
    } catch {
        const importError = m.livetv_admin_import_enqueue_failed();
        await (task === 'import-epg' ? updateEpgRefreshStatus : updateRefreshStatus)(
            sql,
            sourceId,
            'failed',
            { error: importError },
        ).catch(() => {
            logger.warn('Could not record Live TV enqueue failure', { sourceId });
        });
        logger.warn('Could not enqueue Live TV source import', { sourceId, task });
        return { importError };
    }
}
