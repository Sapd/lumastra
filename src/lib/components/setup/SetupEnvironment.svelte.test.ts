// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The install overview greys out what is absent (with a setup link), flags what
 * is configured but broken, lists the live nodes with this replica marked,
 * fills in the streamed half when it arrives, and copies a text summary.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    SetupEnvironment as Env,
    SetupEnvironmentDetails,
} from '$lib/shared/setup-environment';

const { toasts } = vi.hoisted(() => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import SetupEnvironment from './SetupEnvironment.svelte';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function env(overrides: Partial<Env> = {}): Env {
    return {
        services: {
            valkey: true,
            sonic: 'absent',
            liveTvProxy: 'absent',
            gpu: 'none',
            gpuDevice: false,
        },
        database: { postgres: '18.1', pgvector: '0.8.0', dimension: 1024 },
        storage: { config: 'ok' },
        nodes: [],
        cluster: { versionMismatch: false, keyMismatch: false, noWorker: false },
        network: { proxy: 'direct', https: false, platform: 'docker' },
        ...overrides,
    };
}

const cls = (el: HTMLElement): string => el.className;

describe('SetupEnvironment', () => {
    it('greys out absent services with a setup link, marks present ones without one', () => {
        const { getByTestId } = render(SetupEnvironment, { props: { environment: env() } });
        const sonic = getByTestId('setup-env-sonic');
        expect(cls(sonic)).toContain('env-off');
        expect(sonic.querySelector('a')?.getAttribute('href')).toContain('#sonic-embedder-sidecar');
        expect(cls(getByTestId('setup-env-proxy'))).toContain('env-off');
        const valkey = getByTestId('setup-env-valkey');
        expect(cls(valkey)).toContain('env-on');
        expect(valkey.querySelector('a')).toBeNull();
        expect(getByTestId('setup-env-database').textContent).toContain('PostgreSQL 18.1');
        expect(getByTestId('setup-env-database').textContent).toContain('1024 dimensions');
    });

    it('shows a running sidecar and the GPU mode as on', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    services: {
                        valkey: true,
                        sonic: 'ready',
                        liveTvProxy: 'absent',
                        gpu: 'vaapi',
                        gpuDevice: true,
                    },
                }),
            },
        });
        expect(cls(getByTestId('setup-env-sonic'))).toContain('env-on');
        expect(getByTestId('setup-env-gpu').textContent).toContain('VAAPI');
    });

    it('points at the later GPU step when a GPU is visible but unused', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    services: {
                        valkey: true,
                        sonic: 'absent',
                        liveTvProxy: 'absent',
                        gpu: 'none',
                        gpuDevice: true,
                    },
                }),
            },
        });
        const gpu = getByTestId('setup-env-gpu');
        expect(gpu.textContent).toContain('A GPU is visible');
        expect(gpu.textContent).not.toContain('GPU_ACCELERATION');
        expect(cls(gpu)).toContain('env-off');
    });

    it('warns about proxies it cannot trust, a missing pgvector and a lost config volume', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    database: { postgres: '18.1', pgvector: null, dimension: null },
                    storage: { config: 'not-mounted' },
                    network: { proxy: 'proxy-unpinned', https: true, platform: 'kubernetes' },
                }),
            },
        });
        expect(cls(getByTestId('setup-env-proxy'))).toContain('env-warn');
        expect(getByTestId('setup-env-proxy').textContent).toContain('TRUSTED_PROXY_IPS');
        expect(getByTestId('setup-env-https').textContent).toContain('reported by the proxy');
        expect(cls(getByTestId('setup-env-database'))).toContain('env-warn');
        expect(cls(getByTestId('setup-env-config'))).toContain('env-warn');
        expect(getByTestId('setup-env-platform').textContent).toContain('Kubernetes');
    });

    it('a trusted view shows paths and mounts; an empty mount list warns', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({ storage: { config: 'ok', configPath: '/config', mounts: [] } }),
            },
        });
        expect(getByTestId('setup-env-config').textContent).toContain('/config');
        expect(cls(getByTestId('setup-env-mounts'))).toContain('env-warn');
    });

    it('lists the nodes, marks this replica and shows limits; no stray host', () => {
        const { getAllByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    nodes: [
                        {
                            instanceId: 'web-1',
                            role: 'web',
                            version: 'v1.2.3',
                            uptimeSeconds: 3700,
                            self: true,
                            host: 'k3s-a',
                            memoryLimitBytes: 2 * 1024 ** 3,
                            cpuLimitCores: 1.5,
                        },
                        {
                            instanceId: 'worker-1',
                            role: 'worker',
                            version: '1.2.3',
                            uptimeSeconds: 60,
                            self: false,
                        },
                    ],
                }),
            },
        });
        const nodes = getAllByTestId('setup-env-node');
        expect(nodes).toHaveLength(2);
        expect(nodes[0].textContent).toContain('this node');
        expect(nodes[0].textContent).toContain('k3s-a');
        expect(nodes[0].textContent).toContain('v1.2.3');
        expect(nodes[0].textContent).not.toContain('vv');
        expect(nodes[0].textContent).toContain('2.0 GB RAM');
        expect(nodes[0].textContent).toContain('1.5 CPU');
        expect(nodes[1].textContent).toContain('Worker');
        expect(nodes[1].textContent).not.toContain('this node');
        expect(nodes[1].textContent).not.toContain('k3s-a');
        expect(nodes[1].textContent).not.toContain('undefined');
    });

    it('says so when no node has reported', () => {
        const { queryAllByTestId, getByText } = render(SetupEnvironment, {
            props: { environment: env() },
        });
        expect(queryAllByTestId('setup-env-node')).toHaveLength(0);
        expect(getByText('No node has reported in yet.')).toBeTruthy();
    });

    it('shows the cluster warnings with links', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    cluster: { versionMismatch: true, keyMismatch: true, noWorker: true },
                }),
            },
        });
        expect(getByTestId('setup-env-key-mismatch').querySelector('a')).not.toBeNull();
        expect(getByTestId('setup-env-version-mismatch')).toBeTruthy();
        expect(getByTestId('setup-env-no-worker').textContent).toContain('worker');
    });

    it('fills in ffmpeg when the streamed part arrives', async () => {
        let resolve: (d: SetupEnvironmentDetails) => void = () => undefined;
        const details = new Promise<SetupEnvironmentDetails>((r) => (resolve = r));
        const { getByTestId, queryByTestId } = render(SetupEnvironment, {
            props: { environment: env(), details },
        });
        expect(getByTestId('setup-env-checking')).toBeTruthy();
        resolve({
            ffmpeg: { version: '7.1', hwaccels: ['vaapi'] },
        });
        await waitFor(() => expect(queryByTestId('setup-env-checking')).toBeNull());
        expect(getByTestId('setup-env-ffmpeg').textContent).toContain('vaapi');
    });

    it('Recheck calls back and is disabled while it runs', async () => {
        let done: () => void = () => undefined;
        const onrecheck = vi.fn(() => new Promise<void>((r) => (done = r)));
        const { getByRole } = render(SetupEnvironment, {
            props: { environment: env(), onrecheck },
        });
        const button = getByRole('button', { name: 'Recheck' }) as HTMLButtonElement;
        await fireEvent.click(button);
        expect(onrecheck).toHaveBeenCalledTimes(1);
        expect(button.disabled).toBe(true);
        done();
        await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('copies a plain-text summary', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const { getByRole } = render(SetupEnvironment, {
            props: {
                environment: env({
                    nodes: [
                        {
                            instanceId: 'web-1',
                            role: 'web',
                            version: '1.0.0',
                            uptimeSeconds: 60,
                            self: true,
                        },
                    ],
                }),
            },
        });
        await fireEvent.click(getByRole('button', { name: 'Copy as text' }));
        await waitFor(() => expect(writeText).toHaveBeenCalled());
        const text = (writeText.mock.calls[0] as unknown as [string])[0];
        expect(text).toContain('[ok] Valkey: Connected, one instance for cache and tasks');
        expect(text).toContain('[--] Music sound analysis');
        expect(text).toContain('web-1 (Web, this node)');
        expect(toasts.success).toHaveBeenCalled();
    });

    it('shows the cache and task Valkey instances separately when split', () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    services: {
                        valkey: true,
                        valkeyTasks: false,
                        sonic: 'absent',
                        liveTvProxy: 'absent',
                        gpu: 'none',
                        gpuDevice: false,
                    },
                }),
            },
        });
        expect(getByTestId('setup-env-valkey').textContent).toContain('Valkey (cache)');
        const tasks = getByTestId('setup-env-valkey-tasks');
        expect(tasks.textContent).toContain('Valkey (tasks)');
        expect(cls(tasks)).toContain('env-warn');
    });

    it('Live TV proxy: greyed out with a link when absent, warns when not answering', () => {
        const absent = render(SetupEnvironment, { props: { environment: env() } });
        const row = absent.getByTestId('setup-env-livetv');
        expect(cls(row)).toContain('env-off');
        expect(row.querySelector('a')?.getAttribute('href')).toContain('/live-tv/');
        absent.unmount();

        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env({
                    services: {
                        valkey: true,
                        sonic: 'absent',
                        liveTvProxy: 'unreachable',
                        gpu: 'none',
                        gpuDevice: false,
                    },
                }),
            },
        });
        expect(cls(getByTestId('setup-env-livetv'))).toContain('env-warn');
    });

    it('a slow first ffmpeg probe shows as still checking', async () => {
        const { getByTestId } = render(SetupEnvironment, {
            props: {
                environment: env(),
                details: Promise.resolve({ ffmpeg: null, ffmpegPending: true }),
            },
        });
        await waitFor(() =>
            expect(getByTestId('setup-env-ffmpeg').textContent).toContain('Still checking'),
        );
        expect(cls(getByTestId('setup-env-ffmpeg'))).toContain('env-off');
    });
});
