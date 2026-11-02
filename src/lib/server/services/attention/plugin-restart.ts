// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { AttentionItem } from './types.js';
import { listExternalPluginsIncludingPendingRemoval } from '$lib/server/database/queries/external-plugins.queries.js';
import { registry } from '$lib/server/tasks/registry.js';
import { PLUGIN_RESTART_ATTENTION_ID } from '$lib/shared/attention-persistent.js';
import * as m from '$lib/paraglide/messages.js';

/**
 * Saved registry intent survives reloads, retries and process restarts. Compare
 * it with THIS process on every attention read: the scheduled derivation may
 * run on a different replica, and waiting for it hides a still-running plugin.
 * No directory scans, imports or full attention derivation on the request path.
 * Uninstalled rows must remain in the comparison until their code is gone.
 */
export async function readPluginRestartAttention(
    sql: postgres.Sql,
    nowIso: string,
): Promise<AttentionItem[]> {
    const rows = await listExternalPluginsIncludingPendingRemoval(sql);
    const pending = rows.filter((row) => row.enabled !== registry.hasPluginRegistered(row.name));
    if (pending.length === 0) return [];

    return [
        {
            id: PLUGIN_RESTART_ATTENTION_ID,
            fingerprint: createHash('sha256')
                .update(JSON.stringify(pending.map((row) => [row.name, row.enabled])))
                .digest('hex'),
            type: 'degraded-component',
            domain: 'plugins',
            severity: 'warning',
            title: m.plugins_external_restart_pending_title(),
            detail: m.plugins_external_restart_pending_detail(),
            sourceRef: '/admin/settings/plugins',
            actions: [
                {
                    kind: 'investigate',
                    label: m.admin_attention_action_view_plugins(),
                    href: '/admin/settings/plugins',
                },
            ],
            firstSeen: pending.map((row) => row.updatedAt).sort()[0],
            lastSeen: nowIso,
            acked: false,
        },
    ];
}
