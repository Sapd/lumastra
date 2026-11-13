// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "contact lumastra.org" answer is stored even when it is the default (on).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
    envLocked: new Set<string>(),
}));
vi.mock('$lib/server/config/index.js', () => ({
    saveConfig: vi.fn(),
    getAll: () => state.current,
    isEnvOverridden: (key: string) => state.envLocked.has(key),
}));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: vi.fn(),
    auditActorFromLocals: () => ({}),
}));

import { saveConfig } from '$lib/server/config/index.js';
import { commitSettingsUpdates, planSettingsUpdates } from './settings-write.js';

beforeEach(() => {
    state.current = { LICENSE_SERVER_CONTACT_ENABLED: false };
    state.envLocked.clear();
});

describe('planSettingsUpdates — the contact switch', () => {
    it('is planned like any other setting, with nothing coupled to it', () => {
        expect(planSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: true }).updates).toEqual({
            LICENSE_SERVER_CONTACT_ENABLED: true,
        });
    });

    it('is refused as env-locked when an environment variable owns it', () => {
        state.envLocked.add('LICENSE_SERVER_CONTACT_ENABLED');
        expect(planSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: true }).envLocked).toEqual([
            'LICENSE_SERVER_CONTACT_ENABLED',
        ]);
    });
});

describe('commitSettingsUpdates — the contact answer is stored even when on', () => {
    it('pins LICENSE_SERVER_CONTACT_ENABLED when the save carries it', async () => {
        vi.mocked(saveConfig).mockClear();
        await commitSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: true }, {} as never);
        expect(vi.mocked(saveConfig)).toHaveBeenCalledWith(
            { LICENSE_SERVER_CONTACT_ENABLED: true },
            { pinKeys: ['LICENSE_SERVER_CONTACT_ENABLED'] },
        );
    });

    it('CONTROL: another save is not pinned', async () => {
        vi.mocked(saveConfig).mockClear();
        await commitSettingsUpdates({ APP_NAME: 'X' }, {} as never);
        expect(vi.mocked(saveConfig)).toHaveBeenCalledWith({ APP_NAME: 'X' });
    });
});
