// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir } from 'node:fs/promises';
import { endpoints, endpointPath, missingPublicOperations } from './endpoints';
import { root, roles, roleLogin, discover, capture, save, load, only, excerpt } from './common';
import type { Index } from './common';
import { liveChecks } from './checks';
async function main(): Promise<void> {
    const selected = only();
    if (selected)
        for (const key of selected)
            if (!endpoints.some((e) => e.key === key)) throw new Error(`Unknown endpoint: ${key}`);
    for (const role of roles) {
        const auth = await roleLogin(role);
        const resolved = new Map<string, number>();
        try {
            await mkdir(`${root}/${role}`, { recursive: true });
            const prior = selected ? await load<Index>(`${root}/${role}/_index.json`) : undefined;
            // A partial re-capture keeps the recorded ids but fills ids a new endpoint key needs
            // (e.g. a station id added after the first capture); recorded ids always win.
            const ids = prior ? { ...(await discover(auth.token)), ...prior.ids } : await discover(auth.token);
            const skipped = prior?.skipped.filter((s) => !selected?.has(s.key)) ?? [];
            for (const endpoint of endpoints) {
                if (selected && !selected.has(endpoint.key)) continue;
                const path = endpointPath(endpoint, ids);
                if (!path) {
                    skipped.push({
                        key: endpoint.key,
                        reason: `No ${endpoint.id} content discovered`,
                    });
                    continue;
                }
                const result = await capture(path, auth.token);
                result.baselineProblems = await liveChecks(
                    endpoint.key,
                    result.body,
                    auth.token,
                    resolved,
                );
                await save(`${root}/${role}/${endpoint.key}.json`, result);
                console.log(
                    `${role}/${endpoint.key}: ${result.status}${result.baselineProblems.length ? ` (${result.baselineProblems.length} known problem(s))` : ''}`,
                );
            }
            await save(`${root}/${role}/_index.json`, {
                ids,
                skipped,
                missingPublicOperations,
            } satisfies Index);
        } finally {
            await auth.close();
        }
    }
}
main().catch((error) => {
    console.error(excerpt(error instanceof Error ? error.message : error));
    process.exitCode = 1;
});
