// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The appearance save action validates themes and then writes its payload as
 * is. It must not double as a writer for other settings, and must not answer
 * "saved" for an ENV-owned key that saveConfig skips.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    saved: [] as Record<string, unknown>[],
    envKeys: new Set<string>(),
}));

vi.mock('$lib/server/admin/admin-action-gate.js', () => ({ denyUnlessAdmin: () => null }));
vi.mock('$lib/server/admin/settings-helpers', () => ({ loadSettingsForSections: vi.fn() }));
vi.mock('$lib/server/config/index.js', () => ({
    saveConfig: vi.fn(async (updates: Record<string, unknown>) => {
        state.saved.push(updates);
    }),
    isEnvOverridden: (key: string) => state.envKeys.has(key),
}));
vi.mock('$lib/server/theme/enabled-themes.js', () => ({ getEnabledThemes: () => [] }));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: vi.fn(),
    auditActorFromLocals: vi.fn(() => ({ kind: 'user' })),
}));

import { actions } from './+page.server';

function save(updates: unknown) {
    const body = new FormData();
    body.set('updates', JSON.stringify(updates));
    return actions.save({
        request: new Request('http://localhost/admin/settings/appearance?/save', {
            method: 'POST',
            body,
        }),
        locals: { user: { ownerIsAdmin: true } },
    } as never);
}

beforeEach(() => {
    state.saved = [];
    state.envKeys = new Set();
});

describe('appearance ?/save', () => {
    it('writes only the keys it was sent', async () => {
        expect(await save({ APPEARANCE_CUSTOM_CSS: 'body{}' })).toEqual({ success: true });
        expect(state.saved).toEqual([{ APPEARANCE_CUSTOM_CSS: 'body{}' }]);
    });

    it('refuses any key that is not an appearance setting', async () => {
        const result = await save({ APPEARANCE_CUSTOM_CSS: '', LICENSE_KEY: 'x' });
        expect(result).toMatchObject({ status: 400 });
        expect(state.saved).toEqual([]);
    });

    it('refuses an ENV-locked key instead of answering saved', async () => {
        state.envKeys.add('APPEARANCE_CUSTOM_JS');
        const result = await save({ APPEARANCE_CUSTOM_JS: 'alert(1)' });
        expect(result).toMatchObject({ status: 409 });
        expect(state.saved).toEqual([]);
    });
});
