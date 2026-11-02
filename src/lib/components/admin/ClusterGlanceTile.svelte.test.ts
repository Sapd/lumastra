// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Home's cluster tile. The tile never fetches: it renders the glance the status
 * payload carried, names the machine when there is one, leaves out any figure the
 * setup does not report instead of showing a zero, and its link reads as one
 * sentence for a screen reader (title, count, subtitle, level in words, action).
 */

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClusterGlance } from '$lib/schemas/api-admin-status-payload';
import ClusterGlanceTile from './ClusterGlanceTile.svelte';

const GiB = 1024 ** 3;
const HREF = '/admin/system/health?tab=cluster';
const OPEN = /Open the cluster view$/;

function glance(over: Partial<ClusterGlance> = {}): ClusterGlance {
    return {
        level: 'ok',
        services: { up: 1, expected: 1, late: 0 },
        hostCount: 1,
        uncleanExits24h: 0,
        hostMemory: {
            usedRatio: 0.5,
            availableBytes: 8 * GiB,
            totalBytes: 16 * GiB,
            level: 'ok',
        },
        cpu: { load: 0.5, cores: 4, ratio: 0.125, level: 'ok' },
        disk: {
            role: 'data',
            freeBytes: 500 * GiB,
            totalBytes: 1000 * GiB,
            freeRatio: 0.5,
            level: 'ok',
        },
        ...over,
    };
}

function tileLink(name: RegExp): HTMLAnchorElement {
    return screen.getByRole('link', { name }) as HTMLAnchorElement;
}

/** The label/value row for a label, e.g. "CPU load". */
function rowFor(label: string): HTMLElement {
    return screen.getByText(label).closest('div') as HTMLElement;
}

afterEach(() => {
    cleanup();
});

describe('ClusterGlanceTile', () => {
    it('without a glance: a dash, "Status unavailable", the unknown level, and a name that says so', () => {
        render(ClusterGlanceTile, { props: { href: HREF } });
        const link = tileLink(/^Server, —, Status unavailable, Open the cluster view$/);
        expect(link.getAttribute('data-level')).toBe('unknown');
        expect(screen.getByText('—')).toBeTruthy();
        expect(screen.getByText('Status unavailable')).toBeTruthy();
    });

    it('a single-machine ok glance reads as one sentence, shows the rows, and links to the cluster view', () => {
        render(ClusterGlanceTile, { props: { glance: glance(), href: HREF } });

        expect(screen.getByText('Server')).toBeTruthy();
        expect(screen.getByText('1/1')).toBeTruthy();
        expect(screen.getByText('Memory used')).toBeTruthy();
        expect(screen.getByText('CPU load')).toBeTruthy();
        expect(screen.getByText('Disk free')).toBeTruthy();
        expect(screen.queryByText(/vs\. limit/)).toBeNull();

        const link = tileLink(/^Server, 1\/1, services up, all fine, Open the cluster view$/);
        expect(link.getAttribute('data-level')).toBe('ok');
        expect(link.getAttribute('href')).toMatch(/\/admin\/system\/health\?tab=cluster$/);
    });

    it('leaves out a figure the setup does not report instead of showing zero', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({ hostMemory: undefined, cpu: undefined, disk: undefined }),
                href: HREF,
            },
        });
        expect(screen.queryByText('Memory used')).toBeNull();
        expect(screen.queryByText('CPU load')).toBeNull();
        expect(screen.queryByText('Disk free')).toBeNull();
    });

    it('two machines read "Cluster" and say how many', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    hostCount: 2,
                    services: { up: 2, expected: 2, late: 0 },
                }),
                href: HREF,
            },
        });
        expect(screen.getByText('Cluster')).toBeTruthy();
        expect(screen.getByText(/2 machines/)).toBeTruthy();
        tileLink(/^Cluster, 2\/2, services up · 2 machines, all fine, Open the cluster view$/);
    });

    it('a service that stopped answering is counted as down in the subtitle and the name', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    level: 'critical',
                    services: { up: 1, expected: 3, late: 0 },
                }),
                href: HREF,
            },
        });
        expect(screen.getByText(/2 down/)).toBeTruthy();
        tileLink(
            /^Server, 1\/3, services up · 2 down, needs attention now, Open the cluster view$/,
        );
    });

    it('a late service is counted as late, not as down', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    level: 'warn',
                    services: { up: 0, expected: 1, late: 1 },
                }),
                href: HREF,
            },
        });
        expect(screen.getByText(/1 late/)).toBeTruthy();
        expect(screen.queryByText(/down/)).toBeNull();
    });

    it('a warn container shows its percentage in amber, turns the tile warn, and says so in the name', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    level: 'warn',
                    container: {
                        role: 'web',
                        usedBytes: 0.9 * GiB,
                        limitBytes: GiB,
                        ratio: 0.9,
                        level: 'warn',
                    },
                }),
                href: HREF,
            },
        });
        const row = rowFor('Web vs. limit');
        const value = within(row).getByText('90 %');
        expect(value.className).toContain('text-amber-300');

        const link = tileLink(/needs a look, Open the cluster view$/);
        expect(link.getAttribute('data-level')).toBe('warn');
    });

    it('a critical container shows its percentage in red and the name says "needs attention now"', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    level: 'critical',
                    container: {
                        role: 'worker',
                        usedBytes: 0.96 * GiB,
                        limitBytes: GiB,
                        ratio: 0.96,
                        level: 'critical',
                    },
                }),
                href: HREF,
            },
        });
        const row = rowFor('Worker vs. limit');
        const value = within(row).getByText('96 %');
        expect(value.className).toContain('text-red-300');

        const link = tileLink(OPEN);
        expect(link.getAttribute('data-level')).toBe('critical');
        expect(link.getAttribute('aria-label')).toContain('needs attention now');
    });

    it('unexpected stops show as a row with the count', () => {
        render(ClusterGlanceTile, {
            props: { glance: glance({ level: 'warn', uncleanExits24h: 2 }), href: HREF },
        });
        const row = rowFor('Unexpected stops (24 h)');
        expect(within(row).getByText('2')).toBeTruthy();
    });

    it('a container whose 24 h peak is above its current share reads "now · peak", in amber', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    level: 'warn',
                    container: {
                        role: 'web',
                        usedBytes: 620,
                        limitBytes: 1000,
                        ratio: 0.62,
                        peakBytes: 960,
                        peakRatio: 0.96,
                        level: 'warn',
                    },
                }),
                href: HREF,
            },
        });
        const value = within(rowFor('Web vs. limit')).getByText('62 % · peak 96 %');
        expect(value.className).toContain('text-amber-300');
        expect(tileLink(/needs a look, Open the cluster view$/).getAttribute('data-level')).toBe(
            'warn',
        );
    });

    it('a peak that rounds to the current share is not repeated', () => {
        render(ClusterGlanceTile, {
            props: {
                glance: glance({
                    container: {
                        role: 'web',
                        usedBytes: 620,
                        limitBytes: 1000,
                        ratio: 0.62,
                        peakBytes: 618,
                        peakRatio: 0.618,
                        level: 'ok',
                    },
                }),
                href: HREF,
            },
        });
        expect(within(rowFor('Web vs. limit')).getByText('62 %')).toBeTruthy();
        expect(screen.queryByText(/peak/)).toBeNull();
    });
});

it('resource pressure is visible in words while service availability remains green', () => {
    render(ClusterGlanceTile, {
        glance: glance({
            level: 'warn',
            container: {
                role: 'worker',
                ratio: 0.92,
                usedBytes: 920,
                limitBytes: 1000,
                level: 'warn',
            },
        }),
        href: HREF,
    });
    expect(screen.getByText(/Worker vs. limit: Memory near its limit/)).toBeTruthy();
    expect(screen.getByTestId('cluster-glance-availability').className).toContain('text-green-300');
    expect(tileLink(OPEN).getAttribute('aria-describedby')).toBeTruthy();
});

it('GPU scope, value and host attribution are visible without hovering', () => {
    render(ClusterGlanceTile, {
        glance: glance({
            gpu: {
                inUse: 2,
                videoPercent: 55,
                videoScope: 'lumastra',
                host: 'media-b',
                level: 'ok',
            },
        }),
        href: HREF,
    });
    const gpu = screen.getByTestId('cluster-glance-gpu');
    expect(gpu.textContent).toContain('media-b');
    expect(gpu.textContent).toContain('Lumastra FFmpeg video engine');
    expect(gpu.textContent).toContain('55 %');
    expect(gpu.textContent).toContain('2 FFmpeg on the GPU');
});

it('a GPU without an engine sample says not measured and draws no activity meter', () => {
    render(ClusterGlanceTile, { glance: glance({ gpu: { inUse: 0, level: 'ok' } }), href: HREF });
    const gpu = screen.getByTestId('cluster-glance-gpu');
    expect(gpu.textContent).toContain('Not measured');
    expect(within(gpu).queryByRole('meter')).toBeNull();
});

it('labels host encoder and host-wide utilization as separate visible, bounded measurements', () => {
    render(ClusterGlanceTile, {
        glance: glance({
            gpu: {
                inUse: 2,
                max: 10,
                videoPercent: 140,
                videoScope: 'host',
                utilizationPercent: 63,
                level: 'warn',
            },
        }),
        href: HREF,
    });
    const gpu = screen.getByTestId('cluster-glance-gpu');
    expect(within(gpu).getByText('Host GPU encoder')).toBeTruthy();
    expect(within(gpu).getByText('100 %')).toBeTruthy();
    expect(within(gpu).getByText('Host GPU utilization')).toBeTruthy();
    expect(within(gpu).getByText('63 %')).toBeTruthy();
    expect(
        within(gpu).getByRole('meter', { name: 'Host GPU encoder' }).getAttribute('aria-valuenow'),
    ).toBe('100');
    expect(
        within(gpu)
            .getByRole('meter', { name: 'Host GPU utilization' })
            .getAttribute('aria-valuenow'),
    ).toBe('63');
    expect(screen.getByText('At least one GPU has reached its encoder session limit')).toBeTruthy();
    expect(gpu.textContent).toContain('2 / 10 encode sessions');
});
