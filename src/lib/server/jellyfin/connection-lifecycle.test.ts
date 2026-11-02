// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin settings changed while a process runs (audit 2026-10-14).
 *
 * Before connection-lifecycle.ts the connection state, the verify function and
 * the sessions mirror were set up at boot only, and only the SAVING process
 * reset the API client. A URL + API key saved after an unconfigured boot left
 * every process `not_configured` (canCallJellyfin() false, admin Reconnect a
 * no-op), and a process that only RELOADED the settings (the worker, other
 * replicas) kept a client latched on "not configured" until restart.
 *
 * Asserted at the seam: the REAL config service (settings.json reload = the
 * worker / other-replica path; saveConfig = the saving process), the real
 * connection status, runtime gate and API client. Only the filesystem, the
 * Jellyfin HTTP transport and the sessions mirror are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ json: {} as Record<string, unknown> }));
const jf = vi.hoisted(() => ({
    up: true,
    calls: [] as Array<{ url: string; token: string | undefined }>,
    /** Per-URL gate: a verify against that URL waits until the promise settles. */
    hold: new Map<string, Promise<void>>(),
}));
const mirror = vi.hoisted(() => ({ start: 0, stop: 0, failStop: false }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify(files.json)),
    };
});
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        readFile: vi.fn(async () => JSON.stringify(files.json)),
        writeFile: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
    };
});
vi.mock('$env/dynamic/private', () => {
    throw new Error('not in SvelteKit');
});
vi.mock('$lib/server/cache/valkey.js', () => ({ getValkeyClient: () => null }));

vi.mock('../services/sessions-cache.service.js', () => ({
    sessionsCacheService: {
        startCaching: () => {
            mirror.start++;
        },
        stopCaching: () => {
            mirror.stop++;
            if (mirror.failStop) throw new Error('mirror stop failed');
        },
    },
}));

vi.mock('@jellyfin/sdk', () => ({
    Jellyfin: class {
        createApi(url: string, accessToken?: string) {
            return {
                basePath: url,
                accessToken,
                axiosInstance: {
                    interceptors: { request: { use() {} }, response: { use() {} } },
                    get: async () => {
                        jf.calls.push({ url, token: accessToken });
                        const held = jf.hold.get(url);
                        if (held) await held;
                        if (!jf.up) throw new Error('connect ECONNREFUSED');
                        return { data: { ServerName: 'Living room', Version: '10.11.0' } };
                    },
                },
            };
        }
    },
}));

import { initConfigServiceSync, reloadConfig, saveConfig } from '../config/config.service.js';
import { connectionStatus } from '../services/connection-status.service.js';
import { canCallJellyfin } from './runtime-gate.js';
import { jellyfinAuthService } from './auth.service.js';
import { resetJellyfinApi } from './base-client.js';
import {
    reconnectJellyfin,
    resetJellyfinConnectionLifecycleForTests,
    startJellyfinConnectionLifecycle,
    stopJellyfinConnectionLifecycle,
} from './connection-lifecycle.js';

const CREDS = { JELLYFINURL: 'http://jf.lan:8096', JELLYFINAPIKEY: 'k-1' };

/** Let the fire-and-forget apply triggered by a config notification settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function bootUnconfigured(): Promise<void> {
    files.json = {};
    initConfigServiceSync({});
    await startJellyfinConnectionLifecycle();
    // Something in this process touched the client while unconfigured, which
    // latches "not configured" in base-client (the worker case in the audit).
    await expect(jellyfinAuthService.verifyConnection()).rejects.toThrow('not configured');
}

beforeEach(() => {
    jf.up = true;
    jf.calls = [];
    jf.hold.clear();
    mirror.start = 0;
    mirror.stop = 0;
    mirror.failStop = false;
    resetJellyfinConnectionLifecycleForTests();
    connectionStatus.stopJellyfinRetry();
    connectionStatus.setNotConfigured('jellyfin');
    resetJellyfinApi();
});

afterEach(() => {
    connectionStatus.stopJellyfinRetry();
    vi.useRealTimers();
});

describe('Jellyfin settings saved after an unconfigured boot', () => {
    it('a process that only RELOADS settings (worker, other replica) connects', async () => {
        await bootUnconfigured();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('not_configured');
        expect(mirror.start).toBe(0);

        // Another process saved the credentials; this one gets the reload.
        files.json = { ...CREDS };
        await reloadConfig();
        await settle();

        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
        expect(canCallJellyfin()).toBe(true);
        expect(mirror.start).toBe(1);
        // The latched client was rebuilt from the new settings.
        expect(jf.calls.at(-1)).toEqual({ url: CREDS.JELLYFINURL, token: CREDS.JELLYFINAPIKEY });
    });

    it('the saving process connects too', async () => {
        await bootUnconfigured();
        await saveConfig({ ...CREDS });
        await settle();

        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
        expect(canCallJellyfin()).toBe(true);
    });

    it('admin Reconnect re-reads settings this process never received, and checks once', async () => {
        await bootUnconfigured();
        // Another process saved the creds; the reload broadcast never arrived here.
        files.json = { ...CREDS };
        const calls = jf.calls.length;

        expect(await reconnectJellyfin()).toBe(true);
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
        expect(canCallJellyfin()).toBe(true);
        expect(jf.calls.length).toBe(calls + 1);
    });

    it('admin Reconnect on an unchanged connection forces one fresh check', async () => {
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        const calls = jf.calls.length;

        expect(await reconnectJellyfin()).toBe(true);
        expect(jf.calls.length).toBe(calls + 1);
    });

    it('Reconnect reports "not configured" while Jellyfin is still not configured', async () => {
        await bootUnconfigured();
        expect(await reconnectJellyfin()).toBeNull();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('not_configured');
    });
});

describe('Jellyfin settings changed or removed later', () => {
    it('a new URL re-verifies against the new server', async () => {
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');

        files.json = { ...CREDS, JELLYFINURL: 'http://jf2.lan:8096' };
        await reloadConfig();
        await settle();

        expect(jf.calls.at(-1)?.url).toBe('http://jf2.lan:8096');
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
    });

    it('clearing the settings closes the gate and stops the mirror', async () => {
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(canCallJellyfin()).toBe(true);
        const stopsBefore = mirror.stop;

        files.json = {};
        await reloadConfig();
        await settle();

        expect(connectionStatus.getStatus('jellyfin').state).toBe('not_configured');
        expect(canCallJellyfin()).toBe(false);
        expect(mirror.stop).toBeGreaterThan(stopsBefore);
    });

    it('turning watch sync off stops the mirror; back on restarts it', async () => {
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        const calls = jf.calls.length;
        const starts = mirror.start;
        const stops = mirror.stop;

        files.json = { ...CREDS, FEATURE_JELLYFIN_SYNC: false };
        await reloadConfig();
        await settle();
        expect(canCallJellyfin()).toBe(false);
        expect(mirror.stop).toBe(stops + 1);

        files.json = { ...CREDS };
        await reloadConfig();
        await settle();
        expect(canCallJellyfin()).toBe(true);
        expect(mirror.start).toBe(starts + 1);
        // Only the switch moved: no re-verify.
        expect(jf.calls.length).toBe(calls);
    });

    it('an unrelated setting change does not touch Jellyfin', async () => {
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        const calls = jf.calls.length;
        const starts = mirror.start;

        files.json = { ...CREDS, TMDB_LANGUAGE: 'de-DE' };
        await reloadConfig();
        await settle();

        expect(jf.calls.length).toBe(calls);
        expect(mirror.start).toBe(starts);
    });
});

describe('Jellyfin unreachable when the settings arrive', () => {
    it('retries on its own and starts the mirror once it recovers', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        jf.up = false;
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('disconnected');
        expect(mirror.start).toBe(0);

        jf.up = true;
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
        expect(canCallJellyfin()).toBe(true);
        expect(mirror.start).toBe(1);
    });
});

describe('races between a running check and a settings change', () => {
    it('a slow check of the OLD server cannot overwrite the new state', async () => {
        let releaseOld!: () => void;
        jf.hold.set(CREDS.JELLYFINURL, new Promise<void>((r) => (releaseOld = r)));
        jf.up = false; // the old server's answer, once released, is a failure
        files.json = { ...CREDS };
        initConfigServiceSync({});
        const boot = startJellyfinConnectionLifecycle();
        await settle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connecting');

        // The admin points at a working server while the old check hangs.
        jf.up = true;
        files.json = { ...CREDS, JELLYFINURL: 'http://jf2.lan:8096' };
        await reloadConfig();
        await settle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');

        jf.up = false;
        releaseOld();
        await boot;
        await settle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
    });

    it('a slow check that succeeds after the settings were removed stays not_configured', async () => {
        let release!: () => void;
        jf.hold.set(CREDS.JELLYFINURL, new Promise<void>((r) => (release = r)));
        files.json = { ...CREDS };
        initConfigServiceSync({});
        const boot = startJellyfinConnectionLifecycle();
        await settle();

        files.json = {};
        await reloadConfig();
        await settle();
        release();
        await boot;
        await settle();

        expect(connectionStatus.getStatus('jellyfin').state).toBe('not_configured');
        expect(mirror.start).toBe(0);
    });

    it('an automatic retry in flight when the settings are removed is dropped', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        jf.up = false;
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('disconnected');

        // The retry fires and hangs on the old server.
        let release!: () => void;
        jf.hold.set(CREDS.JELLYFINURL, new Promise<void>((r) => (release = r)));
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connecting');

        files.json = {};
        await reloadConfig();
        await vi.advanceTimersByTimeAsync(0);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(connectionStatus.getStatus('jellyfin').state).toBe('not_configured');

        // ...and nothing keeps probing the removed server.
        const calls = jf.calls.length;
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(jf.calls.length).toBe(calls);
    });

    it('a failed check schedules ONE retry chain, not two', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        jf.up = false;
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(jf.calls.length).toBe(1);

        // First retry after 45 s (30 s × 1.5); a duplicated chain would double up.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(jf.calls.length).toBe(2);
        await vi.advanceTimersByTimeAsync(68_000);
        expect(jf.calls.length).toBe(3);
    });
});

describe('watch sync off means no background traffic', () => {
    it('stops retrying an unreachable server when sync is turned off, reconnects when on again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        jf.up = false;
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        expect(connectionStatus.getStatus('jellyfin').state).toBe('disconnected');

        files.json = { ...CREDS, FEATURE_JELLYFIN_SYNC: false };
        await reloadConfig();
        await vi.advanceTimersByTimeAsync(0);
        const calls = jf.calls.length;
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(jf.calls.length).toBe(calls);

        jf.up = true;
        files.json = { ...CREDS };
        await reloadConfig();
        await vi.advanceTimersByTimeAsync(0);
        expect(connectionStatus.getStatus('jellyfin').state).toBe('connected');
        expect(canCallJellyfin()).toBe(true);
        expect(mirror.start).toBe(1);
    });
});

describe('connectionStatus.forceJellyfinReconnect recovery callback', () => {
    it.each(['connecting', 'disconnected', 'not_configured'] as const)(
        'runs the callback when the previous state was %s',
        async (state) => {
            const onConnected = vi.fn();
            connectionStatus.registerJellyfinVerifyFn(
                async () => ({ serverName: 's', version: 'v' }),
                onConnected,
            );
            if (state === 'connecting') connectionStatus.setConnecting('jellyfin');
            if (state === 'disconnected') {
                connectionStatus.setDisconnected('jellyfin', 'x');
                connectionStatus.stopJellyfinRetry();
            }
            if (state === 'not_configured') connectionStatus.setNotConfigured('jellyfin');

            expect(await connectionStatus.forceJellyfinReconnect()).toBe(true);
            expect(onConnected).toHaveBeenCalledTimes(1);
        },
    );

    it('does not run it when already connected', async () => {
        const onConnected = vi.fn();
        connectionStatus.registerJellyfinVerifyFn(
            async () => ({ serverName: 's', version: 'v' }),
            onConnected,
        );
        connectionStatus.setConnected('jellyfin');
        expect(await connectionStatus.forceJellyfinReconnect()).toBe(true);
        expect(onConnected).not.toHaveBeenCalled();
    });
});

describe('terminal Jellyfin lifecycle stop', () => {
    it('unsubscribes config, waits for superseded checks and prevents late mirror restarts', async () => {
        await bootUnconfigured();
        let releaseOld: () => void = () => {};
        let releaseNew: () => void = () => {};
        jf.hold.set(
            CREDS.JELLYFINURL,
            new Promise<void>((resolve) => {
                releaseOld = resolve;
            }),
        );
        const newUrl = 'http://jf-new.lan:8096';
        jf.hold.set(
            newUrl,
            new Promise<void>((resolve) => {
                releaseNew = resolve;
            }),
        );
        files.json = { ...CREDS };
        await reloadConfig();
        await settle();
        files.json = { ...CREDS, JELLYFINURL: newUrl };
        await reloadConfig();
        await settle();
        expect(jf.calls).toHaveLength(2);
        let settled = false;
        const stopping = stopJellyfinConnectionLifecycle().then(() => {
            settled = true;
        });
        const starts = mirror.start;
        files.json = { ...CREDS, JELLYFINURL: 'http://jf-after-stop.lan:8096' };
        await reloadConfig();
        await settle();
        expect(jf.calls).toHaveLength(2);
        releaseNew();
        await settle();
        expect(settled).toBe(false);
        releaseOld();
        await stopping;
        expect(mirror.start).toBe(starts);
        expect(await connectionStatus.forceJellyfinReconnect()).toBe(false);
        await expect(startJellyfinConnectionLifecycle()).rejects.toThrow('stopping');
        expect(jf.calls).toHaveLength(2);
    });

    it('invalidates an automatic retry already in flight and drains its verification', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        jf.up = false;
        files.json = { ...CREDS };
        initConfigServiceSync({});
        await startJellyfinConnectionLifecycle();
        let release: () => void = () => {};
        jf.hold.set(
            CREDS.JELLYFINURL,
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        );
        await vi.advanceTimersByTimeAsync(45_000);
        expect(jf.calls).toHaveLength(2);
        const stopping = stopJellyfinConnectionLifecycle();
        jf.up = true;
        release();
        await stopping;
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(jf.calls).toHaveLength(2);
        expect(mirror.start).toBe(0);
        expect(await connectionStatus.forceJellyfinReconnect()).toBe(false);
    });

    it('preserves independent unsubscribe and retry teardown when mirror stop fails, then retries', async () => {
        await bootUnconfigured();
        mirror.failStop = true;
        await expect(stopJellyfinConnectionLifecycle()).rejects.toThrow('cleanup incomplete');
        files.json = { ...CREDS };
        await reloadConfig();
        await settle();
        expect(jf.calls).toHaveLength(0);
        expect(await connectionStatus.forceJellyfinReconnect()).toBe(false);
        mirror.failStop = false;
        await stopJellyfinConnectionLifecycle();
        expect(mirror.stop).toBeGreaterThan(1);
    });
});
