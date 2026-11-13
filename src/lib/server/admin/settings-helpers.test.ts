// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const state = vi.hoisted(() => ({
    values: {} as Record<string, unknown>,
    envKeys: new Set<string>(),
    saved: [] as Record<string, unknown>[],
    savedOptions: [] as unknown[],
    audits: [] as unknown[],
}));

vi.mock('$lib/server/config/index.js', () => ({
    getConfigForAdmin: vi.fn(() => ({
        values: state.values,
        envOverrides: [],
        fileKeys: [],
        schema: { sections: [{ id: 'push' }], settings: [] },
    })),
    getPendingRestartKeys: () => [],
    initConfigService: vi.fn(),
    saveConfig: vi.fn(async (updates: Record<string, unknown>, options?: unknown) => {
        state.saved.push(updates);
        state.savedOptions.push(options);
    }),
    isEnvOverridden: (key: string) => state.envKeys.has(key),
    reloadConfig: vi.fn(),
    getConfigPath: vi.fn(() => '/config/settings.json'),
    getConfigStorageStatus: vi.fn(),
    getAll: vi.fn(() => ({ ...state.values })),
    isSensitiveKey: (key: string) => key.endsWith('APIKEY') || key === 'APNS_KEY_P8',
}));
vi.mock('$lib/server/config', () => ({
    devFeaturesEnabled: false,
    privateModulesBuildEnabled: false,
}));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: vi.fn((...args: unknown[]) => state.audits.push(args)),
    auditActorFromLocals: vi.fn(() => ({ kind: 'user' })),
}));
vi.mock('$lib/server/admin/provider-search-index', () => ({
    loadProviderSearchIndex: vi.fn(async () => []),
}));
vi.mock('./admin-action-gate.js', () => ({ denyUnlessAdmin: () => null }));

import {
    maskSensitiveValues,
    saveSettingsAction,
    loadSettingsForSections,
} from './settings-helpers';
import { SECRET_CONFIGURED_SENTINEL } from '$lib/shared/secret-sentinel';

function request(updates: Record<string, unknown>, persistEnv?: string[]): Request {
    const body = new FormData();
    body.set('updates', JSON.stringify(updates));
    if (persistEnv) body.set('persistEnv', JSON.stringify(persistEnv));
    return new Request('http://localhost/admin/settings?/save', { method: 'POST', body });
}

beforeEach(() => {
    state.values = { SONARRURL: 'http://sonarr:8989', SONARRAPIKEY: 'real-key', APP_NAME: 'X' };
    state.saved = [];
    state.savedOptions = [];
    state.audits = [];
    state.envKeys = new Set();
});

describe('maskSensitiveValues', () => {
    it('replaces stored secrets with the sentinel and keeps unset ones empty', () => {
        expect(
            maskSensitiveValues({ SONARRAPIKEY: 'real-key', RADARRAPIKEY: '', APP_NAME: 'X' }),
        ).toEqual({
            SONARRAPIKEY: SECRET_CONFIGURED_SENTINEL,
            RADARRAPIKEY: '',
            APP_NAME: 'X',
        });
    });
});

describe('saveSettingsAction', () => {
    it('never persists the sentinel and skips values that did not change', async () => {
        await saveSettingsAction(
            request({
                SONARRAPIKEY: SECRET_CONFIGURED_SENTINEL,
                APP_NAME: 'X',
                SONARRURL: 'http://sonarr:9999',
            }),
            { user: { isAdmin: true } } as never,
        );
        expect(state.saved).toEqual([{ SONARRURL: 'http://sonarr:9999' }]);
        expect(JSON.stringify(state.audits)).toContain('SONARRURL');
        expect(JSON.stringify(state.audits)).not.toContain('APP_NAME');
    });

    it('writes nothing and audits nothing when nothing changed', async () => {
        await saveSettingsAction(request({ APP_NAME: 'X' }), { user: { isAdmin: true } } as never);
        expect(state.saved).toEqual([]);
        expect(state.audits).toEqual([]);
    });

    it('lets an explicit empty value clear a stored secret', async () => {
        await saveSettingsAction(request({ SONARRAPIKEY: '' }), {
            user: { isAdmin: true },
        } as never);
        expect(state.saved).toEqual([{ SONARRAPIKEY: '' }]);
    });

    it('"Save to config" copies the environment value (read server-side) into settings.json', async () => {
        state.envKeys = new Set(['SONARRAPIKEY']);
        await saveSettingsAction(request({}, ['SONARRAPIKEY', 'APP_NAME']), {
            user: { isAdmin: true },
        } as never);
        // APP_NAME is not ENV-owned: nothing to copy.
        expect(state.saved).toEqual([{ SONARRAPIKEY: 'real-key' }]);
        expect(state.savedOptions).toEqual([{ persistEnvOverridden: true }]);
    });

    it('"Save to config" never copies an env-only setting (FORWARD_AUTH_ENABLED)', async () => {
        state.values = { ...state.values, FORWARD_AUTH_ENABLED: true };
        state.envKeys = new Set(['SONARRAPIKEY', 'FORWARD_AUTH_ENABLED']);
        await saveSettingsAction(request({}, ['FORWARD_AUTH_ENABLED', 'SONARRAPIKEY']), {
            user: { isAdmin: true },
        } as never);
        expect(state.saved).toEqual([{ SONARRAPIKEY: 'real-key' }]);
    });

    it('refuses a changed value for an ENV-locked key instead of reporting it saved', async () => {
        state.envKeys = new Set(['SONARRURL']);
        const result = await saveSettingsAction(
            request({ SONARRURL: 'http://elsewhere:1', APP_NAME: 'Y' }),
            { user: { isAdmin: true } } as never,
        );
        expect(result).toMatchObject({ status: 409 });
        expect(JSON.stringify(result)).toContain('SONARRURL');
        // Nothing of the batch is written or audited.
        expect(state.saved).toEqual([]);
        expect(state.audits).toEqual([]);
    });

    it('still accepts the unchanged value of an ENV-locked key', async () => {
        state.envKeys = new Set(['SONARRURL']);
        const result = await saveSettingsAction(
            request({ SONARRURL: 'http://sonarr:8989', APP_NAME: 'Y' }),
            { user: { isAdmin: true } } as never,
        );
        expect(result).toEqual({ success: true });
        expect(state.saved).toEqual([{ APP_NAME: 'Y' }]);
    });

    it('rejects malformed JSON with a 400 before writing anything', async () => {
        const body = new FormData();
        body.set('updates', JSON.stringify({ APP_NAME: 'Y' }));
        body.set('persistEnv', '[not json');
        const result = await saveSettingsAction(
            new Request('http://localhost/admin/settings?/save', { method: 'POST', body }),
            { user: { isAdmin: true } } as never,
        );
        expect(result).toMatchObject({ status: 400 });
        expect(state.saved).toEqual([]);

        const bad = new FormData();
        bad.set('updates', '{oops');
        expect(
            await saveSettingsAction(
                new Request('http://localhost/admin/settings?/save', { method: 'POST', body: bad }),
                { user: { isAdmin: true } } as never,
            ),
        ).toMatchObject({ status: 400 });
    });
});

describe('APNs validation before saving', () => {
    const key = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    beforeEach(() => {
        state.values = {
            ...state.values,
            APNS_KEY_P8: key,
            APNS_KEY_P8_PATH: '',
            APNS_KEY_ID: 'ABCDE12345',
            APNS_TEAM_ID: 'TEAM123456',
        };
    });
    it.each([
        [{ APNS_KEY_P8: 'top-secret-broken-key' }, /PKCS#8/],
        [{ APNS_KEY_P8: '-----BEGIN PRIVATE KEY-----\ntruncated' }, /could not be parsed/],
        [{ APNS_KEY_ID: 'ABC123' }, /10.*alphanumeric/],
        [{ APNS_TEAM_ID: 'bad-team' }, /10.*alphanumeric/],
        [{ APNS_KEY_P8_PATH: '/secret/path' }, /not both/],
    ])('rejects malformed credentials atomically: %j', async (updates, reason) => {
        const result = await saveSettingsAction(request({ ...updates, APP_NAME: 'Y' }), {});
        expect(result).toMatchObject({ status: 400 });
        expect(JSON.stringify(result)).toMatch(reason);
        expect(JSON.stringify(result)).not.toMatch(/top-secret-broken-key|truncated|secret\/path/);
        expect(state.saved).toEqual([]);
        expect(state.audits).toEqual([]);
    });
    it('merges partial edits with the stored secret and accepts the sentinel', async () => {
        expect(
            await saveSettingsAction(
                request({ APNS_KEY_P8: SECRET_CONFIGURED_SENTINEL, APNS_KEY_ID: 'NEWID12345' }),
                {},
            ),
        ).toEqual({ success: true });
        expect(state.saved).toEqual([{ APNS_KEY_ID: 'NEWID12345' }]);
    });
    it('can clear all credentials and can safely re-run that save', async () => {
        const clear = { APNS_KEY_P8: '', APNS_KEY_P8_PATH: '', APNS_KEY_ID: '', APNS_TEAM_ID: '' };
        expect(await saveSettingsAction(request(clear), {})).toEqual({ success: true });
        state.values = { ...state.values, ...clear };
        state.saved = [];
        expect(await saveSettingsAction(request(clear), {})).toEqual({ success: true });
        expect(state.saved).toEqual([]);
    });
});

it('loads invalid saved or environment APNs state with a safe reason and masks the key', async () => {
    state.values = {
        APNS_KEY_P8: 'secret-key-material',
        APNS_KEY_ID: 'ABCDE12345',
        APNS_TEAM_ID: 'TEAM123456',
    };
    state.envKeys.add('APNS_KEY_P8');
    const data = await loadSettingsForSections(['push']);
    expect(data.apnsStatus).toMatchObject({
        kind: 'invalid',
        reason: expect.stringMatching(/PKCS#8/),
    });
    expect(data.values.APNS_KEY_P8).toBe(SECRET_CONFIGURED_SENTINEL);
    expect(JSON.stringify(data)).not.toContain('secret-key-material');
});

it('saves a worker-only APNs key path without reading it in the web process and can re-run', async () => {
    const updates = {
        APNS_KEY_P8: '',
        APNS_KEY_P8_PATH: '/worker-only/AuthKey.p8',
        APNS_KEY_ID: 'abcde12345',
        APNS_TEAM_ID: 'team123456',
    };
    expect(await saveSettingsAction(request(updates), {})).toEqual({ success: true });
    expect(state.saved).toHaveLength(1);
    state.values = { ...state.values, ...updates };
    state.saved = [];
    expect(await saveSettingsAction(request(updates), {})).toEqual({ success: true });
    expect(state.saved).toEqual([]);
    const data = await loadSettingsForSections(['push']);
    expect(data.apnsStatus).toMatchObject({
        kind: 'warning',
        reason: expect.stringMatching(/push sender/i),
    });
    expect(JSON.stringify(data.apnsStatus)).not.toContain('/worker-only/');
});
it('tells first-time admins to save the key and both IDs together', async () => {
    const result = await saveSettingsAction(request({ APNS_KEY_P8: 'not-echoed' }), {});
    expect(result).toMatchObject({ status: 400 });
    expect(JSON.stringify(result)).toMatch(/signing key, APNS_KEY_ID and APNS_TEAM_ID together/);
    expect(JSON.stringify(result)).not.toContain('not-echoed');
});
it.each([
    'relative/AuthKey.p8',
    'https://secret@example.com/key.p8',
    '/bad\u0000key.p8',
    '/bad\nkey.p8',
])('rejects invalid APNs path syntax without echoing it', async (path) => {
    const result = await saveSettingsAction(
        request({ APNS_KEY_P8_PATH: path, APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456' }),
        {},
    );
    expect(result).toMatchObject({ status: 400 });
    expect(JSON.stringify(result)).toMatch(/absolute file path/);
    expect(JSON.stringify(result)).not.toContain(path);
    expect(state.saved).toEqual([]);
});
