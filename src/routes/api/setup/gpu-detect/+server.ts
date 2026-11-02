// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/setup/gpu-detect — admin-only: combine this service's one-frame
 * encoder probe with the per-host GPU reports used by the cluster view.
 * Recommend a GPU_ACCELERATION value from a transcode-eligible host, explicitly
 * distinguishing tested encoders from hardware reported by an unconfigured worker.
 * Candidate probes and container diagnostics remain local to the serving process.
 *
 * Read-only: it never writes config. The wizard saves the chosen value via
 * /api/setup/preferences.
 */

import { hostname } from 'node:os';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import {
    detectGpuForOnboarding,
    summarizeClusterGpuDetection,
} from '$lib/server/services/transcoding/gpu-detection.js';
import { safeExists, safeReaddir, safeReadFile } from '$lib/server/utils/safe-fs.js';

/**
 * True when the process is running inside a container. Used to tell the
 * wizard when a missing GPU is likely just `/dev/dri` not being mounted into
 * the container, rather than "no GPU on this host at all".
 */
async function detectInContainer(): Promise<boolean> {
    if (await safeExists('/.dockerenv')) return true;
    if (await safeExists('/run/.containerenv')) return true;
    try {
        const cgroup = (await safeReadFile('/proc/1/cgroup')).toString('utf8');
        return (
            cgroup.includes('docker') ||
            cgroup.includes('containerd') ||
            cgroup.includes('kubepods')
        );
    } catch {
        return false;
    }
}

/**
 * True when `/dev/dri` is present and exposes at least one `renderD*` node
 * (the device VAAPI/QSV need). Falls back to plain existence if the
 * directory can't be listed.
 */
async function detectDriPresent(): Promise<boolean> {
    if (!(await safeExists('/dev/dri'))) return false;
    try {
        const entries = await safeReaddir('/dev/dri');
        return entries.some((entry) => entry.name.startsWith('renderD'));
    } catch {
        return true;
    }
}

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const localHostname = hostname();
        const [result, inContainer, driPresent, cluster] = await Promise.all([
            detectGpuForOnboarding(),
            detectInContainer(),
            detectDriPresent(),
            import('$lib/server/services/cluster-heartbeat.service.js')
                .then(async ({ readClusterNodes, HEARTBEAT_TTL_SECONDS }) => ({
                    nodes: await readClusterNodes({ withHeartbeatAge: true }),
                    heartbeatTtlMs: HEARTBEAT_TTL_SECONDS * 1000,
                }))
                .catch(() => ({ nodes: [], heartbeatTtlMs: 0 })),
        ]);
        return json({
            hostname: localHostname,
            ...summarizeClusterGpuDetection(
                localHostname,
                result,
                cluster.nodes,
                cluster.heartbeatTtlMs,
            ),
            inContainer,
            driPresent,
        });
    }),
);
