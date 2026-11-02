// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Update Check — the scheduled half of the plugin catalog.
 *
 * Re-syncs every enabled repository index and records, per installed plugin,
 * whether a newer installable version is on offer. It NEVER installs anything.
 *
 * That restraint is the point. The plugin trust model rests on a human having
 * decided to run a specific signed build; an auto-updater would remove exactly
 * that step, and would do it on a timer, unattended, for code that runs with
 * full host trust. So this task's whole output is a flag the admin UI reads —
 * the operator still presses the button, and the install still passes every
 * signature, ABI, publisher-continuity and anti-rollback gate it would have
 * passed if they had pasted the URL themselves.
 *
 * Failure of any one repository is reported, not thrown: a single unreachable
 * URL must not stop the other repositories from being checked, and must not
 * mark the Run failed or feed the circuit breaker for what is a remote
 * server's outage.
 */

import { z } from 'zod';
import { defineTask, PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { listExternalPlugins } from '$lib/server/database/queries/external-plugins.queries.js';
import {
    listCatalogEntries,
    setAvailableUpdate,
} from '$lib/server/database/queries/plugin-repositories.queries.js';
import {
    syncAllRepositories,
    findAvailableUpdates,
} from '$lib/server/services/plugin-repository.service.js';
import type { RepositoryVersion } from '$lib/schemas/plugin-repository.js';

type PluginUpdateCheckInput = Record<string, unknown>;

type PluginUpdateCheckResult = {
    repositoriesSynced: number;
    repositoryErrors: number;
    catalogEntries: number;
    updatesAvailable: number;
    securityUpdates: number;
    message: string;
};

const EMPTY: Omit<PluginUpdateCheckResult, 'message'> = {
    repositoriesSynced: 0,
    repositoryErrors: 0,
    catalogEntries: 0,
    updatesAvailable: 0,
    securityUpdates: 0,
};

export const pluginUpdateCheckTask = defineTask<PluginUpdateCheckInput, PluginUpdateCheckResult>({
    id: 'plugin-update-check',
    purpose: 'maintenance',
    name: 'Plugin Update Check',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    // Database only. An install needs to write to disk and load code; this task
    // must never be able to, however its logic changes later.
    capabilities: { database: true },

    schedule: {
        // Slow on purpose. A catalog is a convenience, and hammering
        // third-party static hosts on a short timer is rude at scale.
        every: '12h',
        runOnStartup: false,
    },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema: z.object({}).passthrough(),

    timeout: { hard: '15m', soft: '13m' },

    async execute(ctx) {
        const { logger, signal } = ctx;

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted',
                result: { ...EMPTY, message: 'Aborted before start' },
            };
        }

        const sql = getDb();
        if (!sql) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { ...EMPTY, message: 'No database — nothing to check' },
            };
        }

        const outcomes = await syncAllRepositories(sql);
        const repositoryErrors = outcomes.filter((o) => o.error).length;
        for (const outcome of outcomes) {
            if (outcome.error) {
                logger.warn('plugin repository sync failed', {
                    repository: outcome.repositoryId,
                    reason: outcome.error,
                });
            }
        }

        const [installed, catalog] = await Promise.all([
            listExternalPlugins(sql),
            listCatalogEntries(sql),
        ]);

        const updates = findAvailableUpdates(
            installed.map((p) => ({
                name: p.name,
                version: p.version,
                signingKeyId: p.signingKeyId,
            })),
            catalog.map((c) => ({
                name: c.name,
                advisoryKeyId: c.advisoryKeyId,
                versions: c.versions as RepositoryVersion[],
            })),
            PLUGIN_SDK_ABI,
        );

        // Write every installed plugin's row, not just the ones with an offer.
        // A plugin the operator has since updated by hand has no offer any more,
        // and leaving the old flag set would leave the badge on screen with
        // nothing behind it.
        const byName = new Map(updates.map((u) => [u.name, u]));
        for (const plugin of installed) {
            const update = byName.get(plugin.name);
            await setAvailableUpdate(
                sql,
                plugin.name,
                update
                    ? {
                          version: update.toVersion,
                          manifestUrl: update.manifestUrl,
                          signature: update.signature,
                      }
                    : null,
            );
        }

        const securityUpdates = updates.filter((u) => u.security).length;
        if (updates.length > 0) {
            logger.info('plugin updates available', {
                count: updates.length,
                security: securityUpdates,
                plugins: updates.map((u) => `${u.name} ${u.fromVersion}→${u.toVersion}`),
            });
        }

        const parts = [
            updates.length > 0
                ? `${updates.length} update(s) available`
                : 'No plugin updates available',
        ];
        if (securityUpdates > 0) parts.push(`${securityUpdates} flagged as security`);
        if (repositoryErrors > 0) parts.push(`${repositoryErrors} repository error(s) — see logs`);

        return {
            success: true,
            itemsProcessed: updates.length,
            result: {
                repositoriesSynced: outcomes.length - repositoryErrors,
                repositoryErrors,
                catalogEntries: catalog.length,
                updatesAvailable: updates.length,
                securityUpdates,
                message: parts.join('; '),
            },
        };
    },
});

registry.registerTask(pluginUpdateCheckTask);
