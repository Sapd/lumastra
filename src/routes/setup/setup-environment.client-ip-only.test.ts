// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /setup proxy state with the REAL client-ip module: a client-IP-only peer list
 * (CLIENT_IP_PROXY_IPS, the router hop) is not an identity pin, so forwarding headers stay
 * `proxy-unpinned`; only TRUSTED_PROXY_IPS makes a listed peer `proxy`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const KEYS = ['TRUSTED_PROXY_IPS', 'CLIENT_IP_PROXY_IPS', 'LUMASTRA_TRUST_ANY_PROXY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

async function state(env: Record<string, string>, headers: Record<string, string>) {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    vi.resetModules();
    const { setupProxyState } = await import('./setup-environment.js');
    return setupProxyState({
        request: new Request('http://app/setup', { headers }),
        getClientAddress: () => '10.42.0.11',
    });
}

describe('setupProxyState with the real client-ip module', () => {
    const fwd = { 'x-forwarded-for': '203.0.113.9' };

    it('CLIENT_IP_PROXY_IPS alone does not pin a proxy: proxy-unpinned', async () => {
        expect(await state({ CLIENT_IP_PROXY_IPS: '10.42.0.11' }, fwd)).toBe('proxy-unpinned');
    });

    it('TRUSTED_PROXY_IPS pins it: a listed peer is the proxy', async () => {
        expect(await state({ TRUSTED_PROXY_IPS: '10.42.0.11' }, fwd)).toBe('proxy');
    });

    it('TRUSTED_PROXY_IPS plus CLIENT_IP_PROXY_IPS: an unlisted-for-identity peer still follows the client list for headers', async () => {
        expect(
            await state({ TRUSTED_PROXY_IPS: '10.42.9.9', CLIENT_IP_PROXY_IPS: '10.42.0.11' }, fwd),
        ).toBe('proxy');
    });
});
