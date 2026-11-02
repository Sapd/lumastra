// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turning "Contact lumastra.org for the licence" back on turns the weekly
 * check-in back on too (its default), unless the same save sets it.
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
    state.current = { LICENSE_SERVER_CONTACT_ENABLED: false, LICENSE_CHECK_IN_ENABLED: false };
    state.envLocked.clear();
});

describe('planSettingsUpdates — licence contact back on', () => {
    it('off → on also turns the check-in on', () => {
        const { updates } = planSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: true });
        expect(updates).toEqual({
            LICENSE_SERVER_CONTACT_ENABLED: true,
            LICENSE_CHECK_IN_ENABLED: true,
        });
    });

    it('the form sending the unchanged (off) check-in still gets it turned on', () => {
        const { updates } = planSettingsUpdates({
            LICENSE_SERVER_CONTACT_ENABLED: true,
            LICENSE_CHECK_IN_ENABLED: false,
        });
        expect(updates.LICENSE_CHECK_IN_ENABLED).toBe(true);
    });

    it('an explicit change of the check-in in the same save wins', () => {
        state.current.LICENSE_CHECK_IN_ENABLED = true;
        const { updates } = planSettingsUpdates({
            LICENSE_SERVER_CONTACT_ENABLED: true,
            LICENSE_CHECK_IN_ENABLED: false,
        });
        expect(updates.LICENSE_CHECK_IN_ENABLED).toBe(false);
    });

    it('an env-owned check-in is left alone', () => {
        state.envLocked.add('LICENSE_CHECK_IN_ENABLED');
        const { updates } = planSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: true });
        expect('LICENSE_CHECK_IN_ENABLED' in updates).toBe(false);
    });

    it('CONTROL: turning contact off, or another save, leaves the check-in alone', () => {
        state.current.LICENSE_SERVER_CONTACT_ENABLED = true;
        expect(planSettingsUpdates({ LICENSE_SERVER_CONTACT_ENABLED: false }).updates).toEqual({
            LICENSE_SERVER_CONTACT_ENABLED: false,
        });
        expect(planSettingsUpdates({ APP_NAME: 'x' }).updates).toEqual({ APP_NAME: 'x' });
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
