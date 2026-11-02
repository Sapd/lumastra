// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { refreshJellyfinFilePairings } from '$lib/server/services/jellyfin-file-pairing.service.js';
import { features } from '$lib/server/config.js';
import { requestJellyfinSetupPull } from '$lib/server/services/jellyfin-setup-sync.service.js';
import { saveJellyfinSetupValue } from '$lib/server/database/queries/jellyfin-setup.queries.js';
import { refreshSetupJellyfinCounts } from '$lib/server/database/queries/onboarding.queries.js';

/** Inventory HTTP has its own budget and never occupies the five-minute sync run. */
export const jellyfinFileInventoryTask = defineTask<Record<string, unknown>, { summary: string }>({
    id: 'jellyfin-file-inventory',
    purpose: 'watch-sync',
    name: 'Jellyfin file pairing',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },
    resourceClass: 'io',
    schedule: { every: '5m', runOnStartup: true },
    identityFor: () => 'global',
    scope: 'global',
    exclusiveWith: { scope: 'global', ttl: '31m' },
    inputSchema: z.object({ kickPull: z.boolean().optional() }).passthrough(),
    timeout: { hard: '30m', soft: '29m' },
    async execute(ctx) {
        if (features.jellyfinSync) {
            try {
                await saveJellyfinSetupValue(ctx.sql, 'inventory-run', { runId: ctx.runId });
            } catch {
                ctx.logger.warn('Could not record Jellyfin inventory status');
            }
            const refreshed = await refreshJellyfinFilePairings(ctx.sql, ctx.signal);
            try {
                await refreshSetupJellyfinCounts(ctx.sql);
            } catch {
                ctx.logger.warn('Could not update Jellyfin pairing counts');
            }
            if (
                !ctx.signal.aborted &&
                ctx.input.kickPull &&
                (refreshed.firstInventory || refreshed.changedPairings)
            ) {
                try {
                    await requestJellyfinSetupPull(ctx.sql, ctx.logger);
                } catch {
                    ctx.logger.warn(
                        'Jellyfin watch pull could not start; inventory remains successful',
                    );
                }
            }
        }
        return { success: true, result: { summary: 'Jellyfin file pairing checked' } };
    },
});
registry.registerTask(jellyfinFileInventoryTask);
