// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveConfig = vi.hoisted(() => vi.fn());
const auditLog = vi.hoisted(() => vi.fn());
const isEnvOverridden = vi.hoisted(() => vi.fn((_key: string) => false));
// The config service as the profile state reads it (effective values).
const stored = vi.hoisted(() => ({}) as Record<string, unknown>);
const config = vi.hoisted(() => ({
    LICENSE_KEY: 'existing-key',
    get INSTANCE_USE_CASES() {
        return stored.INSTANCE_USE_CASES ?? [];
    },
    get INSTANCE_PROFILE_APPLIED() {
        return stored.INSTANCE_PROFILE_APPLIED ?? '';
    },
    INSTANCE_LANDING_PATH: '',
    APP_VERSION: 'test',
    buildInfo: {},
    LICENSE_SERVER_CONTACT_ENABLED: true,
}));

vi.mock('$lib/server/config.js', () => ({
    config,
    hasEmbeddingProvider: () => false,
}));
vi.mock('$lib/server/config/index.js', () => ({ saveConfig }));
vi.mock('$lib/server/config/config.service.js', () => ({
    isEnvOverridden,
    get: (key: string) => stored[key],
}));
vi.mock('$lib/server/services/sonic-embedding.service.js', () => ({
    isSonicEngineConfigured: () => false,
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/license-install.queries.js', () => ({
    getInstallUuid: vi.fn(),
}));
vi.mock('$lib/server/licensing/entitlements.js', () => ({
    getLicenseServerContact: vi.fn(),
    getLicenseStatus: vi.fn(),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog,
    auditActorFromLocals: () => ({ username: 'admin' }),
}));

import { actions, load } from './+page.server.js';
import { applyUseCasePreset, serializeAppliedProfile } from '$lib/config/use-case-presets';

const locals = { user: { username: 'admin', isAdmin: true }, principal: { isAdmin: true } };

function saveEvent(licenseKey: string) {
    const body = new FormData();
    body.set('licenseKey', licenseKey);
    return {
        request: new Request('http://localhost/admin/system/instance?/save', {
            method: 'POST',
            body,
        }),
        locals,
    } as never;
}

beforeEach(() => {
    saveConfig.mockReset().mockResolvedValue(undefined);
    auditLog.mockReset();
    isEnvOverridden.mockReset().mockReturnValue(false);
});

describe('/admin/system/instance save action', () => {
    it('refuses a blank key instead of wiping the stored one', async () => {
        const result = (await actions.save(saveEvent('   '))) as { status?: number };
        expect(result.status).toBe(400);
        expect(saveConfig).not.toHaveBeenCalled();
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('saves a trimmed key', async () => {
        const result = await actions.save(saveEvent('  abc-123  '));
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'abc-123' });
        expect(result).toEqual({ success: true, licenseKeySet: true });
    });
});

describe('/admin/system/instance license key owned by the environment', () => {
    it('save and clear refuse instead of answering "saved"', async () => {
        isEnvOverridden.mockImplementation((key: string) => key === 'LICENSE_KEY');
        const saved = (await actions.save(saveEvent('abc-123'))) as { status?: number };
        expect(saved.status).toBe(409);
        const cleared = (await actions.clear({ locals } as never)) as { status?: number };
        expect(cleared.status).toBe(409);
        expect(saveConfig).not.toHaveBeenCalled();
        expect(auditLog).not.toHaveBeenCalled();
    });
});

describe('/admin/system/instance load', () => {
    it('seeds the profile tiles with known use cases only', async () => {
        // An unknown id here made every Preview and Apply a 422.
        stored.INSTANCE_USE_CASES = ['music', 'legacy-mode'];
        config.INSTANCE_LANDING_PATH = '/music';
        const data = (await load({} as never)) as { selected: string[]; landingPath: string };
        expect(data.selected).toEqual(['music']);
        expect(data.landingPath).toBe('/music');
    });
});

describe('/admin/system/instance load: applied profile', () => {
    beforeEach(() => {
        for (const k of Object.keys(stored)) delete stored[k];
    });

    it('hands the form the revision of the recorded apply', async () => {
        stored.INSTANCE_USE_CASES = ['music'];
        stored.INSTANCE_PROFILE_APPLIED = serializeAppliedProfile({
            useCases: ['music'],
            values: applyUseCasePreset(['music'], { hasEmbeddings: false, hasSonicEmbedder: false })
                .patch,
            at: '2026-10-07T10:00:00.000Z',
        });
        const data = (await load({} as never)) as {
            profileRevision: string | null;
            profileUpdates: string[];
        };
        expect(data.profileRevision).toBe('2026-10-07T10:00:00.000Z');
        expect(data.profileUpdates).toEqual([]);
    });

    it('names settings a re-apply would change because the profile itself moved', async () => {
        const values = applyUseCasePreset(['music'], {
            hasEmbeddings: false,
            hasSonicEmbedder: false,
        }).patch;
        delete values.FEATURE_LIVETV; // an older release did not set it
        stored.INSTANCE_USE_CASES = ['music'];
        stored.FEATURE_LIVETV = true;
        stored.INSTANCE_PROFILE_APPLIED = serializeAppliedProfile({
            useCases: ['music'],
            values,
            at: '2026-10-07T10:00:00.000Z',
        });
        const data = (await load({} as never)) as { profileUpdates: string[] };
        expect(data.profileUpdates).toEqual(['FEATURE_LIVETV']);
    });

    it('no record: no revision, nothing pending', async () => {
        stored.INSTANCE_USE_CASES = ['music'];
        const data = (await load({} as never)) as {
            profileRevision: string | null;
            profileUpdates: string[];
        };
        expect(data.profileRevision).toBeNull();
        expect(data.profileUpdates).toEqual([]);
    });
});

describe('/admin/system/instance license errors are codes the page translates', () => {
    it('blank, env-owned and failed saves each return their code', async () => {
        expect(await actions.save(saveEvent('  '))).toMatchObject({
            status: 400,
            data: { errorCode: 'empty' },
        });
        saveConfig.mockRejectedValueOnce(new Error('disk full'));
        expect(await actions.save(saveEvent('abc'))).toMatchObject({
            status: 500,
            data: { errorCode: 'save_failed', errorDetail: 'disk full' },
        });
        isEnvOverridden.mockImplementation((key: string) => key === 'LICENSE_KEY');
        expect(await actions.save(saveEvent('abc'))).toMatchObject({
            status: 409,
            data: { errorCode: 'env_locked' },
        });
    });
});

describe('load — contact with lumastra.org', () => {
    it.each([true, false])('hands the page LICENSE_SERVER_CONTACT_ENABLED=%s', async (value) => {
        config.LICENSE_SERVER_CONTACT_ENABLED = value;
        try {
            const data = (await load({} as never)) as { licenseServerContactEnabled: boolean };
            expect(data.licenseServerContactEnabled).toBe(value);
        } finally {
            config.LICENSE_SERVER_CONTACT_ENABLED = true;
        }
    });
});
