// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /setup install overview. The page is served before any admin exists, so
 * the properties that matter are: bounded work per page load (cached probes,
 * timeouts, no blocking module check), robustness against odd heartbeats from
 * other builds, and the trusted-context gate on WHERE things are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    sonicUrl: '',
    liveTvUrl: '',
    liveTvSource: 'standalone',
    split: false,
    valkeyTasks: vi.fn(),
    peek: null as boolean | null,
    gpu: 'none',
    fetch: vi.fn(),
    valkey: vi.fn(),
    nodes: vi.fn(),
    configStatus: vi.fn(),
    dbVersions: vi.fn(),
    caps: vi.fn(),
    posture: 'fail-closed' as 'allowlist' | 'trust-any' | 'fail-closed',
    peerTrusted: false,
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        get SONIC_EMBEDDER_URL() {
            return h.sonicUrl;
        },
        get GPU_ACCELERATION() {
            return h.gpu;
        },
        get STREAM_PROXY_URL() {
            return h.liveTvUrl;
        },
        get LIVETV_SOURCE() {
            return h.liveTvSource;
        },
        STREAM_PROXY_SECRET: 's3cret',
        INSTANCE_ID: 'web-1',
    },
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    getConfigStorageStatus: h.configStatus,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyHealthy: h.valkey,
    isCoordinationValkeyHealthy: h.valkeyTasks,
    hasSeparateCoordinationValkey: () => h.split,
}));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', async (importOriginal) => ({
    hasMasterKeyDivergence: (
        await importOriginal<typeof import('$lib/server/services/cluster-heartbeat.service.js')>()
    ).hasMasterKeyDivergence,
    readClusterNodes: h.nodes,
}));
vi.mock('$lib/server/services/sonic-embedding.service.js', () => ({
    peekSonicEngineConfigured: () => h.peek,
}));
vi.mock('$lib/server/services/transcoding/hardware-detection.js', () => ({
    hardwareDetection: { getCapabilities: h.caps },
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getDatabaseVersions: h.dbVersions,
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: h.fetch }));
vi.mock('$lib/server/utils/client-ip.js', () => ({
    forwardAuthTrustPosture: () => h.posture,
    isForwardedHeaderPeerTrusted: () => h.peerTrusted,
}));

import {
    buildSetupEnvironment,
    buildSetupEnvironmentDetails,
    parseMountinfo,
    resetSetupEnvironmentCachesForTests,
    setupProxyState,
    toSetupNodes,
} from './setup-environment.js';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';

const input = {
    proxy: 'direct' as const,
    https: false,
    trustedContext: false,
    sql: {} as never,
    embeddingDimension: 1024,
};

function node(overrides: Partial<LiveClusterNode> = {}): LiveClusterNode {
    return {
        instanceId: 'web-1',
        role: 'web',
        version: '1.0.0',
        hostname: 'h',
        startedAt: '2026-10-12T00:00:00Z',
        uptimeSeconds: 60,
        keyFingerprint: 'k1',
        ...overrides,
    };
}

beforeEach(() => {
    resetSetupEnvironmentCachesForTests();
    h.sonicUrl = '';
    h.liveTvUrl = '';
    h.liveTvSource = 'standalone';
    h.split = false;
    h.valkeyTasks.mockReset().mockResolvedValue(true);
    h.peek = false;
    h.gpu = 'none';
    h.posture = 'fail-closed';
    h.peerTrusted = false;
    h.fetch.mockReset();
    h.valkey.mockReset().mockResolvedValue(true);
    h.nodes.mockReset().mockResolvedValue([]);
    h.configStatus.mockReset().mockResolvedValue({
        path: '/config/settings.json',
        directoryExists: true,
        isWritable: true,
        isMounted: true,
        willPersist: true,
        message: '',
    });
    h.dbVersions.mockReset().mockResolvedValue({ postgres: '18.1', pgvector: '0.8.0' });
    h.caps.mockReset().mockResolvedValue({ ffmpegVersion: '7.1', hwaccels: ['vaapi', 'cuda'] });
});
afterEach(() => {
    vi.useRealTimers();
});

describe('sonic embedder', () => {
    it('absent when neither a sidecar nor the subprocess files are there', async () => {
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('absent');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('subprocess when installed, also while the module check has not run (null)', async () => {
        h.peek = null;
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('subprocess');
        h.peek = true;
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('subprocess');
    });

    it('ready when /health answers 2xx; credentials and query never reach the probe URL', async () => {
        h.sonicUrl = 'http://user:pw@sonic:8000/?x=1';
        h.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('ready');
        expect(h.fetch.mock.calls[0][0]).toBe('http://sonic:8000/health');
    });

    it('unreachable on a non-2xx, a network error or an unparsable URL', async () => {
        h.sonicUrl = 'http://sonic:8000';
        h.fetch.mockResolvedValue(new Response('', { status: 503 }));
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('unreachable');

        resetSetupEnvironmentCachesForTests();
        h.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('unreachable');

        resetSetupEnvironmentCachesForTests();
        h.fetch.mockClear();
        h.sonicUrl = 'sonic:8000 not a url';
        expect((await buildSetupEnvironment(input)).services.sonic).toBe('unreachable');
    });

    it('one probe serves page loads for 30 s when ready, then probes again', async () => {
        vi.useFakeTimers();
        h.sonicUrl = 'http://sonic:8000';
        h.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
        await buildSetupEnvironment(input);
        vi.advanceTimersByTime(29_999);
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2);
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('a down sidecar is re-asked after 5 s (it may still be loading its model)', async () => {
        vi.useFakeTimers();
        h.sonicUrl = 'http://sonic:8000';
        h.fetch.mockResolvedValue(new Response('', { status: 503 }));
        await buildSetupEnvironment(input);
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_001);
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('concurrent page loads share one probe; a changed URL probes again', async () => {
        h.sonicUrl = 'http://sonic:8000';
        let release: (r: Response) => void = () => undefined;
        h.fetch.mockReturnValue(new Promise<Response>((r) => (release = r)));
        const both = Promise.all([buildSetupEnvironment(input), buildSetupEnvironment(input)]);
        release(new Response('ok', { status: 200 }));
        await both;
        expect(h.fetch).toHaveBeenCalledTimes(1);

        h.sonicUrl = 'http://other:8000';
        h.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });
});

describe('cluster read', () => {
    it('Valkey down: valkey false, no nodes, no crash', async () => {
        h.valkey.mockRejectedValue(new Error('down'));
        h.nodes.mockRejectedValue(new Error('down'));
        const env = await buildSetupEnvironment(input);
        expect(env.services.valkey).toBe(false);
        expect(env.nodes).toEqual([]);
    });

    it('a hanging heartbeat SCAN is cut off instead of holding the page', async () => {
        vi.useFakeTimers();
        h.nodes.mockReturnValue(new Promise(() => undefined));
        const pending = buildSetupEnvironment(input);
        await vi.advanceTimersByTimeAsync(1_600);
        expect((await pending).nodes).toEqual([]);
    });

    it('is shared by page loads for 5 s', async () => {
        vi.useFakeTimers();
        await buildSetupEnvironment(input);
        await buildSetupEnvironment(input);
        expect(h.nodes).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_001);
        await buildSetupEnvironment(input);
        expect(h.nodes).toHaveBeenCalledTimes(2);
    });
});

describe('toSetupNodes', () => {
    it('puts this node first, then by role and name', () => {
        const nodes = toSetupNodes(
            [
                node({ instanceId: 'worker-1', role: 'worker' }),
                node({ instanceId: 'web-2' }),
                node({ instanceId: 'web-1' }),
            ],
            'web-1',
            false,
        );
        expect(nodes.map((n) => n.instanceId)).toEqual(['web-1', 'web-2', 'worker-1']);
        expect(nodes[0].self).toBe(true);
    });

    it('survives heartbeats from other builds: no id, duplicate id, missing fields', () => {
        const odd = [
            node({ instanceId: undefined as never }),
            node({ instanceId: 'a', version: undefined as never, uptimeSeconds: Number.NaN }),
            node({ instanceId: 'a', version: '2.0.0' }),
            node({ instanceId: 'b', role: 'x' as never, uptimeSeconds: -5 }),
        ];
        const nodes = toSetupNodes(odd, 'self', false);
        // The unknown role falls back to 'general', which sorts before 'web'.
        expect(nodes.map((n) => n.instanceId)).toEqual(['b', 'a']);
        expect(nodes[1]).toMatchObject({ version: '', uptimeSeconds: 0 });
        expect(nodes[0]).toMatchObject({ role: 'general', uptimeSeconds: 0 });
    });

    it('caps over-long strings from a heartbeat', () => {
        const [n] = toSetupNodes([node({ version: 'v'.repeat(500) })], 'web-1', false);
        expect(n.version).toHaveLength(64);
    });

    it('node placement only in a trusted context; limits always', () => {
        const live = [
            node({
                placement: { nodeName: 'k3s-a' },
                resources: { memoryUsedBytes: 1, memoryLimitBytes: 2 ** 31, cpuLimitCores: 2 },
            }),
        ];
        expect(toSetupNodes(live, 'web-1', false)[0]).toMatchObject({
            host: undefined,
            memoryLimitBytes: 2 ** 31,
            cpuLimitCores: 2,
        });
        expect(toSetupNodes(live, 'web-1', true)[0].host).toBe('k3s-a');
    });
});

describe('cluster warnings', () => {
    it('different versions and different master keys', async () => {
        h.nodes.mockResolvedValue([
            node({ instanceId: 'web-1', version: '1.0.0', keyFingerprint: 'k1' }),
            node({ instanceId: 'web-2', version: '1.1.0', keyFingerprint: 'k2' }),
        ]);
        expect((await buildSetupEnvironment(input)).cluster).toEqual({
            versionMismatch: true,
            keyMismatch: true,
            noWorker: true,
        });
    });

    it('a combined node or a worker means background tasks run', async () => {
        h.nodes.mockResolvedValue([node({ role: 'general' })]);
        expect((await buildSetupEnvironment(input)).cluster.noWorker).toBe(false);
        resetSetupEnvironmentCachesForTests();
        h.nodes.mockResolvedValue([node(), node({ instanceId: 'w', role: 'worker' })]);
        expect((await buildSetupEnvironment(input)).cluster.noWorker).toBe(false);
    });

    it('no nodes: no warnings (the empty list says it)', async () => {
        expect((await buildSetupEnvironment(input)).cluster).toEqual({
            versionMismatch: false,
            keyMismatch: false,
            noWorker: false,
        });
    });
});

describe('services, database and storage', () => {
    it('maps an unknown GPU_ACCELERATION value to other', async () => {
        h.gpu = '__proto__';
        expect((await buildSetupEnvironment(input)).services.gpu).toBe('other');
        h.gpu = 'VAAPI';
        expect((await buildSetupEnvironment(input)).services.gpu).toBe('vaapi');
    });

    it('database versions, and a failed read degrades to unknown', async () => {
        expect((await buildSetupEnvironment(input)).database).toEqual({
            postgres: '18.1',
            pgvector: '0.8.0',
            dimension: 1024,
        });
        h.dbVersions.mockRejectedValue(new Error('boom'));
        expect((await buildSetupEnvironment(input)).database).toMatchObject({
            postgres: null,
            pgvector: null,
        });
    });

    it('config volume state, with the path only in a trusted context', async () => {
        const env = await buildSetupEnvironment(input);
        expect(env.storage).toEqual({ config: 'ok', configPath: undefined, mounts: undefined });
        expect(
            (await buildSetupEnvironment({ ...input, trustedContext: true })).storage.configPath,
        ).toBe('/config');

        h.configStatus.mockResolvedValue({
            path: '/config/settings.json',
            directoryExists: true,
            isWritable: true,
            isMounted: false,
        });
        expect((await buildSetupEnvironment(input)).storage.config).toBe('not-mounted');
        h.configStatus.mockResolvedValue({
            path: '/c/s.json',
            directoryExists: true,
            isWritable: false,
        });
        expect((await buildSetupEnvironment(input)).storage.config).toBe('not-writable');
        h.configStatus.mockRejectedValue(new Error('eacces'));
        expect((await buildSetupEnvironment(input)).storage.config).toBe('missing');
    });
});

describe('parseMountinfo', () => {
    const line = (mount: string, fs: string): string =>
        `36 35 98:0 / ${mount} rw,noatime master:1 - ${fs} /dev/x rw`;

    it('keeps data mounts, drops system and runtime mounts, unescapes spaces', () => {
        const text = [
            line('/', 'overlay'),
            line('/proc', 'proc'),
            line('/etc/hosts', 'ext4'),
            line('/run/secrets/kubernetes.io/serviceaccount', 'tmpfs'),
            line('/var/run/secrets/x', 'ext4'),
            line('/dev/shm', 'tmpfs'),
            line('/data/movies', 'nfs4'),
            line('/config', 'ext4'),
            line('/media/My\\040Shows', 'cifs'),
            line('/data/movies', 'nfs4'),
            'garbage line',
        ].join('\n');
        expect(parseMountinfo(text)).toEqual(['/config', '/data/movies', '/media/My Shows']);
    });
});

describe('setupProxyState', () => {
    const event = (headers: Record<string, string> = {}) => ({
        request: new Request('http://app/setup', { headers }),
        getClientAddress: () => '10.0.0.2',
    });

    it('direct without forwarding headers', () => {
        expect(setupProxyState(event())).toBe('direct');
    });

    it('headers without TRUSTED_PROXY_IPS: anyone could send them', () => {
        h.posture = 'trust-any';
        expect(setupProxyState(event({ 'x-forwarded-for': '1.2.3.4' }))).toBe('proxy-unpinned');
        h.posture = 'fail-closed';
        expect(setupProxyState(event({ 'x-forwarded-proto': 'https' }))).toBe('proxy-unpinned');
    });

    it('with TRUSTED_PROXY_IPS: listed peer is the proxy, anyone else is ignored', () => {
        h.posture = 'allowlist';
        h.peerTrusted = true;
        expect(setupProxyState(event({ 'x-forwarded-for': '1.2.3.4' }))).toBe('proxy');
        h.peerTrusted = false;
        expect(setupProxyState(event({ 'x-forwarded-for': '1.2.3.4' }))).toBe('proxy-untrusted');
    });
});

describe('buildSetupEnvironmentDetails', () => {
    it('ffmpeg version and hardware accelerators', async () => {
        expect(await buildSetupEnvironmentDetails()).toEqual({
            ffmpeg: { version: '7.1', hwaccels: ['cuda', 'vaapi'] },
        });
    });

    it('ffmpeg missing reads as null: the probe reports it as version "unknown", not an error', async () => {
        h.caps.mockResolvedValue({ ffmpegVersion: 'unknown', hwaccels: [], detected: false });
        expect(await buildSetupEnvironmentDetails()).toEqual({ ffmpeg: null });
        h.caps.mockRejectedValue(new Error('ENOENT'));
        expect(await buildSetupEnvironmentDetails()).toEqual({ ffmpeg: null });
    });

    it('a first probe slower than 10 s reads as pending, not missing', async () => {
        vi.useFakeTimers();
        h.caps.mockReturnValue(new Promise(() => undefined));
        const pending = buildSetupEnvironmentDetails();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await pending).toEqual({ ffmpeg: null, ffmpegPending: true });
    });
});

describe('Live TV stream proxy', () => {
    it('absent without STREAM_PROXY_URL or with Live TV disabled', async () => {
        expect((await buildSetupEnvironment(input)).services.liveTvProxy).toBe('absent');
        h.liveTvUrl = 'http://proxy:3000';
        h.liveTvSource = 'disabled';
        expect((await buildSetupEnvironment(input)).services.liveTvProxy).toBe('absent');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('probes /status with the shared secret, cached separately from the sonic sidecar', async () => {
        h.liveTvUrl = 'http://proxy:3000';
        h.sonicUrl = 'http://sonic:8000';
        h.fetch.mockImplementation(async (url: string) =>
            url.endsWith('/status') ? new Response('ok') : new Response('', { status: 503 }),
        );
        const env = await buildSetupEnvironment(input);
        expect(env.services.liveTvProxy).toBe('ready');
        expect(env.services.sonic).toBe('unreachable');
        const call = h.fetch.mock.calls.find((c) => String(c[0]).endsWith('/status'));
        expect(call?.[0]).toBe('http://proxy:3000/status');
        expect(call?.[1]).toMatchObject({
            headers: { 'X-Proxy-Secret': 's3cret' },
            redirect: 'manual',
        });
        await buildSetupEnvironment(input);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });
});

describe('sidecar redirects', () => {
    it('a sidecar answering with a redirect counts as unreachable', async () => {
        h.liveTvUrl = 'http://proxy:3000';
        h.fetch.mockResolvedValue(
            new Response(null, { status: 302, headers: { Location: 'http://elsewhere/' } }),
        );
        expect((await buildSetupEnvironment(input)).services.liveTvProxy).toBe('unreachable');
    });
});

describe('Valkey instances', () => {
    it('one instance: no separate task row', async () => {
        const env = await buildSetupEnvironment(input);
        expect(env.services.valkey).toBe(true);
        expect('valkeyTasks' in env.services).toBe(false);
        expect(h.valkeyTasks).not.toHaveBeenCalled();
    });

    it('TASK_CACHE_URL split: the task instance is pinged on its own', async () => {
        h.split = true;
        h.valkeyTasks.mockResolvedValue(false);
        const env = await buildSetupEnvironment(input);
        expect(env.services).toMatchObject({ valkey: true, valkeyTasks: false });
    });
});

describe('Recheck (fresh)', () => {
    it('bypasses the probe caches, at most once per 3 s across all visitors', async () => {
        vi.useFakeTimers();
        h.sonicUrl = 'http://sonic:8000';
        h.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
        await buildSetupEnvironment(input); // fills the caches
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.nodes).toHaveBeenCalledTimes(1);

        await buildSetupEnvironment({ ...input, fresh: true });
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.nodes).toHaveBeenCalledTimes(2);

        // A second Recheck within 3 s is served from the caches.
        vi.advanceTimersByTime(1_000);
        await buildSetupEnvironment({ ...input, fresh: true });
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(h.nodes).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(2_001);
        await buildSetupEnvironment({ ...input, fresh: true });
        expect(h.fetch).toHaveBeenCalledTimes(3);
    });
});
