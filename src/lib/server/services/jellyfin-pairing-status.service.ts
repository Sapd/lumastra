// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import { registry } from '../tasks/registry.js';
import { buildPluginContext } from '../tasks/plugin-context.js';
import { listPreferences } from '../database/queries/watch-sync-preferences.queries.js';
import {
    queryJellyfinPairingStatus,
    queryJellyfinDeliveryStatus,
    type PushScope,
} from '../database/queries/jellyfin-file-pairing.queries.js';

/** Same account, direction and watermark gates as the background engine. Fail closed. */
export async function getJellyfinPairingScopes(
    sql: postgres.Sql,
    signal?: AbortSignal,
): Promise<{ push: PushScope[]; pull: string[] }> {
    const plugin = registry.getAllWatchSyncs().find((p) => p.id === 'jellyfin-watch-sync');
    if (!plugin?.listLinkedUsers) return { push: [], pull: [] };
    const ctx = buildPluginContext(plugin.id, { sql, signal });
    if (!(await plugin.isAvailable(ctx))) return { push: [], pull: [] };
    const linked = await plugin.listLinkedUsers(ctx);
    const pullLinked = plugin.listPullUsers ? await plugin.listPullUsers(ctx) : linked;
    const pushIds = [...new Set(linked ?? [])];
    const pullIds = [...new Set(pullLinked ?? [])];
    const prefs = await listPreferences(sql, 'jellyfin', [...new Set([...pushIds, ...pullIds])]);
    return {
        push: pushIds
            .filter((id) => prefs.get(id)?.direction !== 'pull')
            .map((id) => ({
                user_id: id,
                since: prefs.get(id)?.pushWatermark?.toISOString() ?? null,
            })),
        pull: pullIds.filter((id) => prefs.get(id)?.direction !== 'push'),
    };
}

export async function getJellyfinPairingStatus(
    sql: postgres.Sql,
    olderThanMinutes = 0,
): Promise<{
    count: number;
    examples: string[];
    failed?: { count: number; examples: string[] };
    oneSided?: number;
}> {
    // Broken account lookup must not create findings for everyone on the server.
    const eligible = await getJellyfinPairingScopes(sql).catch(() => ({ push: [], pull: [] }));
    const pairing = await queryJellyfinPairingStatus(
        sql,
        olderThanMinutes,
        eligible.push,
        eligible.pull,
    );
    const delivery = await queryJellyfinDeliveryStatus(sql, eligible.push, eligible.pull);
    return {
        ...pairing,
        ...(delivery.failed.count ? { failed: delivery.failed } : {}),
        ...(delivery.oneSided ? { oneSided: delivery.oneSided } : {}),
    };
}
