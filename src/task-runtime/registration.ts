// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Register contracts for HTTP providers/admin producers and dedicated consumers. */
export async function loadTaskRegistry(signal?: AbortSignal): Promise<postgres.Sql> {
    const { aiDbService } = await import('$lib/server/services/database.service.js');
    const sql = await aiDbService.getSql();
    if (!sql) throw new Error('Database not available for task registry initialization');
    const { loadBuiltins } = await import('$lib/server/tasks/builtin');
    signal?.throwIfAborted();
    await loadBuiltins();
    const { loadAllPlugins } = await import('$lib/server/plugins');
    signal?.throwIfAborted();
    await loadAllPlugins(sql);
    const { applyStoredRateLimits } = await import('$lib/server/tasks/http-rate-limit.js');
    signal?.throwIfAborted();
    await applyStoredRateLimits(sql as never);
    signal?.throwIfAborted();
    return sql;
}
