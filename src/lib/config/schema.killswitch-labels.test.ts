// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `DISABLE_*` killswitches store an inverted boolean — `false` means the
 * task RUNS — and are shown through `uiHints.invert` so the switch reads
 * positively ("Run Database Cleanup", ON = running).
 *
 * The pairing is the whole contract, and half of it is worse than neither:
 *
 *  - a positive label WITHOUT `invert` renders an ON switch for a stopped task,
 *    which is a straight lie about system state;
 *  - `invert` WITH a "Disable …" label reads as a double negative, so ON means
 *    the task is running while the label says disable.
 *
 * Nothing else enforces this — `defineSetting` has no notion of it and a
 * missing `uiHints` is perfectly valid TypeScript — so it is pinned here.
 */

import { describe, it, expect } from 'vitest';
import { configSchema, configSections } from './schema';

const killswitches = configSchema.filter(
    (s) => s.key.startsWith('DISABLE_') && s.type === 'boolean',
);

describe('DISABLE_* killswitch labelling', () => {
    it('finds the killswitches at all (guards against a silently-empty sweep)', () => {
        expect(killswitches.length).toBeGreaterThanOrEqual(15);
    });

    it.each(killswitches.map((s) => [s.key, s] as const))(
        '%s renders inverted, so ON means running',
        (_key, setting) => {
            expect(setting.uiHints?.invert).toBe(true);
        },
    );

    it.each(killswitches.map((s) => [s.key, s] as const))(
        '%s is labelled by what it does, not by what turning it on prevents',
        (_key, setting) => {
            // "Disable Media Probe" + invert reads ON = disabled = running.
            expect(setting.label.toLowerCase().startsWith('disable')).toBe(false);
        },
    );

    it('does not tell the operator to turn a switch ON in order to stop a task', () => {
        // The pre-inversion help text did exactly that, and survived the
        // inversion — leaving the panel's instructions inverted relative to its
        // own switches.
        const section = configSections.find((s) => s.id === 'advanced-tasks');
        expect(section).toBeDefined();
        expect(section?.helpText).toBeDefined();
        expect(section?.helpText).not.toMatch(/turn one ON to stop/i);
        // And it should describe the inverted reading positively.
        expect(section?.helpText).toMatch(/ON means the task runs/i);
    });
});
