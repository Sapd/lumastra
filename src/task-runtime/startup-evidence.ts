// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** A process-local sample, not a total deployment/RAM comparison or a qualification. */
export function reportTaskStartupEvidence(phase: 'imports' | 'ready'): void {
    if (!process.argv.includes('--startup-evidence')) return;
    const resources: Record<string, number> = {};
    for (const resource of process.getActiveResourcesInfo())
        resources[resource] = (resources[resource] ?? 0) + 1;
    console.log(
        `TASK_RUNTIME_EVIDENCE ${JSON.stringify({
            version: 1,
            phase,
            pid: process.pid,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            elapsedMs: process.uptime() * 1000,
            memoryBytes: process.memoryUsage(),
            // Node reports maxRSS in KiB on all platforms, unlike the OS APIs.
            maxRssBytes: process.resourceUsage().maxRSS * 1024,
            cpuMicroseconds: process.cpuUsage(),
            activeResources: resources,
        })}`,
    );
}
