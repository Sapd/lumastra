// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const UPGRADE_DOCS_URL =
    'https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys';

export type WorkerMode = 'enabled' | 'disabled';

export function parseWorkerMode(value: string | undefined): WorkerMode {
    const mode = (value ?? 'disabled').trim().toLowerCase();
    if (mode !== 'enabled' && mode !== 'disabled')
        throw new Error(
            `WORKER_MODE=${value} is unsupported; use WORKER_MODE=disabled on the web container and run a dedicated worker container (./start-worker.sh). Upgrade guide: ${UPGRADE_DOCS_URL}`,
        );
    return mode;
}

export function resolveTaskProcessRole(mode: WorkerMode, dedicated: boolean): 'web' | 'worker' {
    if (mode === 'enabled' && dedicated) return 'worker';
    if (mode === 'disabled' && !dedicated) return 'web';
    throw new Error(
        `Combined web/task mode is unsupported; use WORKER_MODE=disabled for web and the dedicated worker entrypoint for tasks. Upgrade guide: ${UPGRADE_DOCS_URL}`,
    );
}
