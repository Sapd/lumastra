// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API (FEATURE_DEVICE_AUTH) on a fresh install, end to end through the
 * REAL config stack: schema default → config.ts getter → isDeviceAuthEnabled()
 * → the /oauth/device route, and the setup wizard's `publicApi` toggle →
 * saveConfig → settings.json → the same route.
 *
 * Default ON since v0.1: the native iPhone/iPad/Apple TV apps sign in through
 * the OAuth device flow, so a fresh install with this off had no working
 * native client. The sibling server.test.ts mocks saveConfig; this file does
 * not, so a wizard write that never reaches the running config (or a default
 * that only changed in one of schema.ts / config.ts) fails here.
 */

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// config.ts snapshots process.env at import, so the fresh-install environment
// must be in place before anything imports it: an empty settings.json location,
// no operator override, and a master key (a fresh Docker install generates one;
// JWT_SECRET is derived from it when unset).
const env = vi.hoisted(() => {
    // saveConfig creates the directory on first write.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/lumastra-public-api-${process.pid}-${Date.now()}`;
    const saved = {
        CONFIG_PATH: process.env.CONFIG_PATH,
        FEATURE_DEVICE_AUTH: process.env.FEATURE_DEVICE_AUTH,
        JWT_SECRET: process.env.JWT_SECRET,
        LUMASTRA_MASTER_KEY: process.env.LUMASTRA_MASTER_KEY,
    };
    process.env.CONFIG_PATH = `${dir}/settings.json`;
    delete process.env.FEATURE_DEVICE_AUTH;
    delete process.env.JWT_SECRET;
    process.env.LUMASTRA_MASTER_KEY = 'a1'.repeat(32);
    return { dir, saved };
});

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
// saveConfig's cross-replica publish — no Valkey in a unit test.
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    getValkeyClient: () => null,
}));

import { configSchema } from '$lib/config/schema.js';
import { config, features } from '$lib/server/config.js';
import { isDeviceAuthEnabled } from '$lib/server/oauth/jwt.js';
import { POST as savePreferences } from './+server.js';
import { HEAD as deviceProbe, POST as deviceAuthorize } from '../../../oauth/device/+server.js';

afterAll(() => {
    for (const [k, v] of Object.entries(env.saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(env.dir, { recursive: true, force: true });
});

function wizardSave(body: Record<string, unknown>): Promise<Response> {
    return (savePreferences as (event: unknown) => Promise<Response>)({
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    });
}

function probe(): Promise<Response> {
    return (deviceProbe as (event: unknown) => Promise<Response>)({});
}

function settingsFile(): Record<string, unknown> {
    const path = join(env.dir, 'settings.json');
    return existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)
        : {};
}

describe('Public API on a fresh install (default ON)', () => {
    it('schema default and the config.ts getter both say ON', () => {
        expect(configSchema.find((s) => s.key === 'FEATURE_DEVICE_AUTH')?.defaultValue).toBe(true);
        expect(settingsFile()).toEqual({});
        expect(config.FEATURE_DEVICE_AUTH).toBe(true);
        expect(features.deviceAuth).toBe(true);
        expect(isDeviceAuthEnabled()).toBe(true);
    });

    it('/oauth/device is reachable with no operator configuration', async () => {
        expect((await probe()).status).toBe(200);
    });
});

describe('setup wizard publicApi toggle persists through saveConfig', () => {
    it('OFF writes FEATURE_DEVICE_AUTH=false and disables /oauth/device', async () => {
        const res = await wizardSave({ publicApi: false });
        expect(await res.json()).toEqual({ saved: true, keys: ['FEATURE_DEVICE_AUTH'] });

        expect(settingsFile().FEATURE_DEVICE_AUTH).toBe(false);
        expect(config.FEATURE_DEVICE_AUTH).toBe(false);
        expect(isDeviceAuthEnabled()).toBe(false);

        expect((await probe()).status).toBe(400);
        const denied = await (deviceAuthorize as (event: unknown) => Promise<Response>)({
            request: new Request('http://localhost/oauth/device', { method: 'POST' }),
            url: new URL('http://localhost/oauth/device'),
            getClientAddress: () => '127.0.0.1',
        });
        expect(denied.status).toBe(400);
        expect(await denied.json()).toMatchObject({
            error: 'invalid_request',
            error_description: 'Device authorization is not enabled',
        });
    });

    it('ON after OFF re-enables it (default-equal value is dropped from settings.json)', async () => {
        const res = await wizardSave({ publicApi: true });
        expect(await res.json()).toEqual({ saved: true, keys: ['FEATURE_DEVICE_AUTH'] });

        expect('FEATURE_DEVICE_AUTH' in settingsFile()).toBe(false);
        expect(config.FEATURE_DEVICE_AUTH).toBe(true);
        expect((await probe()).status).toBe(200);
    });

    it('a malformed value falls back to ON, never silently locking the apps out', async () => {
        await wizardSave({ publicApi: false });
        expect(config.FEATURE_DEVICE_AUTH).toBe(false);

        await wizardSave({ publicApi: 'yes please' });
        expect(config.FEATURE_DEVICE_AUTH).toBe(true);
    });

    it('omitting publicApi leaves the setting untouched', async () => {
        await wizardSave({ publicApi: false });
        await wizardSave({ gravatar: true });
        expect(config.FEATURE_DEVICE_AUTH).toBe(false);
        await wizardSave({ publicApi: true });
    });
});
