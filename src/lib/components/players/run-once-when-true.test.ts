// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RunOnceWhenTrue — the gate +layout.svelte uses to bootstrap the music
 * store exactly once, the first time the app-shell branch (not /login,
 * /setup, /showcase) is active (Task 8 fix round 1, Critical 1).
 *
 * A plain unit test, not a component test: the class has no Svelte runes and
 * no store dependency, so it's testable directly — see the class's own doc
 * comment for why this was extracted instead of rendering the real root
 * layout for this specific fix.
 */

import { describe, expect, it, vi } from 'vitest';
import { RunOnceWhenTrue } from './run-once-when-true';

describe('RunOnceWhenTrue', () => {
    it('does not fire while every call is false — the /login-only session', () => {
        const gate = new RunOnceWhenTrue();
        const fn = vi.fn();

        gate.run(false, fn); // e.g. on /login
        gate.run(false, fn); // still on /login (route-derived condition re-evaluated)

        expect(fn).not.toHaveBeenCalled();
        expect(gate.hasRun).toBe(false);
    });

    it('fires immediately on the first call when the condition starts true — landing on an app route', () => {
        const gate = new RunOnceWhenTrue();
        const fn = vi.fn();

        gate.run(true, fn);

        expect(fn).toHaveBeenCalledOnce();
        expect(gate.hasRun).toBe(true);
    });

    it('fires exactly once after navigating from an auth route into the app', () => {
        const gate = new RunOnceWhenTrue();
        const fn = vi.fn();

        gate.run(false, fn); // start on /login
        gate.run(false, fn); // still /login
        expect(fn).not.toHaveBeenCalled();

        gate.run(true, fn); // navigated to / — the fix: this must still fire
        expect(fn).toHaveBeenCalledOnce();

        // Further re-evaluations (e.g. navigating between /  and /browse,
        // both non-auth) must NOT re-fire it.
        gate.run(true, fn);
        gate.run(true, fn);
        expect(fn).toHaveBeenCalledOnce();
    });

    it('never re-fires even if the condition later goes false again (e.g. navigating back to /login)', () => {
        const gate = new RunOnceWhenTrue();
        const fn = vi.fn();

        gate.run(true, fn);
        expect(fn).toHaveBeenCalledOnce();

        gate.run(false, fn);
        gate.run(true, fn);

        expect(fn).toHaveBeenCalledOnce();
    });
});
