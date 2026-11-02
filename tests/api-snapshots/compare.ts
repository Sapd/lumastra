// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { readdir } from 'node:fs/promises';
import { root, roles, roleLogin, load, capture, save, only, excerpt } from './common';
import type { Snapshot } from './common';
import { differences } from './semantic';
import { liveChecks } from './checks';
interface Result {
    role: string;
    endpoint: string;
    verdict: 'OK' | 'CHANGED' | 'KNOWN' | 'BROKEN';
    details: string[];
}
async function main(): Promise<void> {
    const selected = only();
    const results: Result[] = [];
    for (const role of roles) {
        const files = (await readdir(`${root}/${role}`))
            .filter(
                (f) =>
                    f.endsWith('.json') &&
                    !f.startsWith('_') &&
                    (!selected || selected.has(f.slice(0, -5))),
            )
            .sort();
        if (!files.length) throw new Error(`No ${role} snapshots selected; capture first`);
        const auth = await roleLogin(role);
        const resolved = new Map<string, number>();
        try {
            for (const file of files) {
                const details: string[] = [];
                const known: string[] = [];
                let verdict: Result['verdict'] = 'OK';
                try {
                    const before = await load<Snapshot>(`${root}/${role}/${file}`);
                    const after = await capture(before.request.path, auth.token);
                    if (Math.floor(before.status / 100) !== Math.floor(after.status / 100))
                        details.push(`Status ${before.status} → ${after.status}`);
                    const diff = differences(before.body, after.body);
                    details.push(...diff.broken);
                    // Problems already present at capture time are KNOWN (listed, exit 0); only a
                    // check that passed at capture and fails now is BROKEN.
                    const baseline = new Set(before.baselineProblems ?? []);
                    for (const problem of await liveChecks(
                        file.slice(0, -5),
                        after.body,
                        auth.token,
                        resolved,
                    )) {
                        if (baseline.has(problem)) known.push(problem);
                        else details.push(problem);
                    }
                    verdict = details.length
                        ? 'BROKEN'
                        : diff.added.length
                          ? 'CHANGED'
                          : known.length
                            ? 'KNOWN'
                            : 'OK';
                    if (known.length)
                        details.push(...known.map((k) => `Known since capture: ${k}`));
                    if (diff.added.length)
                        details.push(`Added keys (info): ${diff.added.join(', ')}`);
                } catch (error) {
                    verdict = 'BROKEN';
                    details.push(error instanceof Error ? error.message : String(error));
                }
                results.push({ role, endpoint: file.slice(0, -5), verdict, details });
            }
        } finally {
            await auth.close();
        }
    }
    const report = { createdAt: new Date().toISOString(), results };
    await save(`${root}/compare-report.json`, report);
    console.table(
        results.map((r) => ({
            role: r.role,
            endpoint: r.endpoint,
            result: r.verdict,
            details: excerpt(r.details),
        })),
    );
    if (results.some((r) => r.verdict === 'BROKEN')) process.exitCode = 1;
}
main().catch((error) => {
    console.error(excerpt(error instanceof Error ? error.message : error));
    process.exitCode = 1;
});
