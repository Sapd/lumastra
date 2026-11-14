// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shared lumastra.org consent rule: an answered contact question (environment
 * or stored setting) allows contact at once; otherwise only a setup older than a day.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
    state: {
        envOverridden: false,
        configState: { jsonOverrides: new Set<string>() } as { jsonOverrides: Set<string> } | null,
        setupOld: false as boolean | Error,
        askedMs: [] as number[],
    },
}));

vi.mock('$lib/server/config/index.js', () => ({
    getConfigState: () => state.configState,
    isEnvOverridden: (key: string) =>
        key === 'LICENSE_SERVER_CONTACT_ENABLED' && state.envOverridden,
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    isFirstRunSetupOlderThan: async (_sql: unknown, ms: number) => {
        state.askedMs.push(ms);
        if (state.setupOld instanceof Error) throw state.setupOld;
        return state.setupOld;
    },
}));

import {
    CONTACT_SETUP_FALLBACK_MS,
    contactQuestionAnswered,
    setupAllowsLumastraOrgContact,
} from './lumastra-org-consent.js';

const sql = {} as Parameters<typeof setupAllowsLumastraOrgContact>[0];

describe('lumastra-org consent', () => {
    beforeEach(() => {
        state.envOverridden = false;
        state.configState = { jsonOverrides: new Set() };
        state.setupOld = false;
        state.askedMs = [];
    });

    it('a fresh install with no answer and a young setup may not contact', async () => {
        expect(contactQuestionAnswered()).toBe(false);
        await expect(setupAllowsLumastraOrgContact(sql)).resolves.toBe(false);
        expect(state.askedMs).toEqual([CONTACT_SETUP_FALLBACK_MS]);
        expect(CONTACT_SETUP_FALLBACK_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('an environment override counts as an answer', async () => {
        state.envOverridden = true;
        expect(contactQuestionAnswered()).toBe(true);
        await expect(setupAllowsLumastraOrgContact(sql)).resolves.toBe(true);
        expect(state.askedMs).toEqual([]);
    });

    it('a stored setting counts as an answer', async () => {
        state.configState = { jsonOverrides: new Set(['LICENSE_SERVER_CONTACT_ENABLED']) };
        expect(contactQuestionAnswered()).toBe(true);
        await expect(setupAllowsLumastraOrgContact(sql)).resolves.toBe(true);
    });

    it('another stored setting does not count', () => {
        state.configState = { jsonOverrides: new Set(['UPDATE_CHECK_ENABLED']) };
        expect(contactQuestionAnswered()).toBe(false);
    });

    it('no config state yet means unanswered', async () => {
        state.configState = null;
        expect(contactQuestionAnswered()).toBe(false);
        await expect(setupAllowsLumastraOrgContact(sql)).resolves.toBe(false);
    });

    it('an unanswered install may contact once setup is older than a day', async () => {
        state.setupOld = true;
        await expect(setupAllowsLumastraOrgContact(sql)).resolves.toBe(true);
    });

    it('rejects when the database cannot say', async () => {
        state.setupOld = new Error('db down');
        await expect(setupAllowsLumastraOrgContact(sql)).rejects.toThrow('db down');
    });
});
