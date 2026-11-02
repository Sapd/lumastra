// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ClusterHostCard from './ClusterHostCard.svelte';
import type { ClusterHostGroup } from './cluster-hosts.js';

const GiB = 1024 ** 3;
function group(
    total: number,
    available: number,
    diskTotal: number,
    diskFree: number,
): ClusterHostGroup {
    const host = {
        id: 'name:test',
        memTotalBytes: total * GiB,
        memAvailableBytes: available * GiB,
        disks: [
            {
                role: 'data' as const,
                path: '/data',
                totalBytes: diskTotal * GiB,
                freeBytes: diskFree * GiB,
            },
        ],
    };
    return {
        id: host.id,
        known: true,
        host,
        hostMemoryWarn: true,
        serviceRssBytes: 0,
        gpuClients: 0,
        gpuAccess: [],
        services: [
            { key: 'node:a', kind: 'general', state: 'healthy', reasons: [], isSelf: true, host },
        ],
    };
}
afterEach(cleanup);

describe('shared host pressure thresholds', () => {
    it('does not warn on low free percentages when absolute memory and disk headroom are sufficient', () => {
        render(ClusterHostCard, { group: group(256, 5, 20 * 1024, 400) });
        expect(screen.queryByText('Low available host memory')).toBeNull();
        expect(screen.queryByText('Low free disk space')).toBeNull();
        expect(screen.getByTestId('cluster-host-memory').className).not.toContain('text-amber-300');
    });
    it('names actual memory and disk pressure using the shared absolute and percentage floors', () => {
        render(ClusterHostCard, { group: group(16, 0.7, 50, 2) });
        expect(screen.getByText('Low available host memory')).toBeTruthy();
        expect(screen.getByText('Low free disk space')).toBeTruthy();
    });
});
