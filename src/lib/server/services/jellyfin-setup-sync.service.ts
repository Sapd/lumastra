// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '../database/with-tx.js';
import {
    getJellyfinInventoryWave,
    hasPendingJellyfinPull,
    lockJellyfinSetup,
    saveJellyfinSetupValue,
} from '../database/queries/jellyfin-setup.queries.js';

interface FollowupLogger {
    warn(message: string): void;
}

async function failedKick(sql: postgres.Sql, logger: FollowupLogger): Promise<false> {
    logger.warn('Jellyfin follow-up could not start; the parent run is unchanged');
    try {
        await saveJellyfinSetupValue(sql, 'kick-error', true);
    } catch {
        logger.warn('Could not record Jellyfin follow-up status');
    }
    return false;
}

export async function requestJellyfinSetupInventory(
    sql: postgres.Sql,
    source: string,
    logger: FollowupLogger,
): Promise<boolean> {
    const bucket = Math.floor(Date.now() / 600_000);
    try {
        return await withTx(sql, async (tx) => {
            await lockJellyfinSetup(tx);
            if (await getJellyfinInventoryWave(tx, bucket)) {
                if (await hasPendingJellyfinPull(tx)) await enqueuePendingPull(tx);
                return true;
            }
            const { orchestrator } = await import('../tasks/orchestrator.js');
            const run = await orchestrator.startRun(
                'jellyfin-file-inventory',
                { kickPull: true },
                {
                    trigger: { kind: 'in-process', sourceRoute: source },
                    idempotencyKey: `jellyfin-setup-inventory-${bucket}`,
                },
            );
            await saveJellyfinSetupValue(tx, 'inventory-wave', { bucket, runId: run.runId });
            await saveJellyfinSetupValue(tx, 'inventory-run', { runId: run.runId });
            await saveJellyfinSetupValue(tx, 'kick-error', false);
            return true;
        });
    } catch {
        return failedKick(sql, logger);
    }
}

async function enqueuePendingPull(sql: postgres.Sql): Promise<void> {
    const { orchestrator } = await import('../tasks/orchestrator.js');
    const run = await orchestrator.startRun(
        'watch-sync-pull',
        {},
        {
            trigger: { kind: 'in-process', sourceRoute: 'jellyfin-file-inventory' },
        },
    );
    await saveJellyfinSetupValue(sql, 'pull-run', { runId: run.runId });
    await saveJellyfinSetupValue(sql, 'kick-error', false);
}

export async function requestJellyfinSetupPull(
    sql: postgres.Sql,
    logger: FollowupLogger,
): Promise<boolean> {
    try {
        await saveJellyfinSetupValue(sql, 'pending-pull', {
            requestedAt: new Date().toISOString(),
        });
        await enqueuePendingPull(sql);
        return true;
    } catch {
        return failedKick(sql, logger);
    }
}

export async function flushPendingJellyfinPull(
    sql: postgres.Sql,
    logger: FollowupLogger,
): Promise<void> {
    try {
        if (await hasPendingJellyfinPull(sql)) await enqueuePendingPull(sql);
    } catch {
        await failedKick(sql, logger);
    }
}
